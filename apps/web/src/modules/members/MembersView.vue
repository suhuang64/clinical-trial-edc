<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useI18n } from 'vue-i18n'
import { apiRequest, ApiClientError } from '@/api/client'
import { useStudyStore } from '@/modules/studies/study.store'
import StatusPill from '@/components/ui/StatusPill.vue'

type RoleCode = 'study_admin' | 'site_admin' | 'investigator' | 'readonly'
type OverrideEffect = 'allow' | 'deny'

interface PermissionOverride {
  permissionCode: string
  effect: OverrideEffect
}

interface MemberRow {
  id: string
  user_id: string
  username: string
  display_name: string
  role_code: RoleCode
  status: 'active' | 'disabled'
  siteNames: string[]
  overrides: PermissionOverride[]
}

interface SiteRow {
  name: string
}

interface PermissionItem {
  code: string
  domain: string
  nameZh: string
  nameEn: string
  defaultRoleCodes: RoleCode[]
}

const studyStore = useStudyStore()
const { t, locale } = useI18n()
const loading = ref(false)
const createDrawerOpen = ref(false)
const permissionDrawerOpen = ref(false)
const passwordDialogOpen = ref(false)
const saving = ref(false)
const query = ref('')
const members = ref<MemberRow[]>([])
const sites = ref<SiteRow[]>([])
const permissions = ref<PermissionItem[]>([])
const grantableRoleCodes = ref<RoleCode[]>([])
const selectedMember = ref<MemberRow | null>(null)
const createForm = reactive({
  username: '',
  displayName: '',
  initialPassword: '',
  roleCode: 'investigator' as RoleCode,
  siteNames: [] as string[],
})
const editForm = reactive({
  roleCode: 'investigator' as RoleCode,
  siteNames: [] as string[],
  status: 'active' as 'active' | 'disabled',
})
const permissionEffects = reactive<Record<string, 'inherit' | OverrideEffect>>({})
const passwordForm = reactive({ newPassword: '', confirmPassword: '' })

const currentStudyId = computed(() => studyStore.currentStudyId)
const roleLabels = computed<Record<RoleCode, string>>(() => ({
  study_admin: t('members.roles.studyAdmin'),
  site_admin: t('members.roles.siteAdmin'),
  investigator: t('members.roles.investigator'),
  readonly: t('members.roles.readonly'),
}))
const domainLabels = computed<Record<string, string>>(() => ({
  study: t('members.domains.study'),
  site: t('members.domains.site'),
  member: t('members.domains.member'),
  form: t('members.domains.form'),
  subject: t('members.domains.subject'),
  randomization: t('members.domains.randomization'),
  data: t('members.domains.data'),
  export: t('members.domains.export'),
  audit: t('members.domains.audit'),
  dashboard: t('members.domains.dashboard'),
}))
const filteredMembers = computed(() => {
  const keyword = query.value.trim().toLocaleLowerCase()
  if (!keyword) return members.value
  return members.value.filter((member) =>
    `${member.display_name} ${member.username} ${roleLabels.value[member.role_code]}`
      .toLocaleLowerCase()
      .includes(keyword),
  )
})
const permissionGroups = computed(() => {
  const groups = new Map<string, PermissionItem[]>()
  for (const permission of permissions.value) {
    const items = groups.get(permission.domain) ?? []
    items.push(permission)
    groups.set(permission.domain, items)
  }
  return [...groups.entries()].map(([domain, items]) => ({
    domain,
    label: domainLabels.value[domain] ?? domain,
    items,
  }))
})

function siteScopeLabel(member: MemberRow) {
  if (member.role_code === 'study_admin') return t('members.allSites')
  return member.siteNames
    .map((name) => sites.value.find((site) => site.name === name)?.name || name)
    .join('、')
}

function inheritedLabel(permission: PermissionItem) {
  return permission.defaultRoleCodes.includes(editForm.roleCode)
    ? t('members.inheritedAllow')
    : t('members.inheritedDeny')
}

async function load() {
  await studyStore.load()
  if (!currentStudyId.value) return
  loading.value = true
  try {
    const [memberResponse, siteResponse, permissionResponse] = await Promise.all([
      apiRequest<{ items: MemberRow[] }>(`/studies/${currentStudyId.value}/members`),
      apiRequest<{ items: SiteRow[] }>(`/studies/${currentStudyId.value}/sites`),
      apiRequest<{ items: PermissionItem[]; grantableRoleCodes: RoleCode[] }>(
        `/studies/${currentStudyId.value}/members/permissions`,
      ),
    ])
    members.value = memberResponse.items
    sites.value = siteResponse.items
    permissions.value = permissionResponse.items
    grantableRoleCodes.value = permissionResponse.grantableRoleCodes
  } catch (error) {
    ElMessage.error(error instanceof ApiClientError ? error.message : t('members.loadFailed'))
  } finally {
    loading.value = false
  }
}

function validateRoleScope(roleCode: RoleCode, siteNames: string[]) {
  if (roleCode !== 'study_admin' && !siteNames.length) {
    ElMessage.warning(t('members.siteScopeRequired'))
    return false
  }
  return true
}

async function createMember() {
  if (!currentStudyId.value) return
  if (!createForm.username.trim() || !createForm.displayName.trim()) {
    ElMessage.warning(t('members.identityRequired'))
    return
  }
  if (createForm.initialPassword.length < 12) {
    ElMessage.warning(t('members.initialPasswordLength'))
    return
  }
  if (!validateRoleScope(createForm.roleCode, createForm.siteNames)) return
  saving.value = true
  try {
    await apiRequest(`/studies/${currentStudyId.value}/members`, {
      method: 'POST',
      body: JSON.stringify({
        ...createForm,
        username: createForm.username.trim(),
        displayName: createForm.displayName.trim(),
        siteNames: createForm.roleCode === 'study_admin' ? [] : createForm.siteNames,
        overrides: [],
      }),
    })
    ElMessage.success(t('members.created'))
    createDrawerOpen.value = false
    Object.assign(createForm, {
      username: '',
      displayName: '',
      initialPassword: '',
      roleCode: 'investigator',
      siteNames: [],
    })
    await load()
  } catch (error) {
    ElMessage.error(error instanceof ApiClientError ? error.message : t('members.createFailed'))
  } finally {
    saving.value = false
  }
}

function openPermissions(member: MemberRow) {
  selectedMember.value = member
  editForm.roleCode = member.role_code
  editForm.siteNames = [...member.siteNames]
  editForm.status = member.status
  for (const permission of permissions.value) permissionEffects[permission.code] = 'inherit'
  for (const override of member.overrides)
    permissionEffects[override.permissionCode] = override.effect
  permissionDrawerOpen.value = true
}

function collectOverrides() {
  return permissions.value.flatMap((permission) => {
    const effect = permissionEffects[permission.code]
    return effect === 'allow' || effect === 'deny'
      ? [{ permissionCode: permission.code, effect }]
      : []
  })
}

async function savePermissions() {
  if (!currentStudyId.value || !selectedMember.value) return
  if (!validateRoleScope(editForm.roleCode, editForm.siteNames)) return
  saving.value = true
  try {
    await apiRequest(`/studies/${currentStudyId.value}/members/${selectedMember.value.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        roleCode: editForm.roleCode,
        siteNames: editForm.roleCode === 'study_admin' ? [] : editForm.siteNames,
        status: editForm.status,
        overrides: collectOverrides(),
      }),
    })
    ElMessage.success(t('members.permissionsUpdated'))
    permissionDrawerOpen.value = false
    await load()
  } catch (error) {
    ElMessage.error(
      error instanceof ApiClientError ? error.message : t('members.permissionsUpdateFailed'),
    )
  } finally {
    saving.value = false
  }
}

async function toggleMember(member: MemberRow) {
  if (!currentStudyId.value) return
  const nextStatus = member.status === 'active' ? 'disabled' : 'active'
  const action = nextStatus === 'disabled' ? t('members.disable') : t('members.enable')
  const confirmed = await ElMessageBox.confirm(
    t('members.toggleQuestion', { action, name: member.display_name }),
    t('members.toggleTitle', { action }),
    {
      type: nextStatus === 'disabled' ? 'warning' : 'info',
      confirmButtonText: action,
      cancelButtonText: t('common.cancel'),
    },
  ).then(
    () => true,
    () => false,
  )
  if (!confirmed) return
  saving.value = true
  try {
    await apiRequest(`/studies/${currentStudyId.value}/members/${member.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        roleCode: member.role_code,
        siteNames: member.role_code === 'study_admin' ? [] : member.siteNames,
        status: nextStatus,
        overrides: member.overrides,
      }),
    })
    ElMessage.success(t('members.statusChanged', { action }))
    await load()
  } catch (error) {
    ElMessage.error(
      error instanceof ApiClientError ? error.message : t('members.statusChangeFailed', { action }),
    )
  } finally {
    saving.value = false
  }
}

function openPasswordDialog(member: MemberRow) {
  selectedMember.value = member
  Object.assign(passwordForm, { newPassword: '', confirmPassword: '' })
  passwordDialogOpen.value = true
}

async function resetPassword() {
  if (!currentStudyId.value || !selectedMember.value) return
  if (passwordForm.newPassword.length < 12) {
    ElMessage.warning(t('members.newPasswordLength'))
    return
  }
  if (passwordForm.newPassword !== passwordForm.confirmPassword) {
    ElMessage.warning(t('members.passwordMismatch'))
    return
  }
  saving.value = true
  try {
    await apiRequest(
      `/studies/${currentStudyId.value}/members/${selectedMember.value.id}/reset-password`,
      { method: 'POST', body: JSON.stringify({ newPassword: passwordForm.newPassword }) },
    )
    ElMessage.success(t('members.passwordReset'))
    passwordDialogOpen.value = false
  } catch (error) {
    ElMessage.error(
      error instanceof ApiClientError ? error.message : t('members.passwordResetFailed'),
    )
  } finally {
    saving.value = false
  }
}
function permissionName(permission: PermissionItem) {
  return locale.value === 'en-US' ? permission.nameEn : permission.nameZh
}

onMounted(load)
</script>

<template>
  <el-alert
    v-if="!currentStudyId"
    :title="t('subjects.selectStudy')"
    type="info"
    show-icon
    :closable="false"
  />
  <template v-else>
    <div class="toolbar">
      <el-input
        v-model="query"
        :placeholder="t('members.searchPlaceholder')"
        clearable
        style="max-width: 300px"
      />
      <span class="toolbar-spacer" />
      <el-button type="primary" @click="createDrawerOpen = true">
        {{ t('members.addMember') }}
      </el-button>
    </div>
    <section v-loading="loading" class="panel">
      <el-table :data="filteredMembers" style="width: 100%">
        <el-table-column prop="display_name" :label="t('members.name')" min-width="140" />
        <el-table-column prop="username" :label="t('members.username')" min-width="140" />
        <el-table-column :label="t('members.role')" min-width="180">
          <template #default="scope">{{ roleLabels[scope.row.role_code as RoleCode] }}</template>
        </el-table-column>
        <el-table-column :label="t('members.siteScope')" min-width="220">
          <template #default="scope">{{ siteScopeLabel(scope.row as MemberRow) }}</template>
        </el-table-column>
        <el-table-column :label="t('members.permissionOverrides')" width="110">
          <template #default="scope">
            {{ t('members.overrideCount', { count: scope.row.overrides.length }) }}
          </template>
        </el-table-column>
        <el-table-column :label="t('members.status')" width="110">
          <template #default="scope">
            <StatusPill
              :tone="scope.row.status === 'active' ? 'success' : 'neutral'"
              :label="scope.row.status === 'active' ? t('members.active') : t('members.disabled')"
            />
          </template>
        </el-table-column>
        <el-table-column :label="t('members.actions')" fixed="right" width="220">
          <template #default="scope">
            <el-button link type="primary" @click="openPermissions(scope.row as MemberRow)">
              {{ t('members.configurePermissions') }}
            </el-button>
            <el-dropdown>
              <el-button link type="primary">{{ t('members.moreActions') }}</el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item @click="openPasswordDialog(scope.row as MemberRow)">
                    {{ t('members.resetPassword') }}
                  </el-dropdown-item>
                  <el-dropdown-item divided @click="toggleMember(scope.row as MemberRow)">
                    {{
                      scope.row.status === 'active'
                        ? t('members.disableMember')
                        : t('members.reenable')
                    }}
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </template>
        </el-table-column>
      </el-table>
      <div v-if="!loading && !filteredMembers.length" class="empty-state">
        <div>
          <h2>{{ query ? t('members.noMatches') : t('members.noMembers') }}</h2>
          <p class="muted-text">
            {{ query ? t('members.tryOtherKeywords') : t('members.emptyHint') }}
          </p>
        </div>
      </div>
    </section>
  </template>

  <el-drawer
    v-model="createDrawerOpen"
    :title="t('members.addMember')"
    size="min(480px, 92vw)"
    :close-on-click-modal="false"
  >
    <el-form label-position="top">
      <el-form-item :label="t('members.username')" required>
        <el-input v-model="createForm.username" autocomplete="off" maxlength="64" />
      </el-form-item>
      <el-form-item :label="t('members.name')" required>
        <el-input v-model="createForm.displayName" maxlength="100" />
      </el-form-item>
      <el-form-item :label="t('members.initialPassword')" required>
        <el-input
          v-model="createForm.initialPassword"
          type="password"
          show-password
          autocomplete="new-password"
        />
        <div class="muted-text">{{ t('members.initialPasswordHint') }}</div>
      </el-form-item>
      <el-form-item :label="t('members.role')" required>
        <el-select v-model="createForm.roleCode" style="width: 100%">
          <el-option
            v-for="role in grantableRoleCodes"
            :key="role"
            :label="roleLabels[role]"
            :value="role"
          />
        </el-select>
      </el-form-item>
      <el-form-item
        v-if="createForm.roleCode !== 'study_admin'"
        :label="t('members.siteScope')"
        required
      >
        <el-select v-model="createForm.siteNames" multiple filterable style="width: 100%">
          <el-option v-for="site in sites" :key="site.name" :label="site.name" :value="site.name" />
        </el-select>
      </el-form-item>
      <el-alert :title="t('members.createHint')" type="info" show-icon :closable="false" />
    </el-form>
    <template #footer>
      <el-button @click="createDrawerOpen = false">{{ t('common.cancel') }}</el-button>
      <el-button type="primary" :loading="saving" @click="createMember">
        {{ t('members.createMember') }}
      </el-button>
    </template>
  </el-drawer>

  <el-drawer
    v-model="permissionDrawerOpen"
    :title="
      selectedMember
        ? t('members.configureTitle', { name: selectedMember.display_name })
        : t('members.configurePermissions')
    "
    size="min(760px, 96vw)"
    :close-on-click-modal="false"
  >
    <el-form label-position="top">
      <div class="member-settings-grid">
        <el-form-item :label="t('members.roleTemplate')" required>
          <el-select v-model="editForm.roleCode" style="width: 100%">
            <el-option
              v-for="role in grantableRoleCodes"
              :key="role"
              :label="roleLabels[role]"
              :value="role"
            />
          </el-select>
        </el-form-item>
        <el-form-item :label="t('members.memberStatus')" required>
          <el-select v-model="editForm.status" style="width: 100%">
            <el-option :label="t('members.active')" value="active" />
            <el-option :label="t('members.disabled')" value="disabled" />
          </el-select>
        </el-form-item>
      </div>
      <el-form-item
        v-if="editForm.roleCode !== 'study_admin'"
        :label="t('members.siteScope')"
        required
      >
        <el-select v-model="editForm.siteNames" multiple filterable style="width: 100%">
          <el-option v-for="site in sites" :key="site.name" :label="site.name" :value="site.name" />
        </el-select>
      </el-form-item>
    </el-form>

    <el-alert :title="t('members.overrideHint')" type="info" show-icon :closable="false" />
    <div class="permission-matrix">
      <section v-for="group in permissionGroups" :key="group.domain" class="permission-group">
        <h3>{{ group.label }}</h3>
        <div v-for="permission in group.items" :key="permission.code" class="permission-row">
          <div>
            <strong>{{ permissionName(permission) }}</strong>
            <span class="permission-code">{{ permission.code }}</span>
          </div>
          <el-radio-group
            v-model="permissionEffects[permission.code]"
            :aria-label="t('members.overrideAria', { permission: permissionName(permission) })"
          >
            <el-radio-button value="inherit">
              {{ t('members.inherit', { label: inheritedLabel(permission) }) }}
            </el-radio-button>
            <el-radio-button value="allow">{{ t('members.explicitAllow') }}</el-radio-button>
            <el-radio-button value="deny">{{ t('members.explicitDeny') }}</el-radio-button>
          </el-radio-group>
        </div>
      </section>
    </div>
    <template #footer>
      <el-button @click="permissionDrawerOpen = false">{{ t('common.cancel') }}</el-button>
      <el-button type="primary" :loading="saving" @click="savePermissions">
        {{ t('members.savePermissions') }}
      </el-button>
    </template>
  </el-drawer>

  <el-dialog
    v-model="passwordDialogOpen"
    :title="
      selectedMember
        ? t('members.resetTitle', { name: selectedMember.display_name })
        : t('members.resetPassword')
    "
    width="min(480px, 92vw)"
    :close-on-click-modal="false"
  >
    <el-alert :title="t('members.resetWarning')" type="warning" show-icon :closable="false" />
    <el-form label-position="top" class="password-form">
      <el-form-item :label="t('members.newPassword')" required>
        <el-input
          v-model="passwordForm.newPassword"
          type="password"
          show-password
          autocomplete="new-password"
        />
      </el-form-item>
      <el-form-item :label="t('members.confirmPassword')" required>
        <el-input
          v-model="passwordForm.confirmPassword"
          type="password"
          show-password
          autocomplete="new-password"
        />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="passwordDialogOpen = false">{{ t('common.cancel') }}</el-button>
      <el-button type="primary" :loading="saving" @click="resetPassword">
        {{ t('members.confirmReset') }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.member-settings-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.permission-matrix {
  display: grid;
  gap: 12px;
  margin-top: 16px;
}
.permission-group {
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-surface);
}
.permission-group h3 {
  margin: 0;
  padding: 12px 16px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-surface-subtle);
  font-size: 15px;
}
.permission-row {
  display: flex;
  min-height: 56px;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 8px 16px;
}
.permission-row + .permission-row {
  border-top: 1px solid var(--color-border);
}
.permission-code {
  display: block;
  color: var(--color-text-secondary);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12px;
}
.password-form {
  margin-top: 16px;
}
@media (max-width: 900px) {
  .permission-row {
    align-items: flex-start;
    flex-direction: column;
  }
}
@media (max-width: 767px) {
  .member-settings-grid {
    grid-template-columns: 1fr;
    gap: 0;
  }
}
</style>
