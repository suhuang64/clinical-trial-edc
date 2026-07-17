<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import type { CreateFormInput } from '@edc/contracts'
import { apiRequest, ApiClientError } from '@/api/client'
import { useStudyStore } from '@/modules/studies/study.store'
import StatusPill from '@/components/ui/StatusPill.vue'

interface FormRow {
  id: string
  code: string
  name: string
  form_type: string
  repeatable: number
  bind_visits: number
  status: 'draft' | 'published' | 'archived'
  active_version_number: number | null
  draft_version_number: number | null
  draft_version_status: 'draft' | 'failed' | null
  record_count: number
  updated_at: string
}

interface ImportIssue {
  code: string
  message: string
  severity: 'error' | 'warning'
}

interface ImportPreview {
  canImport: boolean
  normalized: CreateFormInput
  summary: { fieldCount: number; sectionCount: number; visitCount: number }
  issues: ImportIssue[]
}

interface MigrationJob {
  id: string
  from_version_id: string | null
  to_version_id: string
  from_version_number: number | null
  to_version_number: number
  status: 'pending' | 'running' | 'completed' | 'failed'
  total_records: number
  processed_records: number
  error_message: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

const router = useRouter()
const { t, locale } = useI18n()
const studyStore = useStudyStore()
const loading = ref(false)
const query = ref('')
const forms = ref<FormRow[]>([])
const importInput = ref<HTMLInputElement | null>(null)
const excelImportInput = ref<HTMLInputElement | null>(null)
const importDialogOpen = ref(false)
const importPreview = ref<ImportPreview | null>(null)
const importSource = ref<unknown>(null)
const importFormat = ref<'json' | 'xlsx'>('json')
const previewLoading = ref(false)
const importing = ref(false)
const migrationDrawerOpen = ref(false)
const migrationLoading = ref(false)
const migrationJobs = ref<MigrationJob[]>([])
const migrationForm = ref<FormRow | null>(null)
const canRetryMigration = ref(false)
const retryingJobId = ref('')
let migrationPollTimer: number | undefined
const currentStudyId = computed(() => studyStore.currentStudyId)
const typeLabels = computed<Record<string, string>>(() => ({
  screening: t('formList.types.screening'),
  baseline: t('formList.types.baseline'),
  followup: t('formList.types.followup'),
  adverse_event: t('formList.types.adverseEvent'),
  concomitant_medication: t('formList.types.concomitantMedication'),
  protocol_deviation: t('formList.types.protocolDeviation'),
  endpoint_event: t('formList.types.endpointEvent'),
  custom: t('formList.types.custom'),
}))
const filteredForms = computed(() => {
  const keyword = query.value.trim().toLocaleLowerCase()
  if (!keyword) return forms.value
  return forms.value.filter((form) =>
    `${form.code} ${form.name} ${typeLabels.value[form.form_type] ?? form.form_type}`
      .toLocaleLowerCase()
      .includes(keyword),
  )
})
const migrationStatus = computed<
  Record<MigrationJob['status'], { label: string; tone: 'neutral' | 'info' | 'success' | 'danger' }>
>(() => ({
  pending: { label: t('formList.migrations.pending'), tone: 'neutral' },
  running: { label: t('formList.migrations.running'), tone: 'info' },
  completed: { label: t('formList.migrations.completed'), tone: 'success' },
  failed: { label: t('formList.migrations.failed'), tone: 'danger' },
}))

function versionLabel(form: FormRow) {
  if (form.draft_version_number)
    return t('formList.versionDraft', { version: form.draft_version_number })
  if (form.active_version_number) return `v${form.active_version_number}`
  return t('formList.versionDraft', { version: 1 })
}

function statusPresentation(form: FormRow) {
  if (form.draft_version_status === 'failed')
    return { label: t('formList.statuses.publishFailed'), tone: 'danger' as const }
  if (form.draft_version_number)
    return { label: t('formList.statuses.editing'), tone: 'warning' as const }
  if (form.status === 'published')
    return { label: t('formList.statuses.published'), tone: 'success' as const }
  return { label: t('formList.statuses.draft'), tone: 'warning' as const }
}

async function load() {
  await studyStore.load()
  if (!currentStudyId.value) return
  loading.value = true
  try {
    const response = await apiRequest<{ items: FormRow[] }>(
      `/studies/${currentStudyId.value}/forms`,
    )
    forms.value = response.items
  } catch (error) {
    ElMessage.error(error instanceof ApiClientError ? error.message : t('formList.loadFailed'))
  } finally {
    loading.value = false
  }
}

async function copyForm(form: FormRow) {
  if (!currentStudyId.value) return
  const result = await ElMessageBox.prompt(
    t('formList.copyPrompt'),
    t('formList.copyTitle', { name: form.name }),
    {
      inputValue: `${form.code}_COPY`,
      inputPattern: /\S+/,
      inputErrorMessage: t('formList.codeRequired'),
      confirmButtonText: t('formList.next'),
      cancelButtonText: t('common.cancel'),
    },
  ).catch(() => null)
  if (!result) return
  try {
    const response = await apiRequest<{ id: string }>(
      `/studies/${currentStudyId.value}/forms/${form.id}/copy`,
      {
        method: 'POST',
        body: JSON.stringify({
          code: result.value.trim(),
          name: t('formList.copyName', { name: form.name }),
        }),
      },
    )
    ElMessage.success(t('formList.copied'))
    await router.push(`/forms/designer/${response.id}`)
  } catch (error) {
    ElMessage.error(error instanceof ApiClientError ? error.message : t('formList.copyFailed'))
  }
}

async function downloadForm(form: FormRow, format: 'json' | 'xlsx') {
  if (!currentStudyId.value) return
  try {
    const response = await fetch(
      `/api/v1/studies/${currentStudyId.value}/forms/${form.id}/export/${format}`,
      {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-CSRF-Token': sessionStorage.getItem('edc-csrf-token') ?? '' },
      },
    )
    if (!response.ok) {
      const payload = (await response.json()) as { message?: string }
      throw new Error(payload.message ?? t('formList.exportFailed'))
    }
    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${form.code}.${format}`
    link.click()
    URL.revokeObjectURL(url)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : t('formList.exportFailed'))
  }
}

async function loadMigrationJobs(form = migrationForm.value) {
  if (!currentStudyId.value || !form) return
  migrationLoading.value = true
  try {
    const response = await apiRequest<{ items: MigrationJob[]; canRetry: boolean }>(
      `/studies/${currentStudyId.value}/forms/${form.id}/migrations`,
    )
    migrationJobs.value = response.items
    canRetryMigration.value = response.canRetry
  } catch (error) {
    ElMessage.error(
      error instanceof ApiClientError ? error.message : t('formList.migrationLoadFailed'),
    )
  } finally {
    migrationLoading.value = false
  }
}

async function openMigrationDrawer(form: FormRow) {
  migrationForm.value = form
  migrationJobs.value = []
  migrationDrawerOpen.value = true
  await loadMigrationJobs(form)
}

async function retryMigration(job: MigrationJob) {
  if (!currentStudyId.value || !migrationForm.value) return
  retryingJobId.value = job.id
  try {
    await apiRequest(
      `/studies/${currentStudyId.value}/forms/${migrationForm.value.id}/migrations/${job.id}/retry`,
      { method: 'POST' },
    )
    ElMessage.success(t('formList.migrationQueued'))
    await Promise.all([loadMigrationJobs(), load()])
  } catch (error) {
    ElMessage.error(
      error instanceof ApiClientError ? error.message : t('formList.migrationRetryFailed'),
    )
    await loadMigrationJobs()
  } finally {
    retryingJobId.value = ''
  }
}

function migrationProgress(job: MigrationJob) {
  if (!job.total_records) return 100
  return Math.round((job.processed_records / job.total_records) * 100)
}

async function requestImportPreview(overrides?: { code: string; name: string }) {
  if (!currentStudyId.value || !importSource.value) return
  previewLoading.value = true
  try {
    importPreview.value = await apiRequest<ImportPreview>(
      `/studies/${currentStudyId.value}/forms/import/preview`,
      {
        method: 'POST',
        body: JSON.stringify({ source: importSource.value, overrides }),
      },
    )
    importDialogOpen.value = true
  } catch (error) {
    importPreview.value = null
    ElMessage.error(
      error instanceof ApiClientError ? error.message : t('formList.jsonPreviewFailed'),
    )
  } finally {
    previewLoading.value = false
  }
}

async function handleImportFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (file.size > 2 * 1024 * 1024) {
    ElMessage.warning(t('formList.jsonTooLarge'))
    return
  }
  try {
    importSource.value = JSON.parse(await file.text()) as unknown
    importFormat.value = 'json'
  } catch {
    ElMessage.error(t('formList.jsonInvalid'))
    return
  }
  await requestImportPreview()
}

async function handleExcelImportFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || !currentStudyId.value) return
  if (file.size > 5 * 1024 * 1024) {
    ElMessage.warning(t('formList.excelTooLarge'))
    return
  }
  previewLoading.value = true
  try {
    const body = new FormData()
    body.append('file', file)
    const preview = await apiRequest<ImportPreview>(
      `/studies/${currentStudyId.value}/forms/import/excel/preview`,
      { method: 'POST', body },
    )
    importPreview.value = preview
    importSource.value = preview.normalized
    importFormat.value = 'xlsx'
    importDialogOpen.value = true
  } catch (error) {
    importPreview.value = null
    ElMessage.error(
      error instanceof ApiClientError ? error.message : t('formList.excelPreviewFailed'),
    )
  } finally {
    previewLoading.value = false
  }
}

async function revalidateImport() {
  if (!importPreview.value) return
  await requestImportPreview({
    code: importPreview.value.normalized.code,
    name: importPreview.value.normalized.name,
  })
}

async function confirmImport() {
  if (!currentStudyId.value || !importPreview.value?.canImport) return
  importing.value = true
  try {
    const response = await apiRequest<{ id: string }>(`/studies/${currentStudyId.value}/forms`, {
      method: 'POST',
      headers: { 'X-EDC-Import-Format': importFormat.value },
      body: JSON.stringify(importPreview.value.normalized),
    })
    importDialogOpen.value = false
    ElMessage.success(t('formList.imported'))
    await router.push(`/forms/designer/${response.id}`)
  } catch (error) {
    ElMessage.error(error instanceof ApiClientError ? error.message : t('formList.importFailed'))
  } finally {
    importing.value = false
  }
}
function formatDateTime(value: string) {
  return new Date(value).toLocaleString(locale.value)
}

onMounted(() => {
  void load()
  migrationPollTimer = window.setInterval(() => {
    if (
      migrationDrawerOpen.value &&
      !migrationLoading.value &&
      migrationJobs.value.some((job) => job.status === 'pending' || job.status === 'running')
    ) {
      void Promise.all([loadMigrationJobs(), load()])
    }
  }, 1500)
})
onBeforeUnmount(() => {
  if (migrationPollTimer !== undefined) window.clearInterval(migrationPollTimer)
})
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
        :placeholder="t('formList.searchPlaceholder')"
        clearable
        style="max-width: 300px"
      />
      <span class="toolbar-spacer" />
      <input
        ref="importInput"
        class="visually-hidden"
        type="file"
        accept=".json,application/json"
        @change="handleImportFile"
      />
      <input
        ref="excelImportInput"
        class="visually-hidden"
        type="file"
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        @change="handleExcelImportFile"
      />
      <el-button :loading="previewLoading" @click="importInput?.click()">
        {{ t('formList.importJson') }}
      </el-button>
      <el-button :loading="previewLoading" @click="excelImportInput?.click()">
        {{ t('formList.importExcel') }}
      </el-button>
      <el-button type="primary" @click="router.push('/forms/designer/new')">
        {{ t('formList.newForm') }}
      </el-button>
    </div>
    <section v-loading="loading" class="form-card-grid">
      <article v-for="form in filteredForms" :key="form.id" class="panel form-card">
        <header>
          <div>
            <span class="muted-text"
              >{{ typeLabels[form.form_type] ?? form.form_type }} · {{ form.code }}</span
            >
            <h2>{{ form.name }}</h2>
          </div>
          <StatusPill
            :tone="statusPresentation(form).tone"
            :label="statusPresentation(form).label"
          />
        </header>
        <div class="form-behaviors">
          <el-tag v-if="form.repeatable" size="small" effect="plain">
            {{ t('formList.repeatable') }}
          </el-tag>
          <el-tag v-if="form.bind_visits" size="small" effect="plain">
            {{ t('formList.boundVisits') }}
          </el-tag>
        </div>
        <dl>
          <div>
            <dt>{{ t('formList.currentVersion') }}</dt>
            <dd>{{ versionLabel(form) }}</dd>
          </div>
          <div>
            <dt>{{ t('formList.records') }}</dt>
            <dd>{{ form.record_count }}</dd>
          </div>
        </dl>
        <footer>
          <span class="muted-text">{{ formatDateTime(form.updated_at) }}</span>
          <div>
            <el-button link type="primary" @click="copyForm(form)">
              {{ t('formList.copy') }}
            </el-button>
            <el-button link type="primary" @click="downloadForm(form, 'json')">
              {{ t('formList.exportJson') }}
            </el-button>
            <el-button link type="primary" @click="downloadForm(form, 'xlsx')">
              {{ t('formList.exportExcel') }}
            </el-button>
            <el-button link type="primary" @click="openMigrationDrawer(form)">
              {{ t('formList.migrationHistory') }}
            </el-button>
            <el-button link type="primary" @click="router.push(`/forms/designer/${form.id}`)">
              {{ t('formList.openDesigner') }}
            </el-button>
          </div>
        </footer>
      </article>
      <div v-if="!loading && !filteredForms.length" class="panel empty-state">
        <div>
          <h2>{{ query ? t('formList.noMatches') : t('formList.noForms') }}</h2>
          <p class="muted-text">
            {{ query ? t('formList.tryOtherKeywords') : t('formList.emptyHint') }}
          </p>
          <el-button v-if="!query" type="primary" @click="router.push('/forms/designer/new')">
            {{ t('formList.newForm') }}
          </el-button>
        </div>
      </div>
    </section>

    <el-dialog
      v-model="importDialogOpen"
      :title="t('formList.importPreview')"
      width="min(620px, calc(100vw - 32px))"
    >
      <template v-if="importPreview">
        <el-alert
          :title="
            importPreview.canImport
              ? t('formList.validationPassed')
              : t('formList.validationFailed')
          "
          :type="importPreview.canImport ? 'success' : 'error'"
          show-icon
          :closable="false"
        />
        <el-form label-position="top" class="import-form">
          <el-form-item :label="t('formList.formCode')" required>
            <el-input v-model="importPreview.normalized.code" maxlength="80" />
          </el-form-item>
          <el-form-item :label="t('formList.formName')" required>
            <el-input v-model="importPreview.normalized.name" maxlength="200" />
          </el-form-item>
        </el-form>
        <dl class="import-summary">
          <div>
            <dt>{{ t('formList.fields') }}</dt>
            <dd>{{ importPreview.summary.fieldCount }}</dd>
          </div>
          <div>
            <dt>{{ t('formList.sections') }}</dt>
            <dd>{{ importPreview.summary.sectionCount }}</dd>
          </div>
          <div>
            <dt>{{ t('formList.visitBindings') }}</dt>
            <dd>{{ importPreview.summary.visitCount }}</dd>
          </div>
        </dl>
        <el-alert
          v-for="issue in importPreview.issues"
          :key="`${issue.code}-${issue.message}`"
          :title="issue.message"
          :type="issue.severity === 'error' ? 'error' : 'warning'"
          show-icon
          :closable="false"
          class="import-issue"
        />
      </template>
      <template #footer>
        <el-button @click="importDialogOpen = false">{{ t('common.cancel') }}</el-button>
        <el-button :loading="previewLoading" @click="revalidateImport">
          {{ t('formList.revalidate') }}
        </el-button>
        <el-button
          type="primary"
          :disabled="!importPreview?.canImport"
          :loading="importing"
          @click="confirmImport"
        >
          {{ t('formList.confirmImport') }}
        </el-button>
      </template>
    </el-dialog>

    <el-drawer
      v-model="migrationDrawerOpen"
      :title="t('formList.migrationTitle', { name: migrationForm?.name ?? '' })"
      size="min(760px, 92vw)"
      class="migration-drawer"
    >
      <div v-loading="migrationLoading" class="migration-list" aria-live="polite">
        <el-alert :title="t('formList.migrationHint')" type="info" show-icon :closable="false" />
        <el-empty
          v-if="!migrationLoading && !migrationJobs.length"
          :description="t('formList.noMigrations')"
        />
        <article v-for="job in migrationJobs" :key="job.id" class="migration-job">
          <header>
            <div>
              <strong>
                {{
                  job.from_version_number
                    ? `v${job.from_version_number}`
                    : t('formList.initialVersion')
                }}
                → v{{ job.to_version_number }}
              </strong>
              <span class="muted-text">{{ formatDateTime(job.created_at) }}</span>
            </div>
            <StatusPill
              :tone="migrationStatus[job.status].tone"
              :label="migrationStatus[job.status].label"
            />
          </header>
          <el-progress
            :percentage="migrationProgress(job)"
            :status="
              job.status === 'failed'
                ? 'exception'
                : job.status === 'completed'
                  ? 'success'
                  : undefined
            "
          />
          <p class="migration-count">
            {{
              t('formList.processedRecords', {
                processed: job.processed_records,
                total: job.total_records,
              })
            }}
          </p>
          <el-alert
            v-if="job.error_message"
            :title="job.error_message"
            type="error"
            show-icon
            :closable="false"
          />
          <footer v-if="job.status === 'failed' && canRetryMigration" class="migration-actions">
            <el-button
              type="primary"
              :loading="retryingJobId === job.id"
              :disabled="Boolean(retryingJobId)"
              @click="retryMigration(job)"
            >
              {{ t('formList.retryMigration') }}
            </el-button>
          </footer>
        </article>
      </div>
    </el-drawer>
  </template>
</template>

<style scoped>
.form-card-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(260px, 1fr));
  gap: 12px;
}
.form-card {
  padding: 16px;
  text-align: left;
}
.form-card header,
.form-card footer {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
}
.import-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 2fr);
  gap: 12px;
  margin-top: 16px;
}
.import-summary {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin: 0 0 16px;
}
.import-summary div {
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-surface-subtle);
}
.import-summary dt {
  color: var(--color-text-secondary);
  font-size: 12px;
}
.import-summary dd {
  margin: 4px 0 0;
  font-size: 20px;
  font-weight: 650;
}
.import-issue + .import-issue {
  margin-top: 8px;
}
.migration-list {
  min-height: 180px;
}
.migration-job {
  margin-top: 12px;
  padding: 16px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-surface);
}
.migration-job header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}
.migration-job header > div {
  display: grid;
  gap: 4px;
}
.migration-count {
  margin: 8px 0 0;
  color: var(--color-text-secondary);
  font-variant-numeric: tabular-nums;
}
.migration-job .el-alert,
.migration-actions {
  margin-top: 12px;
}
.migration-actions {
  display: flex;
  justify-content: flex-end;
  padding-top: 12px;
  border-top: 1px solid var(--color-border);
}
.form-card h2 {
  margin: 3px 0 0;
  font-size: 17px;
}
.form-behaviors {
  display: flex;
  min-height: 24px;
  gap: 6px;
  margin-top: 12px;
}
.form-card dl {
  display: flex;
  gap: 32px;
  margin: 20px 0;
}
.form-card dl div {
  display: grid;
  gap: 3px;
}
.form-card dt {
  color: var(--color-text-secondary);
  font-size: 12px;
}
.form-card dd {
  margin: 0;
  font-size: 18px;
  font-weight: 650;
}
.form-card footer {
  align-items: center;
  padding-top: 12px;
  border-top: 1px solid var(--color-border);
}
@media (max-width: 1100px) {
  .form-card-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}
@media (max-width: 767px) {
  .form-card-grid {
    grid-template-columns: 1fr;
  }
}
@media (hover: none), (max-width: 1024px) {
  .migration-actions .el-button {
    min-height: 44px;
  }
}
</style>
