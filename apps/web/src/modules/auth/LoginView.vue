<script setup lang="ts">
import { Lock, Moon, Sunny, User } from '@element-plus/icons-vue'
import { reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useI18n } from 'vue-i18n'
import { ApiClientError } from '@/api/client'
import openedcWordmark from '@/assets/brand/openedc-wordmark.webp'
import { useAuthStore } from './auth.store'
import { usePreferencesStore } from '@/modules/settings/preferences.store'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()
const preferences = usePreferencesStore()
const { t } = useI18n()
const loading = ref(false)
const form = reactive({ username: '', password: '' })

function toggleTheme() {
  preferences.setTheme(preferences.resolvedTheme === 'dark' ? 'light' : 'dark')
}

async function submit() {
  loading.value = true
  try {
    await auth.login(form.username, form.password)
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/dashboard'
    await router.push(redirect)
  } catch (error) {
    ElMessage.error(error instanceof ApiClientError ? error.message : t('login.failed'))
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="login-page">
    <div class="login-preferences" :aria-label="t('login.interfacePreferences')">
      <el-select
        :model-value="preferences.locale"
        :aria-label="t('login.language')"
        @update:model-value="preferences.setLocale"
      >
        <el-option label="简体中文" value="zh-CN" />
        <el-option label="English" value="en-US" />
      </el-select>
      <el-tooltip :content="t('login.toggleTheme')">
        <button
          class="icon-button"
          type="button"
          :aria-label="t('login.toggleTheme')"
          @click="toggleTheme"
        >
          <el-icon>
            <Moon v-if="preferences.resolvedTheme === 'light'" />
            <Sunny v-else />
          </el-icon>
        </button>
      </el-tooltip>
    </div>
    <section class="login-brand-panel">
      <div class="brand login-brand">
        <img
          class="login-brand-logo"
          :src="openedcWordmark"
          alt="OpenEDC"
          width="251"
          height="64"
        />
      </div>
      <div>
        <p>{{ t('login.platform') }}</p>
        <h1>{{ t('login.headline') }}</h1>
      </div>
      <small>{{ t('login.values') }}</small>
    </section>
    <main class="login-form-panel">
      <div class="login-card">
        <p class="page-eyebrow">{{ t('login.welcome') }}</p>
        <h2>{{ t('login.title') }}</h2>
        <p class="muted-text">{{ t('login.hint') }}</p>
        <el-form label-position="top" @submit.prevent="submit">
          <el-form-item :label="t('login.username')" required>
            <el-input
              v-model="form.username"
              autocomplete="username"
              size="large"
              :prefix-icon="User"
            />
          </el-form-item>
          <el-form-item :label="t('login.password')" required>
            <el-input
              v-model="form.password"
              type="password"
              show-password
              autocomplete="current-password"
              size="large"
              :prefix-icon="Lock"
            />
          </el-form-item>
          <el-button
            type="primary"
            size="large"
            native-type="submit"
            :loading="loading"
            style="width: 100%"
          >
            {{ t('login.submit') }}
          </el-button>
          <div class="register-link">
            <span class="muted-text">{{ t('login.noAccount') }}</span>
            <el-button link type="primary" @click="router.push('/register')">
              {{ t('login.register') }}
            </el-button>
          </div>
        </el-form>
      </div>
    </main>
  </div>
</template>

<style scoped>
.login-preferences {
  position: fixed;
  z-index: 10;
  top: 16px;
  right: 16px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.login-preferences .el-select {
  width: 132px;
}
.login-preferences :deep(.el-select__wrapper) {
  min-height: 44px;
}
.login-preferences .icon-button {
  min-width: 44px;
  min-height: 44px;
}
.login-brand {
  width: fit-content;
  height: auto;
  padding: 10px 14px;
  border: 0;
  border-radius: 12px;
}
.login-brand-logo {
  display: block;
  width: min(251px, 100%);
  height: auto;
}
.register-link {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 4px;
  margin-top: 16px;
}
@media (max-width: 767px) {
  .login-preferences {
    top: max(12px, env(safe-area-inset-top));
    right: 12px;
  }
}
</style>
