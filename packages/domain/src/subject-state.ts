import type { SubjectStatus } from '@edc/contracts'

const allowedTransitions: Record<SubjectStatus, readonly SubjectStatus[]> = {
  screening: ['screen_failed', 'pending_enrollment'],
  screen_failed: [],
  pending_enrollment: ['enrolled'],
  enrolled: ['completed', 'withdrawn', 'lost_to_followup'],
  completed: [],
  withdrawn: [],
  lost_to_followup: [],
}

export function canTransitionSubject(from: SubjectStatus, to: SubjectStatus) {
  return allowedTransitions[from].includes(to)
}

export function assertSubjectTransition(from: SubjectStatus, to: SubjectStatus) {
  if (!canTransitionSubject(from, to)) throw new Error(`不允许从 ${from} 变更为 ${to}`)
}
