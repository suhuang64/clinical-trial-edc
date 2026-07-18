<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import type { FormInstance, FormRules } from 'element-plus'
import { ElMessage } from 'element-plus'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { apiRequest, ApiClientError } from '@/api/client'

const router = useRouter()
const { t } = useI18n()
const saving = ref(false)
const formRef = ref<FormInstance>()
const form = reactive({
  username: '',
  displayName: '',
  gender: '',
  birthDate: '',
  phone: '',
  email: '',
  organization: '',
  password: '',
  confirmPassword: '',
})
const rules = computed<FormRules>(() => ({
  username: [{ required: true, message: t('register.required'), trigger: 'blur' }],
  displayName: [{ required: true, message: t('register.required'), trigger: 'blur' }],
  gender: [{ required: true, message: t('register.required'), trigger: 'change' }],
  birthDate: [{ required: true, message: t('register.required'), trigger: 'change' }],
  phone: [{ required: true, message: t('register.required'), trigger: 'blur' }],
  email: [
    { required: true, message: t('register.required'), trigger: 'blur' },
    { type: 'email', message: t('register.emailInvalid'), trigger: 'blur' },
  ],
  organization: [{ required: true, message: t('register.required'), trigger: 'blur' }],
  password: [
    { required: true, message: t('register.required'), trigger: 'blur' },
    { min: 12, message: t('register.passwordLength'), trigger: 'blur' },
  ],
  confirmPassword: [
    { required: true, message: t('register.required'), trigger: 'blur' },
    {
      validator: (_rule, value, callback) => {
        if (value !== form.password) callback(new Error(t('register.passwordMismatch')))
        else callback()
      },
      trigger: 'blur',
    },
  ],
}))

async function submit() {
  try {
    await formRef.value?.validate()
  } catch {
    return
  }
  saving.value = true
  try {
    await apiRequest('/auth/register', { method: 'POST', body: JSON.stringify(form) })
    ElMessage.success(t('register.succeeded'))
    await router.push('/login')
  } catch (error) {
    ElMessage.error(error instanceof ApiClientError ? error.message : t('register.failed'))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <main class="register-page">
    <section class="register-card panel">
      <div class="brand"><span class="brand-mark">O</span><span>OpenEDC</span></div>
      <p class="page-eyebrow">{{ t('register.eyebrow') }}</p>
      <h1>{{ t('register.title') }}</h1>
      <p class="muted-text">{{ t('register.hint') }}</p>
      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-position="top"
        @submit.prevent="submit"
      >
        <div class="register-grid">
          <el-form-item :label="t('register.username')" prop="username">
            <el-input v-model="form.username" maxlength="64" autocomplete="username" />
          </el-form-item>
          <el-form-item :label="t('register.displayName')" prop="displayName">
            <el-input v-model="form.displayName" maxlength="100" autocomplete="name" />
          </el-form-item>
          <el-form-item :label="t('register.gender')" prop="gender">
            <el-select
              v-model="form.gender"
              :placeholder="t('register.selectGender')"
              style="width: 100%"
            >
              <el-option :label="t('register.genders.male')" value="male" />
              <el-option :label="t('register.genders.female')" value="female" />
              <el-option :label="t('register.genders.other')" value="other" />
              <el-option :label="t('register.genders.undisclosed')" value="undisclosed" />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('register.birthDate')" prop="birthDate">
            <el-date-picker
              v-model="form.birthDate"
              type="date"
              value-format="YYYY-MM-DD"
              :placeholder="t('register.selectDate')"
              style="width: 100%"
            />
          </el-form-item>
          <el-form-item :label="t('register.phone')" prop="phone">
            <el-input v-model="form.phone" maxlength="30" autocomplete="tel" />
          </el-form-item>
          <el-form-item :label="t('register.email')" prop="email">
            <el-input v-model="form.email" maxlength="254" autocomplete="email" />
          </el-form-item>
          <el-form-item class="span-2" :label="t('register.organization')" prop="organization">
            <el-input v-model="form.organization" maxlength="200" autocomplete="organization" />
          </el-form-item>
          <el-form-item :label="t('register.password')" prop="password">
            <el-input
              v-model="form.password"
              type="password"
              show-password
              autocomplete="new-password"
            />
          </el-form-item>
          <el-form-item :label="t('register.confirmPassword')" prop="confirmPassword">
            <el-input
              v-model="form.confirmPassword"
              type="password"
              show-password
              autocomplete="new-password"
            />
          </el-form-item>
        </div>
        <el-alert :title="t('register.approvalHint')" type="info" show-icon :closable="false" />
        <div class="register-actions">
          <el-button native-type="button" @click="router.push('/login')">
            {{ t('register.backToLogin') }}
          </el-button>
          <el-button type="primary" native-type="submit" :loading="saving">
            {{ t('register.submit') }}
          </el-button>
        </div>
      </el-form>
    </section>
  </main>
</template>

<style scoped>
.register-page {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 32px 16px;
  background: var(--color-background);
}
.register-card {
  width: min(760px, 100%);
  padding: 32px;
}
.register-card h1 {
  margin: 4px 0 8px;
}
.register-card .brand {
  margin-bottom: 28px;
}
.register-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 16px;
  margin-top: 24px;
}
.register-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 24px;
}
.span-2 {
  grid-column: 1 / -1;
}
@media (max-width: 767px) {
  .register-page {
    display: block;
    padding: max(16px, env(safe-area-inset-top)) 12px max(16px, env(safe-area-inset-bottom));
  }
  .register-card {
    padding: 20px 16px;
  }
  .register-grid {
    grid-template-columns: 1fr;
  }
  .span-2 {
    grid-column: auto;
  }
  .register-actions .el-button {
    min-height: 44px;
  }
}
</style>
