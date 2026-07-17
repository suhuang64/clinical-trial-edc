import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { apiRequest } from '@/api/client'

export interface SiteScopeRow {
  name: string
  status: 'active' | 'disabled'
}

function storageKey(studyId: string) {
  return `edc-current-site:${studyId}`
}

export const useSiteScopeStore = defineStore('site-scope', () => {
  const studyId = ref('')
  const sites = ref<SiteScopeRow[]>([])
  const currentSiteName = ref('')
  const loading = ref(false)
  const currentSite = computed(
    () => sites.value.find((site) => site.name === currentSiteName.value) ?? null,
  )

  async function load(nextStudyId: string, force = false) {
    if (!nextStudyId) {
      studyId.value = ''
      sites.value = []
      currentSiteName.value = ''
      return
    }
    if (!force && studyId.value === nextStudyId && sites.value.length) return
    loading.value = true
    try {
      const response = await apiRequest<{ items: SiteScopeRow[] }>(`/studies/${nextStudyId}/sites`)
      studyId.value = nextStudyId
      sites.value = response.items
      const saved = localStorage.getItem(storageKey(nextStudyId)) ?? ''
      currentSiteName.value = sites.value.some((site) => site.name === saved) ? saved : ''
    } finally {
      loading.value = false
    }
  }

  function setCurrent(siteName: string) {
    if (siteName && !sites.value.some((site) => site.name === siteName)) return
    currentSiteName.value = siteName
    if (!studyId.value) return
    if (siteName) localStorage.setItem(storageKey(studyId.value), siteName)
    else localStorage.removeItem(storageKey(studyId.value))
  }

  function reset() {
    studyId.value = ''
    sites.value = []
    currentSiteName.value = ''
    loading.value = false
  }

  return { sites, currentSiteName, currentSite, loading, load, setCurrent, reset }
})
