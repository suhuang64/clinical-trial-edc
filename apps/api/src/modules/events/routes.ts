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
import { sqlite } from '../../db/database.js'

const eventTypes = [
  'adverse_event',
  'concomitant_medication',
  'protocol_deviation',
  'endpoint',
  'death',
  'completed',
  'withdrawn',
  'lost_to_followup',
  'note',
] as const

const createEventSchema = z
  .object({
    eventType: z.enum(eventTypes),
    occurredOn: z.string().date(),
    title: z.string().trim().min(1).max(200),
    details: z.string().trim().max(4000).optional().default(''),
    recordId: z.string().uuid().nullable().optional().default(null),
  })
  .superRefine((value, context) => {
    if (['withdrawn', 'lost_to_followup'].includes(value.eventType) && !value.details) {
      context.addIssue({
        code: 'custom',
        path: ['details'],
        message: '退出或失访必须填写原因',
      })
    }
  })

interface SubjectRow {
  id: string
  study_id: string
  site_id: string
  subject_number: string | null
  status: string
}

const statusEventMap: Partial<Record<(typeof eventTypes)[number], string>> = {
  completed: 'completed',
  withdrawn: 'withdrawn',
  lost_to_followup: 'lost_to_followup',
}

const eventFormTypeMap: Partial<Record<(typeof eventTypes)[number], string>> = {
  adverse_event: 'adverse_event',
  concomitant_medication: 'concomitant_medication',
  protocol_deviation: 'protocol_deviation',
  endpoint: 'endpoint_event',
}

interface LinkedRecordRow {
  id: string
  form_type: string
}

export const subjectEventRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (request, reply) => {
    const { studyId, subjectId } = request.params as { studyId: string; subjectId: string }
    const auth = await requireStudyPermission(request, reply, studyId, 'subject.view')
    if (!auth) return
    const subject = sqlite
      .prepare(
        'SELECT id, study_id, site_id, subject_number, status FROM subjects WHERE study_id = ? AND id = ?',
      )
      .get(studyId, subjectId) as SubjectRow | undefined
    if (!subject)
      return reply
        .code(404)
        .send({ code: 'SUBJECT_NOT_FOUND', message: '受试者不存在', requestId: request.id })
    if (!(await requireAllowedSite(auth, subject.site_id, request, reply))) return
    const items = sqlite
      .prepare(
        `SELECT e.*, u.display_name AS created_by_name,
                f.name AS linked_form_name, f.code AS linked_form_code,
                fv.version_number AS linked_version_number,
                dr.repeat_index AS linked_repeat_index
         FROM subject_events e
         JOIN users u ON u.id = e.created_by
         LEFT JOIN data_records dr
           ON dr.study_id = e.study_id AND dr.site_id = e.site_id
          AND dr.subject_id = e.subject_id AND dr.id = e.record_id
         LEFT JOIN forms f ON f.study_id = dr.study_id AND f.id = dr.form_id
         LEFT JOIN form_versions fv ON fv.id = dr.form_version_id
         WHERE e.study_id = ? AND e.site_id = ? AND e.subject_id = ?
         ORDER BY e.occurred_on DESC, e.created_at DESC`,
      )
      .all(studyId, subject.site_id, subjectId)
    return { items }
  })

  app.post('/', async (request, reply) => {
    const { studyId, subjectId } = request.params as { studyId: string; subjectId: string }
    const auth = await requireStudyPermission(request, reply, studyId, 'subject.edit')
    if (!auth) return
    if (!(await verifyCsrf(request, reply))) return
    if (!(await requireStudyStatus(studyId, ['active'], request, reply))) return
    const parsed = createEventSchema.safeParse(request.body)
    if (!parsed.success)
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: '事件信息不完整',
        details: parsed.error.flatten(),
        requestId: request.id,
      })
    const subject = sqlite
      .prepare(
        'SELECT id, study_id, site_id, subject_number, status FROM subjects WHERE study_id = ? AND id = ?',
      )
      .get(studyId, subjectId) as SubjectRow | undefined
    if (!subject)
      return reply
        .code(404)
        .send({ code: 'SUBJECT_NOT_FOUND', message: '受试者不存在', requestId: request.id })
    if (!(await requireAllowedSite(auth, subject.site_id, request, reply))) return
    if (!(await requireActiveSite(studyId, subject.site_id, request, reply))) return
    if (!subject.subject_number)
      return reply.code(409).send({
        code: 'SUBJECT_NOT_ENROLLED',
        message: '只有已入组受试者可以记录随访事件',
        requestId: request.id,
      })

    const expectedFormType = eventFormTypeMap[parsed.data.eventType]
    let linkedRecord: LinkedRecordRow | undefined
    if (parsed.data.recordId) {
      if (!expectedFormType)
        return reply.code(400).send({
          code: 'EVENT_RECORD_NOT_SUPPORTED',
          message: '该事件类型不支持关联数据记录',
          requestId: request.id,
        })
      linkedRecord = sqlite
        .prepare(
          `SELECT dr.id, f.form_type
           FROM data_records dr
           JOIN forms f ON f.study_id = dr.study_id AND f.id = dr.form_id
           WHERE dr.study_id = ? AND dr.site_id = ? AND dr.subject_id = ? AND dr.id = ?`,
        )
        .get(studyId, subject.site_id, subjectId, parsed.data.recordId) as
        LinkedRecordRow | undefined
      if (!linkedRecord)
        return reply.code(404).send({
          code: 'EVENT_RECORD_NOT_FOUND',
          message: '关联数据记录不存在或不属于当前受试者',
          requestId: request.id,
        })
      if (linkedRecord.form_type !== expectedFormType)
        return reply.code(409).send({
          code: 'EVENT_RECORD_TYPE_MISMATCH',
          message: '关联数据记录的表单用途与事件类型不匹配',
          requestId: request.id,
        })
    }

    const nextStatus = statusEventMap[parsed.data.eventType] ?? null
    if (nextStatus && subject.status !== 'enrolled')
      return reply.code(409).send({
        code: 'INVALID_SUBJECT_STATE',
        message: '只有已入组状态可以变更为完成、退出或失访',
        requestId: request.id,
      })

    const id = randomUUID()
    const now = new Date().toISOString()
    sqlite.transaction(() => {
      sqlite
        .prepare(
          `INSERT INTO subject_events
           (id, study_id, site_id, subject_id, record_id, event_type, occurred_on, title, details,
            before_status, after_status, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          studyId,
          subject.site_id,
          subjectId,
          linkedRecord?.id ?? null,
          parsed.data.eventType,
          parsed.data.occurredOn,
          parsed.data.title,
          parsed.data.details || null,
          nextStatus ? subject.status : null,
          nextStatus,
          auth.user.id,
          now,
        )
      if (nextStatus) {
        sqlite
          .prepare(
            `UPDATE subjects
             SET status = ?, row_version = row_version + 1, updated_at = ?
             WHERE study_id = ? AND site_id = ? AND id = ? AND status = 'enrolled'`,
          )
          .run(nextStatus, now, studyId, subject.site_id, subjectId)
      }
    })()
    await writeAudit({
      requestId: request.id,
      actorUserId: auth.user.id,
      studyId,
      siteId: subject.site_id,
      subjectId,
      objectType: 'subject_event',
      objectId: id,
      action: 'subject_event.created',
      before: nextStatus ? { subjectStatus: subject.status } : undefined,
      after: {
        ...parsed.data,
        recordId: linkedRecord?.id ?? null,
        subjectId,
        subjectStatus: nextStatus ?? subject.status,
      },
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    })
    return reply.code(201).send({ id, status: nextStatus ?? subject.status })
  })
}
