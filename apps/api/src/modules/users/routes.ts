import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { hashPassword, requireUser, verifyCsrf } from '../../auth/auth.js'
import { writeAudit } from '../../audit/audit.js'
import { sqlite } from '../../db/database.js'

const listSchema = z.object({
  query: z.string().trim().max(100).optional(),
  status: z.enum(['active', 'disabled', 'locked']).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
})
const statusSchema = z.object({ status: z.enum(['active', 'disabled']) })
const passwordSchema = z.object({ newPassword: z.string().min(12).max(512) })

async function requireSystemAdmin(
  request: Parameters<typeof requireUser>[0],
  reply: Parameters<typeof requireUser>[1],
) {
  const user = await requireUser(request, reply)
  if (!user) return null
  if (!user.isSystemAdmin) {
    await reply.code(403).send({
      code: 'SYSTEM_ADMIN_REQUIRED',
      message: '仅系统超级管理员可以管理全局账号',
      requestId: request.id,
    })
    return null
  }
  return user
}

export const userRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (request, reply) => {
    if (!(await requireSystemAdmin(request, reply))) return
    const parsed = listSchema.safeParse(request.query)
    if (!parsed.success)
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: '账号查询条件不合法',
        requestId: request.id,
      })
    const clauses = ['1 = 1']
    const values: unknown[] = []
    if (parsed.data.query) {
      clauses.push('(u.username LIKE ? OR u.display_name LIKE ?)')
      values.push(`%${parsed.data.query}%`, `%${parsed.data.query}%`)
    }
    if (parsed.data.status) {
      clauses.push('u.status = ?')
      values.push(parsed.data.status)
    }
    const total = (
      sqlite
        .prepare(`SELECT COUNT(*) AS value FROM users u WHERE ${clauses.join(' AND ')}`)
        .get(...values) as { value: number }
    ).value
    const items = sqlite
      .prepare(
        `SELECT u.id, u.username, u.display_name, u.is_system_admin, u.status,
                u.locale, u.theme, u.locked_until, u.created_at, u.updated_at,
                COUNT(DISTINCT m.study_id) AS study_count,
                GROUP_CONCAT(DISTINCT s.protocol_code) AS study_codes
         FROM users u
         LEFT JOIN study_memberships m ON m.user_id = u.id
         LEFT JOIN studies s ON s.id = m.study_id
         WHERE ${clauses.join(' AND ')}
         GROUP BY u.id
         ORDER BY u.created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...values, parsed.data.pageSize, (parsed.data.page - 1) * parsed.data.pageSize)
    return { items, total, page: parsed.data.page, pageSize: parsed.data.pageSize }
  })

  app.get('/login-audit', async (request, reply) => {
    if (!(await requireSystemAdmin(request, reply))) return
    const parsed = z
      .object({
        page: z.coerce.number().int().positive().default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(50),
      })
      .safeParse(request.query)
    if (!parsed.success)
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: '登录审计查询条件不合法',
        requestId: request.id,
      })
    const total = (
      sqlite
        .prepare(
          `SELECT COUNT(*) AS value FROM audit_events
           WHERE study_id IS NULL AND action IN ('auth.login_succeeded', 'auth.login_failed')`,
        )
        .get() as { value: number }
    ).value
    const rows = sqlite
      .prepare(
        `SELECT a.id, a.request_id, a.actor_user_id, a.action, a.after_json,
                a.ip_address, a.user_agent, a.created_at,
                u.username AS actor_username, u.display_name AS actor_name
         FROM audit_events a
         LEFT JOIN users u ON u.id = a.actor_user_id
         WHERE a.study_id IS NULL
           AND a.action IN ('auth.login_succeeded', 'auth.login_failed')
         ORDER BY a.created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(parsed.data.pageSize, (parsed.data.page - 1) * parsed.data.pageSize) as Array<{
      id: string
      request_id: string
      actor_user_id: string | null
      actor_username: string | null
      actor_name: string | null
      action: string
      after_json: string | null
      ip_address: string | null
      user_agent: string | null
      created_at: string
    }>
    const items = rows.map(({ after_json: afterJson, ...row }) => {
      let attemptedUsername: string | null = null
      try {
        const after = afterJson ? (JSON.parse(afterJson) as { username?: unknown }) : null
        if (typeof after?.username === 'string') attemptedUsername = after.username
      } catch {
        attemptedUsername = null
      }
      return { ...row, attemptedUsername: row.actor_username ?? attemptedUsername }
    })
    return { items, total, page: parsed.data.page, pageSize: parsed.data.pageSize }
  })

  app.put('/:userId/status', async (request, reply) => {
    const actor = await requireSystemAdmin(request, reply)
    if (!actor) return
    if (!(await verifyCsrf(request, reply))) return
    const userId = z
      .string()
      .uuid()
      .safeParse((request.params as { userId: string }).userId)
    const parsed = statusSchema.safeParse(request.body)
    if (!userId.success || !parsed.success)
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: '账号状态参数不合法',
        requestId: request.id,
      })
    if (userId.data === actor.id && parsed.data.status === 'disabled')
      return reply.code(409).send({
        code: 'SELF_DISABLE_FORBIDDEN',
        message: '不能停用当前登录的超级管理员账号',
        requestId: request.id,
      })
    const existing = sqlite
      .prepare('SELECT id, username, status FROM users WHERE id = ?')
      .get(userId.data) as { id: string; username: string; status: string } | undefined
    if (!existing)
      return reply
        .code(404)
        .send({ code: 'USER_NOT_FOUND', message: '账号不存在', requestId: request.id })
    sqlite.transaction(() => {
      sqlite
        .prepare(
          `UPDATE users
           SET status = ?, failed_login_count = 0, locked_until = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(parsed.data.status, new Date().toISOString(), userId.data)
      if (parsed.data.status === 'disabled')
        sqlite.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId.data)
    })()
    await writeAudit({
      requestId: request.id,
      actorUserId: actor.id,
      objectType: 'user',
      objectId: userId.data,
      action: `user.${parsed.data.status}`,
      before: { status: existing.status, username: existing.username },
      after: { status: parsed.data.status },
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    })
    return { id: userId.data, status: parsed.data.status }
  })

  app.post('/:userId/reset-password', async (request, reply) => {
    const actor = await requireSystemAdmin(request, reply)
    if (!actor) return
    if (!(await verifyCsrf(request, reply))) return
    const userId = z
      .string()
      .uuid()
      .safeParse((request.params as { userId: string }).userId)
    const parsed = passwordSchema.safeParse(request.body)
    if (!userId.success || !parsed.success)
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: '新密码至少需要 12 个字符',
        requestId: request.id,
      })
    const existing = sqlite.prepare('SELECT id, username FROM users WHERE id = ?').get(userId.data)
    if (!existing)
      return reply
        .code(404)
        .send({ code: 'USER_NOT_FOUND', message: '账号不存在', requestId: request.id })
    const passwordHash = await hashPassword(parsed.data.newPassword)
    sqlite.transaction(() => {
      sqlite
        .prepare(
          `UPDATE users
           SET password_hash = ?, failed_login_count = 0, locked_until = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(passwordHash, new Date().toISOString(), userId.data)
      sqlite.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId.data)
    })()
    await writeAudit({
      requestId: request.id,
      actorUserId: actor.id,
      objectType: 'user',
      objectId: userId.data,
      action: 'user.password_reset',
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    })
    return reply.code(204).send()
  })
}
