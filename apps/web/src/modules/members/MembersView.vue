<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useI18n } from 'vue-i18n'
import { apiRequest, ApiClientError } from '@/api/client'
import { useStudyStore } from '@/modules/studies/study.store'
import StatusPill from '@/components/ui/StatusPill.vue'

type RoleCode = 'study_admin' | 'site_admin' | 'investigator' | 'readonly'
interface PermissionOverride {
  permissionCode: string
  effect: 'deny'
}
interface MemberRow {
  id: string
  user_id: string
  username: string
  display_name: string
  gender: 'male' | 'female' | 'other' | 'undisclosed' | null
  birth_date: string | null
  phone: string | null
  email: string | null
  organization: string | null
  role_code: RoleCode
  status: 'active' | 'disabled'
  site_id: string | null
  site_name: string | null
  manageable: boolean
  overrides: PermissionOverride[]
}
interface CandidateRow {
  id: string
  username: string
  display_name: string
  gender: 'male' | 'female' | 'other' | 'undisclosed' | null
  birth_date: string | null
  phone: string | null
  email: string | null
  organization: string | null
}
interface SiteRow {
  id: string
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
const saving = ref(false)
const query = ref('')
const members = ref<MemberRow[]>([])
const sites = ref<SiteRow[]>([])
const permissions = ref<PermissionItem[]>([])
const grantableRoleCodes = ref<RoleCode[]>([])
const addDrawerOpen = ref(false)
const permissionDrawerOpen = ref(false)
const candidateName = ref('')
const candidateLoading = ref(false)
const candidates = ref<CandidateRow[]>([])
const candidateSearched = ref(false)
const selectedMember = ref<MemberRow | null>(null)
const deniedPermissions = ref<string[]>([])
const addForm = reactive({
  userId: '',
  roleCode: 'investigator' as RoleCode,
  siteId: '' as string,
})
const editForm = reactive({
  roleCode: 'investigator' as RoleCode,
  siteId: '' as string,
  status: 'active' as 'active' | 'disabled',
})

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
  file: t('members.domains.file'),
  export: t('members.domains.export'),
  audit: t('members.domains.audit'),
  dashboard: t('members.domains.dashboard'),
}))
const filteredMembers = computed(() => {
  const keyword = query.value.trim().toLocaleLowerCase()
  if (!keyword) return members.value
  return members.value.filter((member) =>
    `${member.display_name} ${member.username} ${roleLabels.value[member.role_code]} ${member.site_name ?? ''}`
      .toLocaleLowerCase()
      .includes(keyword),
  )
})
const editablePermissions = computed(() =>
  permissions.value.filter((permission) => permission.defaultRoleCodes.includes(editForm.roleCode)),
)
const permissionGroups = computed(() => {
  const groups = new Map<string, PermissionItem[]>()
  for (const permission of editablePermissions.value) {
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

watch(
  () => editForm.roleCode,
  () => {
    const valid = new Set(editablePermissions.value.map((permission) => permission.code))
    deniedPermissions.value = deniedPermissions.value.filter((code) => valid.has(code))
    if (editForm.roleCode === 'study_admin') editForm.siteId = ''
  },
)
watch(
  () => addForm.roleCode,
  (role) => {
    if (role === 'study_admin') addForm.siteId = ''
  },
)

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

function openAddDrawer() {
  Object.assign(addForm, {
    userId: '',
    roleCode: grantableRoleCodes.value.includes('investigator')
      ? 'investigator'
      : grantableRoleCodes.value[0],
    siteId: studyStore.currentStudy?.siteId ?? '',
  })
  candidateName.value = ''
  candidates.value = []
  candidateSearched.value = false
  addDrawerOpen.value = true
}

async function searchCandidates() {
  if (!currentStudyId.value || !candidateName.value.trim()) {
    ElMessage.warning(t('members.nameSearchRequired'))
    return
  }
  candidateLoading.value = true
  candidateSearched.value = true
  try {
    const params = new URLSearchParams({ name: candidateName.value.trim() })
    const response = await apiRequest<{ items: CandidateRow[] }>(
      `/studies/${currentStudyId.value}/members/candidates?${params}`,
    )
    candidates.value = response.items
    addForm.userId = response.items.length === 1 ? response.items[0]!.id : ''
  } catch (error) {
    ElMessage.error(error instanceof ApiClientError ? error.message : t('members.searchFailed'))
  } finally {
    candidateLoading.value = false
  }
}

function validateScope(roleCode: RoleCode, siteId: string) {
  if (roleCode !== 'study_admin' && !siteId) {
    ElMessage.warning(t('members.siteScopeRequired'))
    return false
  }
  return true
}

async function addMember() {
  if (!currentStudyId.value || !addForm.userId) {
    ElMessage.warning(t('members.selectUserRequired'))
    return
  }
  if (!validateScope(addForm.roleCode, addForm.siteId)) return
  saving.value = true
  try {
    await apiRequest(`/studies/${currentStudyId.value}/members`, {
      method: 'POST',
      body: JSON.stringify({
        userId: addForm.userId,
        roleCode: addForm.roleCode,
        siteId: addForm.roleCode === 'study_admin' ? null : addForm.siteId,
        overrides: [],
      }),
    })
    ElMessage.success(t('members.created'))
    addDrawerOpen.value = false
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
  editForm.siteId = member.site_id ?? ''
  editForm.status = member.status
  deniedPermissions.value = member.overrides.map((override) => override.permissionCode)
  permissionDrawerOpen.value = true
}

async function savePermissions() {
  if (!currentStudyId.value || !selectedMember.value) return
  if (!validateScope(editForm.roleCode, editForm.siteId)) return
  saving.value = true
  try {
    await apiRequest(`/studies/${currentStudyId.value}/members/${selectedMember.value.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        roleCode: editForm.roleCode,
        siteId: editForm.roleCode === 'study_admin' ? null : editForm.siteId,
        status: editForm.status,
        overrides: deniedPermissions.value.map((permissionCode) => ({
          permissionCode,
          effect: 'deny',
        })),
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
  ).catch(() => false)
  if (!confirmed) return
  selectedMember.value = member
  editForm.roleCode = member.role_code
  editForm.siteId = member.site_id ?? ''
  editForm.status = nextStatus
  deniedPermissions.value = member.overrides.map((override) => override.permissionCode)
  await savePermissions()
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
        style="max-width: 320px"
      />
      <span class="toolbar-spacer" />
      <el-button type="primary" @click="openAddDrawer">{{ t('members.addMember') }}</el-button>
    </div>
    <section v-loading="loading" class="panel">
      <el-table :data="filteredMembers" style="width: 100%">
        <el-table-column :label="t('members.name')" min-width="170">
          <template #default="scope">
            <strong>{{ scope.row.display_name }}</strong>
            <div class="muted-text">{{ scope.row.username }}</div>
          </template>
        </el-table-column>
        <el-table-column :label="t('members.identityInfo')" min-width="250">
          <template #default="scope">
            <div>
              {{ scope.row.gender ? t(`members.genders.${scope.row.gender}`) : '—' }} ·
              {{ scope.row.birth_date || '—' }}
            </div>
            <div class="muted-text">{{ scope.row.phone || '—' }}</div>
            <div class="muted-text">{{ scope.row.organization || '—' }}</div>
          </template>
        </el-table-column>
        <el-table-column :label="t('members.role')" min-width="160">
          <template #default="scope">{{ roleLabels[scope.row.role_code as RoleCode] }}</template>
        </el-table-column>
        <el-table-column prop="site_name" :label="t('members.siteScope')" min-width="180">
          <template #default="scope">{{ scope.row.site_name || t('members.allSites') }}</template>
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
        <el-table-column :label="t('members.actions')" fixed="right" width="210">
          <template #default="scope">
            <template v-if="scope.row.manageable">
              <el-button link type="primary" @click="openPermissions(scope.row as MemberRow)">
                {{ t('members.configurePermissions') }}
              </el-button>
              <el-button
                link
                :type="scope.row.status === 'active' ? 'danger' : 'primary'"
                @click="toggleMember(scope.row as MemberRow)"
              >
                {{ scope.row.status === 'active' ? t('members.disable') : t('members.enable') }}
              </el-button>
            </template>
            <span v-else class="muted-text">{{ t('members.viewOnly') }}</span>
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
    v-model="addDrawerOpen"
    :title="t('members.addMember')"
    size="min(680px, 96vw)"
    :close-on-click-modal="false"
  >
    <el-form label-position="top">
      <el-form-item :label="t('members.searchByName')" required>
        <div class="candidate-search">
          <el-input
            v-model="candidateName"
            :placeholder="t('members.nameSearchPlaceholder')"
            maxlength="100"
            @keyup.enter="searchCandidates"
          />
          <el-button type="primary" :loading="candidateLoading" @click="searchCandidates">
            {{ t('common.search') }}
          </el-button>
        </div>
      </el-form-item>
      <div v-if="candidates.length" class="candidate-list" role="radiogroup">
        <label
          v-for="candidate in candidates"
          :key="candidate.id"
          class="candidate-card"
          :class="{ selected: addForm.userId === candidate.id }"
        >
          <el-radio v-model="addForm.userId" :value="candidate.id">
            <strong>{{ candidate.display_name }}</strong>
          </el-radio>
          <dl>
            <div>
              <dt>{{ t('members.gender') }}</dt>
              <dd>{{ candidate.gender ? t(`members.genders.${candidate.gender}`) : '—' }}</dd>
            </div>
            <div>
              <dt>{{ t('members.birthDate') }}</dt>
              <dd>{{ candidate.birth_date || '—' }}</dd>
            </div>
            <div>
              <dt>{{ t('members.phone') }}</dt>
              <dd>{{ candidate.phone || '—' }}</dd>
            </div>
            <div>
              <dt>{{ t('members.email') }}</dt>
              <dd>{{ candidate.email || '—' }}</dd>
            </div>
            <div>
              <dt>{{ t('members.organization') }}</dt>
              <dd>{{ candidate.organization || '—' }}</dd>
            </div>
          </dl>
        </label>
      </div>
      <el-empty
        v-else-if="candidateSearched && !candidateLoading"
        :description="t('members.noCandidates')"
      />
      <el-alert
        v-else
        :title="t('members.candidateHint')"
        type="info"
        show-icon
        :closable="false"
      />
      <div class="member-settings-grid">
        <el-form-item :label="t('members.role')" required>
          <el-select v-model="addForm.roleCode" style="width: 100%">
            <el-option
              v-for="role in grantableRoleCodes"
              :key="role"
              :label="roleLabels[role]"
              :value="role"
            />
          </el-select>
        </el-form-item>
        <el-form-item
          v-if="addForm.roleCode !== 'study_admin'"
          :label="t('members.siteScope')"
          required
        >
          <el-select v-model="addForm.siteId" style="width: 100%">
            <el-option v-for="site in sites" :key="site.id" :label="site.name" :value="site.id" />
          </el-select>
        </el-form-item>
      </div>
    </el-form>
    <template #footer>
      <el-button @click="addDrawerOpen = false">{{ t('common.cancel') }}</el-button>
      <el-button type="primary" :loading="saving" @click="addMember">
        {{ t('members.addSelectedUser') }}
      </el-button>
    </template>
  </el-drawer>

  <el-drawer
    v-model="permissionDrawerOpen"
    :title="
      selectedMember ? t('members.configureTitle', { name: selectedMember.display_name }) : ''
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
        <el-select v-model="editForm.siteId" style="width: 100%">
          <el-option v-for="site in sites" :key="site.id" :label="site.name" :value="site.id" />
        </el-select>
      </el-form-item>
    </el-form>
    <el-alert :title="t('members.denyOnlyHint')" type="info" show-icon :closable="false" />
    <div class="permission-matrix">
      <section v-for="group in permissionGroups" :key="group.domain" class="permission-group">
        <h3>{{ group.label }}</h3>
        <el-checkbox-group v-model="deniedPermissions">
          <label v-for="permission in group.items" :key="permission.code" class="permission-row">
            <div>
              <strong>{{ permissionName(permission) }}</strong>
              <span class="permission-code">{{ permission.code }}</span>
            </div>
            <el-checkbox :value="permission.code">{{ t('members.disablePermission') }}</el-checkbox>
          </label>
        </el-checkbox-group>
      </section>
    </div>
    <template #footer>
      <el-button @click="permissionDrawerOpen = false">{{ t('common.cancel') }}</el-button>
      <el-button type="primary" :loading="saving" @click="savePermissions">
        {{ t('members.savePermissions') }}
      </el-button>
    </template>
  </el-drawer>
</template>

<style scoped>
.member-settings-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 16px;
  margin-top: 20px;
}
.candidate-search {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px;
  width: 100%;
}
.candidate-list {
  display: grid;
  gap: 8px;
}
.candidate-card {
  display: block;
  padding: 14px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  cursor: pointer;
}
.candidate-card.selected {
  border-color: var(--color-primary);
  background: var(--color-surface-subtle);
}
.candidate-card dl {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 20px;
  margin: 10px 0 0 28px;
}
.candidate-card dl div {
  min-width: 0;
}
.candidate-card dt {
  color: var(--color-text-secondary);
  font-size: 12px;
}
.candidate-card dd {
  margin: 2px 0 0;
  overflow-wrap: anywhere;
}
.permission-matrix {
  display: grid;
  gap: 16px;
  margin-top: 16px;
}
.permission-group {
  border: 1px solid var(--color-border);
  border-radius: 8px;
  overflow: hidden;
}
.permission-group h3 {
  margin: 0;
  padding: 10px 12px;
  background: var(--color-surface-subtle);
  font-size: 14px;
}
.permission-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  padding: 10px 12px;
  border-top: 1px solid var(--color-border);
}
.permission-code {
  display: block;
  margin-top: 2px;
  color: var(--color-text-secondary);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
@media (max-width: 767px) {
  .member-settings-grid,
  .candidate-card dl {
    grid-template-columns: 1fr;
  }
  .permission-row {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
