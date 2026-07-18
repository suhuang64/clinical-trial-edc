import type { FastifyPluginAsync } from 'fastify'
import { requireStudyPermission } from '../../auth/permissions.js'
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

interface RandomizationArm {
  id: string
  label: string
}

function randomizationDistribution(
  studyId: string,
  scopedSiteIds: string[] | null,
  sites: Array<{ id: string; name: string }>,
) {
  const scheme = sqlite
    .prepare('SELECT arms_json FROM randomization_schemes WHERE study_id = ?')
    .get(studyId) as { arms_json: string } | undefined
  const arms = scheme ? (JSON.parse(scheme.arms_json) as RandomizationArm[]) : []
  const scope = siteScope(scopedSiteIds, 'site_id')
  const counts = sqlite
    .prepare(
      `SELECT site_id, arm_id, COUNT(*) AS value
       FROM randomization_assignments
       WHERE study_id = ?${scope.sql}
       GROUP BY site_id, arm_id`,
    )
    .all(studyId, ...scope.values) as Array<{ site_id: string; arm_id: string; value: number }>
  const countBySiteArm = new Map(
    counts.map((row) => [`${row.site_id}\u0000${row.arm_id}`, row.value]),
  )
  const armCounts = (siteId?: string) =>
    Object.fromEntries(
      arms.map((arm) => [
        arm.id,
        siteId
          ? (countBySiteArm.get(`${siteId}\u0000${arm.id}`) ?? 0)
          : counts.filter((row) => row.arm_id === arm.id).reduce((sum, row) => sum + row.value, 0),
      ]),
    )
  const overallCounts = armCounts()
  return {
    arms: arms.map(({ id, label }) => ({ id, label })),
    overall: {
      counts: overallCounts,
      total: Object.values(overallCounts).reduce((sum, value) => sum + value, 0),
    },
    sites: sites.map((site) => {
      const siteCounts = armCounts(site.id)
      return {
        id: site.id,
        name: site.name,
        counts: siteCounts,
        total: Object.values(siteCounts).reduce((sum, value) => sum + value, 0),
      }
    }),
  }
}

export const dashboardRoutes: FastifyPluginAsync = async (app) => {
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
        `SELECT st.id, st.name, st.enrollment_target,
                COUNT(s.id) AS enrolled
         FROM sites st
         LEFT JOIN subjects s
           ON s.study_id = st.study_id AND s.site_id = st.id AND s.subject_number IS NOT NULL
         WHERE st.study_id = ?${siteFilter.sql}
         GROUP BY st.id, st.name, st.enrollment_target
         ORDER BY st.name`,
      )
      .all(studyId, ...siteFilter.values) as Array<{
      id: string
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
        `SELECT id, action, object_type, object_id, site_name_snapshot AS site_name,
                strftime('%Y-%m-%dT%H:%M:%fZ', created_at) AS created_at
         FROM audit_events
         WHERE study_id = ?${auditScope.sql}
         ORDER BY julianday(created_at) DESC
         LIMIT 8`,
      )
      .all(studyId, ...auditScope.values)
    const randomization = randomizationDistribution(
      studyId,
      scopedSiteIds,
      sites.map((site) => ({ id: site.id, name: site.name })),
    )

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
      randomization,
      recentActivities,
    }
  })
}
