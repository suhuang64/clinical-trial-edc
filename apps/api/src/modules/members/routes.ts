import { randomUUID } from 'node:crypto'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { hashPassword, verifyCsrf } from '../../auth/auth.js'
import {
  requireStudyPermission,
  requireStudyStatus,
  resolveMembershipPermissions,
} from '../../auth/permissions.js'
import { writeAudit } from '../../audit/audit.js'
import { db } from '../../db/database.js'

const overrideSchema = z.object({
  permissionCode: z.string().min(1).max(100),
  effect: z.enum(['allow', 'deny']),
})
const memberSchema = z.object({
  username: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._-]{3,64}$/),
  displayName: z.string().trim().min(1).max(100),
  initialPassword: z.string().min(12).max(512).optional(),
  roleCode: z.enum(['study_admin', 'site_admin', 'investigator', 'readonly']),
  siteIds: z.array(z.string().uuid()).max(100).default([]),
  overrides: z.array(overrideSchema).max(100).default([]),
})
const updateMemberSchema = memberSchema
  .pick({ roleCode: true, siteIds: true, overrides: true })
  .extend({ status: z.enum(['active', 'disabled']).default('active') })
const resetPasswordSchema = z.object({ newPassword: z.string().min(12).max(512) })

async function validateGrantScope(
  studyId: string,
  auth: NonNullable<Awaited<ReturnType<typeof requireStudyPermission>>>,
  roleCode: string,
  siteIds: string[],
  overrides: z.infer<typeof overrideSchema>[],
) {
  if (
    !auth.user.isSystemAdmin &&
    auth.roleCode === 'site_admin' &&
    !['site_admin', 'investigator', 'readonly'].includes(roleCode)
  ) {
    throw new Error('中心管理员不能授予项目管理员角色')
  }
  if (auth.allowedSiteIds && siteIds.some((siteId) => !auth.allowedSiteIds!.includes(siteId))) {
    throw new Error('不能授权当前账号作用域之外的中心')
  }
  if (roleCode !== 'study_admin' && siteIds.length === 0)
    throw new Error('中心级角色至少需要选择一个中心')
  if (siteIds.length) {
    const validSites = await db
      .selectFrom('sites')
      .select('id')
      .where('study_id', '=', studyId)
      .where('id', 'in', siteIds)
      .where('status', '=', 'active')
      .execute()
    if (validSites.length !== new Set(siteIds).size) throw new Error('包含不属于当前研究的中心')
  }
  if (!auth.user.isSystemAdmin && auth.membershipId && auth.roleCode) {
    const callerPermissions = await resolveMembershipPermissions(auth.membershipId, auth.roleCode)
    if (
      overrides.some(
        (item) => item.effect === 'allow' && !callerPermissions.has(item.permissionCode),
      )
    ) {
      throw new Error('不能授予当前账号自身不具备的权限')
    }
  }
  const permissionCodes = new Set(
    (await db.selectFrom('permissions').select('code').execute()).map((row) => row.code),
  )
  if (overrides.some((item) => !permissionCodes.has(item.permissionCode)))
    throw new Error('包含未知权限项')
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
      grantableRoleCodes:
        auth.user.isSystemAdmin || auth.roleCode === 'study_admin'
          ? ['study_admin', 'site_admin', 'investigator', 'readonly']
          : ['site_admin', 'investigator', 'readonly'],
      items: permissionRows.map((permission) => ({
        code: permission.code,
        domain: permission.domain,
        nameZh: permission.name_zh,
        nameEn: permission.name_en,
        defaultRoleCodes: defaults.get(permission.code) ?? [],
      })),
    }
  })

  app.get('/', async (request, reply) => {
    const studyId = (request.params as { studyId: string }).studyId
    const auth = await requireStudyPermission(request, reply, studyId, 'member.view')
    if (!auth) return
    const memberships = await db
      .selectFrom('study_memberships as m')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .select([
        'm.id',
        'm.user_id',
        'm.role_code',
        'm.status',
        'u.username',
        'u.display_name',
        'u.status as user_status',
      ])
      .where('m.study_id', '=', studyId)
      .orderBy('u.display_name')
      .execute()
    const items = await Promise.all(
      memberships.map(async (membership) => {
        const [sites, overrides] = await Promise.all([
          db
            .selectFrom('membership_sites')
            .select('site_id')
            .where('membership_id', '=', membership.id)
            .execute(),
          db
            .selectFrom('membership_permission_overrides')
            .select(['permission_code', 'effect'])
            .where('membership_id', '=', membership.id)
            .execute(),
        ])
        return {
          ...membership,
          siteIds: sites.map((site) => site.site_id),
          overrides: overrides.map((override) => ({
            permissionCode: override.permission_code,
            effect: override.effect,
          })),
        }
      }),
    )
    const visible =
      auth.allowedSiteIds === null
        ? items
        : items.filter((item) =>
            item.siteIds.some((siteId) => auth.allowedSiteIds!.includes(siteId)),
          )
    return { items: visible }
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
        parsed.data.siteIds,
        parsed.data.overrides,
      )
    } catch (error) {
      return reply.code(403).send({
        code: 'GRANT_SCOPE_EXCEEDED',
        message: (error as Error).message,
        requestId: request.id,
      })
    }

    let user = await db
      .selectFrom('users')
      .selectAll()
      .where('username', '=', parsed.data.username)
      .executeTakeFirst()
    if (!user && !parsed.data.initialPassword)
      return reply.code(400).send({
        code: 'INITIAL_PASSWORD_REQUIRED',
        message: '新账号必须设置至少 12 位的初始密码',
        requestId: request.id,
      })
    if (user?.status !== undefined && user.status !== 'active')
      return reply.code(409).send({
        code: 'USER_NOT_ACTIVE',
        message: '该全局账号已被禁用或锁定',
        requestId: request.id,
      })
    const now = new Date().toISOString(),
      membershipId = randomUUID()
    if (!user) {
      const userId = randomUUID()
      await db
        .insertInto('users')
        .values({
          id: userId,
          username: parsed.data.username,
          display_name: parsed.data.displayName,
          password_hash: await hashPassword(parsed.data.initialPassword!),
          is_system_admin: 0,
          status: 'active',
          failed_login_count: 0,
          locked_until: null,
          locale: 'zh-CN',
          theme: 'system',
          created_at: now,
          updated_at: now,
        })
        .execute()
      user = await db
        .selectFrom('users')
        .selectAll()
        .where('id', '=', userId)
        .executeTakeFirstOrThrow()
    }
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

    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('study_memberships')
        .values({
          id: membershipId,
          study_id: studyId,
          user_id: user!.id,
          role_code: parsed.data.roleCode,
          status: 'active',
          created_at: now,
          updated_at: now,
        })
        .execute()
      if (parsed.data.siteIds.length)
        await trx
          .insertInto('membership_sites')
          .values(
            parsed.data.siteIds.map((siteId) => ({ membership_id: membershipId, site_id: siteId })),
          )
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
      objectType: 'study_membership',
      objectId: membershipId,
      action: 'member.created',
      after: {
        userId: user.id,
        roleCode: parsed.data.roleCode,
        siteIds: parsed.data.siteIds,
        overrides: parsed.data.overrides,
      },
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
    try {
      await validateGrantScope(
        studyId,
        auth,
        parsed.data.roleCode,
        parsed.data.siteIds,
        parsed.data.overrides,
      )
    } catch (error) {
      return reply.code(403).send({
        code: 'GRANT_SCOPE_EXCEEDED',
        message: (error as Error).message,
        requestId: request.id,
      })
    }
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
      if (parsed.data.siteIds.length)
        await trx
          .insertInto('membership_sites')
          .values(
            parsed.data.siteIds.map((siteId) => ({ membership_id: membershipId, site_id: siteId })),
          )
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
      objectType: 'study_membership',
      objectId: membershipId,
      action: 'member.updated',
      before: { roleCode: membership.role_code, status: membership.status },
      after: parsed.data,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    })
    return { id: membershipId }
  })

  app.post('/:membershipId/reset-password', async (request, reply) => {
    const { studyId, membershipId } = request.params as { studyId: string; membershipId: string }
    const auth = await requireStudyPermission(request, reply, studyId, 'member.manage')
    if (!auth) return
    if (!(await verifyCsrf(request, reply))) return
    if (!(await requireStudyStatus(studyId, ['draft', 'active'], request, reply))) return
    const parsed = resetPasswordSchema.safeParse(request.body)
    if (!parsed.success)
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: '新密码至少需要 12 个字符',
        requestId: request.id,
      })
    const membership = await db
      .selectFrom('study_memberships')
      .select(['id', 'user_id'])
      .where('id', '=', membershipId)
      .where('study_id', '=', studyId)
      .executeTakeFirst()
    if (!membership)
      return reply
        .code(404)
        .send({ code: 'MEMBER_NOT_FOUND', message: '项目成员不存在', requestId: request.id })
    const now = new Date().toISOString()
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('users')
        .set({
          password_hash: await hashPassword(parsed.data.newPassword),
          failed_login_count: 0,
          locked_until: null,
          updated_at: now,
        })
        .where('id', '=', membership.user_id)
        .execute()
      await trx.deleteFrom('sessions').where('user_id', '=', membership.user_id).execute()
    })
    await writeAudit({
      requestId: request.id,
      actorUserId: auth.user.id,
      studyId,
      objectType: 'user',
      objectId: membership.user_id,
      action: 'member.password_reset',
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    })
    return reply.code(204).send()
  })
}
