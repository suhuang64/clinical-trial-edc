import type { FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/database.js'
import { requireUser, type AuthenticatedUser } from './auth.js'

export interface StudyAuthorization {
  user: AuthenticatedUser
  membershipId: string | null
  roleCode: string | null
  allowedSiteIds: string[] | null
}

export type StudyStatus = 'draft' | 'active' | 'ended' | 'archived'

export async function requireStudyPermission(
  request: FastifyRequest,
  reply: FastifyReply,
  studyId: string,
  permissionCode: string,
): Promise<StudyAuthorization | null> {
  const user = await requireUser(request, reply)
  if (!user) return null
  if (user.isSystemAdmin) return { user, membershipId: null, roleCode: null, allowedSiteIds: null }

  const membership = await db
    .selectFrom('study_memberships')
    .select(['id', 'role_code'])
    .where('study_id', '=', studyId)
    .where('user_id', '=', user.id)
    .where('status', '=', 'active')
    .executeTakeFirst()
  if (!membership) {
    await reply
      .code(403)
      .send({ code: 'STUDY_ACCESS_DENIED', message: '您无权访问该研究项目', requestId: request.id })
    return null
  }
  const override = await db
    .selectFrom('membership_permission_overrides')
    .select('effect')
    .where('membership_id', '=', membership.id)
    .where('permission_code', '=', permissionCode)
    .executeTakeFirst()
  const roleGrant = await db
    .selectFrom('role_permissions')
    .select('permission_code')
    .where('role_code', '=', membership.role_code)
    .where('permission_code', '=', permissionCode)
    .executeTakeFirst()
  const allowed = override?.effect !== 'deny' && Boolean(roleGrant)
  if (!allowed) {
    await reply.code(403).send({
      code: 'PERMISSION_DENIED',
      message: `缺少权限：${permissionCode}`,
      requestId: request.id,
    })
    return null
  }
  const sites = await db
    .selectFrom('membership_sites')
    .select('site_id')
    .where('membership_id', '=', membership.id)
    .execute()
  return {
    user,
    membershipId: membership.id,
    roleCode: membership.role_code,
    allowedSiteIds:
      membership.role_code === 'study_admin' ? null : sites.map((site) => site.site_id),
  }
}

export async function resolveMembershipPermissions(membershipId: string, roleCode: string) {
  const [roleRows, overrideRows] = await Promise.all([
    db
      .selectFrom('role_permissions')
      .select('permission_code')
      .where('role_code', '=', roleCode)
      .execute(),
    db
      .selectFrom('membership_permission_overrides')
      .select(['permission_code', 'effect'])
      .where('membership_id', '=', membershipId)
      .execute(),
  ])
  const permissions = new Set(roleRows.map((row) => row.permission_code))
  for (const override of overrideRows) {
    if (override.effect === 'deny') permissions.delete(override.permission_code)
  }
  return permissions
}

export async function requireAllowedSite(
  authorization: StudyAuthorization,
  siteId: string,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (authorization.allowedSiteIds === null || authorization.allowedSiteIds.includes(siteId))
    return true
  await reply
    .code(403)
    .send({ code: 'SITE_ACCESS_DENIED', message: '您无权访问该研究中心', requestId: request.id })
  return false
}

export async function requireStudyStatus(
  studyId: string,
  allowedStatuses: StudyStatus[],
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const study = await db
    .selectFrom('studies')
    .select('status')
    .where('id', '=', studyId)
    .executeTakeFirst()
  if (!study) {
    await reply
      .code(404)
      .send({ code: 'STUDY_NOT_FOUND', message: '研究项目不存在', requestId: request.id })
    return false
  }
  if (allowedStatuses.includes(study.status as StudyStatus)) return true
  const draft = study.status === 'draft'
  await reply.code(409).send({
    code: draft ? 'STUDY_NOT_ACTIVE' : 'STUDY_READ_ONLY',
    message: draft
      ? '研究尚未启动，当前操作只允许项目配置'
      : study.status === 'ended'
        ? '研究已结束，当前操作只允许查看或导出'
        : '研究已归档，当前操作只允许授权查询',
    requestId: request.id,
  })
  return false
}

export async function requireActiveSite(
  studyId: string,
  siteId: string,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const site = await db
    .selectFrom('sites')
    .select('status')
    .where('study_id', '=', studyId)
    .where('id', '=', siteId)
    .executeTakeFirst()
  if (!site) {
    await reply
      .code(404)
      .send({ code: 'SITE_NOT_FOUND', message: '研究中心不存在', requestId: request.id })
    return false
  }
  if (site.status === 'active') return true
  await reply.code(409).send({
    code: 'SITE_DISABLED',
    message: '研究中心已停用，不能继续新增或修改业务数据',
    requestId: request.id,
  })
  return false
}
