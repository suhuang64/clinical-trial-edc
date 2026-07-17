<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import type { FormInstance, FormRules } from 'element-plus'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useI18n } from 'vue-i18n'
import { apiRequest, ApiClientError } from '@/api/client'
import { useStudyStore } from '@/modules/studies/study.store'
import StatusPill from '@/components/ui/StatusPill.vue'

interface SiteRow {
  name: string
  principal_investigator: string | null
  contact_name: string | null
  contact_phone: string | null
  contact_email: string | null
  enrollment_target: number
  enrolled_count: number
  status: 'active' | 'disabled'
}

interface VisitRow {
  id: string
  code: string
  name: string
  sort_order: number
}

const studyStore = useStudyStore()
const { t } = useI18n()
const activeTab = ref('sites')
const loading = ref(false)
const sites = ref<SiteRow[]>([])
const visits = ref<VisitRow[]>([])
const siteDialogOpen = ref(false)
const visitDialogOpen = ref(false)
const saving = ref(false)
const editingSiteName = ref('')
const editingVisitId = ref('')
const siteFormRef = ref<FormInstance>()
const visitFormRef = ref<FormInstance>()
const currentStudyId = computed(() => studyStore.currentStudyId)
const siteForm = reactive({
  name: '',
  principalInvestigator: '',
  contactName: '',
  contactPhone: '',
  contactEmail: '',
  enrollmentTarget: 0,
})
const visitForm = reactive({ code: '', name: '', sortOrder: 0 })
const siteRules = computed<FormRules>(() => ({
  name: [{ required: true, message: t('sites.siteNameRequired'), trigger: 'blur' }],
  contactEmail: [{ type: 'email', message: t('sites.emailInvalid'), trigger: 'blur' }],
}))
const visitRules = computed<FormRules>(() => ({
  code: [{ required: true, message: t('sites.visitCodeRequired'), trigger: 'blur' }],
  name: [{ required: true, message: t('sites.visitNameRequired'), trigger: 'blur' }],
}))

async function load() {
  await studyStore.load()
  if (!currentStudyId.value) return
  loading.value = true
  try {
    const [siteResponse, visitResponse] = await Promise.all([
      apiRequest<{ items: SiteRow[] }>(`/studies/${currentStudyId.value}/sites`),
      apiRequest<{ items: VisitRow[] }>(`/studies/${currentStudyId.value}/visits`),
    ])
    sites.value = siteResponse.items
    visits.value = visitResponse.items
  } catch (error) {
    ElMessage.error(error instanceof ApiClientError ? error.message : t('sites.loadFailed'))
  } finally {
    loading.value = false
  }
}

function resetSiteForm() {
  editingSiteName.value = ''
  Object.assign(siteForm, {
    name: '',
    principalInvestigator: '',
    contactName: '',
    contactPhone: '',
    contactEmail: '',
    enrollmentTarget: 0,
  })
  siteFormRef.value?.clearValidate()
}

function openCreateSite() {
  resetSiteForm()
  siteDialogOpen.value = true
}

function openEditSite(site: SiteRow) {
  editingSiteName.value = site.name
  Object.assign(siteForm, {
    name: site.name,
    principalInvestigator: site.principal_investigator ?? '',
    contactName: site.contact_name ?? '',
    contactPhone: site.contact_phone ?? '',
    contactEmail: site.contact_email ?? '',
    enrollmentTarget: site.enrollment_target,
  })
  siteDialogOpen.value = true
}

async function saveSite() {
  if (!currentStudyId.value || !(await siteFormRef.value?.validate())) return
  saving.value = true
  try {
    const payload = {
      ...siteForm,
      principalInvestigator: siteForm.principalInvestigator.trim() || null,
      contactName: siteForm.contactName.trim() || null,
      contactPhone: siteForm.contactPhone.trim() || null,
      contactEmail: siteForm.contactEmail.trim() || null,
    }
    const path = editingSiteName.value
      ? `/studies/${currentStudyId.value}/sites/${encodeURIComponent(editingSiteName.value)}`
      : `/studies/${currentStudyId.value}/sites`
    await apiRequest(path, {
      method: editingSiteName.value ? 'PUT' : 'POST',
      body: JSON.stringify(payload),
    })
    ElMessage.success(editingSiteName.value ? t('sites.siteUpdated') : t('sites.siteCreated'))
    siteDialogOpen.value = false
    await load()
  } catch (error) {
    ElMessage.error(error instanceof ApiClientError ? error.message : t('sites.siteSaveFailed'))
  } finally {
    saving.value = false
  }
}

async function toggleSite(site: SiteRow) {
  if (!currentStudyId.value) return
  const status = site.status === 'active' ? 'disabled' : 'active'
  const verb = status === 'disabled' ? t('sites.disabled') : t('sites.active')
  const confirmed = await ElMessageBox.confirm(
    t('sites.statusWarning', { action: verb }),
    t('sites.actionTitle', { action: verb, site: site.name }),
    {
      type: 'warning',
      confirmButtonText: t('sites.confirmAction', { action: verb }),
      cancelButtonText: t('common.cancel'),
    },
  ).catch(() => null)
  if (!confirmed) return
  try {
    await apiRequest(
      `/studies/${currentStudyId.value}/sites/${encodeURIComponent(site.name)}/status`,
      {
        method: 'POST',
        body: JSON.stringify({ status }),
      },
    )
    ElMessage.success(t('sites.statusChanged', { action: verb }))
    await load()
  } catch (error) {
    ElMessage.error(
      error instanceof ApiClientError
        ? error.message
        : t('sites.statusChangeFailed', { action: verb }),
    )
  }
}

function resetVisitForm() {
  editingVisitId.value = ''
  Object.assign(visitForm, { code: '', name: '', sortOrder: visits.value.length * 10 })
  visitFormRef.value?.clearValidate()
}

function openCreateVisit() {
  resetVisitForm()
  visitDialogOpen.value = true
}

function openEditVisit(visit: VisitRow) {
  editingVisitId.value = visit.id
  Object.assign(visitForm, { code: visit.code, name: visit.name, sortOrder: visit.sort_order })
  visitDialogOpen.value = true
}

async function saveVisit() {
  if (!currentStudyId.value || !(await visitFormRef.value?.validate())) return
  saving.value = true
  try {
    const path = editingVisitId.value
      ? `/studies/${currentStudyId.value}/visits/${editingVisitId.value}`
      : `/studies/${currentStudyId.value}/visits`
    await apiRequest(path, {
      method: editingVisitId.value ? 'PUT' : 'POST',
      body: JSON.stringify(visitForm),
    })
    ElMessage.success(editingVisitId.value ? t('sites.visitUpdated') : t('sites.visitCreated'))
    visitDialogOpen.value = false
    await load()
  } catch (error) {
    ElMessage.error(error instanceof ApiClientError ? error.message : t('sites.visitSaveFailed'))
  } finally {
    saving.value = false
  }
}

async function deleteVisit(visit: VisitRow) {
  if (!currentStudyId.value) return
  const confirmed = await ElMessageBox.confirm(
    t('sites.deleteVisitWarning'),
    t('sites.deleteTitle', { visit: visit.name }),
    {
      type: 'warning',
      confirmButtonText: t('sites.confirmDelete'),
      cancelButtonText: t('common.cancel'),
    },
  ).catch(() => null)
  if (!confirmed) return
  try {
    await apiRequest(`/studies/${currentStudyId.value}/visits/${visit.id}`, { method: 'DELETE' })
    ElMessage.success(t('sites.visitDeleted'))
    await load()
  } catch (error) {
    ElMessage.error(error instanceof ApiClientError ? error.message : t('sites.visitDeleteFailed'))
  }
}

watch(currentStudyId, load)
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
    <el-tabs v-model="activeTab" class="configuration-tabs">
      <el-tab-pane :label="t('sites.tabs.sites')" name="sites">
        <div class="toolbar">
          <span class="muted-text">{{ t('sites.siteHint') }}</span>
          <span class="toolbar-spacer" />
          <el-button type="primary" @click="openCreateSite">
            {{ t('sites.addSite') }}
          </el-button>
        </div>
        <section v-loading="loading" class="site-grid">
          <article v-for="site in sites" :key="site.name" class="panel site-card">
            <header>
              <div>
                <h2>{{ site.name }}</h2>
              </div>
              <StatusPill
                :tone="site.status === 'active' ? 'success' : 'neutral'"
                :label="site.status === 'active' ? t('sites.active') : t('sites.disabled')"
              />
            </header>
            <dl>
              <div>
                <dt>{{ t('sites.principalInvestigator') }}</dt>
                <dd>{{ site.principal_investigator || t('sites.notSet') }}</dd>
              </div>
              <div>
                <dt>{{ t('sites.contact') }}</dt>
                <dd>{{ site.contact_phone || site.contact_email || t('sites.notSet') }}</dd>
              </div>
              <div>
                <dt>{{ t('sites.enrollmentProgress') }}</dt>
                <dd>{{ site.enrolled_count }} / {{ site.enrollment_target }}</dd>
              </div>
            </dl>
            <el-progress
              :percentage="
                site.enrollment_target
                  ? Math.min(100, Math.round((site.enrolled_count / site.enrollment_target) * 100))
                  : 0
              "
            />
            <footer>
              <el-button @click="openEditSite(site)">{{ t('sites.edit') }}</el-button>
              <el-button
                :type="site.status === 'active' ? 'danger' : 'primary'"
                plain
                @click="toggleSite(site)"
              >
                {{ site.status === 'active' ? t('sites.disabled') : t('sites.active') }}
              </el-button>
            </footer>
          </article>
          <div v-if="!loading && !sites.length" class="panel empty-state">
            <div>
              <h2>{{ t('sites.noSites') }}</h2>
              <p class="muted-text">{{ t('sites.noSitesHint') }}</p>
            </div>
          </div>
        </section>
      </el-tab-pane>

      <el-tab-pane :label="t('sites.tabs.visits')" name="visits">
        <div class="toolbar">
          <span class="muted-text">{{ t('sites.visitHint') }}</span>
          <span class="toolbar-spacer" />
          <el-button type="primary" @click="openCreateVisit">
            {{ t('sites.addVisit') }}
          </el-button>
        </div>
        <section v-loading="loading" class="panel">
          <el-table :data="visits" :empty-text="t('sites.noVisits')">
            <el-table-column prop="sort_order" :label="t('sites.order')" width="90" />
            <el-table-column prop="code" :label="t('sites.visitCode')" min-width="160" />
            <el-table-column prop="name" :label="t('sites.visitName')" min-width="200" />
            <el-table-column :label="t('sites.actions')" width="180">
              <template #default="{ row }">
                <el-button link type="primary" @click="openEditVisit(row)">
                  {{ t('sites.edit') }} </el-button
                ><el-button link type="danger" @click="deleteVisit(row)">
                  {{ t('sites.delete') }}
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </section>
      </el-tab-pane>
    </el-tabs>

    <el-dialog
      v-model="siteDialogOpen"
      :title="editingSiteName ? t('sites.editSite') : t('sites.addSite')"
      width="min(680px, calc(100vw - 32px))"
      :close-on-click-modal="false"
      @closed="resetSiteForm"
    >
      <el-form ref="siteFormRef" :model="siteForm" :rules="siteRules" label-position="top">
        <div class="form-grid">
          <el-form-item :label="t('sites.siteName')" prop="name" required>
            <el-input v-model="siteForm.name" maxlength="200" />
          </el-form-item>
          <el-form-item :label="t('sites.principalInvestigator')">
            <el-input v-model="siteForm.principalInvestigator" maxlength="200" />
          </el-form-item>
          <el-form-item :label="t('sites.contactName')">
            <el-input v-model="siteForm.contactName" maxlength="200" />
          </el-form-item>
          <el-form-item :label="t('sites.contactPhone')">
            <el-input v-model="siteForm.contactPhone" maxlength="100" />
          </el-form-item>
          <el-form-item :label="t('sites.contactEmail')" prop="contactEmail">
            <el-input v-model="siteForm.contactEmail" maxlength="254" />
          </el-form-item>
          <el-form-item :label="t('sites.enrollmentTarget')">
            <el-input-number
              v-model="siteForm.enrollmentTarget"
              :min="0"
              :max="1000000"
              style="width: 100%"
            />
          </el-form-item>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="siteDialogOpen = false">{{ t('common.cancel') }}</el-button
        ><el-button type="primary" :loading="saving" @click="saveSite">
          {{ t('sites.saveSite') }}
        </el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="visitDialogOpen"
      :title="editingVisitId ? t('sites.editVisit') : t('sites.addVisit')"
      width="min(520px, calc(100vw - 32px))"
      :close-on-click-modal="false"
      @closed="resetVisitForm"
    >
      <el-form ref="visitFormRef" :model="visitForm" :rules="visitRules" label-position="top">
        <el-form-item :label="t('sites.visitCode')" prop="code" required>
          <el-input
            v-model="visitForm.code"
            maxlength="80"
            :placeholder="t('sites.visitCodePlaceholder')"
          />
        </el-form-item>
        <el-form-item :label="t('sites.visitName')" prop="name" required>
          <el-input v-model="visitForm.name" maxlength="200" />
        </el-form-item>
        <el-form-item :label="t('sites.sortOrder')">
          <el-input-number v-model="visitForm.sortOrder" :min="0" :max="10000" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="visitDialogOpen = false">{{ t('common.cancel') }}</el-button
        ><el-button type="primary" :loading="saving" @click="saveVisit">
          {{ t('sites.saveVisit') }}
        </el-button>
      </template>
    </el-dialog>
  </template>
</template>

<style scoped>
.configuration-tabs :deep(.el-tabs__header) {
  margin-bottom: 16px;
}
.site-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(280px, 1fr));
  gap: 12px;
}
.site-card {
  padding: 16px;
}
.site-card header,
.site-card footer {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.site-card h2 {
  margin: 4px 0 0;
  font-size: 17px;
}
.site-card dl {
  display: grid;
  gap: 10px;
  margin: 18px 0;
}
.site-card dl div {
  display: grid;
  grid-template-columns: 100px 1fr;
  gap: 8px;
}
.site-card dt {
  color: var(--color-text-secondary);
}
.site-card dd {
  margin: 0;
}
.site-card footer {
  justify-content: flex-end;
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--color-border);
}
.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 16px;
}
@media (max-width: 1200px) {
  .site-grid {
    grid-template-columns: repeat(2, minmax(260px, 1fr));
  }
}
@media (max-width: 900px) {
  .site-grid {
    grid-template-columns: 1fr;
  }
}
</style>
