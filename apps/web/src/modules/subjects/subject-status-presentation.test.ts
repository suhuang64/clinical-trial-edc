import { describe, expect, it } from 'vitest'
import { getSubjectStatusPresentation, type SubjectStatus } from './subject-status-presentation'

describe('getSubjectStatusPresentation', () => {
  it('shows randomized while a randomized subject remains enrolled', () => {
    expect(
      getSubjectStatusPresentation({ status: 'enrolled', random_number: 'R-0001' }).labelKey,
    ).toBe('subjects.statuses.randomized')
  })

  it.each([
    ['completed', 'subjects.statuses.completed'],
    ['withdrawn', 'subjects.statuses.withdrawn'],
    ['lost_to_followup', 'subjects.statuses.lostToFollowup'],
  ] satisfies Array<[SubjectStatus, string]>)(
    'shows the terminal %s status even when a random number exists',
    (status, labelKey) => {
      expect(getSubjectStatusPresentation({ status, random_number: 'R-0001' }).labelKey).toBe(
        labelKey,
      )
    },
  )
})
