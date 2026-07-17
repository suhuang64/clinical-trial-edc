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
  roleCode: 'study_admin' | 'site_admin' | 'investigator' | 'readonly' | null
  siteName: string | null
  permissions: string[]
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
  role_code: StudySummary['roleCode']
  site_name: string | null
  permissions: string[]
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
        roleCode: row.role_code,
        siteName: row.site_name,
        permissions: row.permissions,
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

  function can(permission: string) {
    return currentStudy.value?.permissions.includes(permission) ?? false
  }

  function reset() {
    studies.value = []
    loaded.value = false
    loading.value = false
    setCurrent('')
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
    can,
    reset,
    create,
    update,
    changeStatus,
  }
})
