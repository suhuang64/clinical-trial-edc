import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { apiRequest } from '@/api/client'

export interface SiteScopeRow {
  id: string
  code: string
  name: string
  status: 'active' | 'disabled'
}

function storageKey(studyId: string) {
  return `edc-current-site:${studyId}`
}

export const useSiteScopeStore = defineStore('site-scope', () => {
  const studyId = ref('')
  const sites = ref<SiteScopeRow[]>([])
  const currentSiteId = ref('')
  const loading = ref(false)
  const currentSite = computed(
    () => sites.value.find((site) => site.id === currentSiteId.value) ?? null,
  )

  async function load(nextStudyId: string, force = false) {
    if (!nextStudyId) {
      studyId.value = ''
      sites.value = []
      currentSiteId.value = ''
      return
    }
    if (!force && studyId.value === nextStudyId && sites.value.length) return
    loading.value = true
    try {
      const response = await apiRequest<{ items: SiteScopeRow[] }>(`/studies/${nextStudyId}/sites`)
      studyId.value = nextStudyId
      sites.value = response.items
      const saved = localStorage.getItem(storageKey(nextStudyId)) ?? ''
      currentSiteId.value = sites.value.some((site) => site.id === saved) ? saved : ''
    } finally {
      loading.value = false
    }
  }

  function setCurrent(siteId: string) {
    if (siteId && !sites.value.some((site) => site.id === siteId)) return
    currentSiteId.value = siteId
    if (!studyId.value) return
    if (siteId) localStorage.setItem(storageKey(studyId.value), siteId)
    else localStorage.removeItem(storageKey(studyId.value))
  }

  return { sites, currentSiteId, currentSite, loading, load, setCurrent }
})
