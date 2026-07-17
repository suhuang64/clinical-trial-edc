import { createHmac } from 'node:crypto'

export interface TreatmentArm {
  id: string
  weight: number
}

export interface ExistingAssignment {
  armId: string
  factors: Record<string, string>
}

export interface FactorDefinition {
  key: string
  weight: number
}

export class DeterministicRandom {
  private counter = 0
  constructor(
    private readonly seed: string,
    private readonly context: string,
  ) {
    if (seed.length < 16) throw new Error('随机种子长度至少为 16 个字符')
  }

  bytes() {
    const message = `${this.context}:${this.counter++}`
    return createHmac('sha256', this.seed).update(message).digest()
  }

  float() {
    return this.bytes().readUIntBE(0, 6) / 0x1_0000_0000_0000
  }

  integer(maxExclusive: number) {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0)
      throw new Error('随机整数上限必须为正整数')
    return Math.floor(this.float() * maxExclusive)
  }
}

function validateArms(arms: readonly TreatmentArm[]) {
  if (arms.length < 2) throw new Error('随机化至少需要两个治疗组')
  if (new Set(arms.map((arm) => arm.id)).size !== arms.length) throw new Error('治疗组 ID 必须唯一')
  if (arms.some((arm) => !Number.isInteger(arm.weight) || arm.weight <= 0))
    throw new Error('治疗组比例必须为正整数')
}

export function weightedPick(arms: readonly TreatmentArm[], random: DeterministicRandom) {
  validateArms(arms)
  const total = arms.reduce((sum, arm) => sum + arm.weight, 0)
  let cursor = random.float() * total
  for (const arm of arms) {
    cursor -= arm.weight
    if (cursor < 0) return arm.id
  }
  return arms.at(-1)!.id
}

export function simpleRandomization(arms: readonly TreatmentArm[], seed: string, position: number) {
  if (!Number.isInteger(position) || position < 0) throw new Error('序列位置必须为非负整数')
  return weightedPick(arms, new DeterministicRandom(seed, `simple:${position}`))
}

export function generatePermutedBlock(
  arms: readonly TreatmentArm[],
  blockSize: number,
  seed: string,
  blockIndex: number,
  stratumKey = 'all',
) {
  validateArms(arms)
  const ratioTotal = arms.reduce((sum, arm) => sum + arm.weight, 0)
  if (!Number.isInteger(blockSize) || blockSize <= 0 || blockSize % ratioTotal !== 0) {
    throw new Error(`区组大小必须是分配比例总和 ${ratioTotal} 的正整数倍`)
  }
  if (!Number.isInteger(blockIndex) || blockIndex < 0) throw new Error('区组序号必须为非负整数')

  const multiplier = blockSize / ratioTotal
  const block = arms.flatMap((arm) => Array.from({ length: arm.weight * multiplier }, () => arm.id))
  const random = new DeterministicRandom(seed, `block:${stratumKey}:${blockIndex}`)
  for (let index = block.length - 1; index > 0; index -= 1) {
    const swapIndex = random.integer(index + 1)
    ;[block[index], block[swapIndex]] = [block[swapIndex]!, block[index]!]
  }
  return block
}

function imbalanceScore(
  candidateArmId: string,
  arms: readonly TreatmentArm[],
  factors: readonly FactorDefinition[],
  subjectFactors: Record<string, string>,
  existing: readonly ExistingAssignment[],
) {
  let score = 0
  for (const factor of factors) {
    const value = subjectFactors[factor.key]
    if (value === undefined) throw new Error(`缺少分层因素：${factor.key}`)
    const counts = new Map(arms.map((arm) => [arm.id, 0]))
    for (const assignment of existing) {
      if (assignment.factors[factor.key] === value)
        counts.set(assignment.armId, (counts.get(assignment.armId) ?? 0) + 1)
    }
    counts.set(candidateArmId, (counts.get(candidateArmId) ?? 0) + 1)
    const normalized = arms.map((arm) => (counts.get(arm.id) ?? 0) / arm.weight)
    score += (Math.max(...normalized) - Math.min(...normalized)) * factor.weight
  }
  return score
}

export function minimizationRandomization(input: {
  arms: readonly TreatmentArm[]
  factors: readonly FactorDefinition[]
  subjectFactors: Record<string, string>
  existing: readonly ExistingAssignment[]
  biasProbability: number
  seed: string
  position: number
}) {
  validateArms(input.arms)
  if (input.factors.length === 0) throw new Error('最小化随机至少需要一个因素')
  if (input.factors.some((factor) => factor.weight <= 0)) throw new Error('因素权重必须大于 0')
  if (input.biasProbability < 0.5 || input.biasProbability > 1)
    throw new Error('最优组概率必须介于 0.5 和 1 之间')

  const scores = input.arms.map((arm) => ({
    armId: arm.id,
    score: imbalanceScore(arm.id, input.arms, input.factors, input.subjectFactors, input.existing),
  }))
  const minimum = Math.min(...scores.map((item) => item.score))
  const best = scores.filter((item) => Math.abs(item.score - minimum) < Number.EPSILON)
  const random = new DeterministicRandom(input.seed, `minimization:${input.position}`)
  const candidatePool = random.float() < input.biasProbability ? best : scores
  const selected = candidatePool[random.integer(candidatePool.length)]!
  return {
    armId: selected.armId,
    scores: Object.fromEntries(scores.map((item) => [item.armId, item.score])),
  }
}
