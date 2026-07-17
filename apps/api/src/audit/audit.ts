import { randomUUID } from 'node:crypto'
import { db } from '../db/database.js'

export interface AuditInput {
  requestId: string
  actorUserId?: string | null | undefined
  studyId?: string | null | undefined
  siteId?: string | null | undefined
  subjectId?: string | null | undefined
  objectType: string
  objectId?: string | null | undefined
  action: string
  before?: unknown
  after?: unknown
  reason?: string | null | undefined
  ipAddress?: string | null | undefined
  userAgent?: string | null | undefined
}

function safeJson(value: unknown) {
  if (value === undefined) return null
  return JSON.stringify(value, (key, item) =>
    ['password', 'passwordHash', 'token', 'csrfToken', 'seed'].includes(key) ? '[REDACTED]' : item,
  )
}

export async function writeAudit(input: AuditInput) {
  const site = input.siteId
    ? await db.selectFrom('sites').select('name').where('id', '=', input.siteId).executeTakeFirst()
    : null
  await db
    .insertInto('audit_events')
    .values({
      id: randomUUID(),
      request_id: input.requestId,
      actor_user_id: input.actorUserId ?? null,
      study_id: input.studyId ?? null,
      site_id: input.siteId ?? null,
      site_name_snapshot: site?.name ?? null,
      subject_id: input.subjectId ?? null,
      object_type: input.objectType,
      object_id: input.objectId ?? null,
      action: input.action,
      before_json: safeJson(input.before),
      after_json: safeJson(input.after),
      reason: input.reason ?? null,
      ip_address: input.ipAddress ?? null,
      user_agent: input.userAgent ?? null,
      created_at: new Date().toISOString(),
    })
    .execute()
}
