import { randomUUID } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { stringify } from 'csv-stringify/sync'
import ExcelJS from 'exceljs'
import { z } from 'zod'
import { verifyCsrf } from '../../auth/auth.js'
import {
  requireStudyPermission,
  requireStudyStatus,
  type StudyAuthorization,
} from '../../auth/permissions.js'
import { writeAudit } from '../../audit/audit.js'
import { config } from '../../config.js'
import { sqlite } from '../../db/database.js'

const createExportSchema = z.object({
  dataset: z.enum(['subjects', 'clinical_data', 'events', 'audit']),
  format: z.enum(['csv', 'xlsx']).default('csv'),
  siteId: z.uuid().nullable().optional(),
  dateFrom: z.string().date().optional(),
  dateTo: z.string().date().optional(),
})

interface ExportJobRow {
  id: string
  study_id: string
  site_id: string | null
  site_name: string | null
  dataset: string
  format: string
  status: string
  parameters_json: string
  file_path: string | null
  row_count: number | null
  error_message: string | null
  requested_by: string
  requested_by_name?: string
  created_at: string
  started_at: string | null
  completed_at: string | null
}

const exportParametersSchema = z.object({
  siteId: z.uuid().nullable(),
  dateFrom: z.string().date().nullable(),
  dateTo: z.string().date().nullable(),
})

const scheduledJobs = new Map<string, Promise<unknown>>()

function safeExportPath(relativePath: string) {
  const root = resolve(config.exportRoot)
  const target = resolve(root, relativePath)
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error('导出路径超出存储目录')
  }
  return target
}

function scopedSite(
  auth: StudyAuthorization,
  requestedSiteId: string | null | undefined,
): string | null | undefined {
  if (auth.allowedSiteIds === null) return requestedSiteId ?? null
  if (requestedSiteId)
    return auth.allowedSiteIds.includes(requestedSiteId) ? requestedSiteId : undefined
  return auth.allowedSiteIds.length === 1 ? auth.allowedSiteIds[0] : undefined
}

function appendScope(clauses: string[], values: unknown[], column: string, siteId: string | null) {
  if (siteId) {
    clauses.push(`${column} = ?`)
    values.push(siteId)
  }
}

function exportRows(
  studyId: string,
  siteId: string | null,
  dataset: 'subjects' | 'clinical_data' | 'events' | 'audit',
  dateFrom?: string,
  dateTo?: string,
) {
  if (dataset === 'subjects') {
    const clauses = ['s.study_id = ?']
    const values: unknown[] = [studyId]
    appendScope(clauses, values, 's.site_id', siteId)
    return sqlite
      .prepare(
        `SELECT st.name AS center_name,
                s.screening_number, s.subject_number, s.random_number, s.status,
                s.screening_conclusion, s.screening_failure_reason, s.created_at, s.updated_at
         FROM subjects s
         JOIN sites st ON st.study_id = s.study_id AND st.id = s.site_id
         WHERE ${clauses.join(' AND ')}
         ORDER BY st.name, s.screening_number`,
      )
      .all(...values) as Array<Record<string, unknown>>
  }
  if (dataset === 'clinical_data') {
    const clauses = ['r.study_id = ?']
    const values: unknown[] = [studyId]
    appendScope(clauses, values, 'r.site_id', siteId)
    return sqlite
      .prepare(
        `SELECT st.name AS center_name, s.screening_number, s.subject_number,
                f.code AS form_code, f.name AS form_name, fv.version_number,
                v.code AS visit_code, r.repeat_index, r.status AS record_status,
                dv.field_key, dv.value_type,
                CASE dv.value_type
                  WHEN 'number' THEN CAST(dv.value_number AS TEXT)
                  WHEN 'date' THEN dv.value_date
                  WHEN 'datetime' THEN dv.value_datetime
                  WHEN 'boolean' THEN CASE dv.value_boolean WHEN 1 THEN 'true' ELSE 'false' END
                  WHEN 'json' THEN dv.value_json
                  ELSE dv.value_text
                END AS field_value,
                r.updated_at
         FROM data_records r
         JOIN subjects s ON s.study_id = r.study_id AND s.id = r.subject_id
         JOIN sites st ON st.study_id = r.study_id AND st.id = r.site_id
         JOIN forms f ON f.study_id = r.study_id AND f.id = r.form_id
         JOIN form_versions fv ON fv.id = r.form_version_id
         LEFT JOIN visit_definitions v ON v.study_id = r.study_id AND v.id = r.visit_id
         LEFT JOIN data_values dv ON dv.record_id = r.id
         WHERE ${clauses.join(' AND ')}
         ORDER BY st.name, s.screening_number, f.code, v.sort_order, r.repeat_index, dv.field_key`,
      )
      .all(...values) as Array<Record<string, unknown>>
  }
  if (dataset === 'events') {
    const clauses = ['e.study_id = ?']
    const values: unknown[] = [studyId]
    appendScope(clauses, values, 'e.site_id', siteId)
    if (dateFrom) {
      clauses.push('e.occurred_on >= ?')
      values.push(dateFrom)
    }
    if (dateTo) {
      clauses.push('e.occurred_on <= ?')
      values.push(dateTo)
    }
    return sqlite
      .prepare(
        `SELECT st.name AS center_name, s.screening_number, s.subject_number,
                e.event_type, e.occurred_on, e.title, e.details,
                e.before_status, e.after_status, u.display_name AS created_by, e.created_at
         FROM subject_events e
         JOIN subjects s ON s.study_id = e.study_id AND s.id = e.subject_id
         JOIN sites st ON st.study_id = e.study_id AND st.id = e.site_id
         JOIN users u ON u.id = e.created_by
         WHERE ${clauses.join(' AND ')}
         ORDER BY e.occurred_on, e.created_at`,
      )
      .all(...values) as Array<Record<string, unknown>>
  }
  const clauses = ['a.study_id = ?']
  const values: unknown[] = [studyId]
  appendScope(clauses, values, 'a.site_id', siteId)
  if (dateFrom) {
    clauses.push('julianday(a.created_at) >= julianday(?)')
    values.push(`${dateFrom}T00:00:00.000Z`)
  }
  if (dateTo) {
    clauses.push('julianday(a.created_at) <= julianday(?)')
    values.push(`${dateTo}T23:59:59.999Z`)
  }
  return sqlite
    .prepare(
      `SELECT strftime('%Y-%m-%dT%H:%M:%fZ', a.created_at) AS created_at,
              u.username AS actor_username, u.display_name AS actor_name,
              COALESCE(a.site_name_snapshot, st.name) AS center_name,
              a.subject_id, a.action, a.object_type, a.object_id,
              a.before_json, a.after_json, a.reason, a.request_id, a.ip_address
       FROM audit_events a
       LEFT JOIN users u ON u.id = a.actor_user_id
       LEFT JOIN sites st ON st.id = a.site_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY julianday(a.created_at)`,
    )
    .all(...values) as Array<Record<string, unknown>>
}

async function writeExportFile(
  absolutePath: string,
  format: 'csv' | 'xlsx',
  rows: Array<Record<string, unknown>>,
) {
  if (format === 'csv') {
    const csv = rows.length ? stringify(rows, { header: true }) : ''
    writeFileSync(absolutePath, `\uFEFF${csv}`, 'utf8')
    return
  }
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Clinical Trial EDC'
  workbook.created = new Date()
  const worksheet = workbook.addWorksheet('数据', {
    views: [{ state: 'frozen', ySplit: 1 }],
  })
  const columns = rows.length ? Object.keys(rows[0]!) : []
  worksheet.columns = columns.map((key) => ({
    header: key,
    key,
    width: Math.min(40, Math.max(14, key.length + 4)),
  }))
  for (const row of rows) worksheet.addRow(row)
  if (columns.length) {
    const header = worksheet.getRow(1)
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F6CBD' } }
    header.alignment = { vertical: 'middle' }
    worksheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } }
  }
  const buffer = await workbook.xlsx.writeBuffer()
  writeFileSync(absolutePath, Buffer.from(buffer))
}

function publicJob(row: ExportJobRow) {
  return {
    id: row.id,
    studyId: row.study_id,
    siteId: row.site_id,
    siteName: row.site_name,
    dataset: row.dataset,
    format: row.format,
    status: row.status,
    parameters: JSON.parse(row.parameters_json) as unknown,
    rowCount: row.row_count,
    errorMessage: row.error_message,
    requestedBy: row.requested_by_name ?? row.requested_by,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    downloadable: row.status === 'completed' && Boolean(row.file_path),
  }
}

async function auditExport(
  request: FastifyRequest,
  auth: StudyAuthorization,
  studyId: string,
  siteId: string | null,
  objectId: string,
  action: string,
  after: unknown,
) {
  await writeAudit({
    requestId: request.id,
    actorUserId: auth.user.id,
    studyId,
    siteId,
    objectType: 'export_job',
    objectId,
    action,
    after,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'],
  })
}

export async function processExportJob(studyId: string, jobId: string) {
  const job = sqlite
    .prepare('SELECT * FROM export_jobs WHERE study_id = ? AND id = ?')
    .get(studyId, jobId) as ExportJobRow | undefined
  if (!job || job.status === 'completed') return job
  const startedAt = new Date().toISOString()
  sqlite
    .prepare(
      `UPDATE export_jobs
       SET status = 'running', started_at = ?, error_message = NULL
       WHERE study_id = ? AND id = ? AND status IN ('queued', 'running')`,
    )
    .run(startedAt, job.study_id, job.id)
  try {
    const dataset = createExportSchema.shape.dataset.safeParse(job.dataset)
    const format = createExportSchema.shape.format.safeParse(job.format)
    const parameters = exportParametersSchema.safeParse(JSON.parse(job.parameters_json))
    if (!dataset.success || !format.success || !parameters.success) {
      throw new Error('持久化导出任务参数无效')
    }
    const rows = exportRows(
      job.study_id,
      job.site_id,
      dataset.data,
      parameters.data.dateFrom ?? undefined,
      parameters.data.dateTo ?? undefined,
    )
    const relativePath = `${job.study_id}/${job.id}.${format.data}`
    const absolutePath = safeExportPath(relativePath)
    mkdirSync(dirname(absolutePath), { recursive: true })
    await writeExportFile(absolutePath, format.data, rows)
    const completedAt = new Date().toISOString()
    sqlite
      .prepare(
        `UPDATE export_jobs
         SET status = 'completed', file_path = ?, row_count = ?, completed_at = ?
         WHERE study_id = ? AND id = ?`,
      )
      .run(relativePath, rows.length, completedAt, job.study_id, job.id)
    await writeAudit({
      requestId: `export-worker:${job.id}`,
      actorUserId: job.requested_by,
      studyId: job.study_id,
      siteId: job.site_id,
      objectType: 'export_job',
      objectId: job.id,
      action: 'export.completed',
      after: {
        dataset: dataset.data,
        format: format.data,
        rowCount: rows.length,
        parameters: parameters.data,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误'
    sqlite
      .prepare(
        `UPDATE export_jobs
         SET status = 'failed', error_message = ?, completed_at = ?
         WHERE study_id = ? AND id = ?`,
      )
      .run(message.slice(0, 1000), new Date().toISOString(), job.study_id, job.id)
    await writeAudit({
      requestId: `export-worker:${job.id}`,
      actorUserId: job.requested_by,
      studyId: job.study_id,
      siteId: job.site_id,
      objectType: 'export_job',
      objectId: job.id,
      action: 'export.failed',
      after: { dataset: job.dataset, error: message },
    })
  }
  return sqlite
    .prepare('SELECT * FROM export_jobs WHERE study_id = ? AND id = ?')
    .get(job.study_id, job.id)
}

export function scheduleExportJob(studyId: string, jobId: string) {
  const existing = scheduledJobs.get(jobId)
  if (existing) return existing
  const task = new Promise<void>((resolve) => setImmediate(resolve))
    .then(() => processExportJob(studyId, jobId))
    .finally(() => scheduledJobs.delete(jobId))
  scheduledJobs.set(jobId, task)
  void task.catch(() => undefined)
  return task
}

export async function waitForExportJobs() {
  while (scheduledJobs.size) {
    await Promise.allSettled([...scheduledJobs.values()])
  }
}

export function recoverExportJobs() {
  sqlite
    .prepare("UPDATE export_jobs SET status = 'queued', started_at = NULL WHERE status = 'running'")
    .run()
  const jobs = sqlite
    .prepare("SELECT study_id, id FROM export_jobs WHERE status = 'queued' ORDER BY created_at")
    .all() as Array<{ study_id: string; id: string }>
  for (const job of jobs) scheduleExportJob(job.study_id, job.id)
}

export const exportRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (request, reply) => {
    const studyId = (request.params as { studyId: string }).studyId
    const auth = await requireStudyPermission(request, reply, studyId, 'export.execute')
    if (!auth) return
    const clauses = ['j.study_id = ?']
    const values: unknown[] = [studyId]
    if (auth.allowedSiteIds !== null) {
      if (!auth.allowedSiteIds.length) return { items: [] }
      clauses.push(`j.site_id IN (${auth.allowedSiteIds.map(() => '?').join(',')})`)
      values.push(...auth.allowedSiteIds)
    }
    const rows = sqlite
      .prepare(
        `SELECT j.*, u.display_name AS requested_by_name, site.name AS site_name
         FROM export_jobs j JOIN users u ON u.id = j.requested_by
         LEFT JOIN sites site ON site.id = j.site_id
         WHERE ${clauses.join(' AND ')} ORDER BY j.created_at DESC LIMIT 100`,
      )
      .all(...values) as ExportJobRow[]
    return { items: rows.map(publicJob) }
  })

  app.post('/', async (request, reply) => {
    const studyId = (request.params as { studyId: string }).studyId
    const auth = await requireStudyPermission(request, reply, studyId, 'export.execute')
    if (!auth) return
    if (!(await verifyCsrf(request, reply))) return
    if (!(await requireStudyStatus(studyId, ['draft', 'active', 'ended'], request, reply))) return
    const parsed = createExportSchema.safeParse(request.body)
    if (!parsed.success)
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: '导出参数不合法',
        details: parsed.error.flatten(),
        requestId: request.id,
      })
    if (parsed.data.dataset === 'audit') {
      const auditAuth = await requireStudyPermission(request, reply, studyId, 'audit.export')
      if (!auditAuth) return
    }
    const siteId = scopedSite(auth, parsed.data.siteId)
    if (siteId === undefined)
      return reply.code(403).send({
        code: 'SITE_ACCESS_DENIED',
        message: '请选择一个获授权的研究中心后导出',
        requestId: request.id,
      })
    if (siteId) {
      const site = sqlite
        .prepare('SELECT id FROM sites WHERE study_id = ? AND id = ?')
        .get(studyId, siteId)
      if (!site)
        return reply
          .code(404)
          .send({ code: 'SITE_NOT_FOUND', message: '研究中心不存在', requestId: request.id })
    }
    const id = randomUUID()
    const now = new Date().toISOString()
    const parameters = {
      siteId,
      dateFrom: parsed.data.dateFrom ?? null,
      dateTo: parsed.data.dateTo ?? null,
    }
    sqlite
      .prepare(
        `INSERT INTO export_jobs
         (id, study_id, site_id, dataset, format, status, parameters_json, requested_by,
          created_at, started_at)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, NULL)`,
      )
      .run(
        id,
        studyId,
        siteId,
        parsed.data.dataset,
        parsed.data.format,
        JSON.stringify(parameters),
        auth.user.id,
        now,
      )
    await auditExport(request, auth, studyId, siteId, id, 'export.queued', {
      dataset: parsed.data.dataset,
      format: parsed.data.format,
      parameters,
    })
    scheduleExportJob(studyId, id)
    return reply.code(201).send({ id, status: 'queued', rowCount: null })
  })

  app.get('/:jobId/download', async (request, reply) => {
    const studyId = (request.params as { studyId: string }).studyId
    const auth = await requireStudyPermission(request, reply, studyId, 'export.execute')
    if (!auth) return
    const jobId = z
      .string()
      .uuid()
      .safeParse((request.params as { jobId: string }).jobId)
    if (!jobId.success)
      return reply
        .code(404)
        .send({ code: 'EXPORT_NOT_FOUND', message: '导出任务不存在', requestId: request.id })
    const row = sqlite
      .prepare('SELECT * FROM export_jobs WHERE study_id = ? AND id = ?')
      .get(studyId, jobId.data) as ExportJobRow | undefined
    if (!row)
      return reply
        .code(404)
        .send({ code: 'EXPORT_NOT_FOUND', message: '导出任务不存在', requestId: request.id })
    if (
      auth.allowedSiteIds !== null &&
      (!row.site_id || !auth.allowedSiteIds.includes(row.site_id))
    )
      return reply.code(403).send({
        code: 'SITE_ACCESS_DENIED',
        message: '您无权下载该范围的导出文件',
        requestId: request.id,
      })
    if (row.dataset === 'audit') {
      const auditAuth = await requireStudyPermission(request, reply, studyId, 'audit.export')
      if (!auditAuth) return
    }
    if (row.status !== 'completed' || !row.file_path)
      return reply.code(409).send({
        code: 'EXPORT_NOT_READY',
        message: '导出任务尚未完成',
        requestId: request.id,
      })
    const absolutePath = safeExportPath(row.file_path)
    if (!existsSync(absolutePath))
      return reply.code(409).send({
        code: 'EXPORT_FILE_MISSING',
        message: '导出文件已丢失，请重新生成',
        requestId: request.id,
      })
    reply.header(
      'Content-Type',
      row.format === 'xlsx'
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : 'text/csv; charset=utf-8',
    )
    reply.header(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(`${row.dataset}-${row.id}.${row.format}`)}`,
    )
    return reply.send(createReadStream(absolutePath))
  })
}
