import { describe, expect, it } from 'vitest'
import {
  generatePermutedBlock,
  minimizationRandomization,
  simpleRandomization,
} from './randomization.js'

const arms = [
  { id: 'A', weight: 1 },
  { id: 'B', weight: 1 },
] as const
const seed = '0123456789abcdef0123456789abcdef'

describe('随机化领域算法', () => {
  it('简单随机化在固定种子和位置下可复现', () => {
    expect(simpleRandomization(arms, seed, 8)).toBe(simpleRandomization(arms, seed, 8))
  })

  it('置换区组严格满足分配比例', () => {
    const block = generatePermutedBlock(
      [
        { id: 'A', weight: 2 },
        { id: 'B', weight: 1 },
      ],
      6,
      seed,
      0,
    )
    expect(block).toHaveLength(6)
    expect(block.filter((item) => item === 'A')).toHaveLength(4)
    expect(block.filter((item) => item === 'B')).toHaveLength(2)
  })

  it('不同分层拥有独立且可复现的区组', () => {
    const siteA = generatePermutedBlock(arms, 4, seed, 0, 'site=A')
    expect(siteA).toEqual(generatePermutedBlock(arms, 4, seed, 0, 'site=A'))
    const sequencesA = Array.from({ length: 10 }, (_, index) =>
      generatePermutedBlock(arms, 4, seed, index, 'site=A').join(''),
    )
    const sequencesB = Array.from({ length: 10 }, (_, index) =>
      generatePermutedBlock(arms, 4, seed, index, 'site=B').join(''),
    )
    expect(sequencesA).not.toEqual(sequencesB)
  })

  it('最小化随机优先选择不平衡度较低的治疗组', () => {
    const result = minimizationRandomization({
      arms,
      factors: [{ key: 'site', weight: 1 }],
      subjectFactors: { site: '01' },
      existing: [
        { armId: 'A', factors: { site: '01' } },
        { armId: 'A', factors: { site: '01' } },
      ],
      biasProbability: 1,
      seed,
      position: 2,
    })
    expect(result.armId).toBe('B')
    expect(result.scores.B).toBeLessThan(result.scores.A!)
  })

  it('拒绝与比例不兼容的区组大小', () => {
    expect(() =>
      generatePermutedBlock(
        [
          { id: 'A', weight: 2 },
          { id: 'B', weight: 1 },
        ],
        4,
        seed,
        0,
      ),
    ).toThrow('区组大小')
  })
})
