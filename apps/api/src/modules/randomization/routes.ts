import { randomBytes, randomUUID } from 'node:crypto'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import {
  DeterministicRandom,
  generatePermutedBlock,
  minimizationRandomization,
  simpleRandomization,
  type TreatmentArm,
} from '@edc/domain'
import { verifyCsrf } from '../../auth/auth.js'
import {
  requireActiveSite,
  requireAllowedSite,
  requireStudyPermission,
  requireStudyStatus,
  resolveMembershipPermissions,
} from '../../auth/permissions.js'
import { writeAudit } from '../../audit/audit.js'
import { numberingRepository, sqlite } from '../../db/database.js'

const armSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
  label: z.string().min(1).max(100),
  weight: z.number().int().positive(),
})
const schemeSchema = z.object({
  name: z.string().trim().min(1).max(200),
  method: z.enum(['simple', 'permuted_block', 'stratified_block', 'minimization']),
  arms: z.array(armSchema).min(2).max(10),
  config: z.object({
    blockSizes: z.array(z.number().int().positive()).min(1).optional(),
    factorKeys: z
      .array(z.string().regex(/^[a-z][a-z0-9_]{1,63}$/))
      .max(6)
      .optional(),
    factorWeights: z.record(z.string(), z.number().positive()).optional(),
    biasProbability: z.number().min(0.5).max(1).optional(),
  }),
  seed: z.string().min(16).max(256).optional(),
})
const executeSchema = z.object({
  factors: z.record(z.string(), z.string().min(1).max(200)).default({}),
})
const simulationSchema = schemeSchema.extend({
  sampleSize: z.number().int().min(10).max(10_000).default(200),
})

interface SchemeRow {
  id: string
  study_id: string
  method: 'simple' | 'permuted_block' | 'stratified_block' | 'minimization'
  arms_json: string
  config_json: string
  seed: string
  status: 'draft' | 'active' | 'frozen' | 'disabled'
  sequence_position: number
}

function validateScheme(data: z.infer<typeof schemeSchema>) {
  if (new Set(data.arms.map((arm) => arm.id)).size !== data.arms.length)
    throw new Error('治疗组 ID 不得重复')
  const ratioTotal = data.arms.reduce((sum, arm) => sum + arm.weight, 0)
  if (data.method.includes('block')) {
    if (!data.config.blockSizes?.length) throw new Error('区组随机化必须配置区组大小')
    if (data.config.blockSizes.some((size) => size % ratioTotal !== 0))
      throw new Error(`每个区组大小必须是分配比例总和 ${ratioTotal} 的整数倍`)
  }
  if (
    (data.method === 'stratified_block' || data.method === 'minimization') &&
    !data.config.factorKeys?.length
  )
    throw new Error('该随机化方法至少需要一个分层因素')
}

function canonicalStratum(factorKeys: string[], factors: Record<string, string>) {
  return (
    factorKeys
      .slice()
      .sort()
      .map((key) => {
        if (!factors[key]) throw new Error(`缺少随机化因素：${key}`)
        return `${key}=${factors[key]}`
      })
      .join('|') || 'all'
  )
}

function assignFromBlock(
  scheme: SchemeRow,
  arms: TreatmentArm[],
  config: { blockSizes?: number[] | undefined },
  stratumKey: string,
) {
  const current = sqlite
    .prepare(`SELECT * FROM randomization_strata_state WHERE scheme_id = ? AND stratum_key = ?`)
    .get(scheme.id, stratumKey) as
    { block_index: number; current_block_json: string; block_offset: number } | undefined
  let blockIndex = current?.block_index ?? 0
  let block = current ? (JSON.parse(current.current_block_json) as string[]) : []
  let offset = current?.block_offset ?? 0
  if (offset >= block.length) {
    if (current) blockIndex += 1
    const sizes = config.blockSizes ?? []
    const sizeRandom = new DeterministicRandom(
      scheme.seed,
      `block-size:${stratumKey}:${blockIndex}`,
    )
    const blockSize = sizes[sizeRandom.integer(sizes.length)]!
    block = generatePermutedBlock(arms, blockSize, scheme.seed, blockIndex, stratumKey)
    offset = 0
  }
  const armId = block[offset]!
  sqlite
    .prepare(
      `INSERT INTO randomization_strata_state (scheme_id, stratum_key, block_index, current_block_json, block_offset) VALUES (?, ?, ?, ?, ?) ON CONFLICT(scheme_id, stratum_key) DO UPDATE SET block_index = excluded.block_index, current_block_json = excluded.current_block_json, block_offset = excluded.block_offset`,
    )
    .run(scheme.id, stratumKey, blockIndex, JSON.stringify(block), offset + 1)
  return {
    armId,
    decision: { method: scheme.method, stratumKey, blockIndex, positionInBlock: offset },
  }
}

export const randomizationRoutes: FastifyPluginAsync = async (app) => {
  app.get('/scheme', async (request, reply) => {
    const studyId = (request.params as { studyId: string }).studyId
    const auth = await requireStudyPermission(request, reply, studyId, 'randomization.view')
    if (!auth) return
    const scheme = sqlite
      .prepare(
        `SELECT id, study_id, name, method, arms_json, config_json, status, sequence_position, activated_at, frozen_at FROM randomization_schemes WHERE study_id = ?`,
      )
      .get(studyId)
    const permissions = auth.user.isSystemAdmin
      ? new Set(['randomization.manage'])
      : await resolveMembershipPermissions(auth.membershipId!, auth.roleCode!)
    return { scheme, canManage: permissions.has('randomization.manage') }
  })

  app.post('/scheme/simulate', async (request, reply) => {
    const studyId = (request.params as { studyId: string }).studyId
    const auth = await requireStudyPermission(request, reply, studyId, 'randomization.view')
    if (!auth) return
    if (!(await requireStudyStatus(studyId, ['draft', 'active'], request, reply))) return
    const parsed = simulationSchema.safeParse(request.body)
    if (!parsed.success)
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: '模拟参数不合法',
        details: parsed.error.flatten(),
        requestId: request.id,
      })
    try {
      validateScheme(parsed.data)
    } catch (error) {
      return reply.code(400).send({
        code: 'RANDOMIZATION_CONFIG_INVALID',
        message: (error as Error).message,
        requestId: request.id,
      })
    }
    const seed = parsed.data.seed ?? randomBytes(32).toString('hex')
    const counts = new Map(parsed.data.arms.map((arm) => [arm.id, 0]))
    const assignments: Array<{ armId: string; factors: Record<string, string> }> = []
    let block: string[] = []
    let blockIndex = 0
    for (let position = 0; position < parsed.data.sampleSize; position += 1) {
      let armId: string
      if (parsed.data.method === 'simple') {
        armId = simpleRandomization(parsed.data.arms, seed, position)
      } else if (parsed.data.method.includes('block')) {
        if (!block.length) {
          const sizes = parsed.data.config.blockSizes!
          const sizeRandom = new DeterministicRandom(seed, `preview-size:${blockIndex}`)
          const size = sizes[sizeRandom.integer(sizes.length)]!
          block = generatePermutedBlock(parsed.data.arms, size, seed, blockIndex, 'preview')
          blockIndex += 1
        }
        armId = block.shift()!
      } else {
        const factors = Object.fromEntries(
          (parsed.data.config.factorKeys ?? []).map((key) => [key, 'preview']),
        )
        const result = minimizationRandomization({
          arms: parsed.data.arms,
          factors: (parsed.data.config.factorKeys ?? []).map((key) => ({
            key,
            weight: parsed.data.config.factorWeights?.[key] ?? 1,
          })),
          subjectFactors: factors,
          existing: assignments,
          biasProbability: parsed.data.config.biasProbability ?? 0.8,
          seed,
          position,
        })
        armId = result.armId
        assignments.push({ armId, factors })
      }
      counts.set(armId, (counts.get(armId) ?? 0) + 1)
    }
    return {
      sampleSize: parsed.data.sampleSize,
      method: parsed.data.method,
      results: parsed.data.arms.map((arm) => ({
        armId: arm.id,
        label: arm.label,
        count: counts.get(arm.id) ?? 0,
        percent: Math.round(((counts.get(arm.id) ?? 0) / parsed.data.sampleSize) * 1000) / 10,
      })),
    }
  })

  app.put('/scheme', async (request, reply) => {
    const studyId = (request.params as { studyId: string }).studyId
    const auth = await requireStudyPermission(request, reply, studyId, 'randomization.manage')
    if (!auth) return
    if (!(await verifyCsrf(request, reply))) return
    if (!(await requireStudyStatus(studyId, ['draft', 'active'], request, reply))) return
    const parsed = schemeSchema.safeParse(request.body)
    if (!parsed.success)
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: '随机化方案配置不合法',
        details: parsed.error.flatten(),
        requestId: request.id,
      })
    try {
      validateScheme(parsed.data)
    } catch (error) {
      return reply.code(400).send({
        code: 'RANDOMIZATION_CONFIG_INVALID',
        message: (error as Error).message,
        requestId: request.id,
      })
    }
    const existing = sqlite
      .prepare(`SELECT id, status, seed FROM randomization_schemes WHERE study_id = ?`)
      .get(studyId) as { id: string; status: string; seed: string } | undefined
    if (existing?.status === 'frozen')
      return reply.code(409).send({
        code: 'SCHEME_FROZEN',
        message: '首例随机化已完成，方案不能修改',
        requestId: request.id,
      })
    const id = existing?.id ?? randomUUID(),
      now = new Date().toISOString(),
      seed = parsed.data.seed ?? existing?.seed ?? randomBytes(32).toString('hex')
    sqlite
      .prepare(
        `INSERT INTO randomization_schemes (id, study_id, name, method, arms_json, config_json, seed, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?) ON CONFLICT(study_id) DO UPDATE SET name = excluded.name, method = excluded.method, arms_json = excluded.arms_json, config_json = excluded.config_json, seed = excluded.seed, status = 'draft', updated_at = excluded.updated_at`,
      )
      .run(
        id,
        studyId,
        parsed.data.name,
        parsed.data.method,
        JSON.stringify(parsed.data.arms),
        JSON.stringify(parsed.data.config),
        seed,
        auth.user.id,
        now,
        now,
      )
    await writeAudit({
      requestId: request.id,
      actorUserId: auth.user.id,
      studyId,
      objectType: 'randomization_scheme',
      objectId: id,
      action: existing ? 'randomization.scheme_updated' : 'randomization.scheme_created',
      after: { ...parsed.data, seed: '[REDACTED]' },
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    })
    return { id, status: 'draft' }
  })

  app.post('/scheme/activate', async (request, reply) => {
    const studyId = (request.params as { studyId: string }).studyId
    const auth = await requireStudyPermission(request, reply, studyId, 'randomization.manage')
    if (!auth) return
    if (!(await verifyCsrf(request, reply))) return
    if (!(await requireStudyStatus(studyId, ['draft', 'active'], request, reply))) return
    const scheme = sqlite
      .prepare(`SELECT id, status FROM randomization_schemes WHERE study_id = ?`)
      .get(studyId) as { id: string; status: string } | undefined
    if (!scheme)
      return reply
        .code(404)
        .send({ code: 'SCHEME_NOT_FOUND', message: '请先创建随机化方案', requestId: request.id })
    if (scheme.status === 'frozen') return { id: scheme.id, status: 'frozen' }
    const now = new Date().toISOString()
    sqlite
      .prepare(
        `UPDATE randomization_schemes
         SET status = 'active', activated_at = COALESCE(activated_at, ?), updated_at = ?
         WHERE study_id = ? AND id = ?`,
      )
      .run(now, now, studyId, scheme.id)
    await writeAudit({
      requestId: request.id,
      actorUserId: auth.user.id,
      studyId,
      objectType: 'randomization_scheme',
      objectId: scheme.id,
      action: 'randomization.scheme_activated',
      after: { status: 'active' },
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    })
    return { id: scheme.id, status: 'active' }
  })

  app.post('/subjects/:subjectId/assign', async (request, reply) => {
    const { studyId, subjectId } = request.params as { studyId: string; subjectId: string }
    const auth = await requireStudyPermission(request, reply, studyId, 'randomization.execute')
    if (!auth) return
    if (!(await verifyCsrf(request, reply))) return
    if (!(await requireStudyStatus(studyId, ['active'], request, reply))) return
    const parsed = executeSchema.safeParse(request.body)
    if (!parsed.success)
      return reply
        .code(400)
        .send({ code: 'VALIDATION_ERROR', message: '随机化因素不合法', requestId: request.id })
    const subjectBefore = sqlite
      .prepare(
        `SELECT id, site_id, status, random_number FROM subjects WHERE study_id = ? AND id = ?`,
      )
      .get(studyId, subjectId) as
      { id: string; site_id: string; status: string; random_number: string | null } | undefined
    if (!subjectBefore)
      return reply
        .code(404)
        .send({ code: 'SUBJECT_NOT_FOUND', message: '受试者不存在', requestId: request.id })
    if (!(await requireAllowedSite(auth, subjectBefore.site_id, request, reply))) return
    if (subjectBefore.random_number) {
      const existing = sqlite
        .prepare(
          `SELECT arm_id, assigned_at FROM randomization_assignments
           WHERE study_id = ? AND site_id = ? AND subject_id = ?`,
        )
        .get(studyId, subjectBefore.site_id, subjectId)
      return {
        randomNumber: subjectBefore.random_number,
        assignment: existing,
        alreadyAssigned: true,
      }
    }
    if (!(await requireActiveSite(studyId, subjectBefore.site_id, request, reply))) return

    try {
      const transaction = sqlite.transaction(() => {
        const subject = sqlite
          .prepare(`SELECT * FROM subjects WHERE study_id = ? AND id = ?`)
          .get(studyId, subjectId) as {
          site_id: string
          status: string
          random_number: string | null
        }
        if (subject.random_number) throw new Error('ALREADY_ASSIGNED')
        if (subject.status !== 'enrolled') throw new Error('SUBJECT_NOT_ENROLLED')
        const scheme = sqlite
          .prepare(`SELECT * FROM randomization_schemes WHERE study_id = ?`)
          .get(studyId) as SchemeRow | undefined
        if (!scheme || !['active', 'frozen'].includes(scheme.status))
          throw new Error('SCHEME_NOT_ACTIVE')
        const arms = z.array(armSchema).parse(JSON.parse(scheme.arms_json))
        const config = schemeSchema.shape.config.parse(JSON.parse(scheme.config_json))
        const factorKeys = config.factorKeys ?? []
        const factors = { ...parsed.data.factors }
        if (factorKeys.includes('site')) factors.site = subject.site_id
        const stratumKey =
          scheme.method === 'stratified_block' ? canonicalStratum(factorKeys, factors) : 'all'
        let armId: string, decision: Record<string, unknown>
        if (scheme.method === 'simple') {
          armId = simpleRandomization(arms, scheme.seed, scheme.sequence_position)
          decision = { method: 'simple', sequencePosition: scheme.sequence_position }
        } else if (scheme.method === 'permuted_block' || scheme.method === 'stratified_block') {
          ;({ armId, decision } = assignFromBlock(scheme, arms, config, stratumKey))
        } else {
          canonicalStratum(factorKeys, factors)
          const previous = sqlite
            .prepare(
              `SELECT arm_id, factors_json FROM randomization_assignments
               WHERE study_id = ? AND scheme_id = ? ORDER BY sequence_position`,
            )
            .all(studyId, scheme.id) as { arm_id: string; factors_json: string }[]
          const result = minimizationRandomization({
            arms,
            factors: factorKeys.map((key) => ({ key, weight: config.factorWeights?.[key] ?? 1 })),
            subjectFactors: factors,
            existing: previous.map((item) => ({
              armId: item.arm_id,
              factors: JSON.parse(item.factors_json),
            })),
            biasProbability: config.biasProbability ?? 0.8,
            seed: scheme.seed,
            position: scheme.sequence_position,
          })
          armId = result.armId
          decision = {
            method: 'minimization',
            scores: result.scores,
            sequencePosition: scheme.sequence_position,
          }
        }
        const randomNumber = numberingRepository.allocateNextNumber(studyId, 'randomization'),
          assignmentId = randomUUID(),
          now = new Date().toISOString()
        sqlite
          .prepare(
            `INSERT INTO randomization_assignments (id, study_id, site_id, subject_id, scheme_id, sequence_position, arm_id, stratum_key, factors_json, decision_json, assigned_by, assigned_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            assignmentId,
            studyId,
            subject.site_id,
            subjectId,
            scheme.id,
            scheme.sequence_position,
            armId,
            stratumKey,
            JSON.stringify(factors),
            JSON.stringify(decision),
            auth.user.id,
            now,
          )
        sqlite
          .prepare(
            `UPDATE subjects
             SET random_number = ?, row_version = row_version + 1, updated_at = ?
             WHERE study_id = ? AND site_id = ? AND id = ? AND random_number IS NULL`,
          )
          .run(randomNumber, now, studyId, subject.site_id, subjectId)
        sqlite
          .prepare(
            `UPDATE randomization_schemes
             SET sequence_position = sequence_position + 1, status = 'frozen',
                 frozen_at = COALESCE(frozen_at, ?), updated_at = ?
             WHERE study_id = ? AND id = ?`,
          )
          .run(now, now, studyId, scheme.id)
        return { assignmentId, randomNumber, armId, assignedAt: now, decision }
      })
      const result = transaction.immediate()
      await writeAudit({
        requestId: request.id,
        actorUserId: auth.user.id,
        studyId,
        siteId: subjectBefore.site_id,
        subjectId,
        objectType: 'randomization_assignment',
        objectId: result.assignmentId,
        action: 'randomization.assigned',
        after: {
          subjectId,
          randomNumber: result.randomNumber,
          armId: result.armId,
          decision: result.decision,
        },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
      })
      return result
    } catch (error) {
      const message = (error as Error).message
      if (message === 'SUBJECT_NOT_ENROLLED')
        return reply
          .code(409)
          .send({ code: message, message: '只有已入组受试者可以随机化', requestId: request.id })
      if (message === 'SCHEME_NOT_ACTIVE')
        return reply
          .code(409)
          .send({ code: message, message: '随机化方案尚未启用', requestId: request.id })
      if (message === 'ALREADY_ASSIGNED' || message.includes('UNIQUE constraint failed')) {
        const existing = sqlite
          .prepare(
            `SELECT s.random_number, a.arm_id, a.assigned_at
             FROM subjects s
             JOIN randomization_assignments a
               ON a.study_id = s.study_id AND a.subject_id = s.id
             WHERE s.study_id = ? AND s.id = ?`,
          )
          .get(studyId, subjectId) as
          { random_number: string; arm_id: string; assigned_at: string } | undefined
        if (existing)
          return {
            randomNumber: existing.random_number,
            assignment: { arm_id: existing.arm_id, assigned_at: existing.assigned_at },
            alreadyAssigned: true,
          }
        return reply.code(409).send({
          code: 'ALREADY_ASSIGNED',
          message: '该受试者已经完成随机化',
          requestId: request.id,
        })
      }
      throw error
    }
  })
}
