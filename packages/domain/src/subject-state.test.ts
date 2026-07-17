import { describe, expect, it } from 'vitest'
import { assertSubjectTransition, canTransitionSubject } from './subject-state.js'

describe('受试者状态机', () => {
  it('允许正常筛选入组路径', () => {
    expect(canTransitionSubject('screening', 'pending_enrollment')).toBe(true)
    expect(canTransitionSubject('pending_enrollment', 'enrolled')).toBe(true)
  })

  it('拒绝筛选失败后直接入组', () => {
    expect(() => assertSubjectTransition('screen_failed', 'enrolled')).toThrow('不允许')
  })
})
