export type SubjectStatus =
  | 'screening'
  | 'screen_failed'
  | 'pending_enrollment'
  | 'enrolled'
  | 'completed'
  | 'withdrawn'
  | 'lost_to_followup'

interface SubjectStatusInput {
  status: SubjectStatus
  random_number: string | null
}

export interface SubjectStatusPresentation {
  labelKey: string
  tone: 'warning' | 'danger' | 'success' | 'neutral' | 'info'
  mobileType: 'warning' | 'danger' | 'success' | 'default' | 'primary'
}

const statusPresentations: Record<SubjectStatus, SubjectStatusPresentation> = {
  screening: {
    labelKey: 'subjects.statuses.screening',
    tone: 'warning',
    mobileType: 'warning',
  },
  screen_failed: {
    labelKey: 'subjects.statuses.screenFailed',
    tone: 'danger',
    mobileType: 'danger',
  },
  pending_enrollment: {
    labelKey: 'subjects.statuses.pendingEnrollment',
    tone: 'warning',
    mobileType: 'warning',
  },
  enrolled: {
    labelKey: 'subjects.statuses.enrolled',
    tone: 'success',
    mobileType: 'success',
  },
  completed: {
    labelKey: 'subjects.statuses.completed',
    tone: 'success',
    mobileType: 'success',
  },
  withdrawn: {
    labelKey: 'subjects.statuses.withdrawn',
    tone: 'neutral',
    mobileType: 'default',
  },
  lost_to_followup: {
    labelKey: 'subjects.statuses.lostToFollowup',
    tone: 'danger',
    mobileType: 'danger',
  },
}

export function getSubjectStatusPresentation(
  subject: SubjectStatusInput,
): SubjectStatusPresentation {
  if (subject.status === 'enrolled' && subject.random_number)
    return {
      labelKey: 'subjects.statuses.randomized',
      tone: 'info',
      mobileType: 'primary',
    }

  return statusPresentations[subject.status]
}
