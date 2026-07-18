import { createHash, randomUUID } from 'node:crypto'
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import {
  createFormSchema,
  formDefinitionSchema,
  saveFormDraftSchema,
  type FormDefinition,
} from '@edc/contracts'
import { analyzeFormCompatibility, validateFormDefinition } from '@edc/domain'
import ExcelJS from 'exceljs'
import { z } from 'zod'
import { verifyCsrf } from '../../auth/auth.js'
import {
  requireStudyPermission,
  requireStudyStatus,
  resolveMembershipPermissions,
} from '../../auth/permissions.js'
import { writeAudit } from '../../audit/audit.js'
import { sqlite } from '../../db/database.js'

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

interface VersionRow {
  id: string
  form_id: string
  version_number: number
  status: 'draft' | 'migrating' | 'published' | 'failed'
  schema_json: string
  schema_checksum: string
}

const copyFormSchema = z.object({ name: z.string().trim().min(1).max(200) })
const createFormMutationSchema = createFormSchema.omit({ code: true }).extend({
  code: z.string().trim().min(1).max(80).optional(),
})
const saveFormDraftMutationSchema = saveFormDraftSchema.omit({ code: true }).extend({
  code: z.string().trim().min(1).max(80).optional(),
})
const importPreviewSchema = z.object({
  source: z.unknown(),
  overrides: z
    .object({
      code: z.string().trim().min(1).max(80).optional(),
      name: z.string().trim().min(1).max(200).optional(),
    })
    .optional(),
})

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function resolveImportedVisitIds(studyId: string, form: Record<string, unknown>) {
  if (Array.isArray(form.visitCodes)) {
    const codes = [
      ...new Set(form.visitCodes.filter((value): value is string => typeof value === 'string')),
    ]
    if (!codes.length) return { visitIds: [], missingVisitCodes: [] }
    const rows = sqlite
      .prepare(
        `SELECT id, code FROM visit_definitions
         WHERE study_id = ? AND code IN (${codes.map(() => '?').join(',')})`,
      )
      .all(studyId, ...codes) as Array<{ id: string; code: string }>
    const byCode = new Map(rows.map((row) => [row.code, row.id]))
    return {
      visitIds: codes.flatMap((code) => (byCode.has(code) ? [byCode.get(code)!] : [])),
      missingVisitCodes: codes.filter((code) => !byCode.has(code)),
    }
  }
  return {
    visitIds: Array.isArray(form.visitIds) ? form.visitIds : [],
    missingVisitCodes: [] as string[],
  }
}

interface MigrationJobRow {
  id: string
  study_id: string
  form_id: string
  to_version_id: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  created_by: string
  request_id: string | null
  ip_address: string | null
  user_agent: string | null
  total_records: number
}

const scheduledMigrationJobs = new Map<string, Promise<unknown>>()

function yieldToEventLoop() {
  return new Promise<void>((resolve) => setImmediate(resolve))
}

export async function processFormMigrationJob(studyId: string, jobId: string) {
  const job = sqlite
    .prepare('SELECT * FROM form_migration_jobs WHERE study_id = ? AND id = ?')
    .get(studyId, jobId) as MigrationJobRow | undefined
  if (!job || job.status === 'completed') return job
  const now = new Date().toISOString()
  sqlite
    .prepare(
      `UPDATE form_migration_jobs
       SET status = 'running', error_message = NULL, updated_at = ?
       WHERE study_id = ? AND id = ?`,
    )
    .run(now, studyId, jobId)
  const items = sqlite
    .prepare(
      `SELECT i.id, i.record_id, i.from_version_id, i.to_version_id,
              r.site_id, site.name AS site_name, r.subject_id
       FROM form_migration_items i
       JOIN data_records r ON r.study_id = ? AND r.id = i.record_id
       JOIN sites site ON site.id = r.site_id
       WHERE i.job_id = ? AND i.status = 'pending'
       ORDER BY i.id`,
    )
    .all(job.study_id, jobId) as Array<{
    id: string
    record_id: string
    from_version_id: string
    to_version_id: string
    site_id: string
    site_name: string
    subject_id: string
  }>
  try {
    for (const [index, item] of items.entries()) {
      const itemNow = new Date().toISOString()
      sqlite.transaction(() => {
        const updated = sqlite
          .prepare(
            `UPDATE data_records
             SET form_version_id = ?, row_version = row_version + 1,
                 updated_by = ?, updated_at = ?
             WHERE study_id = ? AND id = ? AND form_version_id = ?`,
          )
          .run(
            item.to_version_id,
            job.created_by,
            itemNow,
            job.study_id,
            item.record_id,
            item.from_version_id,
          )
        if (updated.changes !== 1) throw new Error('记录版本已变化，无法自动迁移')
        sqlite
          .prepare(
            `UPDATE form_migration_items
             SET status = 'completed', error_message = NULL, updated_at = ?
             WHERE id = ? AND job_id = ?`,
          )
          .run(itemNow, item.id, jobId)
        sqlite
          .prepare(
            `UPDATE form_migration_jobs
             SET processed_records = processed_records + 1, updated_at = ?
             WHERE study_id = ? AND id = ?`,
          )
          .run(itemNow, job.study_id, jobId)
        sqlite
          .prepare(
            `INSERT INTO audit_events
             (id, request_id, actor_user_id, study_id, site_id, site_name_snapshot, subject_id,
              object_type, object_id, action, before_json, after_json, reason,
              ip_address, user_agent, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'data_record', ?, 'form.record_migrated',
                     ?, ?, NULL, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            job.request_id ?? `migration-recovery:${jobId}`,
            job.created_by,
            job.study_id,
            item.site_id,
            item.site_name,
            item.subject_id,
            item.record_id,
            JSON.stringify({ formVersionId: item.from_version_id }),
            JSON.stringify({ formVersionId: item.to_version_id, migrationJobId: jobId }),
            job.ip_address,
            job.user_agent,
            itemNow,
          )
      })()
      if ((index + 1) % 100 === 0) await yieldToEventLoop()
    }
    const completedAt = new Date().toISOString()
    sqlite.transaction(() => {
      const remaining = (
        sqlite
          .prepare(
            `SELECT COUNT(*) AS value FROM form_migration_items
             WHERE job_id = ? AND status != 'completed'`,
          )
          .get(jobId) as { value: number }
      ).value
      if (remaining) throw new Error('仍有迁移项目未完成')
      sqlite
        .prepare(
          `UPDATE form_versions
           SET status = 'published', published_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(completedAt, completedAt, job.to_version_id)
      sqlite
        .prepare(
          `UPDATE forms
           SET active_version_id = ?, status = 'published', updated_at = ?
           WHERE study_id = ? AND id = ?`,
        )
        .run(job.to_version_id, completedAt, job.study_id, job.form_id)
      sqlite
        .prepare(
          `UPDATE form_migration_jobs
           SET status = 'completed', processed_records = total_records,
               completed_at = ?, updated_at = ? WHERE study_id = ? AND id = ?`,
        )
        .run(completedAt, completedAt, job.study_id, jobId)
      sqlite
        .prepare(
          `INSERT INTO audit_events
           (id, request_id, actor_user_id, study_id, site_id, site_name_snapshot, subject_id,
            object_type, object_id, action, before_json, after_json, reason,
            ip_address, user_agent, created_at)
           VALUES (?, ?, ?, ?, NULL, NULL, NULL, 'form_version', ?, 'form.published',
                   NULL, ?, NULL, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          job.request_id ?? `migration-recovery:${jobId}`,
          job.created_by,
          job.study_id,
          job.to_version_id,
          JSON.stringify({ migrationJobId: jobId, migratedRecords: job.total_records }),
          job.ip_address,
          job.user_agent,
          completedAt,
        )
    })()
  } catch (error) {
    const message = error instanceof Error ? error.message : '迁移失败'
    sqlite.transaction(() => {
      sqlite
        .prepare(
          `UPDATE form_migration_jobs
           SET status = 'failed', error_message = ?, updated_at = ?
           WHERE study_id = ? AND id = ?`,
        )
        .run(message.slice(0, 1000), new Date().toISOString(), job.study_id, jobId)
      sqlite
        .prepare("UPDATE form_versions SET status = 'failed', updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), job.to_version_id)
      sqlite
        .prepare(
          `INSERT INTO audit_events
           (id, request_id, actor_user_id, study_id, site_id, site_name_snapshot, subject_id,
            object_type, object_id, action, before_json, after_json, reason,
            ip_address, user_agent, created_at)
           VALUES (?, ?, ?, ?, NULL, NULL, NULL, 'form_migration_job', ?, 'form.migration_failed',
                   NULL, ?, NULL, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          job.request_id ?? `migration-recovery:${jobId}`,
          job.created_by,
          job.study_id,
          jobId,
          JSON.stringify({ error: message }),
          job.ip_address,
          job.user_agent,
          new Date().toISOString(),
        )
    })()
    throw error
  }
  return sqlite
    .prepare('SELECT * FROM form_migration_jobs WHERE study_id = ? AND id = ?')
    .get(studyId, jobId)
}

export function scheduleFormMigrationJob(studyId: string, jobId: string) {
  const existing = scheduledMigrationJobs.get(jobId)
  if (existing) return existing
  const task = yieldToEventLoop()
    .then(() => processFormMigrationJob(studyId, jobId))
    .finally(() => scheduledMigrationJobs.delete(jobId))
  scheduledMigrationJobs.set(jobId, task)
  void task.catch(() => undefined)
  return task
}

export async function waitForFormMigrationJobs() {
  while (scheduledMigrationJobs.size) {
    await Promise.allSettled([...scheduledMigrationJobs.values()])
  }
}

export function recoverFormMigrationJobs() {
  const jobs = sqlite
    .prepare("SELECT study_id, id FROM form_migration_jobs WHERE status IN ('pending', 'running')")
    .all() as Array<{ study_id: string; id: string }>
  for (const job of jobs) scheduleFormMigrationJob(job.study_id, job.id)
}

function normalizeImportedForm(
  studyId: string,
  source: unknown,
  overrides?: { code?: string | undefined; name?: string | undefined },
) {
  const root = objectValue(source)
  if (!root) return { error: 'JSON 根节点必须是对象' } as const
  const form = objectValue(root.form) ?? root
  const draftVersion = objectValue(root.draftVersion)
  const activeVersion = objectValue(root.activeVersion)
  const definition =
    root.definition ?? draftVersion?.definition ?? activeVersion?.definition ?? form.definition
  const { visitIds, missingVisitCodes } = resolveImportedVisitIds(studyId, form)
  const candidate = {
    code: overrides?.code ?? form.code ?? randomUUID(),
    name: overrides?.name ?? form.name,
    formType: form.formType ?? form.form_type,
    repeatable: Boolean(form.repeatable),
    bindVisits: Boolean(form.bindVisits ?? form.bind_visits),
    visitIds,
    definition,
  }
  const parsed = createFormSchema.safeParse(candidate)
  if (!parsed.success) {
    return { error: '导入文件中的表单结构不合法', details: parsed.error.flatten() } as const
  }
  return { data: parsed.data, missingVisitCodes } as const
}

function buildImportPreview(
  studyId: string,
  source: unknown,
  overrides?: { code?: string | undefined; name?: string | undefined },
) {
  const normalized = normalizeImportedForm(studyId, source, overrides)
  if ('error' in normalized) return normalized
  const issues = validateFormDefinition(normalized.data.definition)
  const visitError = validateVisitConfiguration(
    studyId,
    normalized.data.bindVisits,
    normalized.data.visitIds,
  )
  if (visitError) {
    issues.push({ code: 'FORM_VISIT_INVALID', message: visitError, severity: 'error' })
  }
  if (normalized.missingVisitCodes.length) {
    issues.push({
      code: 'FORM_VISIT_CODE_MISSING',
      message: `当前研究缺少访视：${normalized.missingVisitCodes.join('、')}`,
      severity: 'error',
    })
  }
  return {
    canImport: !issues.some((issue) => issue.severity === 'error'),
    normalized: normalized.data,
    summary: {
      fieldCount: normalized.data.definition.fields.length,
      sectionCount: normalized.data.definition.sections.length,
      visitCount: normalized.data.visitIds.length,
    },
    issues,
  } as const
}

function checksum(definition: unknown) {
  return createHash('sha256').update(JSON.stringify(definition)).digest('hex')
}

function parseDefinition(value: string) {
  return formDefinitionSchema.parse(JSON.parse(value))
}

function excelCellText(worksheet: ExcelJS.Worksheet, row: number, column: number) {
  return worksheet.getCell(row, column).text.trim()
}

function excelBoolean(value: string, fallback = false) {
  if (!value) return fallback
  return ['true', '1', 'yes', '是'].includes(value.trim().toLocaleLowerCase())
}

function parseExcelJson(value: string, fallback: unknown, label: string) {
  if (!value) return fallback
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new Error(`${label}不是有效的 JSON`)
  }
}

async function readFormWorkbook(buffer: Buffer) {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0])
  const metadataSheet = workbook.getWorksheet('表单')
  const fieldSheet = workbook.getWorksheet('字段')
  const sectionSheet = workbook.getWorksheet('分区')
  if (!metadataSheet || !fieldSheet || !sectionSheet)
    throw new Error('工作簿必须包含“表单”“字段”和“分区”工作表')

  const metadata = new Map<string, string>()
  for (let row = 2; row <= metadataSheet.rowCount; row += 1) {
    const key = excelCellText(metadataSheet, row, 1)
    if (key) metadata.set(key, excelCellText(metadataSheet, row, 2))
  }
  if (metadata.get('format') !== 'clinical-trial-edc-form')
    throw new Error('不是受支持的 EDC 表单工作簿')

  const fieldHeaders = new Map<string, number>()
  fieldSheet.getRow(1).eachCell((cell, column) => fieldHeaders.set(cell.text.trim(), column))
  const fieldText = (row: number, header: string) => {
    const column = fieldHeaders.get(header)
    return column ? excelCellText(fieldSheet, row, column) : ''
  }
  const fields: Array<Record<string, unknown>> = []
  for (let row = 2; row <= fieldSheet.rowCount; row += 1) {
    const key = fieldText(row, 'key')
    if (!key) continue
    const defaultValue = fieldText(row, 'defaultValueJSON')
    const visibility = fieldText(row, 'visibilityJSON')
    const calculation = fieldText(row, 'calculationJSON')
    fields.push({
      key,
      type: fieldText(row, 'type'),
      label: fieldText(row, 'label'),
      required: excelBoolean(fieldText(row, 'required')),
      helpText: fieldText(row, 'helpText'),
      placeholder: fieldText(row, 'placeholder'),
      unit: fieldText(row, 'unit'),
      readOnly: excelBoolean(fieldText(row, 'readOnly')),
      hidden: excelBoolean(fieldText(row, 'hidden')),
      exportable: excelBoolean(fieldText(row, 'exportable'), true),
      randomizationFactor: excelBoolean(fieldText(row, 'randomizationFactor')),
      ...(defaultValue
        ? { defaultValue: parseExcelJson(defaultValue, undefined, `字段 ${key} 的默认值`) }
        : {}),
      options: parseExcelJson(fieldText(row, 'optionsJSON'), [], `字段 ${key} 的选项`),
      validation: parseExcelJson(fieldText(row, 'validationJSON'), {}, `字段 ${key} 的校验规则`),
      ...(visibility
        ? { visibility: parseExcelJson(visibility, undefined, `字段 ${key} 的显示条件`) }
        : {}),
      ...(calculation
        ? { calculation: parseExcelJson(calculation, undefined, `字段 ${key} 的计算规则`) }
        : {}),
    })
  }

  const sectionHeaders = new Map<string, number>()
  sectionSheet.getRow(1).eachCell((cell, column) => sectionHeaders.set(cell.text.trim(), column))
  const sectionText = (row: number, header: string) => {
    const column = sectionHeaders.get(header)
    return column ? excelCellText(sectionSheet, row, column) : ''
  }
  const sections: Array<Record<string, unknown>> = []
  for (let row = 2; row <= sectionSheet.rowCount; row += 1) {
    const key = sectionText(row, 'key')
    if (!key) continue
    sections.push({
      key,
      title: sectionText(row, 'title'),
      description: sectionText(row, 'description'),
      fieldKeys: parseExcelJson(sectionText(row, 'fieldKeysJSON'), [], `分区 ${key} 的字段列表`),
    })
  }

  return {
    format: metadata.get('format'),
    formatVersion: Number(metadata.get('formatVersion') ?? 1),
    form: {
      code: metadata.get('code'),
      name: metadata.get('name'),
      formType: metadata.get('formType'),
      repeatable: excelBoolean(metadata.get('repeatable') ?? ''),
      bindVisits: excelBoolean(metadata.get('bindVisits') ?? ''),
      visitCodes: parseExcelJson(metadata.get('visitCodesJSON') ?? '', [], '访视编号'),
    },
    definition: {
      schemaVersion: Number(metadata.get('schemaVersion') ?? 1),
      fields,
      sections,
      retiredFieldKeys: parseExcelJson(
        metadata.get('retiredFieldKeysJSON') ?? '',
        [],
        '停用字段列表',
      ),
    },
  }
}

async function buildFormWorkbook(
  form: FormRow,
  version: VersionRow,
  definition: FormDefinition,
  visitCodes: string[],
) {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Clinical Trial EDC'
  workbook.created = new Date()
  const metadata = workbook.addWorksheet('表单', { views: [{ state: 'frozen', ySplit: 1 }] })
  metadata.columns = [
    { header: '属性', key: 'key', width: 28 },
    { header: '值', key: 'value', width: 72 },
    { header: '说明', key: 'description', width: 44 },
  ]
  const metadataRows = [
    ['format', 'clinical-trial-edc-form', '固定格式标识，请勿修改'],
    ['formatVersion', 1, 'Excel 模板格式版本'],
    ['code', form.code, '研究内唯一表单编号'],
    ['name', form.name, '表单名称'],
    ['formType', form.form_type, '表单用途类型'],
    ['repeatable', Boolean(form.repeatable), '是否允许重复录入'],
    ['bindVisits', Boolean(form.bind_visits), '是否绑定访视'],
    ['visitCodesJSON', JSON.stringify(visitCodes), '访视编号 JSON 数组'],
    ['schemaVersion', definition.schemaVersion, '表单定义版本'],
    ['retiredFieldKeysJSON', JSON.stringify(definition.retiredFieldKeys), '停用字段 key JSON 数组'],
    ['versionNumber', version.version_number, '导出来源版本，仅供参考'],
  ] as Array<[string, string | number | boolean, string]>
  for (const row of metadataRows) metadata.addRow(row)

  const fields = workbook.addWorksheet('字段', { views: [{ state: 'frozen', ySplit: 1 }] })
  const fieldHeaders = [
    'key',
    'type',
    'label',
    'required',
    'helpText',
    'placeholder',
    'unit',
    'readOnly',
    'hidden',
    'exportable',
    'randomizationFactor',
    'defaultValueJSON',
    'optionsJSON',
    'validationJSON',
    'visibilityJSON',
    'calculationJSON',
  ]
  fields.columns = fieldHeaders.map((header) => ({
    header,
    key: header,
    width: [
      'helpText',
      'optionsJSON',
      'validationJSON',
      'visibilityJSON',
      'calculationJSON',
    ].includes(header)
      ? 36
      : 18,
  }))
  for (const field of definition.fields) {
    fields.addRow({
      key: field.key,
      type: field.type,
      label: field.label,
      required: Boolean(field.required),
      helpText: field.helpText ?? '',
      placeholder: field.placeholder ?? '',
      unit: field.unit ?? '',
      readOnly: Boolean(field.readOnly),
      hidden: Boolean(field.hidden),
      exportable: field.exportable !== false,
      randomizationFactor: Boolean(field.randomizationFactor),
      defaultValueJSON: field.defaultValue === undefined ? '' : JSON.stringify(field.defaultValue),
      optionsJSON: JSON.stringify(field.options ?? []),
      validationJSON: JSON.stringify(field.validation ?? {}),
      visibilityJSON: field.visibility ? JSON.stringify(field.visibility) : '',
      calculationJSON: field.calculation ? JSON.stringify(field.calculation) : '',
    })
  }

  const sections = workbook.addWorksheet('分区', { views: [{ state: 'frozen', ySplit: 1 }] })
  sections.columns = [
    { header: 'key', key: 'key', width: 20 },
    { header: 'title', key: 'title', width: 28 },
    { header: 'description', key: 'description', width: 40 },
    { header: 'fieldKeysJSON', key: 'fieldKeysJSON', width: 52 },
  ]
  for (const section of definition.sections) {
    sections.addRow({
      key: section.key,
      title: section.title,
      description: section.description ?? '',
      fieldKeysJSON: JSON.stringify(section.fieldKeys),
    })
  }

  for (const worksheet of [metadata, fields, sections]) {
    const header = worksheet.getRow(1)
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F6CBD' } }
    header.alignment = { vertical: 'middle' }
    worksheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: worksheet.columnCount },
    }
  }
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

function formByStudy(studyId: string, formId: string) {
  return sqlite
    .prepare('SELECT * FROM forms WHERE study_id = ? AND id = ?')
    .get(studyId, formId) as FormRow | undefined
}

function versionById(versionId: string | null) {
  if (!versionId) return undefined
  return sqlite.prepare('SELECT * FROM form_versions WHERE id = ?').get(versionId) as
    VersionRow | undefined
}

function latestDraft(formId: string) {
  return sqlite
    .prepare(
      `SELECT * FROM form_versions
       WHERE form_id = ? AND status IN ('draft', 'failed')
       ORDER BY version_number DESC LIMIT 1`,
    )
    .get(formId) as VersionRow | undefined
}

function randomizationFactorKeys(studyId: string) {
  const row = sqlite
    .prepare(
      `SELECT config_json FROM randomization_schemes
       WHERE study_id = ? AND status IN ('draft', 'active', 'frozen')
       LIMIT 1`,
    )
    .get(studyId) as { config_json: string } | undefined
  if (!row) return new Set<string>()
  try {
    const config = JSON.parse(row.config_json) as { factorKeys?: unknown }
    return new Set(
      Array.isArray(config.factorKeys)
        ? config.factorKeys.filter(
            (key): key is string => typeof key === 'string' && key !== 'site',
          )
        : [],
    )
  } catch {
    return new Set<string>()
  }
}

function screeningDesignerLocked(studyId: string) {
  return Boolean(
    sqlite
      .prepare(
        `SELECT 1 FROM randomization_schemes
         WHERE study_id = ? AND status IN ('active', 'frozen') LIMIT 1`,
      )
      .get(studyId),
  )
}

function nextVersionNumber(formId: string) {
  const row = sqlite
    .prepare(
      'SELECT COALESCE(MAX(version_number), 0) AS value FROM form_versions WHERE form_id = ?',
    )
    .get(formId) as { value: number }
  return row.value + 1
}

function normalizeRetiredKeys(
  previous: FormDefinition | null,
  next: FormDefinition,
): FormDefinition {
  if (!previous) return next
  const currentKeys = new Set(next.fields.map((field) => field.key))
  const removed = previous.fields.map((field) => field.key).filter((key) => !currentKeys.has(key))
  return {
    ...next,
    retiredFieldKeys: [
      ...new Set([...previous.retiredFieldKeys, ...next.retiredFieldKeys, ...removed]),
    ],
  }
}

function validateVisitConfiguration(studyId: string, bindVisits: boolean, visitIds: string[]) {
  if (!bindVisits && visitIds.length) return '未启用访视绑定时不能选择访视'
  if (bindVisits && !visitIds.length) return '启用访视绑定后至少需要选择一个访视'
  if (!visitIds.length) return null
  const rows = sqlite
    .prepare(
      `SELECT id FROM visit_definitions
       WHERE study_id = ? AND id IN (${visitIds.map(() => '?').join(',')})`,
    )
    .all(studyId, ...visitIds) as Array<{ id: string }>
  return rows.length === new Set(visitIds).size ? null : '包含不属于当前研究的访视'
}

function replaceVisitBindings(formId: string, visitIds: string[]) {
  sqlite.prepare('DELETE FROM form_visit_bindings WHERE form_id = ?').run(formId)
  const insert = sqlite.prepare('INSERT INTO form_visit_bindings (form_id, visit_id) VALUES (?, ?)')
  for (const visitId of visitIds) insert.run(formId, visitId)
}

function visitIdsForForm(formId: string) {
  return (
    sqlite
      .prepare('SELECT visit_id FROM form_visit_bindings WHERE form_id = ? ORDER BY visit_id')
      .all(formId) as Array<{ visit_id: string }>
  ).map((row) => row.visit_id)
}

function requestAuditContext(request: FastifyRequest) {
  return { ipAddress: request.ip, userAgent: request.headers['user-agent'] }
}

export const formRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (request, reply) => {
    const studyId = (request.params as { studyId: string }).studyId
    const auth = await requireStudyPermission(request, reply, studyId, 'form.view')
    if (!auth) return
    const items = sqlite
      .prepare(
        `SELECT f.*,
                active.version_number AS active_version_number,
                active.status AS active_version_status,
                draft.id AS draft_version_id,
                draft.version_number AS draft_version_number,
                draft.status AS draft_version_status,
                (SELECT COUNT(*) FROM data_records dr WHERE dr.study_id = f.study_id AND dr.form_id = f.id) AS record_count,
                CASE WHEN f.form_type = 'screening' AND EXISTS (
                  SELECT 1 FROM randomization_schemes rs
                  WHERE rs.study_id = f.study_id AND rs.status IN ('active', 'frozen')
                ) THEN 1 ELSE 0 END AS designer_locked
         FROM forms f
         LEFT JOIN form_versions active ON active.id = f.active_version_id
         LEFT JOIN form_versions draft ON draft.id = (
           SELECT fv.id FROM form_versions fv
           WHERE fv.form_id = f.id AND fv.status IN ('draft', 'failed')
           ORDER BY fv.version_number DESC LIMIT 1
         )
         WHERE f.study_id = ?
         ORDER BY f.updated_at DESC`,
      )
      .all(studyId)
    return { items }
  })

  app.post('/import/preview', async (request, reply) => {
    const studyId = (request.params as { studyId: string }).studyId
    const auth = await requireStudyPermission(request, reply, studyId, 'form.import')
    if (!auth) return
    if (!(await verifyCsrf(request, reply))) return
    if (!(await requireStudyStatus(studyId, ['draft', 'active'], request, reply))) return
    const parsed = importPreviewSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: '导入预览请求不合法',
        details: parsed.error.flatten(),
        requestId: request.id,
      })
    }
    const preview = buildImportPreview(studyId, parsed.data.source, parsed.data.overrides)
    if ('error' in preview) {
      return reply.code(400).send({
        code: 'FORM_IMPORT_INVALID',
        message: preview.error,
        details: preview.details,
        requestId: request.id,
      })
    }
    return preview
  })

  app.post('/import/excel/preview', async (request, reply) => {
    const studyId = (request.params as { studyId: string }).studyId
    const auth = await requireStudyPermission(request, reply, studyId, 'form.import')
    if (!auth) return
    if (!(await verifyCsrf(request, reply))) return
    if (!(await requireStudyStatus(studyId, ['draft', 'active'], request, reply))) return
    const file = await request.file()
    if (!file)
      return reply.code(400).send({
        code: 'FORM_EXCEL_REQUIRED',
        message: '请选择 Excel 工作簿',
        requestId: request.id,
      })
    if (!file.filename.toLocaleLowerCase().endsWith('.xlsx'))
      return reply.code(400).send({
        code: 'FORM_EXCEL_TYPE_INVALID',
        message: '仅支持 .xlsx 工作簿',
        requestId: request.id,
      })
    try {
      const buffer = await file.toBuffer()
      if (buffer.length > 5 * 1024 * 1024)
        return reply.code(413).send({
          code: 'FORM_EXCEL_TOO_LARGE',
          message: '表单工作簿不能超过 5 MB',
          requestId: request.id,
        })
      const source = await readFormWorkbook(buffer)
      const preview = buildImportPreview(studyId, source)
      if ('error' in preview)
        return reply.code(400).send({
          code: 'FORM_IMPORT_INVALID',
          message: preview.error,
          details: preview.details,
          requestId: request.id,
        })
      return preview
    } catch (error) {
      return reply.code(400).send({
        code: 'FORM_EXCEL_INVALID',
        message: error instanceof Error ? error.message : 'Excel 工作簿无法解析',
        requestId: request.id,
      })
    }
  })

  app.post('/', async (request, reply) => {
    const studyId = (request.params as { studyId: string }).studyId
    const auth = await requireStudyPermission(request, reply, studyId, 'form.manage')
    if (!auth) return
    const importFormat = request.headers['x-edc-import-format']
    if (importFormat) {
      const importAuth = await requireStudyPermission(request, reply, studyId, 'form.import')
      if (!importAuth) return
    }
    if (!(await verifyCsrf(request, reply))) return
    if (!(await requireStudyStatus(studyId, ['draft', 'active'], request, reply))) return
    const parsed = createFormMutationSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: '表单定义不合法',
        details: parsed.error.flatten(),
        requestId: request.id,
      })
    }
    if (
      parsed.data.formType === 'screening' &&
      (parsed.data.repeatable || parsed.data.bindVisits || parsed.data.visitIds.length)
    ) {
      return reply.code(400).send({
        code: 'SCREENING_FORM_RESTRICTIONS',
        message: '筛选表单不允许重复录入或绑定访视时间点',
        requestId: request.id,
      })
    }
    const visitError = validateVisitConfiguration(
      studyId,
      parsed.data.bindVisits,
      parsed.data.visitIds,
    )
    if (visitError)
      return reply
        .code(400)
        .send({ code: 'FORM_VISIT_INVALID', message: visitError, requestId: request.id })
    if (parsed.data.formType === 'screening') {
      const screeningDuplicate = sqlite
        .prepare(`SELECT id FROM forms WHERE study_id = ? AND form_type = 'screening'`)
        .get(studyId)
      if (screeningDuplicate)
        return reply.code(409).send({
          code: 'SCREENING_FORM_EXISTS',
          message: '每个研究只能设计一份筛选表单',
          requestId: request.id,
        })
    }
    const definition = parsed.data.definition
    const issues = validateFormDefinition(definition)
    const id = randomUUID()
    const code = id
    const versionId = randomUUID()
    const now = new Date().toISOString()
    sqlite.transaction(() => {
      sqlite
        .prepare(
          `INSERT INTO forms
           (id, study_id, code, name, form_type, repeatable, bind_visits, status, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
        )
        .run(
          id,
          studyId,
          code,
          parsed.data.name,
          parsed.data.formType,
          Number(parsed.data.repeatable),
          Number(parsed.data.bindVisits),
          auth.user.id,
          now,
          now,
        )
      sqlite
        .prepare(
          `INSERT INTO form_versions
           (id, form_id, version_number, status, schema_json, schema_checksum, created_by, created_at, updated_at)
           VALUES (?, ?, 1, 'draft', ?, ?, ?, ?, ?)`,
        )
        .run(
          versionId,
          id,
          JSON.stringify(definition),
          checksum(definition),
          auth.user.id,
          now,
          now,
        )
      replaceVisitBindings(id, parsed.data.visitIds)
    })()
    await writeAudit({
      requestId: request.id,
      actorUserId: auth.user.id,
      studyId,
      objectType: 'form',
      objectId: id,
      action: importFormat ? 'form.imported' : 'form.created',
      after: {
        ...parsed.data,
        code,
        definition: '[FORM_SCHEMA]',
        ...(importFormat ? { importFormat } : {}),
      },
      ...requestAuditContext(request),
    })
    return reply.code(201).send({ id, draftVersionId: versionId, issues })
  })

  app.post('/:formId/export/xlsx', async (request, reply) => {
    const { studyId, formId } = request.params as { studyId: string; formId: string }
    const auth = await requireStudyPermission(request, reply, studyId, 'form.export')
    if (!auth) return
    if (!(await verifyCsrf(request, reply))) return
    if (!(await requireStudyStatus(studyId, ['draft', 'active', 'ended'], request, reply))) return
    const form = formByStudy(studyId, formId)
    if (!form)
      return reply
        .code(404)
        .send({ code: 'FORM_NOT_FOUND', message: '表单不存在', requestId: request.id })
    const version = latestDraft(form.id) ?? versionById(form.active_version_id)
    if (!version)
      return reply.code(409).send({
        code: 'FORM_VERSION_MISSING',
        message: '表单没有可导出的版本',
        requestId: request.id,
      })
    const visitCodes = (
      sqlite
        .prepare(
          `SELECT v.code
           FROM form_visit_bindings b
           JOIN visit_definitions v ON v.study_id = ? AND v.id = b.visit_id
           WHERE b.form_id = ? ORDER BY v.sort_order, v.code`,
        )
        .all(studyId, formId) as Array<{ code: string }>
    ).map((row) => row.code)
    const buffer = await buildFormWorkbook(
      form,
      version,
      parseDefinition(version.schema_json),
      visitCodes,
    )
    await writeAudit({
      requestId: request.id,
      actorUserId: auth.user.id,
      studyId,
      objectType: 'form',
      objectId: formId,
      action: 'form.exported',
      after: { format: 'xlsx', versionNumber: version.version_number },
      ...requestAuditContext(request),
    })
    reply.header(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
    reply.header(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(`${form.code}-v${version.version_number}.xlsx`)}`,
    )
    return reply.send(buffer)
  })

  app.post('/:formId/export/json', async (request, reply) => {
    const { studyId, formId } = request.params as { studyId: string; formId: string }
    const auth = await requireStudyPermission(request, reply, studyId, 'form.export')
    if (!auth) return
    if (!(await verifyCsrf(request, reply))) return
    if (!(await requireStudyStatus(studyId, ['draft', 'active', 'ended'], request, reply))) return
    const form = formByStudy(studyId, formId)
    if (!form)
      return reply
        .code(404)
        .send({ code: 'FORM_NOT_FOUND', message: '表单不存在', requestId: request.id })
    const version = latestDraft(form.id) ?? versionById(form.active_version_id)
    if (!version)
      return reply.code(409).send({
        code: 'FORM_VERSION_MISSING',
        message: '表单没有可导出的版本',
        requestId: request.id,
      })
    const visitCodes = (
      sqlite
        .prepare(
          `SELECT v.code
           FROM form_visit_bindings b
           JOIN visit_definitions v ON v.study_id = ? AND v.id = b.visit_id
           WHERE b.form_id = ? ORDER BY v.sort_order, v.code`,
        )
        .all(studyId, formId) as Array<{ code: string }>
    ).map((row) => row.code)
    const exported = {
      format: 'clinical-trial-edc-form',
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      form: {
        code: form.code,
        name: form.name,
        formType: form.form_type,
        repeatable: Boolean(form.repeatable),
        bindVisits: Boolean(form.bind_visits),
        visitCodes,
      },
      definition: parseDefinition(version.schema_json),
    }
    await writeAudit({
      requestId: request.id,
      actorUserId: auth.user.id,
      studyId,
      objectType: 'form',
      objectId: formId,
      action: 'form.exported',
      after: { format: 'json', versionNumber: version.version_number },
      ...requestAuditContext(request),
    })
    reply.header('Content-Type', 'application/json; charset=utf-8')
    reply.header(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(`${form.code}-v${version.version_number}.json`)}`,
    )
    return reply.send(exported)
  })

  app.get('/:formId', async (request, reply) => {
    const { studyId, formId } = request.params as { studyId: string; formId: string }
    const auth = await requireStudyPermission(request, reply, studyId, 'form.view')
    if (!auth) return
    const form = formByStudy(studyId, formId)
    if (!form)
      return reply
        .code(404)
        .send({ code: 'FORM_NOT_FOUND', message: '表单不存在', requestId: request.id })
    const activeVersion = versionById(form.active_version_id)
    const draftVersion = latestDraft(form.id)
    const selectedVersion = draftVersion ?? activeVersion
    return {
      form: {
        ...form,
        repeatable: Boolean(form.repeatable),
        bindVisits: Boolean(form.bind_visits),
        visitIds: visitIdsForForm(form.id),
      },
      activeVersion: activeVersion
        ? { ...activeVersion, definition: parseDefinition(activeVersion.schema_json) }
        : null,
      draftVersion: draftVersion
        ? { ...draftVersion, definition: parseDefinition(draftVersion.schema_json) }
        : null,
      definition: selectedVersion ? parseDefinition(selectedVersion.schema_json) : null,
      randomizationFactorKeys:
        form.form_type === 'screening' ? [...randomizationFactorKeys(studyId)] : [],
      designerLocked: form.form_type === 'screening' ? screeningDesignerLocked(studyId) : false,
    }
  })

  app.delete('/:formId', async (request, reply) => {
    const { studyId, formId } = request.params as { studyId: string; formId: string }
    const auth = await requireStudyPermission(request, reply, studyId, 'form.manage')
    if (!auth) return
    if (!(await verifyCsrf(request, reply))) return
    if (!(await requireStudyStatus(studyId, ['draft', 'active'], request, reply))) return
    const form = formByStudy(studyId, formId)
    if (!form)
      return reply
        .code(404)
        .send({ code: 'FORM_NOT_FOUND', message: '表单不存在', requestId: request.id })
    if (form.form_type === 'screening') {
      return reply.code(409).send({
        code: 'SCREENING_FORM_PROTECTED',
        message: '筛选表单不能删除',
        requestId: request.id,
      })
    }

    const recordCount = (
      sqlite
        .prepare('SELECT COUNT(*) AS value FROM data_records WHERE study_id = ? AND form_id = ?')
        .get(studyId, formId) as { value: number }
    ).value
    if (recordCount > 0) {
      return reply.code(409).send({
        code: 'FORM_HAS_RECORDS',
        message: `该表单已有 ${recordCount} 条数据记录，不能删除`,
        requestId: request.id,
      })
    }
    const pendingMigration = sqlite
      .prepare(
        `SELECT 1 FROM form_migration_jobs
         WHERE study_id = ? AND form_id = ? AND status IN ('pending', 'running') LIMIT 1`,
      )
      .get(studyId, formId)
    if (pendingMigration) {
      return reply.code(409).send({
        code: 'FORM_MIGRATION_IN_PROGRESS',
        message: '该表单正在迁移，完成后才能删除',
        requestId: request.id,
      })
    }

    sqlite.prepare('DELETE FROM forms WHERE study_id = ? AND id = ?').run(studyId, formId)
    await writeAudit({
      requestId: request.id,
      actorUserId: auth.user.id,
      studyId,
      objectType: 'form',
      objectId: formId,
      action: 'form.deleted',
      before: {
        code: form.code,
        name: form.name,
        formType: form.form_type,
        status: form.status,
      },
      after: null,
      ...requestAuditContext(request),
    })
    return reply.code(204).send()
  })

  app.put('/:formId/draft', async (request, reply) => {
    const { studyId, formId } = request.params as { studyId: string; formId: string }
    const auth = await requireStudyPermission(request, reply, studyId, 'form.manage')
    if (!auth) return
    if (!(await verifyCsrf(request, reply))) return
    if (!(await requireStudyStatus(studyId, ['draft', 'active'], request, reply))) return
    const form = formByStudy(studyId, formId)
    if (!form)
      return reply
        .code(404)
        .send({ code: 'FORM_NOT_FOUND', message: '表单不存在', requestId: request.id })
    if (form.form_type === 'screening' && screeningDesignerLocked(studyId)) {
      return reply.code(409).send({
        code: 'SCREENING_FORM_RANDOMIZATION_LOCKED',
        message: '随机化方案已启用，筛选表单不能再修改或发布',
        requestId: request.id,
      })
    }
    const parsed = saveFormDraftMutationSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: '表单草稿不合法',
        details: parsed.error.flatten(),
        requestId: request.id,
      })
    }
    const changingToScreening = parsed.data.formType === 'screening'
    if (form.form_type === 'screening' && !changingToScreening) {
      return reply.code(409).send({
        code: 'SCREENING_FORM_PROTECTED',
        message: '筛选表单不能修改为其他类型',
        requestId: request.id,
      })
    }
    if (
      changingToScreening &&
      (parsed.data.repeatable || parsed.data.bindVisits || parsed.data.visitIds.length)
    ) {
      return reply.code(400).send({
        code: 'SCREENING_FORM_RESTRICTIONS',
        message: '筛选表单不允许重复录入或绑定访视时间点',
        requestId: request.id,
      })
    }
    if (changingToScreening && form.form_type !== 'screening') {
      const screeningDuplicate = sqlite
        .prepare(
          `SELECT id FROM forms
           WHERE study_id = ? AND form_type = 'screening' AND id <> ?`,
        )
        .get(studyId, formId)
      if (screeningDuplicate) {
        return reply.code(409).send({
          code: 'SCREENING_FORM_EXISTS',
          message: '每个研究只能设计一份筛选表单',
          requestId: request.id,
        })
      }
    }
    const visitError = validateVisitConfiguration(
      studyId,
      parsed.data.bindVisits,
      parsed.data.visitIds,
    )
    if (visitError)
      return reply
        .code(400)
        .send({ code: 'FORM_VISIT_INVALID', message: visitError, requestId: request.id })
    const active = versionById(form.active_version_id)
    const previous = active ? parseDefinition(active.schema_json) : null
    const definition = normalizeRetiredKeys(previous, parsed.data.definition)
    const lockedFactorKeys = randomizationFactorKeys(studyId)
    if ((form.form_type === 'screening' || changingToScreening) && lockedFactorKeys.size) {
      const persistedVersion = latestDraft(formId) ?? active
      const persistedDefinition = persistedVersion
        ? parseDefinition(persistedVersion.schema_json)
        : null
      const changedFactor = [...lockedFactorKeys].find((key) => {
        const before = persistedDefinition?.fields.find((field) => field.key === key)
        const after = definition.fields.find((field) => field.key === key)
        return !before || !after || JSON.stringify(before) !== JSON.stringify(after)
      })
      if (changedFactor) {
        return reply.code(409).send({
          code: 'RANDOMIZATION_FACTOR_LOCKED',
          message: `随机化分层因素“${changedFactor}”已锁定，不能修改或删除`,
          requestId: request.id,
        })
      }
    }
    const issues = [
      ...validateFormDefinition(definition),
      ...analyzeFormCompatibility(previous, definition),
    ]
    const existingDraft = latestDraft(formId)
    const draftVersionId = existingDraft?.id ?? randomUUID()
    const versionNumber = existingDraft?.version_number ?? nextVersionNumber(formId)
    const now = new Date().toISOString()
    sqlite.transaction(() => {
      sqlite
        .prepare(
          `UPDATE forms SET code = ?, name = ?, form_type = ?, repeatable = ?, bind_visits = ?, updated_at = ?
           WHERE study_id = ? AND id = ?`,
        )
        .run(
          form.code,
          parsed.data.name,
          parsed.data.formType,
          Number(parsed.data.repeatable),
          Number(parsed.data.bindVisits),
          now,
          studyId,
          formId,
        )
      if (existingDraft) {
        sqlite
          .prepare(
            `UPDATE form_versions
             SET status = 'draft', schema_json = ?, schema_checksum = ?, updated_at = ?
             WHERE id = ? AND form_id = ?`,
          )
          .run(JSON.stringify(definition), checksum(definition), now, existingDraft.id, formId)
      } else {
        sqlite
          .prepare(
            `INSERT INTO form_versions
             (id, form_id, version_number, status, schema_json, schema_checksum, created_by, created_at, updated_at)
             VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
          )
          .run(
            draftVersionId,
            formId,
            versionNumber,
            JSON.stringify(definition),
            checksum(definition),
            auth.user.id,
            now,
            now,
          )
      }
      replaceVisitBindings(formId, parsed.data.visitIds)
    })()
    await writeAudit({
      requestId: request.id,
      actorUserId: auth.user.id,
      studyId,
      objectType: 'form_version',
      objectId: draftVersionId,
      action: 'form.draft_saved',
      before: existingDraft ? { checksum: existingDraft.schema_checksum } : null,
      after: { versionNumber, checksum: checksum(definition), issues },
      ...requestAuditContext(request),
    })
    return { formId, draftVersionId, versionNumber, definition, issues }
  })

  app.post('/:formId/publish', async (request, reply) => {
    const { studyId, formId } = request.params as { studyId: string; formId: string }
    const auth = await requireStudyPermission(request, reply, studyId, 'form.publish')
    if (!auth) return
    if (!(await verifyCsrf(request, reply))) return
    if (!(await requireStudyStatus(studyId, ['draft', 'active'], request, reply))) return
    const form = formByStudy(studyId, formId)
    if (!form)
      return reply
        .code(404)
        .send({ code: 'FORM_NOT_FOUND', message: '表单不存在', requestId: request.id })
    if (form.form_type === 'screening' && screeningDesignerLocked(studyId)) {
      return reply.code(409).send({
        code: 'SCREENING_FORM_RANDOMIZATION_LOCKED',
        message: '随机化方案已启用，筛选表单不能再修改或发布',
        requestId: request.id,
      })
    }
    const draft = latestDraft(formId)
    if (!draft) {
      return reply.code(404).send({
        code: 'FORM_DRAFT_NOT_FOUND',
        message: '没有可发布的表单草稿',
        requestId: request.id,
      })
    }
    const definition = parseDefinition(draft.schema_json)
    const active = versionById(form.active_version_id)
    const previous = active ? parseDefinition(active.schema_json) : null
    const issues = [
      ...validateFormDefinition(definition),
      ...analyzeFormCompatibility(previous, definition),
    ]
    const visitError = validateVisitConfiguration(
      studyId,
      Boolean(form.bind_visits),
      visitIdsForForm(formId),
    )
    if (visitError) {
      issues.push({ code: 'FORM_VISIT_INVALID', message: visitError, severity: 'error' })
    }
    const errors = issues.filter((issue) => issue.severity === 'error')
    if (errors.length) {
      return reply.code(400).send({
        code: 'FORM_PUBLISH_BLOCKED',
        message: '表单发布校验未通过',
        details: { issues },
        requestId: request.id,
      })
    }

    const records = sqlite
      .prepare('SELECT id, form_version_id FROM data_records WHERE study_id = ? AND form_id = ?')
      .all(studyId, formId) as Array<{ id: string; form_version_id: string }>
    const jobId = randomUUID()
    const now = new Date().toISOString()
    sqlite.transaction(() => {
      sqlite
        .prepare(
          `INSERT INTO form_migration_jobs
           (id, study_id, form_id, from_version_id, to_version_id, status,
            total_records, processed_records, created_by, created_at, updated_at,
            request_id, ip_address, user_agent)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, 0, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          jobId,
          studyId,
          formId,
          active?.id ?? null,
          draft.id,
          records.length,
          auth.user.id,
          now,
          now,
          request.id,
          request.ip,
          request.headers['user-agent'] ?? null,
        )
      sqlite
        .prepare("UPDATE form_versions SET status = 'migrating', updated_at = ? WHERE id = ?")
        .run(now, draft.id)
      const insertItem = sqlite.prepare(
        `INSERT INTO form_migration_items
         (id, job_id, record_id, from_version_id, to_version_id, status, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      )
      for (const record of records) {
        insertItem.run(randomUUID(), jobId, record.id, record.form_version_id, draft.id, now)
      }
    })()
    try {
      scheduleFormMigrationJob(studyId, jobId)
    } catch (error) {
      request.log.error(error)
      return reply.code(500).send({
        code: 'FORM_MIGRATION_FAILED',
        message: '表单版本迁移失败，可在修复后重试迁移任务',
        requestId: request.id,
      })
    }
    await writeAudit({
      requestId: request.id,
      actorUserId: auth.user.id,
      studyId,
      objectType: 'form_version',
      objectId: draft.id,
      action: 'form.migration_queued',
      after: {
        versionNumber: draft.version_number,
        checksum: checksum(definition),
        migrationJobId: jobId,
        migratedRecords: records.length,
        warnings: issues.filter((issue) => issue.severity === 'warning'),
      },
      ...requestAuditContext(request),
    })
    return {
      formId,
      versionId: draft.id,
      versionNumber: draft.version_number,
      migrationJobId: jobId,
      migrationStatus: 'pending',
      migratedRecords: records.length,
      warnings: issues.filter((issue) => issue.severity === 'warning'),
    }
  })

  app.get('/:formId/migrations', async (request, reply) => {
    const { studyId, formId } = request.params as { studyId: string; formId: string }
    const auth = await requireStudyPermission(request, reply, studyId, 'form.view')
    if (!auth) return
    if (!formByStudy(studyId, formId))
      return reply
        .code(404)
        .send({ code: 'FORM_NOT_FOUND', message: '表单不存在', requestId: request.id })
    const items = sqlite
      .prepare(
        `SELECT j.id, j.from_version_id, j.to_version_id, j.status, j.total_records,
                j.processed_records, j.error_message, j.created_at, j.updated_at,
                j.completed_at, source.version_number AS from_version_number,
                target.version_number AS to_version_number
         FROM form_migration_jobs j
         LEFT JOIN form_versions source ON source.id = j.from_version_id
         JOIN form_versions target ON target.id = j.to_version_id
         WHERE j.study_id = ? AND j.form_id = ? ORDER BY j.created_at DESC`,
      )
      .all(studyId, formId)
    const permissions =
      auth.membershipId && auth.roleCode
        ? await resolveMembershipPermissions(auth.membershipId, auth.roleCode)
        : null
    const canRetry = auth.user.isSystemAdmin || Boolean(permissions?.has('form.publish'))
    return { items, canRetry }
  })

  app.post('/:formId/migrations/:jobId/retry', async (request, reply) => {
    const { studyId, formId, jobId } = request.params as {
      studyId: string
      formId: string
      jobId: string
    }
    const auth = await requireStudyPermission(request, reply, studyId, 'form.publish')
    if (!auth) return
    if (!(await verifyCsrf(request, reply))) return
    if (!(await requireStudyStatus(studyId, ['draft', 'active'], request, reply))) return
    const job = sqlite
      .prepare(
        `SELECT id, to_version_id, status FROM form_migration_jobs
         WHERE study_id = ? AND form_id = ? AND id = ?`,
      )
      .get(studyId, formId, jobId) as
      { id: string; to_version_id: string; status: string } | undefined
    if (!job)
      return reply.code(404).send({
        code: 'MIGRATION_JOB_NOT_FOUND',
        message: '迁移任务不存在',
        requestId: request.id,
      })
    if (job.status === 'completed') return { id: job.id, status: 'completed' }
    const now = new Date().toISOString()
    sqlite.transaction(() => {
      sqlite
        .prepare(
          `UPDATE form_migration_items
           SET status = 'pending', error_message = NULL, updated_at = ?
           WHERE job_id = ? AND status = 'failed'`,
        )
        .run(now, jobId)
      sqlite
        .prepare(
          `UPDATE form_migration_jobs
           SET status = 'pending', error_message = NULL, updated_at = ?
           WHERE study_id = ? AND id = ?`,
        )
        .run(now, studyId, jobId)
      sqlite
        .prepare("UPDATE form_versions SET status = 'migrating', updated_at = ? WHERE id = ?")
        .run(now, job.to_version_id)
    })()
    try {
      scheduleFormMigrationJob(studyId, jobId)
      await writeAudit({
        requestId: request.id,
        actorUserId: auth.user.id,
        studyId,
        objectType: 'form_migration_job',
        objectId: jobId,
        action: 'form.migration_retried',
        after: { status: 'pending' },
        ...requestAuditContext(request),
      })
      return { id: jobId, status: 'pending' }
    } catch (error) {
      request.log.error(error)
      return reply.code(500).send({
        code: 'FORM_MIGRATION_FAILED',
        message: '迁移重试失败',
        requestId: request.id,
      })
    }
  })

  app.post('/:formId/copy', async (request, reply) => {
    const { studyId, formId } = request.params as { studyId: string; formId: string }
    const auth = await requireStudyPermission(request, reply, studyId, 'form.manage')
    if (!auth) return
    if (!(await verifyCsrf(request, reply))) return
    if (!(await requireStudyStatus(studyId, ['draft', 'active'], request, reply))) return
    const parsed = copyFormSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: '复制后的表单信息不完整',
        requestId: request.id,
      })
    }
    const source = formByStudy(studyId, formId)
    if (!source)
      return reply
        .code(404)
        .send({ code: 'FORM_NOT_FOUND', message: '源表单不存在', requestId: request.id })
    if (source.form_type === 'screening') {
      const screeningDuplicate = sqlite
        .prepare(`SELECT id FROM forms WHERE study_id = ? AND form_type = 'screening'`)
        .get(studyId)
      if (screeningDuplicate)
        return reply.code(409).send({
          code: 'SCREENING_FORM_EXISTS',
          message: '每个研究只能设计一份筛选表单',
          requestId: request.id,
        })
    }
    const sourceVersion = latestDraft(formId) ?? versionById(source.active_version_id)
    if (!sourceVersion) {
      return reply.code(409).send({
        code: 'FORM_VERSION_MISSING',
        message: '源表单没有可复制的版本',
        requestId: request.id,
      })
    }
    const newFormId = randomUUID()
    const newVersionId = randomUUID()
    const now = new Date().toISOString()
    sqlite.transaction(() => {
      sqlite
        .prepare(
          `INSERT INTO forms
           (id, study_id, code, name, form_type, repeatable, bind_visits, status, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
        )
        .run(
          newFormId,
          studyId,
          newFormId,
          parsed.data.name,
          source.form_type,
          source.repeatable,
          source.bind_visits,
          auth.user.id,
          now,
          now,
        )
      sqlite
        .prepare(
          `INSERT INTO form_versions
           (id, form_id, version_number, status, schema_json, schema_checksum, created_by, created_at, updated_at)
           VALUES (?, ?, 1, 'draft', ?, ?, ?, ?, ?)`,
        )
        .run(
          newVersionId,
          newFormId,
          sourceVersion.schema_json,
          sourceVersion.schema_checksum,
          auth.user.id,
          now,
          now,
        )
      replaceVisitBindings(newFormId, visitIdsForForm(formId))
    })()
    await writeAudit({
      requestId: request.id,
      actorUserId: auth.user.id,
      studyId,
      objectType: 'form',
      objectId: newFormId,
      action: 'form.copied',
      after: { sourceFormId: formId, sourceVersionId: sourceVersion.id },
      ...requestAuditContext(request),
    })
    return reply.code(201).send({ id: newFormId, draftVersionId: newVersionId })
  })
}
