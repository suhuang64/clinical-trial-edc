import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { apiRequest } from '@/api/client'
import { usePreferencesStore } from '@/modules/settings/preferences.store'
import { useSiteScopeStore } from '@/modules/studies/site-scope.store'
import { useStudyStore } from '@/modules/studies/study.store'

export interface SessionUser {
  id: string
  username: string
  displayName: string
  isSystemAdmin: boolean
  approvalStatus: 'pending' | 'approved' | 'rejected'
  locale: 'zh-CN' | 'en-US'
  theme: 'light' | 'dark' | 'system'
}

export const useAuthStore = defineStore('auth', () => {
  const user = ref<SessionUser | null>(null)
  const initialized = ref(false)
  const authenticated = computed(() => Boolean(user.value))

  function resetWorkspaceState() {
    useStudyStore().reset()
    useSiteScopeStore().reset()
  }

  function applySession(payload: { user: SessionUser; csrfToken: string | null }) {
    user.value = payload.user
    const preferences = usePreferencesStore()
    preferences.setLocale(payload.user.locale)
    preferences.setTheme(payload.user.theme)
    if (payload.csrfToken) sessionStorage.setItem('edc-csrf-token', payload.csrfToken)
  }

  async function initialize() {
    if (initialized.value) return
    try {
      applySession(await apiRequest('/auth/me'))
    } catch {
      user.value = null
      resetWorkspaceState()
      sessionStorage.removeItem('edc-csrf-token')
    } finally {
      initialized.value = true
    }
  }

  async function login(username: string, password: string) {
    const payload = await apiRequest<{ user: SessionUser; csrfToken: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    })
    resetWorkspaceState()
    applySession(payload)
    initialized.value = true
  }

  async function logout() {
    try {
      await apiRequest('/auth/logout', { method: 'POST' })
    } finally {
      user.value = null
      resetWorkspaceState()
      initialized.value = true
      sessionStorage.removeItem('edc-csrf-token')
    }
  }

  function clearSession() {
    user.value = null
    resetWorkspaceState()
    initialized.value = true
    sessionStorage.removeItem('edc-csrf-token')
  }

  return { user, initialized, authenticated, initialize, login, logout, clearSession }
})
