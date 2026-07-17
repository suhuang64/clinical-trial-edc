<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import type { FormDefinition } from '@edc/contracts'
import { validateFormRecord, type FormValue, type FormValueMap } from '@edc/domain/form-runtime'
import { apiRequest, ApiClientError } from '@/api/client'
import DynamicFormRenderer from '@/modules/forms/DynamicFormRenderer.vue'
import { useStudyStore } from '@/modules/studies/study.store'
import { useSiteScopeStore } from '@/modules/studies/site-scope.store'

interface SiteRow {
  id: string
  name: string
  status: string
}

interface FormRow {
  id: string
  code: string
  name: string
  form_type: string
  status: string
  active_version_number: number | null
}

interface ScreeningForm {
  id: string
  code: string
  name: string
  versionNumber: number
  definition: FormDefinition
}

const router = useRouter()
const { t } = useI18n()
const studyStore = useStudyStore()
const siteScope = useSiteScopeStore()
const loading = ref(false)
const saving = ref(false)
const active = ref(0)
const sites = ref<SiteRow[]>([])
const siteId = ref('')
const screeningForm = ref<ScreeningForm | null>(null)
const values = ref<FormValueMap>({})
const showErrors = ref(false)
const subjectId = ref('')
const screeningNumber = ref('')
const rowVersion = ref(1)
const conclusion = ref<'eligible' | 'failed' | ''>('')
const failureReason = ref('')
const currentStudyId = computed(() => studyStore.currentStudyId)

function defaults(definition: FormDefinition) {
  return Object.fromEntries(
    definition.fields.flatMap((field) => {
      const value = field.defaultValue
      const valid =
        value === null ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        (Array.isArray(value) && value.every((item) => typeof item === 'string'))
      return valid && value !== undefined ? [[field.key, structuredClone(value) as FormValue]] : []
    }),
  )
}

async function load() {
  loading.value = true
  try {
    await studyStore.load()
    if (!currentStudyId.value) return
    const [siteResponse, formResponse] = await Promise.all([
      apiRequest<{ items: SiteRow[] }>(`/studies/${currentStudyId.value}/sites`),
      apiRequest<{ items: FormRow[] }>(`/studies/${currentStudyId.value}/forms`),
    ])
    sites.value = siteResponse.items.filter((site) => site.status === 'active')
    if (sites.value.some((site) => site.id === siteScope.currentSiteId))
      siteId.value = siteScope.currentSiteId
    else if (sites.value.length === 1) siteId.value = sites.value[0]!.id
    const form = formResponse.items.find(
      (item) =>
        item.form_type === 'screening' && item.status === 'published' && item.active_version_number,
    )
    if (!form) return
    const detail = await apiRequest<{ definition: FormDefinition }>(
      `/studies/${currentStudyId.value}/forms/${form.id}`,
    )
    screeningForm.value = {
      id: form.id,
      code: form.code,
      name: form.name,
      versionNumber: form.active_version_number!,
      definition: detail.definition,
    }
    values.value = defaults(detail.definition)
  } catch (error) {
    ElMessage.error(error instanceof ApiClientError ? error.message : t('screening.loadFailed'))
  } finally {
    loading.value = false
  }
}

async function createScreeningRecord() {
  if (!currentStudyId.value || !siteId.value) {
    ElMessage.warning(t('screening.siteRequired'))
    return false
  }
  saving.value = true
  try {
    const response = await apiRequest<{
      id: string
      screeningNumber: string
    }>(`/studies/${currentStudyId.value}/subjects`, {
      method: 'POST',
      body: JSON.stringify({ siteId: siteId.value, screeningData: {} }),
    })
    subjectId.value = response.id
    screeningNumber.value = response.screeningNumber
    rowVersion.value = 1
    active.value = 1
    ElMessage.success(t('screening.created', { number: response.screeningNumber }))
    return true
  } catch (error) {
    ElMessage.error(error instanceof ApiClientError ? error.message : t('screening.createFailed'))
    return false
  } finally {
    saving.value = false
  }
}

async function saveScreeningData(requireComplete: boolean) {
  if (!currentStudyId.value || !subjectId.value || !screeningForm.value) return false
  showErrors.value = requireComplete
  if (requireComplete) {
    const result = validateFormRecord(screeningForm.value.definition, values.value)
    if (result.issues.length) {
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLElement>(
            '.screening-runtime .el-form-item.is-error input, .screening-runtime .el-form-item.is-error textarea',
          )
          ?.focus(),
      )
      ElMessage.warning(t('screening.completeRequired'))
      return false
    }
  }
  saving.value = true
  try {
    const response = await apiRequest<{ rowVersion: number }>(
      `/studies/${currentStudyId.value}/subjects/${subjectId.value}/screening`,
      {
        method: 'PUT',
        body: JSON.stringify({ rowVersion: rowVersion.value, screeningData: values.value }),
      },
    )
    rowVersion.value = response.rowVersion
    ElMessage.success(requireComplete ? t('screening.dataSaved') : t('screening.draftSaved'))
    return true
  } catch (error) {
    ElMessage.error(error instanceof ApiClientError ? error.message : t('screening.saveFailed'))
    return false
  } finally {
    saving.value = false
  }
}

async function next() {
  if (active.value === 0) {
    await createScreeningRecord()
    return
  }
  if (active.value === 1) {
    if (await saveScreeningData(true)) active.value = 2
    return
  }
  if (!currentStudyId.value || !subjectId.value || !conclusion.value) {
    ElMessage.warning(t('screening.conclusionRequired'))
    return
  }
  if (conclusion.value === 'failed' && !failureReason.value.trim()) {
    ElMessage.warning(t('screening.failureReasonRequired'))
    return
  }
  saving.value = true
  try {
    await apiRequest(`/studies/${currentStudyId.value}/subjects/${subjectId.value}/conclusion`, {
      method: 'POST',
      body: JSON.stringify(
        conclusion.value === 'failed'
          ? { conclusion: 'failed', reason: failureReason.value.trim() }
          : { conclusion: 'eligible' },
      ),
    })
    ElMessage.success(
      conclusion.value === 'eligible' ? t('screening.eligibleSaved') : t('screening.failedSaved'),
    )
    await router.replace(`/subjects/${subjectId.value}`)
  } catch (error) {
    ElMessage.error(error instanceof ApiClientError ? error.message : t('screening.submitFailed'))
  } finally {
    saving.value = false
  }
}

async function saveDraft() {
  if (!subjectId.value) {
    await createScreeningRecord()
    return
  }
  await saveScreeningData(false)
}

watch(siteId, (value) => {
  if (!subjectId.value) siteScope.setCurrent(value)
})
onMounted(load)
</script>

<template>
  <section v-loading="loading" class="panel screening-create-page">
    <div class="panel-body">
      <el-steps :active="active" finish-status="success" simple>
        <el-step :title="t('screening.steps.site')" />
        <el-step :title="t('screening.steps.data')" />
        <el-step :title="t('screening.steps.conclusion')" />
      </el-steps>

      <el-alert
        v-if="!loading && !screeningForm"
        :title="t('screening.noForm')"
        :description="t('screening.noFormDescription')"
        type="warning"
        show-icon
        :closable="false"
        class="screening-notice"
      />

      <div v-else-if="screeningForm" class="screening-content">
        <template v-if="active === 0">
          <h2>{{ t('screening.selectSiteTitle') }}</h2>
          <p class="muted-text">{{ t('screening.siteLockedHint') }}</p>
          <el-form label-position="top">
            <el-form-item :label="t('screening.site')" required>
              <el-select
                v-model="siteId"
                :placeholder="t('screening.selectSite')"
                style="width: 100%"
              >
                <el-option
                  v-for="site in sites"
                  :key="site.id"
                  :label="site.name"
                  :value="site.id"
                />
              </el-select>
            </el-form-item>
          </el-form>
        </template>

        <template v-else-if="active === 1">
          <div class="screening-section-heading">
            <div>
              <h2>{{ screeningForm.name }}</h2>
              <p class="muted-text">
                {{ screeningNumber }} · {{ screeningForm.code }} · v{{
                  screeningForm.versionNumber
                }}
              </p>
            </div>
          </div>
          <DynamicFormRenderer
            v-model="values"
            class="screening-runtime"
            :definition="screeningForm.definition"
            :show-errors="showErrors"
            :file-context="subjectId ? { studyId: currentStudyId, subjectId } : undefined"
          />
        </template>

        <template v-else>
          <h2>{{ t('screening.conclusionTitle') }}</h2>
          <el-descriptions border :column="1">
            <el-descriptions-item :label="t('screening.screeningNumber')">
              {{ screeningNumber }}
            </el-descriptions-item>
            <el-descriptions-item :label="t('screening.site')">
              {{ sites.find((site) => site.id === siteId)?.name }}
            </el-descriptions-item>
            <el-descriptions-item :label="t('screening.form')">
              {{ screeningForm.name }} · v{{ screeningForm.versionNumber }}
            </el-descriptions-item>
          </el-descriptions>
          <el-form label-position="top" class="conclusion-form">
            <el-form-item :label="t('screening.conclusion')" required>
              <el-radio-group v-model="conclusion">
                <el-radio value="eligible">{{ t('screening.eligible') }}</el-radio>
                <el-radio value="failed">{{ t('screening.failed') }}</el-radio>
              </el-radio-group>
            </el-form-item>
            <el-form-item
              v-if="conclusion === 'failed'"
              :label="t('screening.failureReason')"
              required
            >
              <el-input v-model="failureReason" type="textarea" :rows="4" maxlength="1000" />
            </el-form-item>
            <el-alert
              :title="t('screening.manualDecision')"
              type="info"
              show-icon
              :closable="false"
            />
          </el-form>
        </template>

        <div class="screening-actions">
          <el-button :loading="saving" @click="saveDraft">{{ t('screening.saveDraft') }}</el-button>
          <span class="toolbar-spacer" />
          <el-button v-if="active > 0" :disabled="saving" @click="active -= 1">
            {{ t('screening.previous') }}
          </el-button>
          <el-button type="primary" :loading="saving" @click="next">
            {{
              active === 0
                ? t('screening.createRecord')
                : active === 1
                  ? t('screening.saveAndNext')
                  : t('screening.submitConclusion')
            }}
          </el-button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.screening-create-page {
  min-height: 420px;
}
.screening-content {
  max-width: 820px;
  margin: 28px auto 0;
}
.screening-content h2,
.screening-content p {
  margin-top: 0;
}
.screening-notice {
  max-width: 720px;
  margin: 28px auto;
}
.screening-section-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.conclusion-form {
  margin-top: 20px;
}
.screening-actions {
  position: sticky;
  bottom: 0;
  z-index: 10;
  display: flex;
  gap: 8px;
  margin-top: 20px;
  padding: 14px 0 max(8px, env(safe-area-inset-bottom));
  border-top: 1px solid var(--color-border);
  background: var(--color-surface);
}
@media (max-width: 767px) {
  .screening-create-page .panel-body {
    padding: 12px;
  }
  .screening-content {
    margin-top: 20px;
  }
  .screening-actions {
    flex-wrap: wrap;
  }
  .screening-actions .toolbar-spacer {
    display: none;
  }
  .screening-actions .el-button {
    min-height: 44px;
    flex: 1 1 calc(50% - 4px);
    margin-left: 0;
  }
}
</style>
