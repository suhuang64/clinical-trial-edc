import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { requireStudyPermission } from '../../auth/permissions.js'
import { sqlite } from '../../db/database.js'

const auditQuerySchema = z.object({
  siteName: z.string().trim().min(1).max(200).optional(),
  actor: z.string().trim().max(100).optional(),
  action: z.string().trim().max(100).optional(),
  objectType: z.string().trim().max(100).optional(),
  subjectId: z.string().uuid().optional(),
  dateFrom: z.string().date().optional(),
  dateTo: z.string().date().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
})

interface AuditRow {
  id: string
  request_id: string
  actor_user_id: string | null
  actor_username: string | null
  actor_name: string | null
  study_id: string | null
  site_name: string | null
  subject_id: string | null
  object_type: string
  object_id: string | null
  action: string
  before_json: string | null
  after_json: string | null
  reason: string | null
  ip_address: string | null
  user_agent: string | null
  created_at: string
}

function parseSnapshot(value: string | null) {
  if (!value) return null
  try {
    return JSON.parse(value) as unknown
  } catch {
    return { raw: value }
  }
}

export const auditRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (request, reply) => {
    const studyId = (request.params as { studyId: string }).studyId
    const auth = await requireStudyPermission(request, reply, studyId, 'audit.view')
    if (!auth) return
    const parsed = auditQuerySchema.safeParse(request.query)
    if (!parsed.success)
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: '审计查询条件不合法',
        details: parsed.error.flatten(),
        requestId: request.id,
      })
    const filters = parsed.data
    if (
      filters.siteName &&
      auth.allowedSiteNames !== null &&
      !auth.allowedSiteNames.includes(filters.siteName)
    )
      return reply.code(403).send({
        code: 'SITE_ACCESS_DENIED',
        message: '您无权查看该中心的审计记录',
        requestId: request.id,
      })
    const clauses = ['a.study_id = ?']
    const values: unknown[] = [studyId]
    if (auth.allowedSiteNames !== null) {
      if (!auth.allowedSiteNames.length) return { items: [], total: 0, page: 1, pageSize: 50 }
      clauses.push(`a.site_name IN (${auth.allowedSiteNames.map(() => '?').join(',')})`)
      values.push(...auth.allowedSiteNames)
    }
    if (filters.siteName) {
      clauses.push('a.site_name = ?')
      values.push(filters.siteName)
    }
    if (filters.actor) {
      clauses.push('(u.username LIKE ? OR u.display_name LIKE ?)')
      values.push(`%${filters.actor}%`, `%${filters.actor}%`)
    }
    if (filters.action) {
      clauses.push('a.action = ?')
      values.push(filters.action)
    }
    if (filters.objectType) {
      clauses.push('a.object_type = ?')
      values.push(filters.objectType)
    }
    if (filters.subjectId) {
      clauses.push('a.subject_id = ?')
      values.push(filters.subjectId)
    }
    if (filters.dateFrom) {
      clauses.push('julianday(a.created_at) >= julianday(?)')
      values.push(`${filters.dateFrom}T00:00:00.000Z`)
    }
    if (filters.dateTo) {
      clauses.push('julianday(a.created_at) <= julianday(?)')
      values.push(`${filters.dateTo}T23:59:59.999Z`)
    }
    const where = clauses.join(' AND ')
    const total = (
      sqlite
        .prepare(
          `SELECT COUNT(*) AS value
           FROM audit_events a LEFT JOIN users u ON u.id = a.actor_user_id
           WHERE ${where}`,
        )
        .get(...values) as { value: number }
    ).value
    const rows = sqlite
      .prepare(
        `SELECT a.id, a.request_id, a.actor_user_id, a.study_id, a.subject_id,
                a.object_type, a.object_id, a.action, a.before_json, a.after_json, a.reason,
                a.ip_address, a.user_agent,
                strftime('%Y-%m-%dT%H:%M:%fZ', a.created_at) AS created_at,
                u.username AS actor_username, u.display_name AS actor_name,
                COALESCE(st.name, a.site_name) AS site_name
         FROM audit_events a
         LEFT JOIN users u ON u.id = a.actor_user_id
         LEFT JOIN sites st ON st.study_id = a.study_id AND st.name = a.site_name
         WHERE ${where}
         ORDER BY julianday(a.created_at) DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...values, filters.pageSize, (filters.page - 1) * filters.pageSize) as AuditRow[]
    return {
      items: rows.map((row) => ({
        id: row.id,
        requestId: row.request_id,
        actorUserId: row.actor_user_id,
        actorUsername: row.actor_username,
        actorName: row.actor_name,
        siteName: row.site_name,
        subjectId: row.subject_id,
        objectType: row.object_type,
        objectId: row.object_id,
        action: row.action,
        before: parseSnapshot(row.before_json),
        after: parseSnapshot(row.after_json),
        reason: row.reason,
        ipAddress: row.ip_address,
        userAgent: row.user_agent,
        createdAt: row.created_at,
      })),
      total,
      page: filters.page,
      pageSize: filters.pageSize,
    }
  })
}
