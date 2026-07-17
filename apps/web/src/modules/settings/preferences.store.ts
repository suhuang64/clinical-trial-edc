import type { AppLocale, ThemePreference } from '@edc/contracts'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { i18n } from '@/app/i18n'

export const usePreferencesStore = defineStore('preferences', () => {
  const locale = ref<AppLocale>((localStorage.getItem('edc-locale') as AppLocale) || 'zh-CN')
  const theme = ref<ThemePreference>(
    (localStorage.getItem('edc-theme') as ThemePreference) || 'system',
  )

  const resolvedTheme = computed<'light' | 'dark'>(() => {
    if (theme.value !== 'system') return theme.value
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })

  function apply() {
    document.documentElement.lang = locale.value
    document.documentElement.dataset.theme = resolvedTheme.value
    i18n.global.locale.value = locale.value
    localStorage.setItem('edc-locale', locale.value)
    localStorage.setItem('edc-theme', theme.value)
  }

  function setLocale(value: AppLocale) {
    locale.value = value
    apply()
  }

  function setTheme(value: ThemePreference) {
    theme.value = value
    apply()
  }

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (theme.value === 'system') apply()
  })

  return { locale, theme, resolvedTheme, apply, setLocale, setTheme }
})
