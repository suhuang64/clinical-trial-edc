import { randomUUID } from 'node:crypto'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { requireUser, verifyCsrf } from '../../auth/auth.js'
import {
  requireStudyPermission,
  requireStudyStatus,
  resolveMembershipPermissions,
} from '../../auth/permissions.js'
import { writeAudit } from '../../audit/audit.js'
import { db, numberingRepository, sqlite } from '../../db/database.js'
import { NumberingRuleFrozenError } from '../../db/repositories/numbering-repository.js'

const studyMetadataSchema = z.object({
  protocolCode: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(300),
  sponsor: z.string().trim().max(300).nullable().optional(),
  studyType: z.string().trim().max(100).nullable().optional(),
  phase: z.string().trim().max(100).nullable().optional(),
  startDate: z.string().date().nullable().optional(),
  endDate: z.string().date().nullable().optional(),
  defaultLocale: z.enum(['zh-CN', 'en-US']).default('zh-CN'),
  notes: z.string().trim().max(4000).nullable().optional(),
})
const createStudySchema = studyMetadataSchema
const studyStatusSchema = z.object({
  status: z.enum(['active', 'ended', 'archived']),
  reason: z.string().trim().max(1000).optional(),
})
const counterRuleSchema = z.object({
  prefix: z
    .string()
    .trim()
    .min(1)
    .max(20)
    .regex(/^[A-Za-z0-9_-]+$/),
  padLength: z.number().int().min(1).max(12),
})
const counterConfigurationSchema = z.object({
  screening: counterRuleSchema,
  subject: counterRuleSchema,
  randomization: counterRuleSchema,
})
const siteSchema = z.object({
  name: z.string().trim().min(1).max(200),
  principalInvestigator: z.string().trim().max(200).nullable().optional(),
  contactName: z.string().trim().max(200).nullable().optional(),
  contactPhone: z.string().trim().max(100).nullable().optional(),
  contactEmail: z.string().trim().email().max(254).nullable().optional(),
  enrollmentTarget: z.number().int().nonnegative().default(0),
})
const createSiteSchema = siteSchema
const siteStatusSchema = z.object({ status: z.enum(['active', 'disabled']) })
const createVisitSchema = z.object({
  code: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(200),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
})

export const studyRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (!user) return
    const listQuery = z
      .object({ includeArchived: z.coerce.boolean().default(false) })
      .safeParse(request.query)
    if (!listQuery.success)
      return reply
        .code(400)
        .send({ code: 'VALIDATION_ERROR', message: '项目查询条件不合法', requestId: request.id })
    let query = db.selectFrom('studies').selectAll().orderBy('updated_at', 'desc')
    if (!user.isSystemAdmin)
      query = query.where(
        'id',
        'in',
        db
          .selectFrom('study_memberships')
          .select('study_id')
          .where('user_id', '=', user.id)
          .where('status', '=', 'active'),
      )
    if (!listQuery.data.includeArchived) query = query.where('status', '!=', 'archived')
    const items = await query.execute()
    if (user.isSystemAdmin) {
      const permissions = (await db.selectFrom('permissions').select('code').execute()).map(
        (permission) => permission.code,
      )
      return {
        items: items.map((study) => ({
          ...study,
          can_manage: true,
          role_code: null,
          site_id: null,
          site_name: null,
          permissions,
        })),
      }
    }
    const enriched = await Promise.all(
      items.map(async (study) => {
        const membership = await db
          .selectFrom('study_memberships')
          .select(['id', 'role_code'])
          .where('study_id', '=', study.id)
          .where('user_id', '=', user.id)
          .where('status', '=', 'active')
          .executeTakeFirst()
        const permissions = membership
          ? await resolveMembershipPermissions(membership.id, membership.role_code)
          : new Set<string>()
        const site = membership
          ? await db
              .selectFrom('membership_sites as membership_site')
              .innerJoin('sites as site', 'site.id', 'membership_site.site_id')
              .select(['site.id', 'site.name'])
              .where('membership_site.membership_id', '=', membership.id)
              .executeTakeFirst()
          : null
        return {
          ...study,
          can_manage: permissions.has('study.manage'),
          role_code: membership?.role_code ?? null,
          site_id: site?.id ?? null,
          site_name: site?.name ?? null,
          permissions: [...permissions],
        }
      }),
    )
    return { items: enriched }
  })

  app.post('/', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (!user) return
    if (!user.isSystemAdmin)
      return reply.code(403).send({
        code: 'PERMISSION_DENIED',
        message: '仅系统超级管理员可以创建研究项目',
        requestId: request.id,
      })
    if (!(await verifyCsrf(request, reply))) return
    const parsed = createStudySchema.safeParse(request.body)
    if (!parsed.success)
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: '研究项目信息不完整',
        details: parsed.error.flatten(),
        requestId: request.id,
      })
    const now = new Date().toISOString()
    const id = randomUUID()
    const record = {
      id,
      protocol_code: parsed.data.protocolCode,
      name: parsed.data.name,
      sponsor: parsed.data.sponsor ?? null,
      study_type: parsed.data.studyType ?? null,
      phase: parsed.data.phase ?? null,
      status: 'draft' as const,
      start_date: parsed.data.startDate ?? null,
      end_date: parsed.data.endDate ?? null,
      default_locale: parsed.data.defaultLocale,
      notes: parsed.data.notes ?? null,
      created_by: user.id,
      created_at: now,
      updated_at: now,
    }
    await db.insertInto('studies').values(record).execute()
    await writeAudit({
      requestId: request.id,
      actorUserId: user.id,
      studyId: id,
      objectType: 'study',
      objectId: id,
      action: 'study.created',
      after: record,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    })
    return reply.code(201).send({ id })
  })

  app.get('/:studyId', async (request, reply) => {
    const studyId = (request.params as { studyId: string }).studyId
    const auth = await requireStudyPermission(request, reply, studyId, 'study.view')
    if (!auth) return
    const study = await db
      .selectFrom('studies')
      .selectAll()
      .where('id', '=', studyId)
      .executeTakeFirst()
    if (!study)
      return reply
        .code(404)
        .send({ code: 'STUDY_NOT_FOUND', message: '研究项目不存在', requestId: request.id })
    return { study }
  })

  app.put('/:studyId', async (request, reply) => {
    const studyId = (request.params as { studyId: string }).studyId
    const auth = await requireStudyPermission(request, reply, studyId, 'study.manage')
    if (!auth) return
    if (!(await verifyCsrf(request, reply))) return
    const parsed = studyMetadataSchema.safeParse(request.body)
    if (!parsed.success)
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: '研究项目资料不完整',
        details: parsed.error.flatten(),
        requestId: request.id,
      })
    if (
      parsed.data.startDate &&
      parsed.data.endDate &&
      parsed.data.endDate < parsed.data.startDate
    ) {
      return reply.code(400).send({
        code: 'STUDY_DATE_INVALID',
        message: '结束日期不能早于开始日期',
        requestId: request.id,
      })
    }
    const before = await db
      .selectFrom('studies')
      .selectAll()
      .where('id', '=', studyId)
      .executeTakeFirst()
    if (!before)
      return reply
        .code(404)
        .send({ code: 'STUDY_NOT_FOUND', message: '研究项目不存在', requestId: request.id })
    if (before.status === 'ended' || before.status === 'archived')
      return reply.code(409).send({
        code: 'STUDY_READ_ONLY',
        message: '已结束或归档项目不能修改基本资料',
        requestId: request.id,
      })
    const duplicate = await db
      .selectFrom('studies')
      .select('id')
      .where('protocol_code', '=', parsed.data.protocolCode)
      .where('id', '!=', studyId)
      .executeTakeFirst()
    if (duplicate)
      return reply
        .code(409)
        .send({ code: 'PROTOCOL_CODE_EXISTS', message: '方案编号已存在', requestId: request.id })
    const now = new Date().toISOString()
    const after = {
      protocol_code: parsed.data.protocolCode,
      name: parsed.data.name,
      sponsor: parsed.data.sponsor ?? null,
      study_type: parsed.data.studyType ?? null,
      phase: parsed.data.phase ?? null,
      start_date: parsed.data.startDate ?? null,
      end_date: parsed.data.endDate ?? null,
      default_locale: parsed.data.defaultLocale,
      notes: parsed.data.notes ?? null,
      updated_at: now,
    }
    await db.updateTable('studies').set(after).where('id', '=', studyId).execute()
    await writeAudit({
      requestId: request.id,
      actorUserId: auth.user.id,
      studyId,
      objectType: 'study',
      objectId: studyId,
      action: 'study.updated',
      before,
      after,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    })
    return { id: studyId }
  })

  app.post('/:studyId/status', async (request, reply) => {
    const studyId = (request.params as { studyId: string }).studyId
    const auth = await requireStudyPermission(request, reply, studyId, 'study.manage')
    if (!auth) return
    if (!(await verifyCsrf(request, reply))) return
    const parsed = studyStatusSchema.safeParse(request.body)
    if (!parsed.success)
      return reply
        .code(400)
        .send({ code: 'VALIDATION_ERROR', message: '项目状态不合法', requestId: request.id })
    const study = await db
      .selectFrom('studies')
      .select(['id', 'status'])
      .where('id', '=', studyId)
      .executeTakeFirst()
    if (!study)
      return reply
        .code(404)
        .send({ code: 'STUDY_NOT_FOUND', message: '研究项目不存在', requestId: request.id })
    if (study.status === parsed.data.status) return { id: studyId, status: study.status }
    const allowed: Record<string, string> = { draft: 'active', active: 'ended', ended: 'archived' }
    if (allowed[study.status] !== parsed.data.status) {
      return reply.code(409).send({
        code: 'INVALID_STUDY_TRANSITION',
        message: `项目不能从 ${study.status} 变更为 ${parsed.data.status}`,
        requestId: request.id,
      })
    }
    const now = new Date().toISOString()
    await db
      .updateTable('studies')
      .set({ status: parsed.data.status, updated_at: now })
      .where('id', '=', studyId)
      .execute()
    await writeAudit({
      requestId: request.id,
      actorUserId: auth.user.id,
      studyId,
      objectType: 'study',
      objectId: studyId,
      action: 'study.status_changed',
      before: { status: study.status },
      after: { status: parsed.data.status },
      reason: parsed.data.reason,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    })
    return { id: studyId, status: parsed.data.status }
  })

  app.get('/:studyId/counters', async (request, reply) => {
    const studyId = (request.params as { studyId: string }).studyId
    const auth = await requireStudyPermission(request, reply, studyId, 'study.view')
    if (!auth) return
    return { counters: numberingRepository.getConfiguration(studyId) }
  })

  app.put('/:studyId/counters', async (request, reply) => {
    const studyId = (request.params as { studyId: string }).studyId
    const auth = await requireStudyPermission(request, reply, studyId, 'study.manage')
    if (!auth) return
    if (!(await verifyCsrf(request, reply))) return
    if (!(await requireStudyStatus(studyId, ['draft', 'active'], request, reply))) return
    const parsed = counterConfigurationSchema.safeParse(request.body)
    if (!parsed.success)
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: '编号规则不合法',
        details: parsed.error.flatten(),
        requestId: request.id,
      })
    let change
    try {
      change = numberingRepository.updateConfiguration(studyId, parsed.data)
    } catch (error) {
      if (error instanceof NumberingRuleFrozenError)
        return reply.code(409).send({
          code: 'COUNTER_RULE_FROZEN',
          message: '已分配编号的规则不能再修改',
          details: { counterType: error.counterType, currentValue: error.currentValue },
          requestId: request.id,
        })
      throw error
    }
    await writeAudit({
      requestId: request.id,
      actorUserId: auth.user.id,
      studyId,
      objectType: 'study_numbering',
      objectId: studyId,
      action: 'study.numbering_updated',
      before: change.before,
      after: change.after,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    })
    return { counters: change.after }
  })

  app.get('/:studyId/sites', async (request, reply) => {
    const studyId = (request.params as { studyId: string }).studyId
    const auth = await requireStudyPermission(request, reply, studyId, 'site.view')
    if (!auth) return
    let query = db.selectFrom('sites').selectAll().where('study_id', '=', studyId).orderBy('name')
    if (auth.allowedSiteIds) {
      if (auth.allowedSiteIds.length === 0) return { items: [] }
      query = query.where('id', 'in', auth.allowedSiteIds)
    }
    const rows = await query.execute()
    const countStatement = sqlite.prepare(
      `SELECT COUNT(*) AS value FROM subjects WHERE study_id = ? AND site_id = ? AND status NOT IN ('screening', 'screen_failed')`,
    )
    return {
      items: rows.map((site) => ({
        ...site,
        enrolled_count: (countStatement.get(studyId, site.id) as { value: number }).value,
      })),
    }
  })

  app.post('/:studyId/sites', async (request, reply) => {
    const studyId = (request.params as { studyId: string }).studyId
    const auth = await requireStudyPermission(request, reply, studyId, 'site.manage')
    if (!auth) return
    if (!(await verifyCsrf(request, reply))) return
    if (!(await requireStudyStatus(studyId, ['draft', 'active'], request, reply))) return
    const parsed = createSiteSchema.safeParse(request.body)
    if (!parsed.success)
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: '中心信息不完整',
        details: parsed.error.flatten(),
        requestId: request.id,
      })
    const duplicate = await db
      .selectFrom('sites')
      .select('name')
      .where('study_id', '=', studyId)
      .where('name', '=', parsed.data.name)
      .executeTakeFirst()
    if (duplicate)
      return reply
        .code(409)
        .send({ code: 'SITE_NAME_EXISTS', message: '中心名称已存在', requestId: request.id })
    const now = new Date().toISOString()
    const id = randomUUID()
    const record = {
      id,
      study_id: studyId,
      name: parsed.data.name,
      principal_investigator: parsed.data.principalInvestigator ?? null,
      contact_name: parsed.data.contactName ?? null,
      contact_phone: parsed.data.contactPhone ?? null,
      contact_email: parsed.data.contactEmail ?? null,
      enrollment_target: parsed.data.enrollmentTarget,
      status: 'active' as const,
      created_at: now,
      updated_at: now,
    }
    await db.insertInto('sites').values(record).execute()
    await writeAudit({
      requestId: request.id,
      actorUserId: auth.user.id,
      studyId,
      siteId: id,
      objectType: 'site',
      objectId: id,
      action: 'site.created',
      after: record,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    })
    return reply.code(201).send({ id, name: record.name })
  })

  app.put('/:studyId/sites/:siteId', async (request, reply) => {
    const { studyId, siteId } = request.params as { studyId: string; siteId: string }
    const auth = await requireStudyPermission(request, reply, studyId, 'site.manage')
    if (!auth) return
    if (!(await verifyCsrf(request, reply))) return
    if (!(await requireStudyStatus(studyId, ['draft', 'active'], request, reply))) return
    if (auth.allowedSiteIds !== null && !auth.allowedSiteIds.includes(siteId))
      return reply.code(403).send({
        code: 'SITE_ACCESS_DENIED',
        message: '您无权管理该研究中心',
        requestId: request.id,
      })
    const parsed = siteSchema.safeParse(request.body)
    if (!parsed.success)
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: '中心信息不完整',
        details: parsed.error.flatten(),
        requestId: request.id,
      })
    const before = await db
      .selectFrom('sites')
      .selectAll()
      .where('study_id', '=', studyId)
      .where('id', '=', siteId)
      .executeTakeFirst()
    if (!before)
      return reply
        .code(404)
        .send({ code: 'SITE_NOT_FOUND', message: '研究中心不存在', requestId: request.id })
    const duplicate = await db
      .selectFrom('sites')
      .select('name')
      .where('study_id', '=', studyId)
      .where('name', '=', parsed.data.name)
      .where('id', '!=', siteId)
      .executeTakeFirst()
    if (duplicate)
      return reply
        .code(409)
        .send({ code: 'SITE_NAME_EXISTS', message: '中心名称已存在', requestId: request.id })
    const after = {
      name: parsed.data.name,
      principal_investigator: parsed.data.principalInvestigator ?? null,
      contact_name: parsed.data.contactName ?? null,
      contact_phone: parsed.data.contactPhone ?? null,
      contact_email: parsed.data.contactEmail ?? null,
      enrollment_target: parsed.data.enrollmentTarget,
      updated_at: new Date().toISOString(),
    }
    await db
      .updateTable('sites')
      .set(after)
      .where('study_id', '=', studyId)
      .where('id', '=', siteId)
      .execute()
    await writeAudit({
      requestId: request.id,
      actorUserId: auth.user.id,
      studyId,
      siteId,
      objectType: 'site',
      objectId: siteId,
      action: 'site.updated',
      before,
      after,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    })
    return { id: siteId, name: after.name }
  })

  app.post('/:studyId/sites/:siteId/status', async (request, reply) => {
    const { studyId, siteId } = request.params as { studyId: string; siteId: string }
    const auth = await requireStudyPermission(request, reply, studyId, 'site.manage')
    if (!auth) return
    if (!(await verifyCsrf(request, reply))) return
    if (!(await requireStudyStatus(studyId, ['draft', 'active'], request, reply))) return
    if (auth.allowedSiteIds !== null && !auth.allowedSiteIds.includes(siteId))
      return reply.code(403).send({
        code: 'SITE_ACCESS_DENIED',
        message: '您无权管理该研究中心',
        requestId: request.id,
      })
    const parsed = siteStatusSchema.safeParse(request.body)
    if (!parsed.success)
      return reply
        .code(400)
        .send({ code: 'VALIDATION_ERROR', message: '中心状态不合法', requestId: request.id })
    const site = await db
      .selectFrom('sites')
      .select(['id', 'name', 'status'])
      .where('study_id', '=', studyId)
      .where('id', '=', siteId)
      .executeTakeFirst()
    if (!site)
      return reply
        .code(404)
        .send({ code: 'SITE_NOT_FOUND', message: '研究中心不存在', requestId: request.id })
    await db
      .updateTable('sites')
      .set({ status: parsed.data.status, updated_at: new Date().toISOString() })
      .where('study_id', '=', studyId)
      .where('id', '=', siteId)
      .execute()
    await writeAudit({
      requestId: request.id,
      actorUserId: auth.user.id,
      studyId,
      siteId,
      objectType: 'site',
      objectId: siteId,
      action: 'site.status_changed',
      before: { status: site.status },
      after: { status: parsed.data.status },
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    })
    return { id: siteId, name: site.name, status: parsed.data.status }
  })

  app.get('/:studyId/visits', async (request, reply) => {
    const studyId = (request.params as { studyId: string }).studyId
    const auth = await requireStudyPermission(request, reply, studyId, 'form.view')
    if (!auth) return
    const items = await db
      .selectFrom('visit_definitions')
      .selectAll()
      .where('study_id', '=', studyId)
      .orderBy('sort_order')
      .orderBy('code')
      .execute()
    return { items }
  })

  app.post('/:studyId/visits', async (request, reply) => {
    const studyId = (request.params as { studyId: string }).studyId
    const auth = await requireStudyPermission(request, reply, studyId, 'study.manage')
    if (!auth) return
    if (!(await verifyCsrf(request, reply))) return
    if (!(await requireStudyStatus(studyId, ['draft', 'active'], request, reply))) return
    const parsed = createVisitSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: '访视定义不完整',
        details: parsed.error.flatten(),
        requestId: request.id,
      })
    }
    const existing = await db
      .selectFrom('visit_definitions')
      .select('id')
      .where('study_id', '=', studyId)
      .where('code', '=', parsed.data.code)
      .executeTakeFirst()
    if (existing) {
      return reply
        .code(409)
        .send({ code: 'VISIT_CODE_EXISTS', message: '访视编号已存在', requestId: request.id })
    }
    const id = randomUUID()
    await db
      .insertInto('visit_definitions')
      .values({
        id,
        study_id: studyId,
        code: parsed.data.code,
        name: parsed.data.name,
        sort_order: parsed.data.sortOrder,
      })
      .execute()
    await writeAudit({
      requestId: request.id,
      actorUserId: auth.user.id,
      studyId,
      objectType: 'visit_definition',
      objectId: id,
      action: 'visit.created',
      after: parsed.data,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    })
    return reply.code(201).send({ id })
  })

  app.put('/:studyId/visits/:visitId', async (request, reply) => {
    const { studyId, visitId } = request.params as { studyId: string; visitId: string }
    const auth = await requireStudyPermission(request, reply, studyId, 'study.manage')
    if (!auth) return
    if (!(await verifyCsrf(request, reply))) return
    if (!(await requireStudyStatus(studyId, ['draft', 'active'], request, reply))) return
    const parsed = createVisitSchema.safeParse(request.body)
    if (!parsed.success)
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: '访视定义不完整',
        details: parsed.error.flatten(),
        requestId: request.id,
      })
    const before = await db
      .selectFrom('visit_definitions')
      .selectAll()
      .where('study_id', '=', studyId)
      .where('id', '=', visitId)
      .executeTakeFirst()
    if (!before)
      return reply
        .code(404)
        .send({ code: 'VISIT_NOT_FOUND', message: '访视不存在', requestId: request.id })
    const duplicate = await db
      .selectFrom('visit_definitions')
      .select('id')
      .where('study_id', '=', studyId)
      .where('code', '=', parsed.data.code)
      .where('id', '!=', visitId)
      .executeTakeFirst()
    if (duplicate)
      return reply
        .code(409)
        .send({ code: 'VISIT_CODE_EXISTS', message: '访视编号已存在', requestId: request.id })
    const after = {
      code: parsed.data.code,
      name: parsed.data.name,
      sort_order: parsed.data.sortOrder,
    }
    await db
      .updateTable('visit_definitions')
      .set(after)
      .where('study_id', '=', studyId)
      .where('id', '=', visitId)
      .execute()
    await writeAudit({
      requestId: request.id,
      actorUserId: auth.user.id,
      studyId,
      objectType: 'visit_definition',
      objectId: visitId,
      action: 'visit.updated',
      before,
      after,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    })
    return { id: visitId }
  })

  app.delete('/:studyId/visits/:visitId', async (request, reply) => {
    const { studyId, visitId } = request.params as { studyId: string; visitId: string }
    const auth = await requireStudyPermission(request, reply, studyId, 'study.manage')
    if (!auth) return
    if (!(await verifyCsrf(request, reply))) return
    if (!(await requireStudyStatus(studyId, ['draft', 'active'], request, reply))) return
    const visit = await db
      .selectFrom('visit_definitions')
      .selectAll()
      .where('study_id', '=', studyId)
      .where('id', '=', visitId)
      .executeTakeFirst()
    if (!visit)
      return reply
        .code(404)
        .send({ code: 'VISIT_NOT_FOUND', message: '访视不存在', requestId: request.id })
    const inUse = sqlite
      .prepare(
        `SELECT 1
         FROM form_visit_bindings b
         JOIN forms f ON f.study_id = ? AND f.id = b.form_id
         WHERE b.visit_id = ?
         UNION
         SELECT 1 FROM data_records WHERE study_id = ? AND visit_id = ?
         LIMIT 1`,
      )
      .get(studyId, visitId, studyId, visitId)
    if (inUse)
      return reply.code(409).send({
        code: 'VISIT_IN_USE',
        message: '访视已被表单或数据记录使用，不能删除',
        requestId: request.id,
      })
    await db
      .deleteFrom('visit_definitions')
      .where('study_id', '=', studyId)
      .where('id', '=', visitId)
      .execute()
    await writeAudit({
      requestId: request.id,
      actorUserId: auth.user.id,
      studyId,
      objectType: 'visit_definition',
      objectId: visitId,
      action: 'visit.deleted',
      before: visit,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    })
    return reply.code(204).send()
  })
}
