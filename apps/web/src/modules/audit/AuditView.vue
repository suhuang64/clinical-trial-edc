<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { useI18n } from 'vue-i18n'
import { apiRequest, ApiClientError } from '@/api/client'
import { useStudyStore } from '@/modules/studies/study.store'
import { useSiteScopeStore } from '@/modules/studies/site-scope.store'

interface SiteRow {
  id: string
  name: string
}
interface AuditRow {
  id: string
  requestId: string
  actorUsername: string | null
  actorName: string | null
  siteName: string | null
  objectType: string
  objectId: string | null
  action: string
  before: unknown
  after: unknown
  reason: string | null
  ipAddress: string | null
  userAgent: string | null
  createdAt: string
}

const studyStore = useStudyStore()
const siteScope = useSiteScopeStore()
const { t, locale } = useI18n()
const loading = ref(false)
const exporting = ref(false)
const error = ref('')
const rows = ref<AuditRow[]>([])
const sites = ref<SiteRow[]>([])
const total = ref(0)
const selected = ref<AuditRow | null>(null)
const detailOpen = computed({
  get: () => selected.value !== null,
  set: (open) => {
    if (!open) selected.value = null
  },
})
const filters = ref({
  siteId: '',
  actor: '',
  action: '',
  objectType: '',
  dateRange: [] as string[],
  page: 1,
  pageSize: 50,
})

const actionLabels = computed<Record<string, string>>(() => ({
  'subject.screening_created': t('audit.actions.screeningCreated'),
  'subject.screening_concluded': t('audit.actions.screeningConcluded'),
  'subject.enrolled': t('audit.actions.subjectEnrolled'),
  'subject_event.created': t('audit.actions.eventCreated'),
  'randomization.assigned': t('audit.actions.randomized'),
  'data_record.created': t('audit.actions.dataCreated'),
  'data_record.updated': t('audit.actions.dataUpdated'),
  'data_record.deleted': t('audit.actions.dataDeleted'),
  'file.uploaded': t('audit.actions.fileUploaded'),
  'file.deleted': t('audit.actions.fileDeleted'),
  'form.published': t('audit.actions.formPublished'),
  'form.created': t('audit.actions.formCreated'),
  'form.deleted': t('audit.actions.formDeleted'),
  'form.record_migrated': t('audit.actions.formRecordMigrated'),
  'form.migration_failed': t('audit.actions.formMigrationFailed'),
  'export.completed': t('audit.actions.exportCompleted'),
  'export.failed': t('audit.actions.exportFailed'),
  'export.queued': t('audit.actions.exportQueued'),
  'auth.login_failed': t('audit.actions.loginFailed'),
  'auth.login_succeeded': t('audit.actions.loginSucceeded'),
  'auth.logout': t('audit.actions.logout'),
  'user.registered': t('audit.actions.userRegistered'),
  'user.created': t('audit.actions.userCreated'),
  'user.updated': t('audit.actions.userUpdated'),
  'user.deleted': t('audit.actions.userDeleted'),
  'user.password_changed': t('audit.actions.passwordChanged'),
  'user.password_reset': t('audit.actions.passwordReset'),
  'user.preferences_updated': t('audit.actions.preferencesUpdated'),
  'user.profile_updated': t('audit.actions.profileUpdated'),
  'user.registration_approved': t('audit.actions.registrationApproved'),
  'user.registration_rejected': t('audit.actions.registrationRejected'),
  'user.active': t('audit.actions.userActivated'),
  'user.disabled': t('audit.actions.userDisabled'),
  'study.created': t('audit.actions.studyCreated'),
  'study.updated': t('audit.actions.studyUpdated'),
  'study.status_changed': t('audit.actions.studyStatusChanged'),
  'study.numbering_updated': t('audit.actions.numberingUpdated'),
  'site.created': t('audit.actions.siteCreated'),
  'site.updated': t('audit.actions.siteUpdated'),
  'site.status_changed': t('audit.actions.siteStatusChanged'),
  'visit.created': t('audit.actions.visitCreated'),
  'visit.updated': t('audit.actions.visitUpdated'),
  'visit.deleted': t('audit.actions.visitDeleted'),
  'member.created': t('audit.actions.memberCreated'),
  'member.updated': t('audit.actions.memberUpdated'),
  'form.copied': t('audit.actions.formCopied'),
  'form.draft_saved': t('audit.actions.formDraftSaved'),
  'form.exported': t('audit.actions.formExported'),
  'form.imported': t('audit.actions.formImported'),
  'form.migration_queued': t('audit.actions.formMigrationQueued'),
  'form.migration_retried': t('audit.actions.formMigrationRetried'),
  'randomization.scheme_activated': t('audit.actions.schemeActivated'),
  'randomization.scheme_created': t('audit.actions.schemeCreated'),
  'randomization.scheme_updated': t('audit.actions.schemeUpdated'),
  'subject.screening_updated': t('audit.actions.screeningUpdated'),
  'subject.deleted': t('audit.actions.subjectDeleted'),
  'dashboard.exported': t('audit.actions.dashboardExported'),
}))

function queryString() {
  const query = new URLSearchParams({
    page: String(filters.value.page),
    pageSize: String(filters.value.pageSize),
  })
  for (const key of ['siteId', 'actor', 'action', 'objectType'] as const)
    if (filters.value[key]) query.set(key, filters.value[key])
  if (filters.value.dateRange.length === 2) {
    query.set('dateFrom', filters.value.dateRange[0]!)
    query.set('dateTo', filters.value.dateRange[1]!)
  }
  return query.toString()
}

async function load() {
  await studyStore.load()
  if (!studyStore.currentStudyId) return
  loading.value = true
  error.value = ''
  try {
    const [auditResponse, siteResponse] = await Promise.all([
      apiRequest<{ items: AuditRow[]; total: number }>(
        `/studies/${studyStore.currentStudyId}/audit?${queryString()}`,
      ),
      apiRequest<{ items: SiteRow[] }>(`/studies/${studyStore.currentStudyId}/sites`),
    ])
    rows.value = auditResponse.items
    total.value = auditResponse.total
    sites.value = siteResponse.items
  } catch (loadError) {
    error.value = loadError instanceof ApiClientError ? loadError.message : t('audit.loadFailed')
  } finally {
    loading.value = false
  }
}

function search() {
  filters.value.page = 1
  void load()
}
function reset() {
  filters.value = {
    siteId: '',
    actor: '',
    action: '',
    objectType: '',
    dateRange: [],
    page: 1,
    pageSize: 50,
  }
  siteScope.setCurrent('')
  void load()
}
function pretty(value: unknown) {
  return value === null ? t('audit.none') : JSON.stringify(value, null, 2)
}

async function exportAudit() {
  if (!studyStore.currentStudyId) return
  exporting.value = true
  try {
    await apiRequest(`/studies/${studyStore.currentStudyId}/exports`, {
      method: 'POST',
      body: JSON.stringify({
        dataset: 'audit',
        format: 'csv',
        siteId: filters.value.siteId || null,
        ...(filters.value.dateRange.length === 2
          ? { dateFrom: filters.value.dateRange[0], dateTo: filters.value.dateRange[1] }
          : {}),
      }),
    })
    ElMessage.success(t('audit.exportReady'))
  } catch (exportError) {
    ElMessage.error(
      exportError instanceof ApiClientError ? exportError.message : t('audit.exportFailed'),
    )
  } finally {
    exporting.value = false
  }
}
function formatDateTime(value: string) {
  return new Date(value).toLocaleString(locale.value)
}

watch(() => studyStore.currentStudyId, load)
watch(
  () => siteScope.currentSiteId,
  (value) => {
    if (filters.value.siteId !== value) {
      filters.value.siteId = value
      void load()
    }
  },
)
watch(
  () => filters.value.siteId,
  (value) => siteScope.setCurrent(value),
)
onMounted(load)
</script>

<template>
  <div v-loading="loading" class="audit-page">
    <section v-if="!studyStore.currentStudyId" class="panel empty-state">
      <div>
        <h2>{{ t('audit.selectStudy') }}</h2>
        <p class="muted-text">{{ t('audit.studyContextHint') }}</p>
      </div>
    </section>
    <template v-else>
      <section class="panel audit-filters">
        <el-form inline @submit.prevent="search">
          <el-form-item :label="t('audit.site')">
            <el-select
              v-model="filters.siteId"
              clearable
              :placeholder="t('audit.allAuthorizedSites')"
              style="width: 190px"
            >
              <el-option v-for="site in sites" :key="site.id" :label="site.name" :value="site.id" />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('audit.actor')">
            <el-input
              v-model="filters.actor"
              clearable
              :placeholder="t('audit.actorPlaceholder')"
            />
          </el-form-item>
          <el-form-item :label="t('audit.action')">
            <el-select
              v-model="filters.action"
              clearable
              filterable
              :placeholder="t('audit.allActions')"
              style="width: 180px"
            >
              <el-option
                v-for="(label, value) in actionLabels"
                :key="value"
                :label="label"
                :value="value"
              />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('audit.objectType')">
            <el-input
              v-model="filters.objectType"
              clearable
              :placeholder="t('audit.objectTypePlaceholder')"
            />
          </el-form-item>
          <el-form-item :label="t('audit.date')">
            <el-date-picker
              v-model="filters.dateRange"
              type="daterange"
              value-format="YYYY-MM-DD"
              :start-placeholder="t('audit.start')"
              :end-placeholder="t('audit.end')"
            />
          </el-form-item>
          <el-form-item>
            <el-button type="primary" @click="search">{{ t('audit.search') }}</el-button
            ><el-button @click="reset">{{ t('audit.reset') }}</el-button
            ><el-button :loading="exporting" @click="exportAudit">
              {{ t('audit.exportCsv') }}
            </el-button>
          </el-form-item>
        </el-form>
      </section>
      <el-result v-if="error" icon="error" :title="t('audit.loadFailed')" :sub-title="error">
        <template #extra>
          <el-button type="primary" @click="load">{{ t('audit.retry') }}</el-button>
        </template>
      </el-result>
      <section v-else class="panel audit-results">
        <el-table
          v-if="rows.length"
          :data="rows"
          style="width: 100%"
          @row-click="selected = $event"
        >
          <el-table-column :label="t('audit.time')" min-width="185">
            <template #default="scope">
              {{ formatDateTime(scope.row.createdAt) }}
            </template>
          </el-table-column>
          <el-table-column :label="t('audit.actor')" min-width="150">
            <template #default="scope">
              {{ scope.row.actorName || t('audit.system') }}
              <div class="muted-text">{{ scope.row.actorUsername }}</div>
            </template>
          </el-table-column>
          <el-table-column prop="siteName" :label="t('audit.site')" min-width="160" />
          <el-table-column :label="t('audit.action')" min-width="160">
            <template #default="scope">
              {{ actionLabels[scope.row.action] ?? scope.row.action }}
            </template>
          </el-table-column>
          <el-table-column prop="objectType" :label="t('audit.object')" min-width="130" />
          <el-table-column
            prop="objectId"
            :label="t('audit.objectId')"
            min-width="210"
            show-overflow-tooltip
          />
          <el-table-column :label="t('audit.details')" width="90">
            <template #default="scope">
              <el-button link type="primary" @click.stop="selected = scope.row">
                {{ t('audit.view') }}
              </el-button>
            </template>
          </el-table-column>
        </el-table>
        <div v-else class="empty-state">
          <div>
            <h2>{{ t('audit.noMatches') }}</h2>
            <p class="muted-text">{{ t('audit.noMatchesHint') }}</p>
          </div>
        </div>
        <el-pagination
          v-if="total > filters.pageSize"
          v-model:current-page="filters.page"
          v-model:page-size="filters.pageSize"
          :total="total"
          layout="total, prev, pager, next"
          @current-change="load"
        />
      </section>
    </template>
  </div>
  <el-drawer v-model="detailOpen" :title="t('audit.detailTitle')" size="min(760px, 100vw)">
    <template v-if="selected">
      <el-descriptions :column="1" border>
        <el-descriptions-item :label="t('audit.requestId')">
          {{ selected.requestId }} </el-descriptions-item
        ><el-descriptions-item :label="t('audit.action')">
          {{ actionLabels[selected.action] ?? selected.action }} </el-descriptions-item
        ><el-descriptions-item :label="t('audit.object')">
          {{ selected.objectType }} · {{ selected.objectId }} </el-descriptions-item
        ><el-descriptions-item :label="t('audit.ipAddress')">
          {{ selected.ipAddress || t('audit.notRecorded') }} </el-descriptions-item
        ><el-descriptions-item :label="t('audit.reason')">
          {{ selected.reason || t('audit.notProvided') }}
        </el-descriptions-item>
      </el-descriptions>
      <div class="diff-grid">
        <section>
          <h3>{{ t('audit.before') }}</h3>
          <pre>{{ pretty(selected.before) }}</pre>
        </section>
        <section>
          <h3>{{ t('audit.after') }}</h3>
          <pre>{{ pretty(selected.after) }}</pre>
        </section>
      </div>
    </template>
  </el-drawer>
</template>

<style scoped>
.audit-page {
  display: grid;
  gap: 16px;
}
.audit-filters {
  padding: 16px;
}
.audit-results :deep(.el-table__row) {
  cursor: pointer;
}
.diff-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-top: 16px;
}
.diff-grid pre {
  min-height: 240px;
  overflow: auto;
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-surface-subtle);
  color: var(--color-text);
  white-space: pre-wrap;
  word-break: break-word;
}
@media (max-width: 900px) {
  .diff-grid {
    grid-template-columns: 1fr;
  }
}
</style>
