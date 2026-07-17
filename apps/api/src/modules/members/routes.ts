import { randomUUID } from 'node:crypto'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { verifyCsrf } from '../../auth/auth.js'
import {
  requireStudyPermission,
  requireStudyStatus,
  resolveMembershipPermissions,
} from '../../auth/permissions.js'
import { writeAudit } from '../../audit/audit.js'
import { db } from '../../db/database.js'

const roleSchema = z.enum(['study_admin', 'site_admin', 'investigator', 'readonly'])
type RoleCode = z.infer<typeof roleSchema>

const overrideSchema = z.object({
  permissionCode: z.string().min(1).max(100),
  effect: z.literal('deny'),
})
const memberSchema = z.object({
  userId: z.uuid(),
  roleCode: roleSchema,
  siteName: z.string().trim().min(1).max(200).nullable().default(null),
  overrides: z.array(overrideSchema).max(100).default([]),
})
const updateMemberSchema = memberSchema
  .omit({ userId: true })
  .extend({ status: z.enum(['active', 'disabled']).default('active') })

type StudyAuth = NonNullable<Awaited<ReturnType<typeof requireStudyPermission>>>

function grantableRoleCodes(auth: StudyAuth): RoleCode[] {
  if (auth.user.isSystemAdmin) return ['study_admin', 'site_admin', 'investigator', 'readonly']
  if (auth.roleCode === 'study_admin') return ['site_admin', 'investigator', 'readonly']
  return ['investigator', 'readonly']
}

async function validateGrantScope(
  studyId: string,
  auth: StudyAuth,
  roleCode: RoleCode,
  siteName: string | null,
  overrides: z.infer<typeof overrideSchema>[],
) {
  if (!grantableRoleCodes(auth).includes(roleCode))
    throw new Error('不能授予超出当前管理层级的角色')
  if (roleCode === 'study_admin' && siteName) throw new Error('研究项目管理员不能绑定单个中心')
  if (roleCode !== 'study_admin' && !siteName) throw new Error('中心级角色必须选择一个中心')
  if (siteName) {
    if (auth.allowedSiteNames && !auth.allowedSiteNames.includes(siteName))
      throw new Error('不能授权当前账号作用域之外的中心')
    const validSite = await db
      .selectFrom('sites')
      .select('name')
      .where('study_id', '=', studyId)
      .where('name', '=', siteName)
      .where('status', '=', 'active')
      .executeTakeFirst()
    if (!validSite) throw new Error('中心不存在、不属于当前研究或已停用')
  }
  const rolePermissions = new Set(
    (
      await db
        .selectFrom('role_permissions')
        .select('permission_code')
        .where('role_code', '=', roleCode)
        .execute()
    ).map((row) => row.permission_code),
  )
  if (overrides.some((item) => !rolePermissions.has(item.permissionCode)))
    throw new Error('只能减少该角色默认拥有的权限')
  if (!auth.user.isSystemAdmin && auth.membershipId && auth.roleCode) {
    const callerPermissions = await resolveMembershipPermissions(auth.membershipId, auth.roleCode)
    const denied = new Set(overrides.map((item) => item.permissionCode))
    const targetPermissions = [...rolePermissions].filter((permission) => !denied.has(permission))
    if (targetPermissions.some((permission) => !callerPermissions.has(permission)))
      throw new Error('不能授予当前账号自身没有的权限')
  }
}

async function membershipSiteName(membershipId: string) {
  return (
    (
      await db
        .selectFrom('membership_sites')
        .select('site_name')
        .where('membership_id', '=', membershipId)
        .executeTakeFirst()
    )?.site_name ?? null
  )
}

async function requireManageableTarget(
  auth: StudyAuth,
  membership: { id: string; user_id: string; role_code: string },
) {
  if (auth.user.isSystemAdmin) return
  if (membership.user_id === auth.user.id) throw new Error('不能修改自己的项目角色或权限')
  if (auth.roleCode === 'study_admin') {
    if (membership.role_code === 'study_admin') throw new Error('只有超级管理员能管理项目管理员')
    return
  }
  if (!['investigator', 'readonly'].includes(membership.role_code))
    throw new Error('中心管理员只能管理研究者和观察者')
  const targetSiteName = await membershipSiteName(membership.id)
  if (!targetSiteName || !auth.allowedSiteNames?.includes(targetSiteName))
    throw new Error('不能管理其他中心的成员')
}

function isManageableTarget(
  auth: StudyAuth,
  membership: { user_id: string; role_code: string; site_name: string | null },
) {
  if (auth.user.isSystemAdmin) return true
  if (membership.user_id === auth.user.id) return false
  if (auth.roleCode === 'study_admin') return membership.role_code !== 'study_admin'
  return (
    ['investigator', 'readonly'].includes(membership.role_code) &&
    Boolean(membership.site_name) &&
    Boolean(auth.allowedSiteNames?.includes(membership.site_name!))
  )
}

export const memberRoutes: FastifyPluginAsync = async (app) => {
  app.get('/permissions', async (request, reply) => {
    const studyId = (request.params as { studyId: string }).studyId
    const auth = await requireStudyPermission(request, reply, studyId, 'member.manage')
    if (!auth) return
    const [permissionRows, grantRows] = await Promise.all([
      db.selectFrom('permissions').selectAll().orderBy('domain').orderBy('code').execute(),
      db.selectFrom('role_permissions').selectAll().execute(),
    ])
    const defaults = new Map<string, string[]>()
    for (const grant of grantRows) {
      const roleCodes = defaults.get(grant.permission_code) ?? []
      roleCodes.push(grant.role_code)
      defaults.set(grant.permission_code, roleCodes)
    }
    return {
      grantableRoleCodes: grantableRoleCodes(auth),
      items: permissionRows.map((permission) => ({
        code: permission.code,
        domain: permission.domain,
        nameZh: permission.name_zh,
        nameEn: permission.name_en,
        defaultRoleCodes: defaults.get(permission.code) ?? [],
      })),
    }
  })

  app.get('/candidates', async (request, reply) => {
    const studyId = (request.params as { studyId: string }).studyId
    const auth = await requireStudyPermission(request, reply, studyId, 'member.manage')
    if (!auth) return
    const parsed = z.object({ name: z.string().trim().min(1).max(100) }).safeParse(request.query)
    if (!parsed.success)
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: '请输入要查找的用户姓名',
        requestId: request.id,
      })
    const items = await db
      .selectFrom('users as u')
      .select([
        'u.id',
        'u.username',
        'u.display_name',
        'u.gender',
        'u.birth_date',
        'u.phone',
        'u.email',
        'u.organization',
      ])
      .where('u.display_name', 'like', `%${parsed.data.name}%`)
      .where('u.status', '=', 'active')
      .where('u.approval_status', '=', 'approved')
      .where((builder) =>
        builder.not(
          builder.exists(
            builder
              .selectFrom('study_memberships as membership')
              .select('membership.id')
              .whereRef('membership.user_id', '=', 'u.id')
              .where('membership.study_id', '=', studyId),
          ),
        ),
      )
      .orderBy('u.display_name')
      .orderBy('u.created_at')
      .limit(50)
      .execute()
    return { items }
  })

  app.get('/', async (request, reply) => {
    const studyId = (request.params as { studyId: string }).studyId
    const auth = await requireStudyPermission(request, reply, studyId, 'member.view')
    if (!auth) return
    const memberships = await db
      .selectFrom('study_memberships as m')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .leftJoin('membership_sites as ms', 'ms.membership_id', 'm.id')
      .select([
        'm.id',
        'm.user_id',
        'm.role_code',
        'm.status',
        'u.username',
        'u.display_name',
        'u.gender',
        'u.birth_date',
        'u.phone',
        'u.email',
        'u.organization',
        'u.status as user_status',
        'ms.site_name',
      ])
      .where('m.study_id', '=', studyId)
      .orderBy('u.display_name')
      .execute()
    const scoped = memberships.filter((membership) => {
      if (auth.allowedSiteNames === null) return true
      return (
        membership.role_code === 'study_admin' ||
        (Boolean(membership.site_name) && auth.allowedSiteNames.includes(membership.site_name!))
      )
    })
    const items = await Promise.all(
      scoped.map(async (membership) => {
        const overrides = await db
          .selectFrom('membership_permission_overrides')
          .select(['permission_code', 'effect'])
          .where('membership_id', '=', membership.id)
          .execute()
        return {
          ...membership,
          manageable: isManageableTarget(auth, membership),
          overrides: overrides.map((override) => ({
            permissionCode: override.permission_code,
            effect: override.effect,
          })),
        }
      }),
    )
    return { items }
  })

  app.post('/', async (request, reply) => {
    const studyId = (request.params as { studyId: string }).studyId
    const auth = await requireStudyPermission(request, reply, studyId, 'member.manage')
    if (!auth) return
    if (!(await verifyCsrf(request, reply))) return
    if (!(await requireStudyStatus(studyId, ['draft', 'active'], request, reply))) return
    const parsed = memberSchema.safeParse(request.body)
    if (!parsed.success)
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: '成员信息不完整',
        details: parsed.error.flatten(),
        requestId: request.id,
      })
    try {
      await validateGrantScope(
        studyId,
        auth,
        parsed.data.roleCode,
        parsed.data.siteName,
        parsed.data.overrides,
      )
    } catch (error) {
      return reply.code(403).send({
        code: 'GRANT_SCOPE_EXCEEDED',
        message: (error as Error).message,
        requestId: request.id,
      })
    }
    const user = await db
      .selectFrom('users')
      .select(['id', 'status', 'approval_status'])
      .where('id', '=', parsed.data.userId)
      .executeTakeFirst()
    if (!user)
      return reply
        .code(404)
        .send({ code: 'USER_NOT_FOUND', message: '账号不存在', requestId: request.id })
    if (user.status !== 'active' || user.approval_status !== 'approved')
      return reply.code(409).send({
        code: 'USER_NOT_AVAILABLE',
        message: '只能添加已审核且状态正常的用户',
        requestId: request.id,
      })
    const existing = await db
      .selectFrom('study_memberships')
      .select('id')
      .where('study_id', '=', studyId)
      .where('user_id', '=', user.id)
      .executeTakeFirst()
    if (existing)
      return reply
        .code(409)
        .send({ code: 'MEMBERSHIP_EXISTS', message: '该用户已经是项目成员', requestId: request.id })
    const membershipId = randomUUID()
    const now = new Date().toISOString()
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('study_memberships')
        .values({
          id: membershipId,
          study_id: studyId,
          user_id: user.id,
          role_code: parsed.data.roleCode,
          status: 'active',
          created_at: now,
          updated_at: now,
        })
        .execute()
      if (parsed.data.siteName)
        await trx
          .insertInto('membership_sites')
          .values({ membership_id: membershipId, site_name: parsed.data.siteName })
          .execute()
      if (parsed.data.overrides.length)
        await trx
          .insertInto('membership_permission_overrides')
          .values(
            parsed.data.overrides.map((item) => ({
              membership_id: membershipId,
              permission_code: item.permissionCode,
              effect: item.effect,
            })),
          )
          .execute()
    })
    await writeAudit({
      requestId: request.id,
      actorUserId: auth.user.id,
      studyId,
      siteName: parsed.data.siteName,
      objectType: 'study_membership',
      objectId: membershipId,
      action: 'member.created',
      after: parsed.data,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    })
    return reply.code(201).send({ id: membershipId, userId: user.id })
  })

  app.put('/:membershipId', async (request, reply) => {
    const { studyId, membershipId } = request.params as { studyId: string; membershipId: string }
    const auth = await requireStudyPermission(request, reply, studyId, 'member.manage')
    if (!auth) return
    if (!(await verifyCsrf(request, reply))) return
    if (!(await requireStudyStatus(studyId, ['draft', 'active'], request, reply))) return
    const parsed = updateMemberSchema.safeParse(request.body)
    if (!parsed.success)
      return reply
        .code(400)
        .send({ code: 'VALIDATION_ERROR', message: '成员权限配置不合法', requestId: request.id })
    const membership = await db
      .selectFrom('study_memberships')
      .selectAll()
      .where('id', '=', membershipId)
      .where('study_id', '=', studyId)
      .executeTakeFirst()
    if (!membership)
      return reply
        .code(404)
        .send({ code: 'MEMBER_NOT_FOUND', message: '项目成员不存在', requestId: request.id })
    try {
      await requireManageableTarget(auth, membership)
      await validateGrantScope(
        studyId,
        auth,
        parsed.data.roleCode,
        parsed.data.siteName,
        parsed.data.overrides,
      )
    } catch (error) {
      return reply.code(403).send({
        code: 'GRANT_SCOPE_EXCEEDED',
        message: (error as Error).message,
        requestId: request.id,
      })
    }
    if (
      membership.role_code === 'study_admin' &&
      (parsed.data.roleCode !== 'study_admin' || parsed.data.status !== 'active')
    ) {
      const otherActiveAdmin = await db
        .selectFrom('study_memberships')
        .select('id')
        .where('study_id', '=', studyId)
        .where('role_code', '=', 'study_admin')
        .where('status', '=', 'active')
        .where('id', '!=', membershipId)
        .executeTakeFirst()
      if (!otherActiveAdmin)
        return reply.code(409).send({
          code: 'LAST_STUDY_ADMIN_REQUIRED',
          message: '研究必须至少保留一名有效的研究项目管理员',
          requestId: request.id,
        })
    }
    const beforeSiteName = await membershipSiteName(membershipId)
    const now = new Date().toISOString()
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('study_memberships')
        .set({ role_code: parsed.data.roleCode, status: parsed.data.status, updated_at: now })
        .where('id', '=', membershipId)
        .execute()
      await trx.deleteFrom('membership_sites').where('membership_id', '=', membershipId).execute()
      await trx
        .deleteFrom('membership_permission_overrides')
        .where('membership_id', '=', membershipId)
        .execute()
      if (parsed.data.siteName)
        await trx
          .insertInto('membership_sites')
          .values({ membership_id: membershipId, site_name: parsed.data.siteName })
          .execute()
      if (parsed.data.overrides.length)
        await trx
          .insertInto('membership_permission_overrides')
          .values(
            parsed.data.overrides.map((item) => ({
              membership_id: membershipId,
              permission_code: item.permissionCode,
              effect: item.effect,
            })),
          )
          .execute()
    })
    await writeAudit({
      requestId: request.id,
      actorUserId: auth.user.id,
      studyId,
      siteName: parsed.data.siteName ?? beforeSiteName,
      objectType: 'study_membership',
      objectId: membershipId,
      action: 'member.updated',
      before: {
        roleCode: membership.role_code,
        status: membership.status,
        siteName: beforeSiteName,
      },
      after: parsed.data,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    })
    return { id: membershipId }
  })
}
