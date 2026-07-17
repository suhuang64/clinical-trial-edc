<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { useI18n } from 'vue-i18n'
import { apiRequest, ApiClientError } from '@/api/client'
import { useStudyStore } from '@/modules/studies/study.store'
import { useSiteScopeStore } from '@/modules/studies/site-scope.store'
import StatusPill from '@/components/ui/StatusPill.vue'

interface SiteRow {
  id: string
  code: string
  name: string
}
interface ExportJob {
  id: string
  siteId: string | null
  dataset: string
  format: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  parameters: { siteId?: string | null; dateFrom?: string | null; dateTo?: string | null }
  rowCount: number | null
  errorMessage: string | null
  requestedBy: string
  createdAt: string
  completedAt: string | null
  downloadable: boolean
}

const studyStore = useStudyStore()
const siteScope = useSiteScopeStore()
const { t, locale } = useI18n()
const loading = ref(false)
const creating = ref(false)
const error = ref('')
const sites = ref<SiteRow[]>([])
const jobs = ref<ExportJob[]>([])
const form = ref({ dataset: 'subjects', format: 'csv', siteId: '', dateRange: [] as string[] })
let pollTimer: ReturnType<typeof setTimeout> | undefined

function schedulePoll() {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = jobs.value.some((job) => ['queued', 'running'].includes(job.status))
    ? setTimeout(() => void load(), 1500)
    : undefined
}

const datasetLabels = computed<Record<string, string>>(() => ({
  subjects: t('exports.datasets.subjects'),
  clinical_data: t('exports.datasets.clinicalData'),
  events: t('exports.datasets.events'),
  audit: t('exports.datasets.audit'),
}))
const statusLabels = computed<Record<string, string>>(() => ({
  queued: t('exports.statuses.queued'),
  running: t('exports.statuses.running'),
  completed: t('exports.statuses.completed'),
  failed: t('exports.statuses.failed'),
}))
const statusTones: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  queued: 'neutral',
  running: 'warning',
  completed: 'success',
  failed: 'danger',
}

async function load() {
  await studyStore.load()
  if (!studyStore.currentStudyId) return
  loading.value = true
  error.value = ''
  try {
    const [jobResponse, siteResponse] = await Promise.all([
      apiRequest<{ items: ExportJob[] }>(`/studies/${studyStore.currentStudyId}/exports`),
      apiRequest<{ items: SiteRow[] }>(`/studies/${studyStore.currentStudyId}/sites`),
    ])
    jobs.value = jobResponse.items
    sites.value = siteResponse.items
    schedulePoll()
  } catch (loadError) {
    error.value = loadError instanceof ApiClientError ? loadError.message : t('exports.loadFailed')
  } finally {
    loading.value = false
  }
}

async function createExport() {
  if (!studyStore.currentStudyId) return
  creating.value = true
  try {
    const response = await apiRequest<{ status: ExportJob['status'] }>(
      `/studies/${studyStore.currentStudyId}/exports`,
      {
        method: 'POST',
        body: JSON.stringify({
          dataset: form.value.dataset,
          format: form.value.format,
          siteId: form.value.siteId || null,
          ...(form.value.dateRange.length === 2
            ? { dateFrom: form.value.dateRange[0], dateTo: form.value.dateRange[1] }
            : {}),
        }),
      },
    )
    ElMessage.success(
      response.status === 'completed' ? t('exports.generated') : t('exports.queued'),
    )
    await load()
  } catch (createError) {
    ElMessage.error(
      createError instanceof ApiClientError ? createError.message : t('exports.createFailed'),
    )
  } finally {
    creating.value = false
  }
}

function siteName(siteId: string | null) {
  if (!siteId) return t('exports.allAuthorizedSites')
  const site = sites.value.find((item) => item.id === siteId)
  return site ? `${site.code} · ${site.name}` : siteId
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString(locale.value)
}

watch(() => studyStore.currentStudyId, load)
watch(
  () => siteScope.currentSiteId,
  (value) => {
    if (form.value.siteId !== value) form.value.siteId = value
  },
)
watch(
  () => form.value.siteId,
  (value) => siteScope.setCurrent(value),
)
onMounted(load)
onBeforeUnmount(() => {
  if (pollTimer) clearTimeout(pollTimer)
})
</script>

<template>
  <div v-loading="loading" class="exports-page">
    <section v-if="!studyStore.currentStudyId" class="panel empty-state">
      <div>
        <h2>{{ t('exports.selectStudy') }}</h2>
        <p class="muted-text">{{ t('exports.studyContextHint') }}</p>
      </div>
    </section>
    <template v-else>
      <section class="panel export-builder">
        <header class="panel-header">
          <div>
            <h2>{{ t('exports.createTitle') }}</h2>
            <p class="muted-text">{{ t('exports.permissionHint') }}</p>
          </div>
        </header>
        <el-form class="export-form" label-position="top" @submit.prevent>
          <el-form-item :label="t('exports.dataset')" required>
            <el-select v-model="form.dataset" style="width: 100%">
              <el-option
                v-for="(label, value) in datasetLabels"
                :key="value"
                :label="label"
                :value="value"
              />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('exports.siteScope')">
            <el-select
              v-model="form.siteId"
              clearable
              :placeholder="t('exports.allAuthorizedSites')"
              style="width: 100%"
            >
              <el-option
                v-for="site in sites"
                :key="site.id"
                :label="`${site.code} · ${site.name}`"
                :value="site.id"
              />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('exports.dateRange')">
            <el-date-picker
              v-model="form.dateRange"
              type="daterange"
              value-format="YYYY-MM-DD"
              :start-placeholder="t('exports.startDate')"
              :end-placeholder="t('exports.endDate')"
              style="width: 100%"
            />
          </el-form-item>
          <el-form-item :label="t('exports.format')" required>
            <el-radio-group v-model="form.format">
              <el-radio-button value="csv">CSV</el-radio-button>
              <el-radio-button value="xlsx">Excel (.xlsx)</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <div class="export-submit">
            <el-button type="primary" :loading="creating" @click="createExport">
              {{ t('exports.generate') }}
            </el-button>
          </div>
        </el-form>
      </section>

      <el-result v-if="error" icon="error" :title="t('exports.loadFailed')" :sub-title="error">
        <template #extra>
          <el-button type="primary" @click="load">{{ t('exports.retry') }}</el-button>
        </template>
      </el-result>
      <section v-else class="panel jobs-panel">
        <header class="panel-header">
          <h2>{{ t('exports.records') }}</h2>
          <el-button @click="load">{{ t('exports.refresh') }}</el-button>
        </header>
        <el-table v-if="jobs.length" :data="jobs" style="width: 100%">
          <el-table-column :label="t('exports.dataset')" min-width="180">
            <template #default="scope">
              {{ datasetLabels[scope.row.dataset] ?? scope.row.dataset }}
            </template>
          </el-table-column>
          <el-table-column :label="t('exports.siteScope')" min-width="190">
            <template #default="scope">{{ siteName(scope.row.siteId) }}</template>
          </el-table-column>
          <el-table-column :label="t('subjects.status')" width="110">
            <template #default="scope">
              <StatusPill
                :tone="statusTones[scope.row.status] ?? 'neutral'"
                :label="statusLabels[scope.row.status] ?? scope.row.status"
              />
            </template>
          </el-table-column>
          <el-table-column :label="t('exports.format')" width="90">
            <template #default="scope">{{ scope.row.format.toUpperCase() }}</template>
          </el-table-column>
          <el-table-column prop="rowCount" :label="t('exports.rows')" width="90" />
          <el-table-column prop="requestedBy" :label="t('exports.requestedBy')" min-width="130" />
          <el-table-column :label="t('exports.createdAt')" min-width="180">
            <template #default="scope">
              {{ formatDateTime(scope.row.createdAt) }}
            </template>
          </el-table-column>
          <el-table-column :label="t('exports.actions')" width="110" fixed="right">
            <template #default="scope">
              <el-button
                v-if="scope.row.downloadable"
                link
                type="primary"
                :href="`/api/v1/studies/${studyStore.currentStudyId}/exports/${scope.row.id}/download`"
                tag="a"
              >
                {{ t('exports.download') }} </el-button
              ><span v-else-if="scope.row.errorMessage" class="danger-text">{{
                t('exports.viewFailure')
              }}</span>
            </template>
          </el-table-column>
        </el-table>
        <div v-else class="empty-state">
          <div>
            <h2>{{ t('exports.noRecords') }}</h2>
            <p class="muted-text">{{ t('exports.noRecordsHint') }}</p>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.exports-page {
  display: grid;
  gap: 16px;
}
.panel-header h2,
.panel-header p {
  margin: 0;
}
.export-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 16px;
  padding: 16px;
}
.export-submit {
  grid-column: 1 / -1;
  display: flex;
  justify-content: flex-end;
}
.danger-text {
  color: var(--color-danger);
}
@media (max-width: 900px) {
  .export-form {
    grid-template-columns: 1fr;
  }
}
</style>
