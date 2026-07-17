<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useI18n } from 'vue-i18n'
import { apiRequest, ApiClientError } from '@/api/client'
import { useAuthStore } from '@/modules/auth/auth.store'
import StatusPill from '@/components/ui/StatusPill.vue'

interface UserRow {
  id: string
  username: string
  display_name: string
  gender: 'male' | 'female' | 'other' | 'undisclosed' | null
  birth_date: string | null
  phone: string | null
  email: string | null
  organization: string | null
  is_system_admin: number
  status: 'active' | 'disabled' | 'locked'
  approval_status: 'pending' | 'approved' | 'rejected'
  locale: string
  theme: string
  locked_until: string | null
  study_count: number
  study_codes: string | null
  created_at: string
  updated_at: string
}

interface LoginAuditRow {
  id: string
  request_id: string
  action: 'auth.login_succeeded' | 'auth.login_failed'
  attemptedUsername: string | null
  actor_name: string | null
  ip_address: string | null
  user_agent: string | null
  created_at: string
}

const auth = useAuthStore()
const { t, locale } = useI18n()
const loading = ref(false)
const error = ref('')
const rows = ref<UserRow[]>([])
const total = ref(0)
const createDrawerOpen = ref(false)
const saving = ref(false)
const deletingUserId = ref('')
const loginAuditOpen = ref(false)
const loginAuditLoading = ref(false)
const loginAuditRows = ref<LoginAuditRow[]>([])
const filters = reactive({ query: '', status: '', approvalStatus: '', page: 1, pageSize: 50 })
const createForm = reactive({
  username: '',
  displayName: '',
  gender: '',
  birthDate: '',
  phone: '',
  email: '',
  organization: '',
  initialPassword: '',
})
const statusLabels = computed(() => ({
  active: t('users.statuses.active'),
  disabled: t('users.statuses.disabled'),
  locked: t('users.statuses.locked'),
}))
const statusTones: Record<string, 'success' | 'danger' | 'warning'> = {
  active: 'success',
  disabled: 'danger',
  locked: 'warning',
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const query = new URLSearchParams({
      page: String(filters.page),
      pageSize: String(filters.pageSize),
    })
    if (filters.query) query.set('query', filters.query)
    if (filters.status) query.set('status', filters.status)
    if (filters.approvalStatus) query.set('approvalStatus', filters.approvalStatus)
    const response = await apiRequest<{ items: UserRow[]; total: number }>(`/users?${query}`)
    rows.value = response.items
    total.value = response.total
  } catch (loadError) {
    error.value = loadError instanceof ApiClientError ? loadError.message : t('users.loadFailed')
  } finally {
    loading.value = false
  }
}

async function createUser() {
  if (Object.values(createForm).some((value) => !value.trim())) {
    ElMessage.warning(t('users.profileRequired'))
    return
  }
  if (createForm.initialPassword.length < 12) {
    ElMessage.warning(t('users.passwordLength'))
    return
  }
  saving.value = true
  try {
    await apiRequest('/users', { method: 'POST', body: JSON.stringify(createForm) })
    ElMessage.success(t('users.created'))
    createDrawerOpen.value = false
    Object.assign(createForm, {
      username: '',
      displayName: '',
      gender: '',
      birthDate: '',
      phone: '',
      email: '',
      organization: '',
      initialPassword: '',
    })
    await load()
  } catch (error) {
    ElMessage.error(error instanceof ApiClientError ? error.message : t('users.createFailed'))
  } finally {
    saving.value = false
  }
}

async function reviewRegistration(row: UserRow, approvalStatus: 'approved' | 'rejected') {
  const confirmed = await ElMessageBox.confirm(
    approvalStatus === 'approved' ? t('users.approveWarning') : t('users.rejectWarning'),
    approvalStatus === 'approved' ? t('users.approveTitle') : t('users.rejectTitle'),
    {
      type: approvalStatus === 'approved' ? 'info' : 'warning',
      confirmButtonText: approvalStatus === 'approved' ? t('users.approve') : t('users.reject'),
      cancelButtonText: t('common.cancel'),
    },
  ).catch(() => false)
  if (!confirmed) return
  try {
    await apiRequest(`/users/${row.id}/approval`, {
      method: 'PUT',
      body: JSON.stringify({ approvalStatus }),
    })
    ElMessage.success(approvalStatus === 'approved' ? t('users.approved') : t('users.rejected'))
    await load()
  } catch (error) {
    ElMessage.error(error instanceof ApiClientError ? error.message : t('users.reviewFailed'))
  }
}

async function toggleStatus(row: UserRow) {
  const status = row.status === 'active' ? 'disabled' : 'active'
  const confirmed = await ElMessageBox.confirm(
    status === 'disabled' ? t('users.disableWarning') : t('users.enableWarning'),
    status === 'disabled' ? t('users.disableTitle') : t('users.enableTitle'),
    {
      type: 'warning',
      confirmButtonText: t('users.confirm'),
      cancelButtonText: t('common.cancel'),
    },
  ).catch(() => null)
  if (!confirmed) return
  try {
    await apiRequest(`/users/${row.id}/status`, { method: 'PUT', body: JSON.stringify({ status }) })
    ElMessage.success(status === 'disabled' ? t('users.disabled') : t('users.enabled'))
    await load()
  } catch (error) {
    ElMessage.error(error instanceof ApiClientError ? error.message : t('users.statusFailed'))
  }
}

async function resetPassword(row: UserRow) {
  const result = await ElMessageBox.prompt(
    t('users.resetWarning'),
    t('users.resetTitle', { username: row.username }),
    {
      inputType: 'password',
      inputPlaceholder: t('users.passwordPlaceholder'),
      inputValidator: (value) => value.length >= 12 || t('users.passwordLength'),
      confirmButtonText: t('users.confirmReset'),
      cancelButtonText: t('common.cancel'),
    },
  ).catch(() => null)
  if (!result) return
  try {
    await apiRequest(`/users/${row.id}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ newPassword: result.value }),
    })
    ElMessage.success(t('users.passwordReset'))
  } catch (error) {
    ElMessage.error(error instanceof ApiClientError ? error.message : t('users.resetFailed'))
  }
}

async function deleteUser(row: UserRow) {
  const result = await ElMessageBox.prompt(
    t('users.deleteWarning', { name: row.display_name, username: row.username }),
    t('users.deleteTitle'),
    {
      type: 'error',
      inputPlaceholder: t('users.deletePlaceholder', { username: row.username }),
      inputValidator: (value) => value === row.username || t('users.deleteMismatch'),
      confirmButtonText: t('users.deleteConfirm'),
      cancelButtonText: t('common.cancel'),
    },
  ).catch(() => null)
  if (!result) return
  deletingUserId.value = row.id
  try {
    await apiRequest(`/users/${row.id}`, { method: 'DELETE' })
    ElMessage.success(t('users.deleted'))
    await load()
  } catch (error) {
    ElMessage.error(error instanceof ApiClientError ? error.message : t('users.deleteFailed'))
  } finally {
    deletingUserId.value = ''
  }
}

async function openLoginAudit() {
  loginAuditOpen.value = true
  loginAuditLoading.value = true
  try {
    const response = await apiRequest<{ items: LoginAuditRow[] }>('/users/login-audit?pageSize=100')
    loginAuditRows.value = response.items
  } catch (error) {
    ElMessage.error(error instanceof ApiClientError ? error.message : t('users.loginAuditFailed'))
  } finally {
    loginAuditLoading.value = false
  }
}
function formatDateTime(value: string) {
  return new Date(value).toLocaleString(locale.value)
}

function search() {
  filters.page = 1
  void load()
}
onMounted(load)
</script>

<template>
  <div v-loading="loading" class="users-page">
    <section class="panel users-toolbar">
      <el-input
        v-model="filters.query"
        class="account-search"
        clearable
        :placeholder="t('users.searchPlaceholder')"
        @keyup.enter="search"
      />
      <el-select
        v-model="filters.status"
        class="account-filter"
        clearable
        :placeholder="t('users.allStatuses')"
      >
        <el-option :label="t('users.statuses.active')" value="active" /><el-option
          :label="t('users.statuses.disabled')"
          value="disabled"
        /><el-option :label="t('users.statuses.locked')" value="locked" />
      </el-select>
      <el-select
        v-model="filters.approvalStatus"
        class="account-filter"
        clearable
        :placeholder="t('users.allApprovalStatuses')"
      >
        <el-option :label="t('users.approvalStatuses.pending')" value="pending" />
        <el-option :label="t('users.approvalStatuses.approved')" value="approved" />
        <el-option :label="t('users.approvalStatuses.rejected')" value="rejected" />
      </el-select>
      <el-button type="primary" @click="search">{{ t('users.search') }}</el-button>
      <el-button type="primary" plain @click="createDrawerOpen = true">
        {{ t('users.createUser') }}
      </el-button>
      <el-button @click="openLoginAudit">{{ t('users.loginAudit') }}</el-button>
    </section>
    <el-result v-if="error" icon="error" :title="t('users.loadFailed')" :sub-title="error">
      <template #extra>
        <el-button type="primary" @click="load">{{ t('users.retry') }}</el-button>
      </template>
    </el-result>
    <section v-else class="panel users-table-panel">
      <el-table class="users-table" :data="rows">
        <el-table-column :label="t('users.account')" min-width="190">
          <template #default="scope">
            <strong>{{ scope.row.display_name }}</strong>
            <div class="muted-text">{{ scope.row.username }}</div>
          </template>
        </el-table-column>
        <el-table-column :label="t('users.level')" width="130">
          <template #default="scope">
            {{ scope.row.is_system_admin ? t('users.systemAdmin') : t('users.studyMember') }}
          </template>
        </el-table-column>
        <el-table-column :label="t('users.identityInfo')" min-width="260">
          <template #default="scope">
            <div>
              {{ scope.row.gender ? t(`users.genders.${scope.row.gender}`) : '—' }} ·
              {{ scope.row.birth_date || '—' }}
            </div>
            <div class="muted-text">{{ scope.row.phone || '—' }}</div>
            <div class="muted-text">{{ scope.row.email || '—' }}</div>
            <div class="muted-text">{{ scope.row.organization || '—' }}</div>
          </template>
        </el-table-column>
        <el-table-column :label="t('users.approvalStatus')" width="110">
          <template #default="scope">
            <StatusPill
              :tone="
                scope.row.approval_status === 'approved'
                  ? 'success'
                  : scope.row.approval_status === 'rejected'
                    ? 'danger'
                    : 'warning'
              "
              :label="t(`users.approvalStatuses.${scope.row.approval_status}`)"
            />
          </template>
        </el-table-column>
        <el-table-column :label="t('users.status')" width="110">
          <template #default="scope">
            <StatusPill
              :tone="statusTones[scope.row.status] ?? 'warning'"
              :label="statusLabels[scope.row.status as keyof typeof statusLabels]"
            />
          </template>
        </el-table-column>
        <el-table-column prop="study_count" :label="t('users.studyCount')" width="90" />
        <el-table-column
          prop="study_codes"
          :label="t('users.studies')"
          min-width="180"
          show-overflow-tooltip
        />
        <el-table-column :label="t('users.updatedAt')" min-width="180">
          <template #default="scope">
            {{ formatDateTime(scope.row.updated_at) }}
          </template>
        </el-table-column>
        <el-table-column :label="t('users.actions')" min-width="250" fixed="right">
          <template #default="scope">
            <template v-if="scope.row.approval_status === 'pending'">
              <el-button link type="primary" @click="reviewRegistration(scope.row, 'approved')">
                {{ t('users.approve') }}
              </el-button>
              <el-button link type="danger" @click="reviewRegistration(scope.row, 'rejected')">
                {{ t('users.reject') }}
              </el-button>
            </template>
            <el-button link type="primary" @click="resetPassword(scope.row)">
              {{ t('users.resetPassword') }} </el-button
            ><el-button
              v-if="scope.row.id !== auth.user?.id"
              link
              :type="scope.row.status === 'active' ? 'danger' : 'primary'"
              @click="toggleStatus(scope.row)"
            >
              {{ scope.row.status === 'active' ? t('users.disable') : t('users.enable') }}
            </el-button>
            <el-button
              v-if="!scope.row.is_system_admin && scope.row.study_count === 0"
              link
              type="danger"
              :loading="deletingUserId === scope.row.id"
              @click="deleteUser(scope.row as UserRow)"
            >
              {{ t('users.delete') }}
            </el-button>
            <el-tooltip
              v-else-if="!scope.row.is_system_admin"
              :content="t('users.deleteMembershipHint')"
              placement="top"
            >
              <span
                ><el-button link type="danger" disabled>{{ t('users.delete') }}</el-button></span
              >
            </el-tooltip>
          </template>
        </el-table-column>
      </el-table>
      <el-pagination
        v-if="total > filters.pageSize"
        v-model:current-page="filters.page"
        :total="total"
        :page-size="filters.pageSize"
        layout="total, prev, pager, next"
        @current-change="load"
      />
    </section>
    <el-drawer
      v-model="createDrawerOpen"
      :title="t('users.createUser')"
      size="min(620px, 94vw)"
      :close-on-click-modal="false"
    >
      <el-form label-position="top">
        <div class="user-form-grid">
          <el-form-item :label="t('users.username')" required>
            <el-input v-model="createForm.username" maxlength="64" autocomplete="off" />
          </el-form-item>
          <el-form-item :label="t('users.displayName')" required>
            <el-input v-model="createForm.displayName" maxlength="100" />
          </el-form-item>
          <el-form-item :label="t('users.gender')" required>
            <el-select v-model="createForm.gender" style="width: 100%">
              <el-option :label="t('users.genders.male')" value="male" />
              <el-option :label="t('users.genders.female')" value="female" />
              <el-option :label="t('users.genders.other')" value="other" />
              <el-option :label="t('users.genders.undisclosed')" value="undisclosed" />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('users.birthDate')" required>
            <el-date-picker
              v-model="createForm.birthDate"
              type="date"
              value-format="YYYY-MM-DD"
              style="width: 100%"
            />
          </el-form-item>
          <el-form-item :label="t('users.phone')" required>
            <el-input v-model="createForm.phone" maxlength="30" />
          </el-form-item>
          <el-form-item :label="t('users.email')" required>
            <el-input v-model="createForm.email" maxlength="254" />
          </el-form-item>
          <el-form-item :label="t('users.organization')" required>
            <el-input v-model="createForm.organization" maxlength="200" />
          </el-form-item>
        </div>
        <el-form-item :label="t('users.initialPassword')" required>
          <el-input
            v-model="createForm.initialPassword"
            type="password"
            show-password
            autocomplete="new-password"
          />
        </el-form-item>
        <el-alert :title="t('users.manualCreateHint')" type="info" show-icon :closable="false" />
      </el-form>
      <template #footer>
        <el-button @click="createDrawerOpen = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="saving" @click="createUser">
          {{ t('users.confirmCreate') }}
        </el-button>
      </template>
    </el-drawer>
    <el-drawer v-model="loginAuditOpen" :title="t('users.loginAudit')" size="min(760px, 92vw)">
      <el-table v-loading="loginAuditLoading" :data="loginAuditRows" size="small">
        <el-table-column :label="t('users.loginResult')" width="110">
          <template #default="scope">
            <StatusPill
              :tone="scope.row.action === 'auth.login_succeeded' ? 'success' : 'danger'"
              :label="
                scope.row.action === 'auth.login_succeeded'
                  ? t('users.loginSucceeded')
                  : t('users.loginFailed')
              "
            />
          </template>
        </el-table-column>
        <el-table-column
          prop="attemptedUsername"
          :label="t('users.loginUsername')"
          min-width="150"
        />
        <el-table-column prop="ip_address" :label="t('users.ipAddress')" min-width="140" />
        <el-table-column :label="t('users.loginTime')" min-width="180">
          <template #default="scope">{{ formatDateTime(scope.row.created_at) }}</template>
        </el-table-column>
        <el-table-column
          prop="user_agent"
          :label="t('users.userAgent')"
          min-width="260"
          show-overflow-tooltip
        />
      </el-table>
    </el-drawer>
  </div>
</template>

<style scoped>
.users-page {
  display: grid;
  min-width: 0;
  gap: 16px;
}
.users-toolbar {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 12px;
}
.account-search {
  min-width: 220px;
  flex: 1 1 320px;
}
.account-filter {
  width: 170px;
}
.users-table-panel {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
}
.users-table {
  width: 100%;
  max-width: 100%;
}
.user-form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 16px;
}
@media (max-width: 767px) {
  .account-search,
  .account-filter {
    width: 100%;
    flex-basis: 100%;
  }
  .user-form-grid {
    grid-template-columns: 1fr;
  }
}
</style>
