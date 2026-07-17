import { createHash, randomUUID } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, extname, resolve, sep } from 'node:path'
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { verifyCsrf } from '../../auth/auth.js'
import {
  requireActiveSite,
  requireAllowedSite,
  requireStudyPermission,
  requireStudyStatus,
} from '../../auth/permissions.js'
import { config } from '../../config.js'
import { sqlite } from '../../db/database.js'

const MAX_FILE_SIZE = 20 * 1024 * 1024
const allowedExtensions = new Set([
  '.pdf',
  '.jpg',
  '.jpeg',
  '.png',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
])
const fieldKeySchema = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/)
const uploadQuerySchema = z.object({ recordId: z.string().uuid().optional() })
const listQuerySchema = z.object({
  recordId: z.string().uuid().optional(),
  fieldKey: fieldKeySchema.optional(),
  ids: z.string().max(4000).optional(),
})

interface SubjectRow {
  id: string
  study_id: string
  site_id: string
}

export interface FileRow {
  id: string
  study_id: string
  site_id: string
  subject_id: string
  record_id: string | null
  field_key: string
  original_name: string
  storage_path: string
  mime_type: string
  size_bytes: number
  sha256: string
  uploaded_by: string
  created_at: string
}

export interface QuarantinedFile {
  row: FileRow
  originalPath: string
  quarantinePath: string
}

function safeStoragePath(root: string, relativePath: string) {
  const normalizedRoot = resolve(root)
  const target = resolve(normalizedRoot, relativePath)
  if (target !== normalizedRoot && !target.startsWith(`${normalizedRoot}${sep}`)) {
    throw new Error('文件路径超出存储目录')
  }
  return target
}

function auditInsert(input: {
  request: FastifyRequest
  actorUserId: string
  studyId: string
  siteId: string
  subjectId: string
  objectId: string
  action: string
  before?: unknown
  after?: unknown
}) {
  sqlite
    .prepare(
      `INSERT INTO audit_events
       (id, request_id, actor_user_id, study_id, site_id, subject_id, object_type, object_id, action,
        before_json, after_json, reason, ip_address, user_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'uploaded_file', ?, ?, ?, ?, NULL, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      input.request.id,
      input.actorUserId,
      input.studyId,
      input.siteId,
      input.subjectId,
      input.objectId,
      input.action,
      input.before === undefined ? null : JSON.stringify(input.before),
      input.after === undefined ? null : JSON.stringify(input.after),
      input.request.ip,
      input.request.headers['user-agent'] ?? null,
      new Date().toISOString(),
    )
}

async function authorizeSubject(
  request: FastifyRequest,
  reply: Parameters<typeof requireStudyPermission>[1],
  permission: string,
) {
  const { studyId, subjectId } = request.params as { studyId: string; subjectId: string }
  const auth = await requireStudyPermission(request, reply, studyId, permission)
  if (!auth) return null
  const subject = sqlite
    .prepare('SELECT id, study_id, site_id FROM subjects WHERE study_id = ? AND id = ?')
    .get(studyId, subjectId) as SubjectRow | undefined
  if (!subject) {
    await reply
      .code(404)
      .send({ code: 'SUBJECT_NOT_FOUND', message: '受试者不存在', requestId: request.id })
    return null
  }
  if (!(await requireAllowedSite(auth, subject.site_id, request, reply))) return null
  return { auth, subject }
}

function publicFile(row: FileRow) {
  return {
    id: row.id,
    recordId: row.record_id,
    fieldKey: row.field_key,
    originalName: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    createdAt: row.created_at,
  }
}

function quarantineRows(rows: FileRow[]): QuarantinedFile[] {
  const quarantined: QuarantinedFile[] = []
  mkdirSync(config.quarantineRoot, { recursive: true })
  try {
    for (const row of rows) {
      const originalPath = safeStoragePath(config.uploadRoot, row.storage_path)
      if (!existsSync(originalPath)) throw new Error(`Missing file ${row.id}`)
      const quarantinePath = safeStoragePath(
        config.quarantineRoot,
        `${row.id}--${basename(row.storage_path)}`,
      )
      renameSync(originalPath, quarantinePath)
      quarantined.push({ row, originalPath, quarantinePath })
    }
    return quarantined
  } catch (error) {
    restoreQuarantinedFiles(quarantined)
    throw error
  }
}

export function quarantineFilesForRecord(recordId: string): QuarantinedFile[] {
  const rows = sqlite
    .prepare('SELECT * FROM uploaded_files WHERE record_id = ? ORDER BY created_at')
    .all(recordId) as FileRow[]
  return quarantineRows(rows)
}

export function quarantineFilesForSubject(
  studyId: string,
  siteId: string,
  subjectId: string,
): QuarantinedFile[] {
  const rows = sqlite
    .prepare(
      `SELECT * FROM uploaded_files
       WHERE study_id = ? AND site_id = ? AND subject_id = ? ORDER BY created_at`,
    )
    .all(studyId, siteId, subjectId) as FileRow[]
  return quarantineRows(rows)
}

export function restoreQuarantinedFiles(files: QuarantinedFile[]) {
  for (const file of [...files].reverse()) {
    if (!existsSync(file.quarantinePath) || existsSync(file.originalPath)) continue
    mkdirSync(dirname(file.originalPath), { recursive: true })
    renameSync(file.quarantinePath, file.originalPath)
  }
}

export function purgeQuarantinedFiles(files: QuarantinedFile[]) {
  for (const file of files) {
    if (existsSync(file.quarantinePath)) unlinkSync(file.quarantinePath)
  }
}

export function recoverQuarantinedFiles() {
  mkdirSync(config.uploadRoot, { recursive: true })
  mkdirSync(config.quarantineRoot, { recursive: true })
  for (const entry of readdirSync(config.quarantineRoot, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    const match = /^([0-9a-f-]{36})--/i.exec(entry.name)
    const quarantinePath = safeStoragePath(config.quarantineRoot, entry.name)
    if (!match) {
      unlinkSync(quarantinePath)
      continue
    }
    const row = sqlite
      .prepare('SELECT storage_path FROM uploaded_files WHERE id = ?')
      .get(match[1]) as { storage_path: string } | undefined
    if (!row) {
      unlinkSync(quarantinePath)
      continue
    }
    const originalPath = safeStoragePath(config.uploadRoot, row.storage_path)
    mkdirSync(dirname(originalPath), { recursive: true })
    if (existsSync(originalPath)) unlinkSync(quarantinePath)
    else renameSync(quarantinePath, originalPath)
  }
}

export const fileRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (request, reply) => {
    const authorization = await authorizeSubject(request, reply, 'data.view')
    if (!authorization) return
    const parsed = listQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: '文件查询条件不合法',
        requestId: request.id,
      })
    }
    const { subject } = authorization
    const clauses = ['study_id = ?', 'site_id = ?', 'subject_id = ?']
    const values: unknown[] = [subject.study_id, subject.site_id, subject.id]
    if (parsed.data.recordId) {
      clauses.push('record_id = ?')
      values.push(parsed.data.recordId)
    }
    if (parsed.data.fieldKey) {
      clauses.push('field_key = ?')
      values.push(parsed.data.fieldKey)
    }
    if (parsed.data.ids) {
      const ids = [
        ...new Set(
          parsed.data.ids.split(',').filter((id) => z.string().uuid().safeParse(id).success),
        ),
      ].slice(0, 100)
      if (!ids.length) return { items: [] }
      clauses.push(`id IN (${ids.map(() => '?').join(',')})`)
      values.push(...ids)
    }
    const rows = sqlite
      .prepare(`SELECT * FROM uploaded_files WHERE ${clauses.join(' AND ')} ORDER BY created_at`)
      .all(...values) as FileRow[]
    return { items: rows.map(publicFile) }
  })

  app.post('/:fieldKey', async (request, reply) => {
    const authorization = await authorizeSubject(request, reply, 'file.upload')
    if (!authorization) return
    if (!(await verifyCsrf(request, reply))) return
    const { auth, subject } = authorization
    if (!(await requireStudyStatus(subject.study_id, ['active'], request, reply))) return
    if (!(await requireActiveSite(subject.study_id, subject.site_id, request, reply))) return
    const fieldKey = fieldKeySchema.safeParse((request.params as { fieldKey: string }).fieldKey)
    const query = uploadQuerySchema.safeParse(request.query)
    if (!fieldKey.success || !query.success) {
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: '文件字段或关联记录不合法',
        requestId: request.id,
      })
    }
    if (query.data.recordId) {
      const record = sqlite
        .prepare(
          'SELECT id FROM data_records WHERE study_id = ? AND site_id = ? AND subject_id = ? AND id = ?',
        )
        .get(subject.study_id, subject.site_id, subject.id, query.data.recordId)
      if (!record) {
        return reply.code(404).send({
          code: 'RECORD_NOT_FOUND',
          message: '关联数据记录不存在',
          requestId: request.id,
        })
      }
    }
    let part
    try {
      part = await request.file({ limits: { fileSize: MAX_FILE_SIZE, files: 1 } })
    } catch {
      return reply.code(413).send({
        code: 'FILE_TOO_LARGE',
        message: '单个文件不能超过 20 MB',
        requestId: request.id,
      })
    }
    if (!part) {
      return reply
        .code(400)
        .send({ code: 'FILE_REQUIRED', message: '请选择要上传的文件', requestId: request.id })
    }
    const originalName = basename(part.filename || 'file')
    const extension = extname(originalName).toLowerCase()
    if (!allowedExtensions.has(extension)) {
      return reply.code(415).send({
        code: 'FILE_TYPE_NOT_ALLOWED',
        message: '仅支持 PDF、常用图片、Word 和 Excel 文件',
        requestId: request.id,
      })
    }
    let buffer: Buffer
    try {
      buffer = await part.toBuffer()
    } catch {
      return reply.code(413).send({
        code: 'FILE_TOO_LARGE',
        message: '单个文件不能超过 20 MB',
        requestId: request.id,
      })
    }
    if (buffer.length > MAX_FILE_SIZE) {
      return reply.code(413).send({
        code: 'FILE_TOO_LARGE',
        message: '单个文件不能超过 20 MB',
        requestId: request.id,
      })
    }
    const id = randomUUID()
    const relativePath = `${subject.study_id}/${subject.site_id}/${subject.id}/${id}${extension}`
    const absolutePath = safeStoragePath(config.uploadRoot, relativePath)
    const sha256 = createHash('sha256').update(buffer).digest('hex')
    const now = new Date().toISOString()
    mkdirSync(dirname(absolutePath), { recursive: true })
    try {
      writeFileSync(absolutePath, buffer, { flag: 'wx' })
      sqlite.transaction(() => {
        sqlite
          .prepare(
            `INSERT INTO uploaded_files
             (id, study_id, site_id, subject_id, record_id, field_key, original_name,
              storage_path, mime_type, size_bytes, sha256, uploaded_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            subject.study_id,
            subject.site_id,
            subject.id,
            query.data.recordId ?? null,
            fieldKey.data,
            originalName,
            relativePath,
            part.mimetype || 'application/octet-stream',
            buffer.length,
            sha256,
            auth.user.id,
            now,
          )
        auditInsert({
          request,
          actorUserId: auth.user.id,
          studyId: subject.study_id,
          siteId: subject.site_id,
          subjectId: subject.id,
          objectId: id,
          action: 'file.uploaded',
          after: { fieldKey: fieldKey.data, originalName, sizeBytes: buffer.length, sha256 },
        })
      })()
    } catch (error) {
      if (existsSync(absolutePath)) unlinkSync(absolutePath)
      request.log.error(error)
      return reply.code(500).send({
        code: 'FILE_UPLOAD_FAILED',
        message: '文件保存失败',
        requestId: request.id,
      })
    }
    return reply.code(201).send(
      publicFile({
        id,
        study_id: subject.study_id,
        site_id: subject.site_id,
        subject_id: subject.id,
        record_id: query.data.recordId ?? null,
        field_key: fieldKey.data,
        original_name: originalName,
        storage_path: relativePath,
        mime_type: part.mimetype || 'application/octet-stream',
        size_bytes: buffer.length,
        sha256,
        uploaded_by: auth.user.id,
        created_at: now,
      }),
    )
  })

  app.get('/:fileId/download', async (request, reply) => {
    const authorization = await authorizeSubject(request, reply, 'file.download')
    if (!authorization) return
    const { subject } = authorization
    const fileId = z
      .string()
      .uuid()
      .safeParse((request.params as { fileId: string }).fileId)
    if (!fileId.success) {
      return reply
        .code(404)
        .send({ code: 'FILE_NOT_FOUND', message: '文件不存在', requestId: request.id })
    }
    const row = sqlite
      .prepare(
        'SELECT * FROM uploaded_files WHERE study_id = ? AND site_id = ? AND subject_id = ? AND id = ?',
      )
      .get(subject.study_id, subject.site_id, subject.id, fileId.data) as FileRow | undefined
    if (!row) {
      return reply
        .code(404)
        .send({ code: 'FILE_NOT_FOUND', message: '文件不存在', requestId: request.id })
    }
    const absolutePath = safeStoragePath(config.uploadRoot, row.storage_path)
    if (!existsSync(absolutePath)) {
      return reply.code(409).send({
        code: 'FILE_STORAGE_MISSING',
        message: '文件存储缺失，请联系管理员',
        requestId: request.id,
      })
    }
    const encodedName = encodeURIComponent(row.original_name)
    reply.header('Content-Type', row.mime_type)
    reply.header('Content-Length', row.size_bytes)
    reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodedName}`)
    return reply.send(createReadStream(absolutePath))
  })

  app.delete('/:fileId', async (request, reply) => {
    const authorization = await authorizeSubject(request, reply, 'file.delete')
    if (!authorization) return
    if (!(await verifyCsrf(request, reply))) return
    const { auth, subject } = authorization
    if (!(await requireStudyStatus(subject.study_id, ['active'], request, reply))) return
    if (!(await requireActiveSite(subject.study_id, subject.site_id, request, reply))) return
    const fileId = z
      .string()
      .uuid()
      .safeParse((request.params as { fileId: string }).fileId)
    if (!fileId.success) {
      return reply
        .code(404)
        .send({ code: 'FILE_NOT_FOUND', message: '文件不存在', requestId: request.id })
    }
    const row = sqlite
      .prepare(
        'SELECT * FROM uploaded_files WHERE study_id = ? AND site_id = ? AND subject_id = ? AND id = ?',
      )
      .get(subject.study_id, subject.site_id, subject.id, fileId.data) as FileRow | undefined
    if (!row) {
      return reply
        .code(404)
        .send({ code: 'FILE_NOT_FOUND', message: '文件不存在', requestId: request.id })
    }
    const originalPath = safeStoragePath(config.uploadRoot, row.storage_path)
    if (!existsSync(originalPath)) {
      return reply.code(409).send({
        code: 'FILE_STORAGE_MISSING',
        message: '文件存储缺失，未删除数据库记录',
        requestId: request.id,
      })
    }
    const quarantineName = `${row.id}--${basename(row.storage_path)}`
    const quarantinePath = safeStoragePath(config.quarantineRoot, quarantineName)
    mkdirSync(config.quarantineRoot, { recursive: true })
    try {
      renameSync(originalPath, quarantinePath)
      sqlite.transaction(() => {
        sqlite
          .prepare(
            'DELETE FROM uploaded_files WHERE study_id = ? AND site_id = ? AND subject_id = ? AND id = ?',
          )
          .run(subject.study_id, subject.site_id, subject.id, row.id)
        auditInsert({
          request,
          actorUserId: auth.user.id,
          studyId: subject.study_id,
          siteId: subject.site_id,
          subjectId: subject.id,
          objectId: row.id,
          action: 'file.deleted',
          before: publicFile(row),
        })
        unlinkSync(quarantinePath)
      })()
    } catch (error) {
      if (existsSync(quarantinePath) && !existsSync(originalPath)) {
        mkdirSync(dirname(originalPath), { recursive: true })
        renameSync(quarantinePath, originalPath)
      }
      request.log.error(error)
      return reply.code(500).send({
        code: 'FILE_DELETE_FAILED',
        message: '文件删除失败，原文件和数据库记录已保留',
        requestId: request.id,
      })
    }
    return reply.code(204).send()
  })
}
