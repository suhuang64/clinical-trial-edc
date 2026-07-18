import { randomBytes, randomInt, randomUUID } from 'node:crypto'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import {
  DeterministicRandom,
  generatePermutedBlock,
  minimizationRandomization,
  simpleRandomization,
  type TreatmentArm,
} from '@edc/domain'
import { formDefinitionSchema, type FormDefinition } from '@edc/contracts'
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
  label: z.string().trim().min(1).max(100),
  weight: z.number().int().positive(),
})
const schemeSchema = z.object({
  name: z.string().trim().min(1).max(200),
  method: z.enum(['simple', 'permuted_block', 'stratified_block', 'minimization']),
  arms: z.array(armSchema).max(10),
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

const SUPPORTED_FACTOR_KEYS = ['site'] as const
const RANDOMIZATION_FIELD_TYPES = new Set([
  'text',
  'number',
  'date',
  'datetime',
  'radio',
  'select',
  'switch',
  'scale',
])

interface RandomizationFactorDefinition {
  key: string
  label: string
  type: string
  options: Array<{ value: string; label: string }>
}

function screeningDefinition(studyId: string): FormDefinition | null {
  const row = sqlite
    .prepare(
      `SELECT fv.schema_json
       FROM forms f
       JOIN form_versions fv ON fv.id = f.active_version_id
       WHERE f.study_id = ? AND f.form_type = 'screening'
         AND f.status = 'published' AND fv.status = 'published'
       ORDER BY f.updated_at DESC LIMIT 1`,
    )
    .get(studyId) as { schema_json: string } | undefined
  if (!row) return null
  try {
    return formDefinitionSchema.parse(JSON.parse(row.schema_json))
  } catch {
    return null
  }
}

function availableRandomizationFactors(studyId: string): RandomizationFactorDefinition[] {
  return (screeningDefinition(studyId)?.fields ?? [])
    .filter((field) => field.randomizationFactor && RANDOMIZATION_FIELD_TYPES.has(field.type))
    .map((field) => ({
      key: field.key,
      label: field.label,
      type: field.type,
      options: field.options
        .filter((option) => !option.disabled)
        .map(({ value, label }) => ({ value, label })),
    }))
}

function scalarFactorValue(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

function factorsForSubject(siteId: string, factorKeys: string[], screeningJson: string) {
  const screeningValues = JSON.parse(screeningJson) as Record<string, unknown>
  const factors: Record<string, string> = {}
  for (const key of factorKeys) {
    const value = key === 'site' ? siteId : scalarFactorValue(screeningValues[key])
    if (value === null) throw new Error(`MISSING_RANDOMIZATION_FACTOR:${key}`)
    factors[key] = value
  }
  return factors
}

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

function validateScheme(
  data: z.infer<typeof schemeSchema>,
  supportedFactorKeys: readonly string[] = SUPPORTED_FACTOR_KEYS,
  requireArms = true,
) {
  const unsupportedFactors = (data.config.factorKeys ?? []).filter(
    (key) => !supportedFactorKeys.includes(key),
  )
  if (unsupportedFactors.length)
    throw new Error(`暂不支持以下分层因素：${unsupportedFactors.join('、')}`)
  if (data.arms.length < 2) {
    if (requireArms) throw new Error('随机化至少需要两个治疗组')
    return
  }
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

function simulateWithTemporaryState(
  studyId: string,
  data: z.infer<typeof simulationSchema>,
): {
  results: Array<{ armId: string; label: string; count: number; percent: number }>
  strata: Array<{
    key: string
    factors: Record<string, string>
    results: Array<{ armId: string; label: string; count: number; percent: number }>
  }>
  breakdown: Array<{
    site: string
    arms: Array<{
      armId: string
      label: string
      total: number
      factors: Record<string, Array<{ value: string; count: number; percent: number }>>
    }>
  }>
} {
  const sites = sqlite
    .prepare(`SELECT id, name FROM sites WHERE study_id = ? AND status = 'active' ORDER BY name`)
    .all(studyId) as Array<{ id: string; name: string }>
  if (!sites.length) throw new Error('请先创建至少一个有效研究中心')
  const factorKeys = data.config.factorKeys ?? []
  const factorDefinitions = new Map(
    availableRandomizationFactors(studyId).map((factor) => [factor.key, factor]),
  )
  const subjects = sqlite
    .prepare(`SELECT site_id, screening_data_json FROM subjects WHERE study_id = ?`)
    .all(studyId) as Array<{ site_id: string; screening_data_json: string }>
  const observedBySite = new Map<string, Map<string, Set<string>>>()
  const observedGlobally = new Map<string, Set<string>>()
  for (const subject of subjects) {
    try {
      const screeningValues = JSON.parse(subject.screening_data_json) as Record<string, unknown>
      for (const key of factorKeys) {
        if (key === 'site') continue
        const value = scalarFactorValue(screeningValues[key])
        if (value === null) continue
        const siteValues = observedBySite.get(subject.site_id) ?? new Map<string, Set<string>>()
        const valuesForKey = siteValues.get(key) ?? new Set<string>()
        valuesForKey.add(value)
        siteValues.set(key, valuesForKey)
        observedBySite.set(subject.site_id, siteValues)
        const globalValues = observedGlobally.get(key) ?? new Set<string>()
        globalValues.add(value)
        observedGlobally.set(key, globalValues)
      }
    } catch {
      // Invalid historical screening JSON cannot provide simulation levels.
    }
  }

  const levelsFor = (site: { id: string; name: string }, key: string) => {
    if (key === 'site') return [{ value: site.id, label: site.name }]
    const definition = factorDefinitions.get(key)
    if (!definition) throw new Error(`随机化因素“${key}”已不存在，请重新配置方案`)
    if (definition.options.length) return definition.options
    if (definition.type === 'switch') {
      return [
        { value: 'true', label: '是' },
        { value: 'false', label: '否' },
      ]
    }
    const observed =
      observedBySite.get(site.id)?.get(key) ?? observedGlobally.get(key) ?? new Set<string>()
    if (!observed.size) {
      throw new Error(
        `随机化因素“${definition.label}”没有可用于模拟的选项或已录入值，请先配置选项或录入筛选数据`,
      )
    }
    return [...observed].sort().map((value) => ({ value, label: value }))
  }

  const contexts: Array<{
    key: string
    stratumKey: string
    siteId: string
    values: Record<string, string>
    display: Record<string, string>
    size: number
  }> = []
  for (const site of sites) {
    let combinations: Array<{
      values: Record<string, string>
      display: Record<string, string>
    }> = [{ values: {}, display: {} }]
    for (const key of factorKeys) {
      combinations = combinations.flatMap((combination) =>
        levelsFor(site, key).map((level) => ({
          values: { ...combination.values, [key]: level.value },
          display: { ...combination.display, [key]: level.label },
        })),
      )
      if (contexts.length + combinations.length * sites.length > 500) {
        throw new Error('随机化因素水平组合超过 500 个，请减少因素或选项后再模拟')
      }
    }
    for (const combination of combinations) {
      const stratumKey = canonicalStratum(factorKeys, combination.values)
      contexts.push({
        key: `${site.id}|${stratumKey}`,
        stratumKey,
        siteId: site.id,
        ...combination,
        size: 0,
      })
    }
  }
  if (contexts.length > 500)
    throw new Error('随机化因素水平组合超过 500 个，请减少因素或选项后再模拟')
  contexts.forEach((context, index) => {
    const total = contexts.length
    const base = Math.floor(data.sampleSize / total)
    context.size = base + (index < data.sampleSize % total ? 1 : 0)
  })
  const counts = new Map(data.arms.map((arm) => [arm.id, 0]))
  const stratumCounts = new Map<string, Map<string, number>>()
  const stratumSizes = new Map<string, number>()
  const stratumDisplays = new Map<string, Record<string, string>>()
  const assignments: Array<{
    armId: string
    siteId: string
    factors: Record<string, string>
  }> = []
  const blocks = new Map<string, { index: number; values: string[]; offset: number }>()
  let sequencePosition = 0
  for (const context of contexts) {
    const localCounts =
      stratumCounts.get(context.stratumKey) ?? new Map(data.arms.map((arm) => [arm.id, 0]))
    stratumCounts.set(context.stratumKey, localCounts)
    stratumSizes.set(context.stratumKey, (stratumSizes.get(context.stratumKey) ?? 0) + context.size)
    stratumDisplays.set(context.stratumKey, context.display)
    for (let index = 0; index < context.size; index += 1) {
      let armId: string
      if (data.method === 'simple') {
        armId = simpleRandomization(
          data.arms,
          data.seed ?? 'simulation-seed-0000',
          sequencePosition,
        )
      } else if (data.method === 'permuted_block' || data.method === 'stratified_block') {
        let state = blocks.get(context.stratumKey)
        if (!state || state.offset >= state.values.length) {
          const blockIndex = state ? state.index + 1 : 0
          const size = data.config.blockSizes![randomInt(data.config.blockSizes!.length)]!
          state = {
            index: blockIndex,
            values: generatePermutedBlock(
              data.arms,
              size,
              data.seed ?? 'simulation-seed-0000',
              blockIndex,
              context.stratumKey,
            ),
            offset: 0,
          }
          blocks.set(context.stratumKey, state)
        }
        armId = state.values[state.offset++]!
      } else {
        armId = minimizationRandomization({
          arms: data.arms,
          factors: factorKeys.map((key) => ({
            key,
            weight: data.config.factorWeights?.[key] ?? 1,
          })),
          subjectFactors: context.values,
          existing: assignments,
          biasProbability: data.config.biasProbability ?? 0.8,
          seed: data.seed ?? 'simulation-seed-0000',
          position: sequencePosition,
        }).armId
      }
      counts.set(armId, (counts.get(armId) ?? 0) + 1)
      localCounts.set(armId, (localCounts.get(armId) ?? 0) + 1)
      assignments.push({ armId, siteId: context.siteId, factors: context.values })
      sequencePosition += 1
    }
  }
  const results = data.arms.map((arm) => ({
    armId: arm.id,
    label: arm.label,
    count: counts.get(arm.id) ?? 0,
    percent: Math.round(((counts.get(arm.id) ?? 0) / data.sampleSize) * 1000) / 10,
  }))
  const strata = [...stratumCounts.entries()].map(([stratumKey, localCounts]) => ({
    key: stratumKey,
    factors: stratumDisplays.get(stratumKey) ?? {},
    results: data.arms.map((arm) => {
      const count = localCounts.get(arm.id) ?? 0
      const stratumSize = stratumSizes.get(stratumKey) ?? 0
      return {
        armId: arm.id,
        label: arm.label,
        count,
        percent: stratumSize ? Math.round((count / stratumSize) * 1000) / 10 : 0,
      }
    }),
  }))
  const breakdown = sites.map((site) => {
    const siteAssignments = assignments.filter((assignment) => assignment.siteId === site.id)
    return {
      site: site.name,
      arms: data.arms.map((arm) => {
        const armAssignments = siteAssignments.filter((assignment) => assignment.armId === arm.id)
        const factors = Object.fromEntries(
          factorKeys
            .filter((key) => key !== 'site')
            .map((key) => {
              const levelLabels = new Map(
                contexts
                  .filter((context) => context.siteId === site.id)
                  .map((context) => [context.values[key]!, context.display[key]!] as const),
              )
              const counts = new Map([...levelLabels.keys()].map((value) => [value, 0]))
              for (const assignment of armAssignments) {
                const value = assignment.factors[key]
                if (!value) continue
                counts.set(value, (counts.get(value) ?? 0) + 1)
              }
              return [
                key,
                [...counts.entries()].map(([value, count]) => ({
                  value: levelLabels.get(value) ?? value,
                  count,
                  percent: armAssignments.length
                    ? Math.round((count / armAssignments.length) * 1000) / 10
                    : 0,
                })),
              ]
            }),
        ) as Record<string, Array<{ value: string; count: number; percent: number }>>
        return { armId: arm.id, label: arm.label, total: armAssignments.length, factors }
      }),
    }
  })
  return { results, strata, breakdown }
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
    const blockSize = sizes[randomInt(sizes.length)]!
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
    const canManage = permissions.has('randomization.manage')
    return {
      scheme: canManage ? scheme : null,
      canManage,
      availableFactors: canManage ? availableRandomizationFactors(studyId) : [],
    }
  })

  app.post('/scheme/simulate', async (request, reply) => {
    const studyId = (request.params as { studyId: string }).studyId
    const auth = await requireStudyPermission(request, reply, studyId, 'randomization.manage')
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
      validateScheme(parsed.data, [
        ...SUPPORTED_FACTOR_KEYS,
        ...availableRandomizationFactors(studyId).map((factor) => factor.key),
      ])
    } catch (error) {
      return reply.code(400).send({
        code: 'RANDOMIZATION_CONFIG_INVALID',
        message: (error as Error).message,
        requestId: request.id,
      })
    }
    try {
      const result = simulateWithTemporaryState(studyId, parsed.data)
      return { sampleSize: parsed.data.sampleSize, method: parsed.data.method, ...result }
    } catch (error) {
      return reply.code(400).send({
        code: 'RANDOMIZATION_SIMULATION_INVALID',
        message: (error as Error).message,
        requestId: request.id,
      })
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
      validateScheme(
        parsed.data,
        [
          ...SUPPORTED_FACTOR_KEYS,
          ...availableRandomizationFactors(studyId).map((factor) => factor.key),
        ],
        false,
      )
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
      .prepare(
        `SELECT id, status, name, method, arms_json, config_json, seed FROM randomization_schemes WHERE study_id = ?`,
      )
      .get(studyId) as
      | {
          id: string
          status: string
          name: string
          method: string
          arms_json: string
          config_json: string
          seed: string
        }
      | undefined
    if (!scheme)
      return reply
        .code(404)
        .send({ code: 'SCHEME_NOT_FOUND', message: '请先创建随机化方案', requestId: request.id })
    if (scheme.status === 'frozen') return { id: scheme.id, status: 'frozen' }
    try {
      const data = schemeSchema.parse({
        name: scheme.name,
        method: scheme.method,
        arms: JSON.parse(scheme.arms_json),
        config: JSON.parse(scheme.config_json),
        seed: scheme.seed,
      })
      validateScheme(data, [
        ...SUPPORTED_FACTOR_KEYS,
        ...availableRandomizationFactors(studyId).map((factor) => factor.key),
      ])
    } catch (error) {
      return reply.code(400).send({
        code: 'RANDOMIZATION_CONFIG_INVALID',
        message: (error as Error).message,
        requestId: request.id,
      })
    }
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
          screening_data_json: string
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
        const factors = factorsForSubject(subject.site_id, factorKeys, subject.screening_data_json)
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
      if (message.startsWith('MISSING_RANDOMIZATION_FACTOR:'))
        return reply.code(409).send({
          code: 'RANDOMIZATION_FACTOR_MISSING',
          message: `筛选表单中的随机化因素“${message.slice('MISSING_RANDOMIZATION_FACTOR:'.length)}”尚未填写`,
          requestId: request.id,
        })
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
