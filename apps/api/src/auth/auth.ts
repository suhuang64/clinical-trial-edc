import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import argon2 from 'argon2'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { config } from '../config.js'
import { db } from '../db/database.js'

export interface AuthenticatedUser {
  id: string
  username: string
  displayName: string
  isSystemAdmin: boolean
  locale: 'zh-CN' | 'en-US'
  theme: 'light' | 'dark' | 'system'
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

export async function hashPassword(password: string) {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  })
}

export async function verifyPassword(hash: string, password: string) {
  try {
    return await argon2.verify(hash, password)
  } catch {
    return false
  }
}

export async function createSession(userId: string) {
  const token = randomBytes(32).toString('base64url')
  const csrfToken = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3_600_000).toISOString()
  await db
    .insertInto('sessions')
    .values({
      id: randomUUID(),
      user_id: userId,
      token_hash: sha256(token),
      csrf_token_hash: sha256(csrfToken),
      expires_at: expiresAt,
      last_seen_at: new Date().toISOString(),
    })
    .execute()
  return { token, csrfToken, expiresAt }
}

export async function getAuthenticatedUser(
  request: FastifyRequest,
): Promise<AuthenticatedUser | null> {
  const token = request.cookies[config.sessionCookieName]
  if (!token) return null
  const row = await db
    .selectFrom('sessions')
    .innerJoin('users', 'users.id', 'sessions.user_id')
    .select([
      'users.id',
      'users.username',
      'users.display_name',
      'users.is_system_admin',
      'users.locale',
      'users.theme',
      'users.status',
      'sessions.expires_at',
    ])
    .where('sessions.token_hash', '=', sha256(token))
    .executeTakeFirst()
  if (!row || row.status !== 'active' || new Date(row.expires_at).getTime() <= Date.now())
    return null
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    isSystemAdmin: row.is_system_admin === 1,
    locale: row.locale,
    theme: row.theme,
  }
}

export async function requireUser(request: FastifyRequest, reply: FastifyReply) {
  const user = await getAuthenticatedUser(request)
  if (!user) {
    await reply
      .code(401)
      .send({ code: 'AUTH_REQUIRED', message: '请先登录', requestId: request.id })
    return null
  }
  return user
}

export async function verifyCsrf(request: FastifyRequest, reply: FastifyReply) {
  const token = request.cookies[config.sessionCookieName]
  const csrf = request.headers['x-csrf-token']
  if (!token || typeof csrf !== 'string') {
    await reply.code(403).send({
      code: 'CSRF_INVALID',
      message: '请求验证失败，请刷新页面后重试',
      requestId: request.id,
    })
    return false
  }
  const row = await db
    .selectFrom('sessions')
    .select('csrf_token_hash')
    .where('token_hash', '=', sha256(token))
    .executeTakeFirst()
  const actual = Buffer.from(row?.csrf_token_hash ?? '', 'utf8')
  const expected = Buffer.from(sha256(csrf), 'utf8')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    await reply.code(403).send({
      code: 'CSRF_INVALID',
      message: '请求验证失败，请刷新页面后重试',
      requestId: request.id,
    })
    return false
  }
  return true
}

export async function revokeSession(request: FastifyRequest) {
  const token = request.cookies[config.sessionCookieName]
  if (token) await db.deleteFrom('sessions').where('token_hash', '=', sha256(token)).execute()
}

export async function rotateCsrfToken(request: FastifyRequest) {
  const token = request.cookies[config.sessionCookieName]
  if (!token) return null
  const csrfToken = randomBytes(32).toString('base64url')
  const result = await db
    .updateTable('sessions')
    .set({ csrf_token_hash: sha256(csrfToken), last_seen_at: new Date().toISOString() })
    .where('token_hash', '=', sha256(token))
    .executeTakeFirst()
  return Number(result.numUpdatedRows) > 0 ? csrfToken : null
}
