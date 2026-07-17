import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { config } from '../../config.js'
import { db } from '../../db/database.js'
import {
  createSession,
  getAuthenticatedUser,
  hashPassword,
  requireUser,
  revokeSession,
  rotateCsrfToken,
  verifyCsrf,
  verifyPassword,
} from '../../auth/auth.js'
import { writeAudit } from '../../audit/audit.js'

const loginSchema = z.object({
  username: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(512),
})
const preferenceSchema = z.object({
  locale: z.enum(['zh-CN', 'en-US']),
  theme: z.enum(['light', 'dark', 'system']),
})
const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(512),
    newPassword: z.string().min(12).max(512),
  })
  .refine((value) => value.currentPassword !== value.newPassword, {
    path: ['newPassword'],
    message: '新密码不能与当前密码相同',
  })

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = loginSchema.safeParse(request.body)
      if (!parsed.success)
        return reply.code(400).send({
          code: 'VALIDATION_ERROR',
          message: '请输入用户名和密码',
          details: parsed.error.flatten(),
          requestId: request.id,
        })
      const user = await db
        .selectFrom('users')
        .selectAll()
        .where('username', '=', parsed.data.username)
        .executeTakeFirst()
      const valid =
        user?.status === 'active' &&
        (!user.locked_until || new Date(user.locked_until).getTime() <= Date.now()) &&
        (await verifyPassword(user.password_hash, parsed.data.password))

      if (!user || !valid) {
        if (user) {
          const failures = user.failed_login_count + 1
          const lockedUntil =
            failures >= 5 ? new Date(Date.now() + 15 * 60_000).toISOString() : null
          await db
            .updateTable('users')
            .set({
              failed_login_count: failures,
              locked_until: lockedUntil,
              updated_at: new Date().toISOString(),
            })
            .where('id', '=', user.id)
            .execute()
        }
        await writeAudit({
          requestId: request.id,
          actorUserId: user?.id,
          objectType: 'session',
          action: 'auth.login_failed',
          after: { username: parsed.data.username },
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'],
        })
        return reply
          .code(401)
          .send({ code: 'INVALID_CREDENTIALS', message: '用户名或密码错误', requestId: request.id })
      }

      await db
        .updateTable('users')
        .set({ failed_login_count: 0, locked_until: null, updated_at: new Date().toISOString() })
        .where('id', '=', user.id)
        .execute()
      const session = await createSession(user.id)
      reply.setCookie(config.sessionCookieName, session.token, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: config.isProduction,
        expires: new Date(session.expiresAt),
      })
      await writeAudit({
        requestId: request.id,
        actorUserId: user.id,
        objectType: 'session',
        action: 'auth.login_succeeded',
        after: { username: user.username },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
      })
      return {
        user: {
          id: user.id,
          username: user.username,
          displayName: user.display_name,
          isSystemAdmin: user.is_system_admin === 1,
          locale: user.locale,
          theme: user.theme,
        },
        csrfToken: session.csrfToken,
      }
    },
  )

  app.get('/me', async (request, reply) => {
    const user = await getAuthenticatedUser(request)
    if (!user)
      return reply
        .code(401)
        .send({ code: 'AUTH_REQUIRED', message: '请先登录', requestId: request.id })
    return { user, csrfToken: await rotateCsrfToken(request) }
  })

  app.post('/logout', async (request, reply) => {
    const user = await getAuthenticatedUser(request)
    if (user && !(await verifyCsrf(request, reply))) return
    await revokeSession(request)
    reply.clearCookie(config.sessionCookieName, { path: '/' })
    await writeAudit({
      requestId: request.id,
      actorUserId: user?.id,
      objectType: 'session',
      action: 'auth.logout',
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    })
    return reply.code(204).send()
  })

  app.put('/preferences', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (!user) return
    if (!(await verifyCsrf(request, reply))) return
    const parsed = preferenceSchema.safeParse(request.body)
    if (!parsed.success)
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: '界面偏好设置不合法',
        details: parsed.error.flatten(),
        requestId: request.id,
      })
    await db
      .updateTable('users')
      .set({ ...parsed.data, updated_at: new Date().toISOString() })
      .where('id', '=', user.id)
      .execute()
    await writeAudit({
      requestId: request.id,
      actorUserId: user.id,
      objectType: 'user_preference',
      objectId: user.id,
      action: 'user.preferences_updated',
      before: { locale: user.locale, theme: user.theme },
      after: parsed.data,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    })
    return { user: { ...user, ...parsed.data } }
  })

  app.post('/change-password', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (!user) return
    if (!(await verifyCsrf(request, reply))) return
    const parsed = changePasswordSchema.safeParse(request.body)
    if (!parsed.success)
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: '密码修改信息不合法',
        details: parsed.error.flatten(),
        requestId: request.id,
      })
    const stored = await db
      .selectFrom('users')
      .select('password_hash')
      .where('id', '=', user.id)
      .executeTakeFirstOrThrow()
    if (!(await verifyPassword(stored.password_hash, parsed.data.currentPassword)))
      return reply.code(400).send({
        code: 'CURRENT_PASSWORD_INVALID',
        message: '当前密码不正确',
        requestId: request.id,
      })
    const passwordHash = await hashPassword(parsed.data.newPassword)
    await db.transaction().execute(async (transaction) => {
      await transaction
        .updateTable('users')
        .set({
          password_hash: passwordHash,
          updated_at: new Date().toISOString(),
        })
        .where('id', '=', user.id)
        .execute()
      await transaction.deleteFrom('sessions').where('user_id', '=', user.id).execute()
    })
    reply.clearCookie(config.sessionCookieName, { path: '/' })
    await writeAudit({
      requestId: request.id,
      actorUserId: user.id,
      objectType: 'user',
      objectId: user.id,
      action: 'user.password_changed',
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    })
    return reply.code(204).send()
  })
}
