import { randomUUID } from 'node:crypto'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { verifyCsrf } from '../../auth/auth.js'
import {
  requireActiveSite,
  requireAllowedSite,
  requireStudyPermission,
  requireStudyStatus,
} from '../../auth/permissions.js'
import { writeAudit } from '../../audit/audit.js'
import { numberingRepository, sqlite } from '../../db/database.js'
import {
  purgeQuarantinedFiles,
  quarantineFilesForSubject,
  restoreQuarantinedFiles,
} from '../files/routes.js'

const createSubjectSchema = z.object({
  siteName: z.string().trim().min(1).max(200),
  screeningData: z.record(z.string(), z.unknown()).default({}),
})
const updateScreeningSchema = z.object({
  rowVersion: z.number().int().positive(),
  screeningData: z.record(z.string(), z.unknown()),
})
const conclusionSchema = z.discriminatedUnion('conclusion', [
  z.object({ conclusion: z.literal('eligible') }),
  z.object({ conclusion: z.literal('failed'), reason: z.string().trim().min(1).max(1000) }),
])
const deleteSubjectSchema = z.object({ reason: z.string().trim().min(3).max(1000) })

export const subjectRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (request, reply) => {
    const studyId = (request.params as { studyId: string }).studyId
    const auth = await requireStudyPermission(request, reply, studyId, 'subject.view')
    if (!auth) return
    const parsedFilters = z
      .object({
        status: z
          .enum([
            'screening',
            'screen_failed',
            'pending_enrollment',
            'enrolled',
            'completed',
            'withdrawn',
            'lost_to_followup',
          ])
          .optional(),
        siteName: z.string().trim().min(1).max(200).optional(),
        query: z.string().trim().max(100).optional(),
        page: z.coerce.number().int().positive().default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(50),
      })
      .safeParse(request.query)
    if (!parsedFilters.success)
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: '受试者查询条件不合法',
        details: parsedFilters.error.flatten(),
        requestId: request.id,
      })
    const filters = parsedFilters.data
    const clauses = ['s.study_id = ?']
    const values: unknown[] = [studyId]
    if (auth.allowedSiteNames && auth.allowedSiteNames.length === 0) return { items: [] }
    if (auth.allowedSiteNames) {
      clauses.push(`s.site_name IN (${auth.allowedSiteNames.map(() => '?').join(',')})`)
      values.push(...auth.allowedSiteNames)
    }
    if (filters.siteName) {
      if (auth.allowedSiteNames && !auth.allowedSiteNames.includes(filters.siteName))
        return reply.code(403).send({
          code: 'SITE_ACCESS_DENIED',
          message: '您无权访问该研究中心',
          requestId: request.id,
        })
      clauses.push('s.site_name = ?')
      values.push(filters.siteName)
    }
    if (filters.status) {
      clauses.push('s.status = ?')
      values.push(filters.status)
    }
    if (filters.query) {
      clauses.push(
        '(s.screening_number LIKE ? OR s.subject_number LIKE ? OR s.random_number LIKE ?)',
      )
      const pattern = `%${filters.query}%`
      values.push(pattern, pattern, pattern)
    }
    const total = (
      sqlite
        .prepare(`SELECT COUNT(*) AS value FROM subjects s WHERE ${clauses.join(' AND ')}`)
        .get(...values) as { value: number }
    ).value
    const items = sqlite
      .prepare(
        `SELECT s.*, st.name AS site_name FROM subjects s JOIN sites st ON st.study_id = s.study_id AND st.name = s.site_name WHERE ${clauses.join(' AND ')} ORDER BY s.updated_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...values, filters.pageSize, (filters.page - 1) * filters.pageSize)
    return { items, total, page: filters.page, pageSize: filters.pageSize }
  })

  app.post('/', async (request, reply) => {
    const studyId = (request.params as { studyId: string }).studyId
    const auth = await requireStudyPermission(request, reply, studyId, 'subject.create')
    if (!auth) return
    if (!(await verifyCsrf(request, reply))) return
    if (!(await requireStudyStatus(studyId, ['active'], request, reply))) return
    const parsed = createSubjectSchema.safeParse(request.body)
    if (!parsed.success)
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: '筛选信息不完整',
        details: parsed.error.flatten(),
        requestId: request.id,
      })
    if (!(await requireAllowedSite(auth, parsed.data.siteName, request, reply))) return
    if (!(await requireActiveSite(studyId, parsed.data.siteName, request, reply))) return
    const id = randomUUID(),
      now = new Date().toISOString()
    let screeningNumber = ''
    sqlite.transaction(() => {
      screeningNumber = numberingRepository.allocateNextNumber(studyId, 'screening')
      sqlite
        .prepare(
          `INSERT INTO subjects (id, study_id, site_name, screening_number, status, screening_data_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'screening', ?, ?, ?, ?)`,
        )
        .run(
          id,
          studyId,
          parsed.data.siteName,
          screeningNumber,
          JSON.stringify(parsed.data.screeningData),
          auth.user.id,
          now,
          now,
        )
    })()
    await writeAudit({
      requestId: request.id,
      actorUserId: auth.user.id,
      studyId,
      siteName: parsed.data.siteName,
      subjectId: id,
      objectType: 'subject',
      objectId: id,
      action: 'subject.screening_created',
      after: { screeningNumber, status: 'screening' },
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    })
    return reply.code(201).send({ id, screeningNumber, status: 'screening' })
  })

  app.get('/:subjectId', async (request, reply) => {
    const { studyId, subjectId } = request.params as { studyId: string; subjectId: string }
    const auth = await requireStudyPermission(request, reply, studyId, 'subject.view')
    if (!auth) return
    const subject = sqlite
      .prepare(
        `SELECT s.*, st.name AS site_name
         FROM subjects s
         JOIN sites st ON st.study_id = s.study_id AND st.name = s.site_name
         WHERE s.study_id = ? AND s.id = ?`,
      )
      .get(studyId, subjectId) as { site_name: string } | undefined
    if (!subject)
      return reply
        .code(404)
        .send({ code: 'SUBJECT_NOT_FOUND', message: '受试者不存在', requestId: request.id })
    if (!(await requireAllowedSite(auth, subject.site_name, request, reply))) return
    return { subject }
  })

  app.get('/:subjectId/timeline', async (request, reply) => {
    const { studyId, subjectId } = request.params as { studyId: string; subjectId: string }
    const auth = await requireStudyPermission(request, reply, studyId, 'subject.view')
    if (!auth) return
    const subject = sqlite
      .prepare('SELECT id, site_name FROM subjects WHERE study_id = ? AND id = ?')
      .get(studyId, subjectId) as { id: string; site_name: string } | undefined
    if (!subject)
      return reply
        .code(404)
        .send({ code: 'SUBJECT_NOT_FOUND', message: '受试者不存在', requestId: request.id })
    if (!(await requireAllowedSite(auth, subject.site_name, request, reply))) return
    const items = sqlite
      .prepare(
        `SELECT a.id, a.action, a.object_type, a.object_id,
                a.reason, a.created_at, u.display_name AS actor_name
         FROM audit_events a
         LEFT JOIN users u ON u.id = a.actor_user_id
         WHERE a.study_id = ? AND a.site_name = ? AND a.subject_id = ?
         ORDER BY a.created_at DESC`,
      )
      .all(studyId, subject.site_name, subjectId)
    return { items }
  })

  app.put('/:subjectId/screening', async (request, reply) => {
    const { studyId, subjectId } = request.params as { studyId: string; subjectId: string }
    const auth = await requireStudyPermission(request, reply, studyId, 'subject.edit')
    if (!auth) return
    if (!(await verifyCsrf(request, reply))) return
    if (!(await requireStudyStatus(studyId, ['active'], request, reply))) return
    const parsed = updateScreeningSchema.safeParse(request.body)
    if (!parsed.success)
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: '筛选资料不完整',
        details: parsed.error.flatten(),
        requestId: request.id,
      })
    const subject = sqlite
      .prepare(
        `SELECT id, site_name, status, row_version, screening_data_json
         FROM subjects WHERE study_id = ? AND id = ?`,
      )
      .get(studyId, subjectId) as
      | {
          id: string
          site_name: string
          status: string
          row_version: number
          screening_data_json: string
        }
      | undefined
    if (!subject)
      return reply
        .code(404)
        .send({ code: 'SUBJECT_NOT_FOUND', message: '受试者不存在', requestId: request.id })
    if (!(await requireAllowedSite(auth, subject.site_name, request, reply))) return
    if (!(await requireActiveSite(studyId, subject.site_name, request, reply))) return
    if (subject.status !== 'screening')
      return reply.code(409).send({
        code: 'SCREENING_DATA_LOCKED',
        message: '筛选结论提交后，筛选资料不允许继续修改',
        requestId: request.id,
      })
    if (subject.row_version !== parsed.data.rowVersion)
      return reply.code(409).send({
        code: 'ROW_VERSION_CONFLICT',
        message: '筛选资料已被其他用户修改，请重新加载后再编辑',
        requestId: request.id,
      })
    const now = new Date().toISOString()
    const updated = sqlite
      .prepare(
        `UPDATE subjects
         SET screening_data_json = ?, row_version = row_version + 1, updated_at = ?
         WHERE study_id = ? AND site_name = ? AND id = ? AND status = 'screening'
           AND row_version = ?`,
      )
      .run(
        JSON.stringify(parsed.data.screeningData),
        now,
        studyId,
        subject.site_name,
        subjectId,
        parsed.data.rowVersion,
      )
    if (updated.changes !== 1)
      return reply.code(409).send({
        code: 'ROW_VERSION_CONFLICT',
        message: '筛选资料状态已变化，请重新加载后再编辑',
        requestId: request.id,
      })
    await writeAudit({
      requestId: request.id,
      actorUserId: auth.user.id,
      studyId,
      siteName: subject.site_name,
      subjectId,
      objectType: 'subject',
      objectId: subjectId,
      action: 'subject.screening_updated',
      before: { screeningData: JSON.parse(subject.screening_data_json) },
      after: { screeningData: parsed.data.screeningData },
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    })
    return { id: subjectId, rowVersion: parsed.data.rowVersion + 1, updatedAt: now }
  })

  app.post('/:subjectId/conclusion', async (request, reply) => {
    const { studyId, subjectId } = request.params as { studyId: string; subjectId: string }
    const auth = await requireStudyPermission(request, reply, studyId, 'subject.edit')
    if (!auth) return
    if (!(await verifyCsrf(request, reply))) return
    if (!(await requireStudyStatus(studyId, ['active'], request, reply))) return
    const parsed = conclusionSchema.safeParse(request.body)
    if (!parsed.success)
      return reply
        .code(400)
        .send({ code: 'VALIDATION_ERROR', message: '请选择筛选结论', requestId: request.id })
    const subject = sqlite
      .prepare(`SELECT * FROM subjects WHERE study_id = ? AND id = ?`)
      .get(studyId, subjectId) as { id: string; site_name: string; status: string } | undefined
    if (!subject)
      return reply
        .code(404)
        .send({ code: 'SUBJECT_NOT_FOUND', message: '受试者不存在', requestId: request.id })
    if (!(await requireAllowedSite(auth, subject.site_name, request, reply))) return
    if (!(await requireActiveSite(studyId, subject.site_name, request, reply))) return
    if (subject.status !== 'screening')
      return reply.code(409).send({
        code: 'INVALID_SUBJECT_STATE',
        message: '只有筛选中的受试者可以提交筛选结论',
        requestId: request.id,
      })
    const nextStatus =
      parsed.data.conclusion === 'eligible' ? 'pending_enrollment' : 'screen_failed'
    const now = new Date().toISOString()
    sqlite
      .prepare(
        `UPDATE subjects
         SET status = ?, screening_conclusion = ?, screening_failure_reason = ?,
             row_version = row_version + 1, updated_at = ?
         WHERE study_id = ? AND site_name = ? AND id = ?`,
      )
      .run(
        nextStatus,
        parsed.data.conclusion,
        parsed.data.conclusion === 'failed' ? parsed.data.reason : null,
        now,
        studyId,
        subject.site_name,
        subjectId,
      )
    await writeAudit({
      requestId: request.id,
      actorUserId: auth.user.id,
      studyId,
      siteName: subject.site_name,
      subjectId,
      objectType: 'subject',
      objectId: subjectId,
      action: 'subject.screening_concluded',
      before: { status: subject.status },
      after: { status: nextStatus, conclusion: parsed.data.conclusion },
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    })
    return { id: subjectId, status: nextStatus }
  })

  app.post('/:subjectId/enroll', async (request, reply) => {
    const { studyId, subjectId } = request.params as { studyId: string; subjectId: string }
    const auth = await requireStudyPermission(request, reply, studyId, 'subject.enroll')
    if (!auth) return
    if (!(await verifyCsrf(request, reply))) return
    if (!(await requireStudyStatus(studyId, ['active'], request, reply))) return
    const subject = sqlite
      .prepare(`SELECT * FROM subjects WHERE study_id = ? AND id = ?`)
      .get(studyId, subjectId) as
      { id: string; site_name: string; status: string; subject_number: string | null } | undefined
    if (!subject)
      return reply
        .code(404)
        .send({ code: 'SUBJECT_NOT_FOUND', message: '受试者不存在', requestId: request.id })
    if (!(await requireAllowedSite(auth, subject.site_name, request, reply))) return
    if (subject.status === 'enrolled' && subject.subject_number)
      return { id: subjectId, subjectNumber: subject.subject_number, status: 'enrolled' }
    if (!(await requireActiveSite(studyId, subject.site_name, request, reply))) return
    if (subject.status !== 'pending_enrollment')
      return reply.code(409).send({
        code: 'INVALID_SUBJECT_STATE',
        message: '受试者尚未达到待入组状态',
        requestId: request.id,
      })
    let subjectNumber = ''
    const now = new Date().toISOString()
    sqlite.transaction(() => {
      subjectNumber = numberingRepository.allocateNextNumber(studyId, 'subject')
      sqlite
        .prepare(
          `UPDATE subjects
           SET subject_number = ?, status = 'enrolled', row_version = row_version + 1, updated_at = ?
           WHERE study_id = ? AND site_name = ? AND id = ? AND status = 'pending_enrollment'`,
        )
        .run(subjectNumber, now, studyId, subject.site_name, subjectId)
    })()
    await writeAudit({
      requestId: request.id,
      actorUserId: auth.user.id,
      studyId,
      siteName: subject.site_name,
      subjectId,
      objectType: 'subject',
      objectId: subjectId,
      action: 'subject.enrolled',
      before: { status: subject.status },
      after: { status: 'enrolled', subjectNumber },
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    })
    return { id: subjectId, subjectNumber, status: 'enrolled' }
  })

  app.delete('/:subjectId', async (request, reply) => {
    const { studyId, subjectId } = request.params as { studyId: string; subjectId: string }
    const auth = await requireStudyPermission(request, reply, studyId, 'subject.delete')
    if (!auth) return
    if (!(await verifyCsrf(request, reply))) return
    if (!(await requireStudyStatus(studyId, ['active'], request, reply))) return
    const parsed = deleteSubjectSchema.safeParse(request.body)
    if (!parsed.success)
      return reply.code(400).send({
        code: 'DELETE_REASON_REQUIRED',
        message: '物理删除受试者必须填写原因',
        details: parsed.error.flatten(),
        requestId: request.id,
      })
    const subject = sqlite
      .prepare('SELECT * FROM subjects WHERE study_id = ? AND id = ?')
      .get(studyId, subjectId) as
      | ({ id: string; site_name: string; random_number: string | null } & Record<string, unknown>)
      | undefined
    if (!subject)
      return reply
        .code(404)
        .send({ code: 'SUBJECT_NOT_FOUND', message: '受试者不存在', requestId: request.id })
    if (!(await requireAllowedSite(auth, subject.site_name, request, reply))) return
    if (!(await requireActiveSite(studyId, subject.site_name, request, reply))) return
    if (subject.random_number)
      return reply.code(409).send({
        code: 'RANDOMIZED_SUBJECT_DELETE_FORBIDDEN',
        message: '已随机化受试者不可物理删除，以保护随机化不可逆性',
        requestId: request.id,
      })
    const recordCount = (
      sqlite
        .prepare('SELECT COUNT(*) AS value FROM data_records WHERE study_id = ? AND subject_id = ?')
        .get(studyId, subjectId) as { value: number }
    ).value
    const eventCount = (
      sqlite
        .prepare(
          'SELECT COUNT(*) AS value FROM subject_events WHERE study_id = ? AND subject_id = ?',
        )
        .get(studyId, subjectId) as { value: number }
    ).value
    let quarantinedFiles: ReturnType<typeof quarantineFilesForSubject> = []
    try {
      quarantinedFiles = quarantineFilesForSubject(studyId, subject.site_name, subjectId)
      sqlite
        .prepare('DELETE FROM subjects WHERE study_id = ? AND site_name = ? AND id = ?')
        .run(studyId, subject.site_name, subjectId)
    } catch (error) {
      restoreQuarantinedFiles(quarantinedFiles)
      request.log.error(error)
      return reply.code(500).send({
        code: 'SUBJECT_DELETE_FAILED',
        message: '受试者及关联文件删除失败，原始数据已保留',
        requestId: request.id,
      })
    }
    await writeAudit({
      requestId: request.id,
      actorUserId: auth.user.id,
      studyId,
      siteName: subject.site_name,
      subjectId,
      objectType: 'subject',
      objectId: subjectId,
      action: 'subject.deleted',
      before: {
        subject,
        recordCount,
        eventCount,
        files: quarantinedFiles.map(({ row }) => ({
          id: row.id,
          fieldKey: row.field_key,
          originalName: row.original_name,
          sizeBytes: row.size_bytes,
          sha256: row.sha256,
        })),
      },
      reason: parsed.data.reason,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    })
    purgeQuarantinedFiles(quarantinedFiles)
    return reply.code(204).send()
  })
}
