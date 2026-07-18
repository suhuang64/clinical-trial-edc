import { randomUUID } from 'node:crypto'
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { formDefinitionSchema, type FormDefinition, type FormField } from '@edc/contracts'
import { validateFormRecord, type FormValue, type FormValueMap } from '@edc/domain'
import { z } from 'zod'
import { verifyCsrf } from '../../auth/auth.js'
import {
  requireActiveSite,
  requireAllowedSite,
  requireStudyPermission,
  requireStudyStatus,
  resolveMembershipPermissions,
  type StudyAuthorization,
} from '../../auth/permissions.js'
import { writeAudit } from '../../audit/audit.js'
import { sqlite } from '../../db/database.js'
import {
  purgeQuarantinedFiles,
  quarantineFilesForRecord,
  restoreQuarantinedFiles,
} from '../files/routes.js'

interface SubjectRow {
  id: string
  study_id: string
  site_id: string
  site_name: string
  screening_number: string
  subject_number: string | null
  random_number: string | null
  randomization_arm_id: string | null
  randomization_arm_label: string | null
  status: string
}

interface FormRow {
  id: string
  study_id: string
  code: string
  name: string
  form_type: string
  repeatable: number
  bind_visits: number
  active_version_id: string | null
  status: string
}

interface RecordRow {
  id: string
  study_id: string
  site_id: string
  subject_id: string
  form_id: string
  form_version_id: string
  visit_id: string | null
  repeat_index: number
  status: 'draft' | 'submitted'
  row_version: number
  created_by: string
  updated_by: string
  created_at: string
  updated_at: string
}

interface StoredValueRow {
  field_key: string
  value_type: string
  value_text: string | null
  value_number: number | null
  value_date: string | null
  value_datetime: string | null
  value_boolean: number | null
  value_json: string | null
}

const formValueSchema = z.union([
  z.string().max(100_000),
  z.number().finite(),
  z.boolean(),
  z.array(z.string().max(500)).max(500),
  z.null(),
])
const createRecordSchema = z.object({
  formId: z.string().uuid(),
  visitId: z.string().uuid().nullable().default(null),
  values: z.record(z.string(), formValueSchema).default({}),
  status: z.enum(['draft', 'submitted']).default('draft'),
})
const updateRecordSchema = z.object({
  rowVersion: z.number().int().positive(),
  values: z.record(z.string(), formValueSchema),
  status: z.enum(['draft', 'submitted']),
})

function subjectByStudy(studyId: string, subjectId: string) {
  return sqlite
    .prepare(
      `SELECT s.*, st.name AS site_name,
              ra.arm_id AS randomization_arm_id,
              (SELECT json_extract(arm.value, '$.label')
               FROM json_each(rs.arms_json) arm
               WHERE json_extract(arm.value, '$.id') = ra.arm_id) AS randomization_arm_label
       FROM subjects s
       JOIN sites st ON st.study_id = s.study_id AND st.id = s.site_id
       LEFT JOIN randomization_assignments ra
         ON ra.study_id = s.study_id AND ra.subject_id = s.id
       LEFT JOIN randomization_schemes rs
         ON rs.study_id = s.study_id AND rs.id = ra.scheme_id
       WHERE s.study_id = ? AND s.id = ?`,
    )
    .get(studyId, subjectId) as SubjectRow | undefined
}

function formByStudy(studyId: string, formId: string) {
  return sqlite
    .prepare('SELECT * FROM forms WHERE study_id = ? AND id = ?')
    .get(studyId, formId) as FormRow | undefined
}

function recordBySubject(studyId: string, subjectId: string, recordId: string) {
  return sqlite
    .prepare('SELECT * FROM data_records WHERE study_id = ? AND subject_id = ? AND id = ?')
    .get(studyId, subjectId, recordId) as RecordRow | undefined
}

function activeDefinition(form: FormRow) {
  if (!form.active_version_id) return null
  const version = sqlite
    .prepare(
      "SELECT schema_json FROM form_versions WHERE id = ? AND form_id = ? AND status = 'published'",
    )
    .get(form.active_version_id, form.id) as { schema_json: string } | undefined
  return version ? formDefinitionSchema.parse(JSON.parse(version.schema_json)) : null
}

function definitionForRecord(record: RecordRow) {
  const version = sqlite
    .prepare('SELECT schema_json FROM form_versions WHERE id = ? AND form_id = ?')
    .get(record.form_version_id, record.form_id) as { schema_json: string } | undefined
  return version ? formDefinitionSchema.parse(JSON.parse(version.schema_json)) : null
}

function readValues(recordId: string): FormValueMap {
  const rows = sqlite
    .prepare('SELECT * FROM data_values WHERE record_id = ?')
    .all(recordId) as StoredValueRow[]
  return Object.fromEntries(
    rows.map((row) => {
      let value: FormValue
      switch (row.value_type) {
        case 'number':
          value = row.value_number
          break
        case 'date':
          value = row.value_date
          break
        case 'datetime':
          value = row.value_datetime
          break
        case 'boolean':
          value = row.value_boolean === null ? null : Boolean(row.value_boolean)
          break
        case 'json':
          value = row.value_json ? (JSON.parse(row.value_json) as string[]) : []
          break
        default:
          value = row.value_text
      }
      return [row.field_key, value]
    }),
  )
}

function isEmpty(value: FormValue | undefined) {
  return (
    value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)
  )
}

function storageValue(field: FormField, value: FormValue) {
  const empty = {
    value_text: null,
    value_number: null,
    value_date: null,
    value_datetime: null,
    value_boolean: null,
    value_json: null,
  }
  const type = field.type === 'calculated' ? field.calculation?.resultType : field.type
  if (type === 'number') return { ...empty, value_type: 'number', value_number: Number(value) }
  if (type === 'date') return { ...empty, value_type: 'date', value_date: String(value) }
  if (type === 'datetime')
    return { ...empty, value_type: 'datetime', value_datetime: String(value) }
  if (type === 'switch')
    return { ...empty, value_type: 'boolean', value_boolean: Number(Boolean(value)) }
  if (type === 'checkbox' || type === 'file')
    return { ...empty, value_type: 'json', value_json: JSON.stringify(value) }
  return { ...empty, value_type: 'text', value_text: String(value) }
}

function writeValues(recordId: string, definition: FormDefinition, values: FormValueMap) {
  const deleteValue = sqlite.prepare(
    'DELETE FROM data_values WHERE record_id = ? AND field_key = ?',
  )
  const upsert = sqlite.prepare(
    `INSERT INTO data_values
     (id, record_id, field_key, value_type, value_text, value_number, value_date, value_datetime, value_boolean, value_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(record_id, field_key) DO UPDATE SET
       value_type = excluded.value_type,
       value_text = excluded.value_text,
       value_number = excluded.value_number,
       value_date = excluded.value_date,
       value_datetime = excluded.value_datetime,
       value_boolean = excluded.value_boolean,
       value_json = excluded.value_json`,
  )
  for (const field of definition.fields) {
    if (field.type === 'heading' || field.type === 'note') continue
    const value = values[field.key]
    if (isEmpty(value)) {
      deleteValue.run(recordId, field.key)
      continue
    }
    const stored = storageValue(field, value!)
    upsert.run(
      randomUUID(),
      recordId,
      field.key,
      stored.value_type,
      stored.value_text,
      stored.value_number,
      stored.value_date,
      stored.value_datetime,
      stored.value_boolean,
      stored.value_json,
    )
  }
}

function validateFileReferences(
  subject: SubjectRow,
  definition: FormDefinition,
  values: FormValueMap,
  recordId: string | null,
) {
  for (const field of definition.fields.filter((item) => item.type === 'file')) {
    const ids = values[field.key]
    if (ids === undefined || ids === null) continue
    if (!Array.isArray(ids) || ids.some((id) => !z.string().uuid().safeParse(id).success)) {
      return `${field.label}包含不合法的文件标识`
    }
    const uniqueIds = [...new Set(ids)]
    if (uniqueIds.length !== ids.length) return `${field.label}包含重复文件`
    if (!uniqueIds.length) continue
    const rows = sqlite
      .prepare(
        `SELECT id, record_id FROM uploaded_files
         WHERE study_id = ? AND site_id = ? AND subject_id = ? AND field_key = ?
           AND id IN (${uniqueIds.map(() => '?').join(',')})`,
      )
      .all(subject.study_id, subject.site_id, subject.id, field.key, ...uniqueIds) as Array<{
      id: string
      record_id: string | null
    }>
    if (rows.length !== uniqueIds.length) return `${field.label}包含无权访问或不存在的文件`
    if (rows.some((row) => row.record_id !== null && row.record_id !== recordId)) {
      return `${field.label}包含已关联其他数据记录的文件`
    }
  }
  return null
}

function attachFileReferences(
  subject: SubjectRow,
  recordId: string,
  definition: FormDefinition,
  values: FormValueMap,
) {
  const update = sqlite.prepare(
    `UPDATE uploaded_files SET record_id = ?
     WHERE study_id = ? AND site_id = ? AND subject_id = ? AND field_key = ? AND id = ?
       AND (record_id IS NULL OR record_id = ?)`,
  )
  for (const field of definition.fields.filter((item) => item.type === 'file')) {
    const ids = values[field.key]
    if (!Array.isArray(ids)) continue
    for (const id of ids) {
      update.run(recordId, subject.study_id, subject.site_id, subject.id, field.key, id, recordId)
    }
  }
}

function validateVisit(form: FormRow, visitId: string | null) {
  if (!form.bind_visits && visitId) return '该表单未绑定访视，不能指定访视时间点'
  if (form.bind_visits && !visitId) return '该表单必须选择访视时间点'
  if (!visitId) return null
  const binding = sqlite
    .prepare('SELECT 1 FROM form_visit_bindings WHERE form_id = ? AND visit_id = ?')
    .get(form.id, visitId)
  return binding ? null : '该表单未绑定所选访视'
}

function validateSubmission(
  definition: FormDefinition,
  values: FormValueMap,
  status: 'draft' | 'submitted',
) {
  const result = validateFormRecord(definition, values)
  const issues =
    status === 'draft' ? result.issues.filter((issue) => issue.code !== 'REQUIRED') : result.issues
  return { ...result, issues }
}

async function authorizeSubject(
  request: FastifyRequest,
  reply: Parameters<typeof requireStudyPermission>[1],
  permission: string,
) {
  const { studyId, subjectId } = request.params as { studyId: string; subjectId: string }
  const auth = await requireStudyPermission(request, reply, studyId, permission)
  if (!auth) return null
  const subject = subjectByStudy(studyId, subjectId)
  if (!subject) {
    await reply
      .code(404)
      .send({ code: 'SUBJECT_NOT_FOUND', message: '受试者不存在', requestId: request.id })
    return null
  }
  if (!(await requireAllowedSite(auth, subject.site_id, request, reply))) return null
  return { auth, subject }
}

function auditContext(request: FastifyRequest, auth: StudyAuthorization, subject: SubjectRow) {
  return {
    requestId: request.id,
    actorUserId: auth.user.id,
    studyId: subject.study_id,
    siteId: subject.site_id,
    subjectId: subject.id,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'],
  }
}

export const recordRoutes: FastifyPluginAsync = async (app) => {
  app.get('/context', async (request, reply) => {
    const authorization = await authorizeSubject(request, reply, 'data.view')
    if (!authorization) return
    const { auth, subject } = authorization
    const permissions = auth.user.isSystemAdmin
      ? new Set([
          'data.view',
          'data.create',
          'data.edit',
          'data.delete',
          'subject.edit',
          'subject.delete',
          'subject.enroll',
          'randomization.execute',
        ])
      : await resolveMembershipPermissions(auth.membershipId!, auth.roleCode!)
    const canRandomize = permissions.has('randomization.execute')
    const randomizationScheme = canRandomize
      ? (sqlite
          .prepare(
            `SELECT name, arms_json, status
             FROM randomization_schemes WHERE study_id = ?`,
          )
          .get(subject.study_id) as
          | {
              name: string
              arms_json: string
              status: string
            }
          | undefined)
      : undefined
    const forms = sqlite
      .prepare(
        `SELECT f.*, fv.version_number, fv.schema_json
         FROM forms f
         JOIN form_versions fv ON fv.id = f.active_version_id
         WHERE f.study_id = ? AND f.status = 'published' AND fv.status = 'published'
         ORDER BY f.name`,
      )
      .all(subject.study_id) as Array<FormRow & { version_number: number; schema_json: string }>
    const items = forms.map((form) => ({
      id: form.id,
      code: form.code,
      name: form.name,
      formType: form.form_type,
      repeatable: Boolean(form.repeatable),
      bindVisits: Boolean(form.bind_visits),
      versionNumber: form.version_number,
      definition: formDefinitionSchema.parse(JSON.parse(form.schema_json)),
      visitIds: (
        sqlite
          .prepare('SELECT visit_id FROM form_visit_bindings WHERE form_id = ? ORDER BY visit_id')
          .all(form.id) as Array<{ visit_id: string }>
      ).map((row) => row.visit_id),
    }))
    const visits = sqlite
      .prepare('SELECT * FROM visit_definitions WHERE study_id = ? ORDER BY sort_order, code')
      .all(subject.study_id)
    return {
      subject,
      forms: items,
      visits,
      randomization: randomizationScheme
        ? {
            name: randomizationScheme.name,
            status: randomizationScheme.status,
            arms: (
              JSON.parse(randomizationScheme.arms_json) as Array<{
                id: string
                label: string
              }>
            ).map(({ id, label }) => ({ id, label })),
          }
        : null,
      capabilities: {
        create: permissions.has('data.create'),
        edit: permissions.has('data.edit'),
        delete: permissions.has('data.delete'),
        editScreening: permissions.has('subject.edit'),
        enroll: permissions.has('subject.enroll'),
        randomize: canRandomize,
        manageEvents: permissions.has('subject.edit'),
        deleteSubject: permissions.has('subject.delete'),
      },
    }
  })

  app.get('/', async (request, reply) => {
    const authorization = await authorizeSubject(request, reply, 'data.view')
    if (!authorization) return
    const { subject } = authorization
    const items = sqlite
      .prepare(
        `SELECT dr.*, f.code AS form_code, f.name AS form_name, f.form_type,
                fv.version_number, v.code AS visit_code, v.name AS visit_name
         FROM data_records dr
         JOIN forms f ON f.id = dr.form_id AND f.study_id = dr.study_id
         JOIN form_versions fv ON fv.id = dr.form_version_id
         LEFT JOIN visit_definitions v ON v.id = dr.visit_id AND v.study_id = dr.study_id
         WHERE dr.study_id = ? AND dr.subject_id = ?
         ORDER BY dr.updated_at DESC`,
      )
      .all(subject.study_id, subject.id)
    return { items }
  })

  app.post('/', async (request, reply) => {
    const authorization = await authorizeSubject(request, reply, 'data.create')
    if (!authorization) return
    if (!(await verifyCsrf(request, reply))) return
    const { auth, subject } = authorization
    if (!(await requireStudyStatus(subject.study_id, ['active'], request, reply))) return
    if (!(await requireActiveSite(subject.study_id, subject.site_id, request, reply))) return
    const parsed = createRecordSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: '数据记录请求不完整',
        details: parsed.error.flatten(),
        requestId: request.id,
      })
    }
    const form = formByStudy(subject.study_id, parsed.data.formId)
    if (!form || form.status !== 'published' || !form.active_version_id) {
      return reply.code(404).send({
        code: 'FORM_NOT_AVAILABLE',
        message: '表单不存在或尚未发布',
        requestId: request.id,
      })
    }
    const visitError = validateVisit(form, parsed.data.visitId)
    if (visitError)
      return reply
        .code(400)
        .send({ code: 'FORM_VISIT_INVALID', message: visitError, requestId: request.id })
    const definition = activeDefinition(form)
    if (!definition)
      return reply.code(409).send({
        code: 'FORM_VERSION_UNAVAILABLE',
        message: '表单活动版本不可用',
        requestId: request.id,
      })
    const validation = validateSubmission(definition, parsed.data.values, parsed.data.status)
    if (validation.issues.length) {
      return reply.code(400).send({
        code: 'RECORD_VALIDATION_FAILED',
        message: '表单数据校验未通过',
        details: { issues: validation.issues },
        requestId: request.id,
      })
    }
    const fileError = validateFileReferences(subject, definition, validation.values, null)
    if (fileError) {
      return reply.code(400).send({
        code: 'RECORD_FILE_INVALID',
        message: fileError,
        requestId: request.id,
      })
    }
    const existing = sqlite
      .prepare(
        `SELECT id FROM data_records
         WHERE study_id = ? AND subject_id = ? AND form_id = ?
           AND ((visit_id IS NULL AND ? IS NULL) OR visit_id = ?)`,
      )
      .all(
        subject.study_id,
        subject.id,
        form.id,
        parsed.data.visitId,
        parsed.data.visitId,
      ) as Array<{ id: string }>
    if (!form.repeatable && existing.length) {
      return reply.code(409).send({
        code: 'RECORD_EXISTS',
        message: '该受试者已存在此单次表单记录',
        requestId: request.id,
      })
    }
    const repeatIndex = form.repeatable ? existing.length + 1 : 1
    const id = randomUUID()
    const now = new Date().toISOString()
    sqlite.transaction(() => {
      sqlite
        .prepare(
          `INSERT INTO data_records
           (id, study_id, site_id, subject_id, form_id, form_version_id, visit_id, repeat_index, status, row_version, created_by, updated_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        )
        .run(
          id,
          subject.study_id,
          subject.site_id,
          subject.id,
          form.id,
          form.active_version_id,
          parsed.data.visitId,
          repeatIndex,
          parsed.data.status,
          auth.user.id,
          auth.user.id,
          now,
          now,
        )
      writeValues(id, definition, validation.values)
      attachFileReferences(subject, id, definition, validation.values)
    })()
    await writeAudit({
      ...auditContext(request, auth, subject),
      objectType: 'data_record',
      objectId: id,
      action: 'data_record.created',
      after: {
        formId: form.id,
        formVersionId: form.active_version_id,
        visitId: parsed.data.visitId,
        repeatIndex,
        status: parsed.data.status,
        values: validation.values,
      },
    })
    return reply.code(201).send({ id, repeatIndex, rowVersion: 1, status: parsed.data.status })
  })

  app.get('/:recordId', async (request, reply) => {
    const authorization = await authorizeSubject(request, reply, 'data.view')
    if (!authorization) return
    const { studyId, subjectId, recordId } = request.params as {
      studyId: string
      subjectId: string
      recordId: string
    }
    const record = recordBySubject(studyId, subjectId, recordId)
    if (!record)
      return reply
        .code(404)
        .send({ code: 'RECORD_NOT_FOUND', message: '数据记录不存在', requestId: request.id })
    const definition = definitionForRecord(record)
    if (!definition)
      return reply.code(409).send({
        code: 'FORM_VERSION_UNAVAILABLE',
        message: '记录对应的表单版本不可用',
        requestId: request.id,
      })
    return { record, definition, values: readValues(record.id) }
  })

  app.put('/:recordId', async (request, reply) => {
    const authorization = await authorizeSubject(request, reply, 'data.edit')
    if (!authorization) return
    if (!(await verifyCsrf(request, reply))) return
    const { auth, subject } = authorization
    if (!(await requireStudyStatus(subject.study_id, ['active'], request, reply))) return
    if (!(await requireActiveSite(subject.study_id, subject.site_id, request, reply))) return
    const { studyId, subjectId, recordId } = request.params as {
      studyId: string
      subjectId: string
      recordId: string
    }
    const parsed = updateRecordSchema.safeParse(request.body)
    if (!parsed.success)
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: '数据记录更新请求不完整',
        details: parsed.error.flatten(),
        requestId: request.id,
      })
    const record = recordBySubject(studyId, subjectId, recordId)
    if (!record)
      return reply
        .code(404)
        .send({ code: 'RECORD_NOT_FOUND', message: '数据记录不存在', requestId: request.id })
    const definition = definitionForRecord(record)
    if (!definition)
      return reply.code(409).send({
        code: 'FORM_VERSION_UNAVAILABLE',
        message: '记录对应的表单版本不可用',
        requestId: request.id,
      })
    const previousValues = readValues(record.id)
    const inputValues = { ...parsed.data.values }
    for (const field of definition.fields) {
      if (!field.hidden && field.visibility === undefined) continue
      const previousValue = previousValues[field.key]
      if (!(field.key in inputValues) && previousValue !== undefined)
        inputValues[field.key] = previousValue
    }
    const validation = validateSubmission(definition, inputValues, parsed.data.status)
    if (validation.issues.length) {
      return reply.code(400).send({
        code: 'RECORD_VALIDATION_FAILED',
        message: '表单数据校验未通过',
        details: { issues: validation.issues },
        requestId: request.id,
      })
    }
    const fileError = validateFileReferences(subject, definition, validation.values, record.id)
    if (fileError) {
      return reply.code(400).send({
        code: 'RECORD_FILE_INVALID',
        message: fileError,
        requestId: request.id,
      })
    }
    const now = new Date().toISOString()
    const changed = sqlite.transaction(() => {
      const result = sqlite
        .prepare(
          `UPDATE data_records
           SET status = ?, row_version = row_version + 1, updated_by = ?, updated_at = ?
           WHERE study_id = ? AND subject_id = ? AND id = ? AND row_version = ?`,
        )
        .run(
          parsed.data.status,
          auth.user.id,
          now,
          studyId,
          subjectId,
          recordId,
          parsed.data.rowVersion,
        )
      if (result.changes === 1) {
        writeValues(recordId, definition, validation.values)
        attachFileReferences(subject, recordId, definition, validation.values)
      }
      return result.changes
    })()
    if (!changed) {
      return reply.code(409).send({
        code: 'ROW_VERSION_CONFLICT',
        message: '该记录已被其他用户修改，请刷新后重试',
        requestId: request.id,
      })
    }
    await writeAudit({
      ...auditContext(request, auth, subject),
      objectType: 'data_record',
      objectId: recordId,
      action: 'data_record.updated',
      before: { status: record.status, rowVersion: record.row_version, values: previousValues },
      after: {
        status: parsed.data.status,
        rowVersion: record.row_version + 1,
        values: validation.values,
      },
    })
    return { id: recordId, rowVersion: record.row_version + 1, status: parsed.data.status }
  })

  app.delete('/:recordId', async (request, reply) => {
    const authorization = await authorizeSubject(request, reply, 'data.delete')
    if (!authorization) return
    if (!(await verifyCsrf(request, reply))) return
    const { auth, subject } = authorization
    if (!(await requireStudyStatus(subject.study_id, ['active'], request, reply))) return
    if (!(await requireActiveSite(subject.study_id, subject.site_id, request, reply))) return
    const { studyId, subjectId, recordId } = request.params as {
      studyId: string
      subjectId: string
      recordId: string
    }
    const record = recordBySubject(studyId, subjectId, recordId)
    if (!record)
      return reply
        .code(404)
        .send({ code: 'RECORD_NOT_FOUND', message: '数据记录不存在', requestId: request.id })
    const values = readValues(record.id)
    let quarantinedFiles: ReturnType<typeof quarantineFilesForRecord> = []
    try {
      quarantinedFiles = quarantineFilesForRecord(recordId)
      sqlite.transaction(() => {
        sqlite.prepare('DELETE FROM uploaded_files WHERE record_id = ?').run(recordId)
        sqlite
          .prepare('DELETE FROM data_records WHERE study_id = ? AND subject_id = ? AND id = ?')
          .run(studyId, subjectId, recordId)
      })()
    } catch (error) {
      restoreQuarantinedFiles(quarantinedFiles)
      request.log.error(error)
      return reply.code(500).send({
        code: 'RECORD_DELETE_FAILED',
        message: '数据记录及关联文件删除失败，原始数据已保留',
        requestId: request.id,
      })
    }
    await writeAudit({
      ...auditContext(request, auth, subject),
      objectType: 'data_record',
      objectId: recordId,
      action: 'data_record.deleted',
      before: {
        ...record,
        values,
        files: quarantinedFiles.map(({ row }) => ({
          id: row.id,
          fieldKey: row.field_key,
          originalName: row.original_name,
          sizeBytes: row.size_bytes,
          sha256: row.sha256,
        })),
      },
    })
    purgeQuarantinedFiles(quarantinedFiles)
    return reply.code(204).send()
  })
}
