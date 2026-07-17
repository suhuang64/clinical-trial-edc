import type { FastifyPluginAsync } from 'fastify'
import { stringify } from 'csv-stringify/sync'
import { verifyCsrf } from '../../auth/auth.js'
import { requireStudyPermission, requireStudyStatus } from '../../auth/permissions.js'
import { writeAudit } from '../../audit/audit.js'
import { sqlite } from '../../db/database.js'

function siteScope(allowedSiteIds: string[] | null, column: string) {
  if (allowedSiteIds === null) return { sql: '', values: [] as string[] }
  if (!allowedSiteIds.length) return { sql: ' AND 1 = 0', values: [] as string[] }
  return {
    sql: ` AND ${column} IN (${allowedSiteIds.map(() => '?').join(',')})`,
    values: allowedSiteIds,
  }
}

function effectiveSiteIds(allowedSiteIds: string[] | null, requestedSiteId?: string) {
  if (!requestedSiteId) return allowedSiteIds
  if (allowedSiteIds !== null && !allowedSiteIds.includes(requestedSiteId)) return undefined
  return [requestedSiteId]
}

export const dashboardRoutes: FastifyPluginAsync = async (app) => {
  app.post('/export.csv', async (request, reply) => {
    const studyId = (request.params as { studyId: string }).studyId
    const auth = await requireStudyPermission(request, reply, studyId, 'export.execute')
    if (!auth) return
    if (!(await verifyCsrf(request, reply))) return
    if (!(await requireStudyStatus(studyId, ['draft', 'active', 'ended'], request, reply))) return
    const requestedSiteId = (request.query as { siteId?: string }).siteId?.trim()
    const scopedSiteIds = effectiveSiteIds(auth.allowedSiteIds, requestedSiteId)
    if (scopedSiteIds === undefined)
      return reply.code(403).send({
        code: 'SITE_ACCESS_DENIED',
        message: '您无权导出该研究中心的统计数据',
        requestId: request.id,
      })

    const subjectScope = siteScope(scopedSiteIds, 'site_id')
    const metrics = sqlite
      .prepare(
        `SELECT COUNT(*) AS screened,
                COALESCE(SUM(CASE WHEN subject_number IS NOT NULL THEN 1 ELSE 0 END), 0) AS enrolled,
                COALESCE(SUM(CASE WHEN random_number IS NOT NULL THEN 1 ELSE 0 END), 0) AS randomized
         FROM subjects WHERE study_id = ?${subjectScope.sql}`,
      )
      .get(studyId, ...subjectScope.values) as Record<string, number>
    const auditScope = siteScope(scopedSiteIds, 'site_id')
    const trends = sqlite
      .prepare(
        `SELECT substr(created_at, 1, 7) AS period, COUNT(*) AS value
         FROM audit_events
         WHERE study_id = ? AND action = 'subject.enrolled'${auditScope.sql}
         GROUP BY substr(created_at, 1, 7) ORDER BY period`,
      )
      .all(studyId, ...auditScope.values) as Array<{ period: string; value: number }>
    const statuses = sqlite
      .prepare(
        `SELECT status, COUNT(*) AS value FROM subjects
         WHERE study_id = ?${subjectScope.sql} GROUP BY status ORDER BY status`,
      )
      .all(studyId, ...subjectScope.values) as Array<{ status: string; value: number }>
    const siteFilter = siteScope(scopedSiteIds, 'st.id')
    const sites = sqlite
      .prepare(
        `SELECT st.code, st.name, st.enrollment_target,
                COUNT(s.id) AS enrolled
         FROM sites st
         LEFT JOIN subjects s
           ON s.study_id = st.study_id AND s.site_id = st.id AND s.subject_number IS NOT NULL
         WHERE st.study_id = ?${siteFilter.sql}
         GROUP BY st.id, st.code, st.name, st.enrollment_target ORDER BY st.code`,
      )
      .all(studyId, ...siteFilter.values) as Array<{
      code: string
      name: string
      enrollment_target: number
      enrolled: number
    }>
    const rows: Array<Record<string, string | number | null>> = [
      ...Object.entries(metrics).map(([key, value]) => ({
        section: 'metrics',
        key,
        label: key,
        value,
        target: null,
        percent: null,
      })),
      ...trends.map((row) => ({
        section: 'enrollment_trend',
        key: row.period,
        label: row.period,
        value: row.value,
        target: null,
        percent: null,
      })),
      ...statuses.map((row) => ({
        section: 'status_distribution',
        key: row.status,
        label: row.status,
        value: row.value,
        target: null,
        percent: null,
      })),
      ...sites.map((site) => ({
        section: 'sites',
        key: site.code,
        label: site.name,
        value: site.enrolled,
        target: site.enrollment_target,
        percent: site.enrollment_target
          ? Math.round((site.enrolled / site.enrollment_target) * 1000) / 10
          : null,
      })),
    ]
    await writeAudit({
      requestId: request.id,
      actorUserId: auth.user.id,
      studyId,
      objectType: 'dashboard',
      objectId: studyId,
      action: 'dashboard.exported',
      after: { format: 'csv', rowCount: rows.length, siteIds: scopedSiteIds },
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    })
    const csv = stringify(rows, { header: true, bom: true })
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="dashboard-${studyId}.csv"`)
      .send(csv)
  })

  app.get('/', async (request, reply) => {
    const studyId = (request.params as { studyId: string }).studyId
    const auth = await requireStudyPermission(request, reply, studyId, 'dashboard.view')
    if (!auth) return
    const requestedSiteId = (request.query as { siteId?: string }).siteId?.trim()
    const scopedSiteIds = effectiveSiteIds(auth.allowedSiteIds, requestedSiteId)
    if (scopedSiteIds === undefined)
      return reply.code(403).send({
        code: 'SITE_ACCESS_DENIED',
        message: '您无权查看该研究中心的统计数据',
        requestId: request.id,
      })

    const subjectScope = siteScope(scopedSiteIds, 'site_id')
    const subjectMetrics = sqlite
      .prepare(
        `SELECT COUNT(*) AS screened,
                COALESCE(SUM(CASE WHEN subject_number IS NOT NULL THEN 1 ELSE 0 END), 0) AS enrolled,
                COALESCE(SUM(CASE WHEN random_number IS NOT NULL THEN 1 ELSE 0 END), 0) AS randomized
         FROM subjects
         WHERE study_id = ?${subjectScope.sql}`,
      )
      .get(studyId, ...subjectScope.values) as {
      screened: number
      enrolled: number
      randomized: number
    }

    const expectedForms = (
      sqlite
        .prepare(
          `SELECT COUNT(*) AS value
           FROM form_visit_bindings b
           JOIN forms f ON f.study_id = ? AND f.id = b.form_id
           WHERE f.status = 'published'`,
        )
        .get(studyId) as { value: number }
    ).value
    const recordScope = siteScope(scopedSiteIds, 'r.site_id')
    const completedRecords = (
      sqlite
        .prepare(
          `SELECT COUNT(*) AS value
           FROM data_records r
           JOIN forms f ON f.study_id = r.study_id AND f.id = r.form_id
           WHERE r.study_id = ? AND r.status = 'submitted' AND f.bind_visits = 1${recordScope.sql}`,
        )
        .get(studyId, ...recordScope.values) as { value: number }
    ).value
    const expectedRecords = subjectMetrics.enrolled * expectedForms
    const followupCompletionRate = expectedRecords
      ? Math.min(100, Math.round((completedRecords / expectedRecords) * 1000) / 10)
      : null

    const siteFilter = siteScope(scopedSiteIds, 'st.id')
    const sites = sqlite
      .prepare(
        `SELECT st.id, st.code, st.name, st.enrollment_target,
                COUNT(s.id) AS enrolled
         FROM sites st
         LEFT JOIN subjects s
           ON s.study_id = st.study_id AND s.site_id = st.id AND s.subject_number IS NOT NULL
         WHERE st.study_id = ?${siteFilter.sql}
         GROUP BY st.id, st.code, st.name, st.enrollment_target
         ORDER BY st.code`,
      )
      .all(studyId, ...siteFilter.values) as Array<{
      id: string
      code: string
      name: string
      enrollment_target: number
      enrolled: number
    }>

    const auditScope = siteScope(scopedSiteIds, 'site_id')
    const enrollmentTrend = sqlite
      .prepare(
        `SELECT substr(created_at, 1, 7) AS period, COUNT(*) AS value
         FROM audit_events
         WHERE study_id = ? AND action = 'subject.enrolled'${auditScope.sql}
         GROUP BY substr(created_at, 1, 7)
         ORDER BY period DESC
         LIMIT 12`,
      )
      .all(studyId, ...auditScope.values)
      .reverse()

    const statusDistribution = sqlite
      .prepare(
        `SELECT status, COUNT(*) AS value
         FROM subjects
         WHERE study_id = ?${subjectScope.sql}
         GROUP BY status
         ORDER BY status`,
      )
      .all(studyId, ...subjectScope.values)

    const recentActivities = sqlite
      .prepare(
        `SELECT id, action, object_type, object_id, site_id, created_at
         FROM audit_events
         WHERE study_id = ?${auditScope.sql}
         ORDER BY created_at DESC
         LIMIT 8`,
      )
      .all(studyId, ...auditScope.values)

    return {
      metrics: {
        ...subjectMetrics,
        followupCompletionRate,
        expectedFollowupRecords: expectedRecords,
        completedFollowupRecords: completedRecords,
      },
      sites,
      enrollmentTrend,
      statusDistribution,
      recentActivities,
    }
  })
}
