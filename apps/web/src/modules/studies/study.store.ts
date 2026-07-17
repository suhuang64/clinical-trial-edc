import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { apiRequest } from '@/api/client'

export interface StudySummary {
  id: string
  protocolCode: string
  name: string
  sponsor: string | null
  studyType: string | null
  phase: string | null
  status: 'draft' | 'active' | 'ended' | 'archived'
  startDate: string | null
  endDate: string | null
  defaultLocale: 'zh-CN' | 'en-US'
  notes: string | null
  canManage: boolean
}

export interface CreateStudyInput {
  protocolCode: string
  name: string
  sponsor?: string
  studyType?: string
  phase?: string
  startDate?: string
  endDate?: string
  defaultLocale?: 'zh-CN' | 'en-US'
  notes?: string
}

interface StudyApiRow {
  id: string
  protocol_code: string
  name: string
  sponsor: string | null
  study_type: string | null
  phase: string | null
  status: StudySummary['status']
  start_date: string | null
  end_date: string | null
  default_locale: 'zh-CN' | 'en-US'
  notes: string | null
  can_manage: boolean
}

export const useStudyStore = defineStore('studies', () => {
  const studies = ref<StudySummary[]>([])
  const currentStudyId = ref(localStorage.getItem('edc-current-study') ?? '')
  const loading = ref(false)
  const loaded = ref(false)
  const currentStudy = computed(
    () => studies.value.find((study) => study.id === currentStudyId.value) ?? null,
  )

  async function load(force = false, includeArchived = false) {
    if ((loaded.value && !force) || loading.value) return
    loading.value = true
    try {
      const response = await apiRequest<{ items: StudyApiRow[] }>(
        `/studies${includeArchived ? '?includeArchived=true' : ''}`,
      )
      studies.value = response.items.map((row) => ({
        id: row.id,
        protocolCode: row.protocol_code,
        name: row.name,
        sponsor: row.sponsor,
        studyType: row.study_type,
        phase: row.phase,
        status: row.status,
        startDate: row.start_date,
        endDate: row.end_date,
        defaultLocale: row.default_locale,
        notes: row.notes,
        canManage: row.can_manage,
      }))
      if (!studies.value.some((study) => study.id === currentStudyId.value))
        setCurrent(studies.value[0]?.id ?? '')
      loaded.value = true
    } finally {
      loading.value = false
    }
  }

  function setCurrent(studyId: string) {
    currentStudyId.value = studyId
    if (studyId) localStorage.setItem('edc-current-study', studyId)
    else localStorage.removeItem('edc-current-study')
  }

  async function create(input: CreateStudyInput) {
    const result = await apiRequest<{ id: string }>('/studies', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    await load(true)
    setCurrent(result.id)
    return result.id
  }

  async function update(studyId: string, input: CreateStudyInput) {
    await apiRequest(`/studies/${studyId}`, { method: 'PUT', body: JSON.stringify(input) })
    await load(true, true)
  }

  async function changeStatus(
    studyId: string,
    status: 'active' | 'ended' | 'archived',
    reason?: string,
  ) {
    await apiRequest(`/studies/${studyId}/status`, {
      method: 'POST',
      body: JSON.stringify({ status, reason }),
    })
    await load(true, true)
  }

  return {
    studies,
    currentStudyId,
    currentStudy,
    loading,
    loaded,
    load,
    setCurrent,
    create,
    update,
    changeStatus,
  }
})
