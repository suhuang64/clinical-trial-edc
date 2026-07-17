<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { useI18n } from 'vue-i18n'
import { apiRequest, ApiClientError } from '@/api/client'
import { useStudyStore, type CreateStudyInput } from './study.store'
import StatusPill from '@/components/ui/StatusPill.vue'

type CounterType = 'screening' | 'subject' | 'randomization'
interface CounterRule {
  prefix: string
  padLength: number
  currentValue: number
}

const { t } = useI18n()
const studies = useStudyStore()
const loading = ref(false)
const saving = ref(false)
const form = reactive({
  protocolCode: '',
  name: '',
  sponsor: '',
  studyType: '',
  phase: '',
  startDate: '',
  endDate: '',
  defaultLocale: 'zh-CN' as 'zh-CN' | 'en-US',
  notes: '',
})
const counters = reactive<Record<CounterType, CounterRule>>({
  screening: { prefix: 'SCR-', padLength: 4, currentValue: 0 },
  subject: { prefix: 'SUB-', padLength: 4, currentValue: 0 },
  randomization: { prefix: 'RND-', padLength: 4, currentValue: 0 },
})

const study = computed(() => studies.currentStudy)
const readOnly = computed(
  () => !study.value?.canManage || ['ended', 'archived'].includes(study.value?.status ?? ''),
)
const statusLabel = computed(() => (study.value ? t(`studies.statuses.${study.value.status}`) : ''))
const statusTone = computed(() => {
  if (study.value?.status === 'active') return 'success'
  if (study.value?.status === 'draft') return 'warning'
  return 'neutral'
})

function fillMetadata() {
  if (!study.value) return
  Object.assign(form, {
    protocolCode: study.value.protocolCode,
    name: study.value.name,
    sponsor: study.value.sponsor ?? '',
    studyType: study.value.studyType ?? '',
    phase: study.value.phase ?? '',
    startDate: study.value.startDate ?? '',
    endDate: study.value.endDate ?? '',
    defaultLocale: study.value.defaultLocale,
    notes: study.value.notes ?? '',
  })
}

async function load() {
  await studies.load()
  if (!studies.currentStudyId) return
  loading.value = true
  try {
    fillMetadata()
    const response = await apiRequest<{ counters: Record<CounterType, CounterRule> }>(
      `/studies/${studies.currentStudyId}/counters`,
    )
    for (const type of ['screening', 'subject', 'randomization'] as const)
      Object.assign(counters[type], response.counters[type])
  } catch (error) {
    ElMessage.error(
      error instanceof ApiClientError ? error.message : t('projectSettings.loadFailed'),
    )
  } finally {
    loading.value = false
  }
}

async function save() {
  if (!studies.currentStudyId || readOnly.value) return
  if (!form.protocolCode.trim() || !form.name.trim()) {
    ElMessage.warning(t('projectSettings.required'))
    return
  }
  if (form.startDate && form.endDate && form.endDate < form.startDate) {
    ElMessage.warning(t('studies.invalidDates'))
    return
  }
  saving.value = true
  try {
    const input: CreateStudyInput = {
      protocolCode: form.protocolCode.trim(),
      name: form.name.trim(),
      defaultLocale: form.defaultLocale,
    }
    if (form.sponsor.trim()) input.sponsor = form.sponsor.trim()
    if (form.studyType.trim()) input.studyType = form.studyType.trim()
    if (form.phase.trim()) input.phase = form.phase.trim()
    if (form.startDate) input.startDate = form.startDate
    if (form.endDate) input.endDate = form.endDate
    if (form.notes.trim()) input.notes = form.notes.trim()
    await studies.update(studies.currentStudyId, input)
    await apiRequest(`/studies/${studies.currentStudyId}/counters`, {
      method: 'PUT',
      body: JSON.stringify(
        Object.fromEntries(
          (['screening', 'subject', 'randomization'] as const).map((type) => [
            type,
            { prefix: counters[type].prefix.trim(), padLength: counters[type].padLength },
          ]),
        ),
      ),
    })
    ElMessage.success(t('projectSettings.saved'))
    await load()
  } catch (error) {
    ElMessage.error(
      error instanceof ApiClientError ? error.message : t('projectSettings.saveFailed'),
    )
  } finally {
    saving.value = false
  }
}

watch(() => studies.currentStudyId, load, { immediate: true })
</script>

<template>
  <section v-if="!studies.currentStudyId" class="panel empty-state">
    <div>
      <h2>{{ t('projectSettings.selectStudy') }}</h2>
      <p class="muted-text">{{ t('projectSettings.selectStudyHint') }}</p>
    </div>
  </section>
  <div v-else v-loading="loading" class="project-settings-page">
    <el-alert
      v-if="readOnly"
      :title="t('projectSettings.readOnly')"
      type="info"
      show-icon
      :closable="false"
    />
    <section class="panel project-settings-section">
      <header class="settings-section-header">
        <div>
          <h2>{{ t('projectSettings.metadata') }}</h2>
          <p class="muted-text">{{ t('projectSettings.metadataHint') }}</p>
        </div>
        <StatusPill :tone="statusTone" :label="statusLabel" />
      </header>
      <el-form label-position="top" :disabled="readOnly">
        <div class="form-grid">
          <el-form-item :label="t('studies.protocolCode')" required>
            <el-input v-model="form.protocolCode" maxlength="100" />
          </el-form-item>
          <el-form-item :label="t('studies.studyName')" required>
            <el-input v-model="form.name" maxlength="300" />
          </el-form-item>
          <el-form-item :label="t('studies.sponsor')">
            <el-input v-model="form.sponsor" maxlength="300" />
          </el-form-item>
          <el-form-item :label="t('studies.studyType')">
            <el-input v-model="form.studyType" maxlength="100" />
          </el-form-item>
          <el-form-item :label="t('studies.phase')">
            <el-input v-model="form.phase" maxlength="100" />
          </el-form-item>
          <el-form-item :label="t('studies.defaultLanguage')">
            <el-select v-model="form.defaultLocale" style="width: 100%">
              <el-option label="简体中文" value="zh-CN" />
              <el-option label="English" value="en-US" />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('studies.startDate')">
            <el-date-picker v-model="form.startDate" type="date" value-format="YYYY-MM-DD" />
          </el-form-item>
          <el-form-item :label="t('studies.endDate')">
            <el-date-picker v-model="form.endDate" type="date" value-format="YYYY-MM-DD" />
          </el-form-item>
        </div>
        <el-form-item :label="t('studies.notes')">
          <el-input v-model="form.notes" type="textarea" :rows="4" maxlength="4000" />
        </el-form-item>
      </el-form>
    </section>

    <section class="panel project-settings-section">
      <header class="settings-section-header">
        <div>
          <h2>{{ t('projectSettings.numbering') }}</h2>
          <p class="muted-text">{{ t('projectSettings.numberingHint') }}</p>
        </div>
      </header>
      <div class="counter-grid">
        <article v-for="type in ['screening', 'subject', 'randomization'] as const" :key="type">
          <h3>{{ t(`projectSettings.counterTypes.${type}`) }}</h3>
          <el-form label-position="top" :disabled="readOnly || counters[type].currentValue > 0">
            <el-form-item :label="t('projectSettings.prefix')">
              <el-input v-model="counters[type].prefix" maxlength="20" />
            </el-form-item>
            <el-form-item :label="t('projectSettings.padLength')">
              <el-input-number v-model="counters[type].padLength" :min="1" :max="12" />
            </el-form-item>
          </el-form>
          <p class="muted-text">
            {{
              counters[type].currentValue
                ? t('projectSettings.frozenAt', { count: counters[type].currentValue })
                : t('projectSettings.preview', {
                    number: `${counters[type].prefix}${String(1).padStart(counters[type].padLength, '0')}`,
                  })
            }}
          </p>
        </article>
      </div>
    </section>
    <div class="settings-save-bar">
      <el-button type="primary" :disabled="readOnly" :loading="saving" @click="save">
        {{ t('projectSettings.save') }}
      </el-button>
    </div>
  </div>
</template>

<style scoped>
.project-settings-page {
  display: grid;
  gap: 16px;
}
.project-settings-section {
  padding: 20px;
}
.settings-section-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
}
.settings-section-header h2,
.settings-section-header p,
.counter-grid h3 {
  margin-top: 0;
}
.counter-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}
.counter-grid article {
  padding: 16px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-surface-subtle);
}
.settings-save-bar {
  position: sticky;
  z-index: 10;
  bottom: 0;
  display: flex;
  justify-content: flex-end;
  padding: 12px 0;
  background: var(--color-background);
}
@media (max-width: 1024px) {
  .counter-grid {
    grid-template-columns: 1fr;
  }
}
</style>
