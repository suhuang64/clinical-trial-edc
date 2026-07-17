<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import type { AppLocale, ThemePreference } from '@edc/contracts'
import { ElMessage } from 'element-plus'
import { apiRequest, ApiClientError } from '@/api/client'
import { useAuthStore } from '@/modules/auth/auth.store'
import { usePreferencesStore } from './preferences.store'

const { t } = useI18n()
const router = useRouter()
const preferences = usePreferencesStore()
const auth = useAuthStore()
const savingPreferences = ref(false)
const passwordDialogOpen = ref(false)
const changingPassword = ref(false)
const passwordForm = reactive({ currentPassword: '', newPassword: '', confirmPassword: '' })

async function savePreferences(locale: AppLocale, theme: ThemePreference) {
  const previous = { locale: preferences.locale, theme: preferences.theme }
  preferences.setLocale(locale)
  preferences.setTheme(theme)
  savingPreferences.value = true
  try {
    const response = await apiRequest<{ user: NonNullable<typeof auth.user> }>(
      '/auth/preferences',
      {
        method: 'PUT',
        body: JSON.stringify({ locale, theme }),
      },
    )
    if (auth.user) Object.assign(auth.user, response.user)
    ElMessage.success(t('settings.saved'))
  } catch (error) {
    preferences.setLocale(previous.locale)
    preferences.setTheme(previous.theme)
    ElMessage.error(error instanceof ApiClientError ? error.message : t('settings.saveFailed'))
  } finally {
    savingPreferences.value = false
  }
}

function changeLocale(value: AppLocale) {
  void savePreferences(value, preferences.theme)
}

function changeTheme(value: ThemePreference) {
  void savePreferences(preferences.locale, value)
}

async function changePassword() {
  if (passwordForm.newPassword.length < 12) {
    ElMessage.warning(t('settings.passwordLength'))
    return
  }
  if (passwordForm.newPassword !== passwordForm.confirmPassword) {
    ElMessage.warning(t('settings.passwordMismatch'))
    return
  }
  changingPassword.value = true
  try {
    await apiRequest('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({
        currentPassword: passwordForm.currentPassword,
        newPassword: passwordForm.newPassword,
      }),
    })
    passwordDialogOpen.value = false
    auth.clearSession()
    ElMessage.success(t('settings.passwordChanged'))
    await router.push('/login')
  } catch (error) {
    ElMessage.error(error instanceof ApiClientError ? error.message : t('settings.passwordFailed'))
  } finally {
    changingPassword.value = false
  }
}

async function logout() {
  await auth.logout()
  await router.push('/login')
}
</script>

<template>
  <section class="settings-grid">
    <article class="panel">
      <header class="panel-header">
        <h2>{{ t('settings.preferences') }}</h2>
      </header>
      <div class="panel-body">
        <el-form v-loading="savingPreferences" label-position="top">
          <el-form-item :label="t('settings.language')">
            <el-radio-group
              :model-value="preferences.locale"
              @update:model-value="changeLocale($event as AppLocale)"
            >
              <el-radio-button value="zh-CN">简体中文</el-radio-button>
              <el-radio-button value="en-US">English</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item :label="t('settings.theme')">
            <el-radio-group
              :model-value="preferences.theme"
              @update:model-value="changeTheme($event as ThemePreference)"
            >
              <el-radio-button value="light">{{ t('settings.light') }}</el-radio-button>
              <el-radio-button value="dark">{{ t('settings.dark') }}</el-radio-button>
              <el-radio-button value="system">{{ t('settings.system') }}</el-radio-button>
            </el-radio-group>
          </el-form-item>
        </el-form>
      </div>
    </article>
    <article class="panel">
      <header class="panel-header">
        <h2>{{ t('settings.security') }}</h2>
      </header>
      <div class="panel-body">
        <p>
          <strong>{{ auth.user?.displayName }}</strong>
        </p>
        <p class="muted-text">
          {{ auth.user?.username }} ·
          {{ auth.user?.isSystemAdmin ? t('settings.systemAdmin') : t('settings.studyUser') }}
        </p>
        <div class="security-actions">
          <el-button @click="passwordDialogOpen = true">
            {{ t('settings.changePassword') }}
          </el-button>
          <el-button @click="logout">{{ t('settings.logout') }}</el-button>
        </div>
      </div>
    </article>
  </section>

  <el-dialog
    v-model="passwordDialogOpen"
    :title="t('settings.changePassword')"
    width="min(460px, calc(100vw - 32px))"
  >
    <el-form label-position="top" @submit.prevent>
      <el-form-item :label="t('settings.currentPassword')" required>
        <el-input
          v-model="passwordForm.currentPassword"
          type="password"
          show-password
          autocomplete="current-password"
        />
      </el-form-item>
      <el-form-item :label="t('settings.newPassword')" required>
        <el-input
          v-model="passwordForm.newPassword"
          type="password"
          show-password
          autocomplete="new-password"
        />
      </el-form-item>
      <el-form-item :label="t('settings.confirmPassword')" required>
        <el-input
          v-model="passwordForm.confirmPassword"
          type="password"
          show-password
          autocomplete="new-password"
        />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="passwordDialogOpen = false">{{ t('common.cancel') }}</el-button
      ><el-button type="primary" :loading="changingPassword" @click="changePassword">
        {{ t('settings.confirmChange') }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.settings-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.security-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
@media (max-width: 767px) {
  .settings-grid {
    grid-template-columns: 1fr;
  }
}
</style>
