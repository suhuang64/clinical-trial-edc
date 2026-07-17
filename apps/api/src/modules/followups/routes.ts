import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { requireStudyPermission } from '../../auth/permissions.js'
import { sqlite } from '../../db/database.js'

const querySchema = z.object({
  query: z.string().trim().max(100).default(''),
  siteName: z.string().trim().min(1).max(200).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
})

interface SubjectRow {
  id: string
  site_name: string
  screening_number: string
  subject_number: string | null
  random_number: string | null
  status: string
}

interface VisitRow {
  id: string
  code: string
  name: string
  sort_order: number
}

interface RecordSummaryRow {
  subject_id: string
  visit_id: string
  submitted_count: number
  draft_count: number
  updated_at: string
}

export const followupRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (request, reply) => {
    const studyId = (request.params as { studyId: string }).studyId
    const authorization = await requireStudyPermission(request, reply, studyId, 'data.view')
    if (!authorization) return
    const parsed = querySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: '随访查询条件不合法',
        details: parsed.error.flatten(),
        requestId: request.id,
      })
    }
    if (
      parsed.data.siteName &&
      authorization.allowedSiteNames !== null &&
      !authorization.allowedSiteNames.includes(parsed.data.siteName)
    ) {
      return reply.code(403).send({
        code: 'SITE_ACCESS_DENIED',
        message: '您无权访问该研究中心',
        requestId: request.id,
      })
    }

    const siteScope = parsed.data.siteName ? [parsed.data.siteName] : authorization.allowedSiteNames
    const where = ['s.study_id = ?', "s.status NOT IN ('screening', 'screen_failed')"]
    const params: Array<string | number> = [studyId]
    if (siteScope !== null) {
      if (!siteScope.length)
        return {
          items: [],
          visits: [],
          sites: [],
          total: 0,
          page: 1,
          pageSize: parsed.data.pageSize,
        }
      where.push(`s.site_name IN (${siteScope.map(() => '?').join(',')})`)
      params.push(...siteScope)
    }
    if (parsed.data.query) {
      where.push('(s.subject_number LIKE ? OR s.screening_number LIKE ? OR s.random_number LIKE ?)')
      const keyword = `%${parsed.data.query}%`
      params.push(keyword, keyword, keyword)
    }

    const count = sqlite
      .prepare(`SELECT COUNT(*) AS value FROM subjects s WHERE ${where.join(' AND ')}`)
      .get(...params) as { value: number }
    const offset = (parsed.data.page - 1) * parsed.data.pageSize
    const subjects = sqlite
      .prepare(
        `SELECT s.id, s.site_name, s.screening_number, s.subject_number, s.random_number, s.status,
                site.name AS site_name
         FROM subjects s
         JOIN sites site ON site.name = s.site_name AND site.study_id = s.study_id
         WHERE ${where.join(' AND ')}
         ORDER BY s.updated_at DESC, s.id
         LIMIT ? OFFSET ?`,
      )
      .all(...params, parsed.data.pageSize, offset) as SubjectRow[]

    const visits = sqlite
      .prepare(
        'SELECT id, code, name, sort_order FROM visit_definitions WHERE study_id = ? ORDER BY sort_order, code',
      )
      .all(studyId) as VisitRow[]
    const sites = sqlite
      .prepare(
        `SELECT name FROM sites
         WHERE study_id = ?${siteScope === null ? '' : ` AND name IN (${siteScope.map(() => '?').join(',')})`}
         ORDER BY name`,
      )
      .all(studyId, ...(siteScope ?? []))
    const expectedRows = sqlite
      .prepare(
        `SELECT fvb.visit_id, COUNT(*) AS expected_count
         FROM forms f
         JOIN form_visit_bindings fvb ON fvb.form_id = f.id
         WHERE f.study_id = ? AND f.status = 'published'
         GROUP BY fvb.visit_id`,
      )
      .all(studyId) as Array<{ visit_id: string; expected_count: number }>
    const expectedByVisit = new Map(expectedRows.map((row) => [row.visit_id, row.expected_count]))

    let recordRows: RecordSummaryRow[] = []
    if (subjects.length) {
      const subjectIds = subjects.map((subject) => subject.id)
      recordRows = sqlite
        .prepare(
          `SELECT dr.subject_id, dr.visit_id,
                  SUM(CASE WHEN dr.status = 'submitted' THEN 1 ELSE 0 END) AS submitted_count,
                  SUM(CASE WHEN dr.status = 'draft' THEN 1 ELSE 0 END) AS draft_count,
                  MAX(dr.updated_at) AS updated_at
           FROM data_records dr
           WHERE dr.study_id = ?
             AND dr.subject_id IN (${subjectIds.map(() => '?').join(',')})
             ${siteScope === null ? '' : `AND dr.site_name IN (${siteScope.map(() => '?').join(',')})`}
             AND dr.visit_id IS NOT NULL
           GROUP BY dr.subject_id, dr.visit_id`,
        )
        .all(studyId, ...subjectIds, ...(siteScope ?? [])) as RecordSummaryRow[]
    }
    const recordByKey = new Map(recordRows.map((row) => [`${row.subject_id}:${row.visit_id}`, row]))
    const items = subjects.map((subject) => ({
      ...subject,
      visits: visits.map((visit) => {
        const record = recordByKey.get(`${subject.id}:${visit.id}`)
        const expectedCount = expectedByVisit.get(visit.id) ?? 0
        const submittedCount = record?.submitted_count ?? 0
        const draftCount = record?.draft_count ?? 0
        const status =
          expectedCount > 0 && submittedCount >= expectedCount
            ? 'completed'
            : submittedCount > 0 || draftCount > 0
              ? 'in_progress'
              : 'not_started'
        return {
          id: visit.id,
          code: visit.code,
          name: visit.name,
          expectedCount,
          submittedCount,
          draftCount,
          status,
          updatedAt: record?.updated_at ?? null,
        }
      }),
    }))
    return {
      items,
      visits,
      sites,
      total: count.value,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
    }
  })
}
