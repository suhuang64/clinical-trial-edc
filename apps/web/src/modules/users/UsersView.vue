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
  is_system_admin: number
  status: 'active' | 'disabled' | 'locked'
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
const loginAuditOpen = ref(false)
const loginAuditLoading = ref(false)
const loginAuditRows = ref<LoginAuditRow[]>([])
const filters = reactive({ query: '', status: '', page: 1, pageSize: 50 })
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
    const response = await apiRequest<{ items: UserRow[]; total: number }>(`/users?${query}`)
    rows.value = response.items
    total.value = response.total
  } catch (loadError) {
    error.value = loadError instanceof ApiClientError ? loadError.message : t('users.loadFailed')
  } finally {
    loading.value = false
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
        clearable
        :placeholder="t('users.searchPlaceholder')"
        @keyup.enter="search"
      />
      <el-select v-model="filters.status" clearable :placeholder="t('users.allStatuses')">
        <el-option :label="t('users.statuses.active')" value="active" /><el-option
          :label="t('users.statuses.disabled')"
          value="disabled"
        /><el-option :label="t('users.statuses.locked')" value="locked" />
      </el-select>
      <el-button type="primary" @click="search">{{ t('users.search') }}</el-button>
      <el-button @click="openLoginAudit">{{ t('users.loginAudit') }}</el-button>
      <span class="muted-text">{{ t('users.creationHint') }}</span>
    </section>
    <el-result v-if="error" icon="error" :title="t('users.loadFailed')" :sub-title="error">
      <template #extra>
        <el-button type="primary" @click="load">{{ t('users.retry') }}</el-button>
      </template>
    </el-result>
    <section v-else class="panel">
      <el-table :data="rows" style="width: 100%">
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
        <el-table-column :label="t('users.actions')" min-width="190" fixed="right">
          <template #default="scope">
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
  gap: 16px;
}
.users-toolbar {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) 160px auto auto minmax(260px, 2fr);
  align-items: center;
  gap: 8px;
  padding: 12px;
}
@media (max-width: 1100px) {
  .users-toolbar {
    grid-template-columns: 1fr 160px auto;
  }
  .users-toolbar .muted-text {
    grid-column: 1 / -1;
  }
}
</style>
