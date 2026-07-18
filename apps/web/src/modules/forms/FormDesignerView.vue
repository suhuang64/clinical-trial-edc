<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useI18n } from 'vue-i18n'
import {
  formFieldSchema,
  type FieldType,
  type FormDefinition,
  type FormField,
  type FormType,
} from '@edc/contracts'
import { apiRequest, ApiClientError } from '@/api/client'
import { useViewport } from '@/composables/useViewport'
import { useStudyStore } from '@/modules/studies/study.store'
import FieldPropertiesPanel from './FieldPropertiesPanel.vue'
import FormPreview from './FormPreview.vue'

interface VisitRow {
  id: string
  code: string
  name: string
}

interface ValidationIssue {
  code: string
  message: string
  fieldKey?: string
  severity: 'error' | 'warning'
}

interface FormDetailResponse {
  form: {
    id: string
    code: string
    name: string
    form_type: FormType
    repeatable: boolean
    bindVisits: boolean
    visitIds: string[]
  }
  activeVersion: { version_number: number; definition: FormDefinition } | null
  draftVersion: { version_number: number; definition: FormDefinition } | null
  definition: FormDefinition
  randomizationFactorKeys: string[]
  designerLocked: boolean
}

const route = useRoute()
const router = useRouter()
const studyStore = useStudyStore()
const { t } = useI18n()
const { width } = useViewport()
const loading = ref(false)
const saving = ref(false)
const publishing = ref(false)
const ready = ref(false)
const dirty = ref(false)
const selectedKey = ref('')
const settingsOpen = ref(false)
const previewOpen = ref(false)
const propertiesDrawerOpen = ref(false)
const visits = ref<VisitRow[]>([])
const issues = ref<ValidationIssue[]>([])
const activeVersionNumber = ref<number | null>(null)
const draftVersionNumber = ref(1)
const publishedKeys = ref(new Set<string>())
const randomizationLockedKeys = ref(new Set<string>())
const designerLocked = ref(false)
const leavePromptOpen = ref(false)
const leaveConfirmed = ref(false)
const metadata = reactive({
  name: t('formDesigner.unnamedForm'),
  formType: 'custom' as FormType,
  repeatable: false,
  bindVisits: false,
  visitIds: [] as string[],
})
const definition = ref<FormDefinition>({
  schemaVersion: 1,
  fields: [],
  sections: [],
  retiredFieldKeys: [],
})

const formId = computed(() => String(route.params.id ?? 'new'))
const isNew = computed(() => formId.value === 'new')
const selectedField = computed<FormField | null>({
  get: () => definition.value.fields.find((field) => field.key === selectedKey.value) ?? null,
  set: (value) => {
    if (!value) return
    const index = definition.value.fields.findIndex((field) => field.key === selectedKey.value)
    if (index >= 0) definition.value.fields[index] = value
  },
})
const selectedKeyLocked = computed(() =>
  Boolean(selectedField.value && publishedKeys.value.has(selectedField.value.key)),
)
const selectedRandomizationLocked = computed(() =>
  Boolean(selectedField.value && randomizationLockedKeys.value.has(selectedField.value.key)),
)
const versionLabel = computed(() =>
  activeVersionNumber.value
    ? t('formDesigner.basedOnVersion', {
        version: draftVersionNumber.value,
        base: activeVersionNumber.value,
      })
    : t('formDesigner.draftVersion', { version: draftVersionNumber.value }),
)

const fieldPalette = computed<Array<{ type: FieldType; label: string }>>(() => [
  { type: 'text', label: t('formDesigner.fields.text') },
  { type: 'textarea', label: t('formDesigner.fields.textarea') },
  { type: 'number', label: t('formDesigner.fields.number') },
  { type: 'date', label: t('formDesigner.fields.date') },
  { type: 'datetime', label: t('formDesigner.fields.datetime') },
  { type: 'radio', label: t('formDesigner.fields.radio') },
  { type: 'checkbox', label: t('formDesigner.fields.checkbox') },
  { type: 'select', label: t('formDesigner.fields.select') },
  { type: 'switch', label: t('formDesigner.fields.switch') },
  { type: 'file', label: t('formDesigner.fields.file') },
  { type: 'calculated', label: t('formDesigner.fields.calculated') },
  { type: 'scale', label: t('formDesigner.fields.scale') },
  { type: 'note', label: t('formDesigner.fields.note') },
  { type: 'heading', label: t('formDesigner.fields.heading') },
])
const typeLabels = computed(
  () =>
    Object.fromEntries(fieldPalette.value.map((item) => [item.type, item.label])) as Record<
      FieldType,
      string
    >,
)
const formTypeLabels = computed<Array<{ value: FormType; label: string }>>(() => [
  { value: 'screening', label: t('formDesigner.formTypes.screening') },
  { value: 'baseline', label: t('formDesigner.formTypes.baseline') },
  { value: 'followup', label: t('formDesigner.formTypes.followup') },
  { value: 'adverse_event', label: t('formDesigner.formTypes.adverseEvent') },
  { value: 'concomitant_medication', label: t('formDesigner.formTypes.concomitantMedication') },
  { value: 'protocol_deviation', label: t('formDesigner.formTypes.protocolDeviation') },
  { value: 'endpoint_event', label: t('formDesigner.formTypes.endpointEvent') },
  { value: 'custom', label: t('formDesigner.formTypes.custom') },
])

function generateKey(type: FieldType) {
  const prefix = type === 'calculated' ? 'calc' : type
  let index = definition.value.fields.length + 1
  let key = `${prefix}_${index}`
  const unavailable = new Set([
    ...definition.value.fields.map((field) => field.key),
    ...definition.value.retiredFieldKeys,
  ])
  while (unavailable.has(key)) key = `${prefix}_${++index}`
  return key
}

function addField(type: FieldType) {
  const label = typeLabels.value[type]
  const field = formFieldSchema.parse({
    key: generateKey(type),
    type,
    label,
    readOnly: type === 'calculated',
    options: ['radio', 'checkbox', 'select', 'scale'].includes(type)
      ? [
          { value: 'option_1', label: t('formDesigner.properties.optionNumber', { number: 1 }) },
          { value: 'option_2', label: t('formDesigner.properties.optionNumber', { number: 2 }) },
        ]
      : [],
    calculation:
      type === 'calculated'
        ? { expression: '', dependencies: [], resultType: 'number', expressionVersion: 1 }
        : undefined,
  })
  definition.value.fields.push(field)
  selectedKey.value = field.key
  if (width.value <= 900) propertiesDrawerOpen.value = true
}

function moveField(index: number, direction: -1 | 1) {
  if (isRandomizationLocked(definition.value.fields[index])) return
  const target = index + direction
  if (target < 0 || target >= definition.value.fields.length) return
  const [field] = definition.value.fields.splice(index, 1)
  definition.value.fields.splice(target, 0, field!)
}

function duplicateField(index: number) {
  const source = definition.value.fields[index]
  if (!source || isRandomizationLocked(source)) return
  const copy = structuredClone(source)
  copy.key = generateKey(source.type)
  copy.label = t('formDesigner.fieldCopy', { label: source.label })
  definition.value.fields.splice(index + 1, 0, copy)
  selectedKey.value = copy.key
}

function removeField(index: number) {
  const field = definition.value.fields[index]
  if (!field || isRandomizationLocked(field)) return
  definition.value.fields.splice(index, 1)
  if (
    publishedKeys.value.has(field.key) &&
    !definition.value.retiredFieldKeys.includes(field.key)
  ) {
    definition.value.retiredFieldKeys.push(field.key)
  }
  if (selectedKey.value === field.key)
    selectedKey.value =
      definition.value.fields[index]?.key ?? definition.value.fields[index - 1]?.key ?? ''
}

function isRandomizationLocked(field: FormField | undefined | null) {
  return Boolean(field && randomizationLockedKeys.value.has(field.key))
}

function handleFormTypeChange() {
  if (metadata.formType !== 'screening') return
  metadata.repeatable = false
  metadata.bindVisits = false
  metadata.visitIds = []
}

function handleFieldKeyChanged(previous: string, next: string) {
  if (selectedKey.value === previous) selectedKey.value = next
  for (const section of definition.value.sections) {
    section.fieldKeys = section.fieldKeys.map((key) => (key === previous ? next : key))
  }
  for (const candidate of definition.value.fields) {
    for (const group of [candidate.visibility, candidate.requiredWhen]) {
      for (const rule of group?.rules ?? []) {
        if (rule.fieldKey === previous) rule.fieldKey = next
      }
    }
    if (candidate.calculation) {
      candidate.calculation.dependencies = candidate.calculation.dependencies.map((key) =>
        key === previous ? next : key,
      )
    }
  }
}

function payload() {
  return {
    name: metadata.name.trim(),
    formType: metadata.formType,
    repeatable: metadata.repeatable,
    bindVisits: metadata.bindVisits,
    visitIds: metadata.bindVisits ? metadata.visitIds : [],
    definition: definition.value,
  }
}

function validateMetadata() {
  if (!metadata.name.trim()) {
    ElMessage.warning(t('formDesigner.metadataRequired'))
    settingsOpen.value = true
    return false
  }
  if (metadata.bindVisits && !metadata.visitIds.length) {
    ElMessage.warning(t('formDesigner.visitRequired'))
    settingsOpen.value = true
    return false
  }
  return true
}

async function saveDraft(showSuccess = true) {
  if (!studyStore.currentStudyId || !validateMetadata()) return false
  saving.value = true
  try {
    if (isNew.value) {
      const response = await apiRequest<{ id: string; issues: ValidationIssue[] }>(
        `/studies/${studyStore.currentStudyId}/forms`,
        { method: 'POST', body: JSON.stringify(payload()) },
      )
      issues.value = response.issues
      dirty.value = false
      await router.replace(`/forms/designer/${response.id}`)
    } else {
      const response = await apiRequest<{
        versionNumber: number
        definition: FormDefinition
        issues: ValidationIssue[]
      }>(`/studies/${studyStore.currentStudyId}/forms/${formId.value}/draft`, {
        method: 'PUT',
        body: JSON.stringify(payload()),
      })
      draftVersionNumber.value = response.versionNumber
      definition.value = response.definition
      issues.value = response.issues
    }
    dirty.value = false
    if (showSuccess) ElMessage.success(t('formDesigner.draftSaved'))
    return true
  } catch (error) {
    ElMessage.error(
      error instanceof ApiClientError ? error.message : t('formDesigner.draftSaveFailed'),
    )
    return false
  } finally {
    saving.value = false
  }
}

async function publish() {
  if (!(await saveDraft(false)) || !studyStore.currentStudyId) return
  publishing.value = true
  try {
    const response = await apiRequest<{
      versionNumber: number
      migratedRecords: number
      migrationStatus: 'pending'
      warnings: ValidationIssue[]
    }>(`/studies/${studyStore.currentStudyId}/forms/${formId.value}/publish`, { method: 'POST' })
    issues.value = response.warnings
    ElMessage.success(
      t('formDesigner.migrationQueued', {
        version: response.versionNumber,
        records: response.migratedRecords,
      }),
    )
    await nextTick()
    dirty.value = false
    await router.push('/forms')
  } catch (error) {
    if (error instanceof ApiClientError) {
      const details = error.payload.details as { issues?: ValidationIssue[] } | undefined
      issues.value = details?.issues ?? []
      ElMessage.error(error.message)
    } else {
      ElMessage.error(t('formDesigner.publishFailed'))
    }
  } finally {
    publishing.value = false
  }
}

async function deleteForm() {
  if (isNew.value || !studyStore.currentStudyId) return
  const confirmed = await ElMessageBox.confirm(
    t('formDesigner.deleteWarning'),
    t('formDesigner.deleteTitle'),
    {
      type: 'warning',
      confirmButtonText: t('formDesigner.confirmDelete'),
      cancelButtonText: t('formDesigner.continueEditing'),
    },
  ).catch(() => null)
  if (!confirmed) return
  try {
    await apiRequest(`/studies/${studyStore.currentStudyId}/forms/${formId.value}`, {
      method: 'DELETE',
    })
    dirty.value = false
    ElMessage.success(t('formDesigner.deleted'))
    await router.push('/forms')
  } catch (error) {
    ElMessage.error(
      error instanceof ApiClientError ? error.message : t('formDesigner.deleteFailed'),
    )
  }
}

async function load() {
  await studyStore.load()
  if (!studyStore.currentStudyId) return
  loading.value = true
  ready.value = false
  try {
    const visitResponse = await apiRequest<{ items: VisitRow[] }>(
      `/studies/${studyStore.currentStudyId}/visits`,
    )
    visits.value = visitResponse.items
    if (!isNew.value) {
      const response = await apiRequest<FormDetailResponse>(
        `/studies/${studyStore.currentStudyId}/forms/${formId.value}`,
      )
      Object.assign(metadata, {
        name: response.form.name,
        formType: response.form.form_type,
        repeatable: response.form.repeatable,
        bindVisits: response.form.bindVisits,
        visitIds: response.form.visitIds,
      })
      definition.value = response.definition
      activeVersionNumber.value = response.activeVersion?.version_number ?? null
      draftVersionNumber.value =
        response.draftVersion?.version_number ?? (response.activeVersion?.version_number ?? 0) + 1
      publishedKeys.value = new Set(
        response.activeVersion?.definition.fields.map((field) => field.key) ?? [],
      )
      randomizationLockedKeys.value = new Set(response.randomizationFactorKeys ?? [])
      designerLocked.value = response.designerLocked
      if (metadata.formType === 'screening') handleFormTypeChange()
      selectedKey.value = definition.value.fields[0]?.key ?? ''
    }
    dirty.value = false
  } catch (error) {
    ElMessage.error(error instanceof ApiClientError ? error.message : t('formDesigner.loadFailed'))
  } finally {
    loading.value = false
    await nextTick()
    dirty.value = false
    ready.value = true
  }
}

function markDirty() {
  if (ready.value) dirty.value = true
}

function beforeUnload(event: BeforeUnloadEvent) {
  if (!dirty.value) return
  event.preventDefault()
}

watch(definition, markDirty, { deep: true })
watch(metadata, markDirty, { deep: true })
onMounted(() => {
  window.addEventListener('beforeunload', beforeUnload)
  load()
})
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload))
onBeforeRouteLeave(async () => {
  if (!dirty.value || leaveConfirmed.value) return true
  if (leavePromptOpen.value) return false
  leavePromptOpen.value = true
  try {
    await ElMessageBox.confirm(t('formDesigner.unsavedWarning'), t('formDesigner.unsavedTitle'), {
      type: 'warning',
      confirmButtonText: t('formDesigner.discard'),
      cancelButtonText: t('formDesigner.continueEditing'),
    })
    dirty.value = false
    leaveConfirmed.value = true
    return true
  } catch {
    return false
  } finally {
    leavePromptOpen.value = false
  }
})
</script>

<template>
  <div class="toolbar designer-toolbar">
    <el-button @click="router.push('/forms')">{{ t('formDesigner.back') }}</el-button>
    <span class="toolbar-spacer" />
    <span class="muted-text"
      >{{ versionLabel }}<template v-if="dirty"> · {{ t('formDesigner.unsaved') }}</template></span
    >
    <el-button
      v-if="!isNew && metadata.formType !== 'screening'"
      type="danger"
      plain
      @click="deleteForm"
    >
      {{ t('formDesigner.deleteForm') }}
    </el-button>
    <el-button @click="previewOpen = true">{{ t('formDesigner.previewAction') }}</el-button>
    <el-button :loading="saving" @click="saveDraft()">{{ t('formDesigner.saveDraft') }}</el-button>
    <el-button type="primary" :loading="publishing" @click="publish">
      {{ t('formDesigner.publish', { version: draftVersionNumber }) }}
    </el-button>
  </div>

  <el-alert
    v-if="!studyStore.currentStudyId"
    :title="t('subjects.selectStudy')"
    type="info"
    show-icon
    :closable="false"
  />
  <template v-else>
    <section v-if="issues.length" class="validation-summary panel" aria-live="polite">
      <strong>{{ t('formDesigner.validationResults') }}</strong>
      <ul>
        <li
          v-for="(issue, index) in issues"
          :key="`${issue.code}-${issue.fieldKey}-${index}`"
          :class="`is-${issue.severity}`"
        >
          {{ issue.severity === 'error' ? t('formDesigner.error') : t('formDesigner.warning') }}：{{
            issue.message
          }}
        </li>
      </ul>
    </section>

    <section v-loading="loading" class="form-designer panel">
      <aside class="designer-column designer-palette">
        <h3>{{ t('formDesigner.fieldComponents') }}</h3>
        <p class="muted-text">{{ t('formDesigner.paletteHint') }}</p>
        <div class="field-palette">
          <button
            v-for="item in fieldPalette"
            :key="item.type"
            class="field-chip"
            type="button"
            @click="addField(item.type)"
          >
            {{ item.label }}
          </button>
        </div>
      </aside>

      <main class="designer-column">
        <div class="toolbar">
          <div>
            <strong>{{ metadata.name }}</strong>
          </div>
          <span class="toolbar-spacer" />
          <el-button
            v-if="width <= 900"
            size="small"
            :disabled="!selectedField"
            @click="propertiesDrawerOpen = true"
          >
            {{ t('formDesigner.fieldProperties') }}
          </el-button>
          <el-button size="small" @click="settingsOpen = true">
            {{ t('formDesigner.formSettings') }}
          </el-button>
        </div>
        <div class="designer-canvas">
          <article
            v-for="(field, index) in definition.fields"
            :key="field.key"
            class="canvas-field"
            :class="{ selected: selectedKey === field.key }"
            :tabindex="0"
            @click="selectedKey = field.key"
            @focus="selectedKey = field.key"
          >
            <div class="canvas-field-header">
              <div>
                <label
                  >{{ field.label }}
                  <span v-if="field.required" class="required-mark">*</span></label
                >
                <span class="field-type">{{ typeLabels[field.type] }} · {{ field.key }}</span>
              </div>
              <div class="field-actions">
                <el-button
                  size="small"
                  :disabled="index === 0 || isRandomizationLocked(field)"
                  :aria-label="t('formDesigner.moveUpLabel', { field: field.label })"
                  @click.stop="moveField(index, -1)"
                >
                  {{ t('formDesigner.moveUp') }}
                </el-button>
                <el-button
                  size="small"
                  :disabled="index === definition.fields.length - 1 || isRandomizationLocked(field)"
                  :aria-label="t('formDesigner.moveDownLabel', { field: field.label })"
                  @click.stop="moveField(index, 1)"
                >
                  {{ t('formDesigner.moveDown') }}
                </el-button>
                <el-button
                  size="small"
                  :disabled="isRandomizationLocked(field)"
                  :aria-label="t('formDesigner.copyLabel', { field: field.label })"
                  @click.stop="duplicateField(index)"
                >
                  {{ t('formDesigner.copy') }}
                </el-button>
                <el-button
                  size="small"
                  type="danger"
                  plain
                  :disabled="isRandomizationLocked(field)"
                  :aria-label="t('formDesigner.deleteLabel', { field: field.label })"
                  @click.stop="removeField(index)"
                >
                  {{ t('formDesigner.delete') }}
                </el-button>
              </div>
            </div>
            <p v-if="field.helpText" class="muted-text">{{ field.helpText }}</p>
            <el-input
              v-if="field.type === 'text' || field.type === 'textarea'"
              :type="field.type === 'textarea' ? 'textarea' : 'text'"
              :placeholder="field.placeholder"
              disabled
            />
            <el-input-number v-else-if="field.type === 'number'" disabled style="width: 100%" />
            <el-date-picker
              v-else-if="field.type === 'date' || field.type === 'datetime'"
              :type="field.type"
              disabled
              style="width: 100%"
            />
            <div
              v-else-if="['radio', 'checkbox', 'select', 'scale'].includes(field.type)"
              class="option-preview"
            >
              <el-tag v-for="option in field.options" :key="option.value" effect="plain">
                {{ option.label }}
              </el-tag>
            </div>
            <el-switch v-else-if="field.type === 'switch'" disabled />
            <el-button v-else-if="field.type === 'file'" disabled>
              {{ t('formDesigner.selectFile') }}
            </el-button>
            <el-input
              v-else-if="field.type === 'calculated'"
              :model-value="t('formDesigner.calculatedPreview')"
              disabled
            />
            <div v-else class="structural-preview">
              {{
                field.type === 'heading'
                  ? t('formDesigner.fields.heading')
                  : t('formDesigner.fields.note')
              }}
            </div>
          </article>
          <div v-if="!definition.fields.length" class="empty-canvas">
            <h3>{{ t('formDesigner.emptyCanvas') }}</h3>
            <p class="muted-text">{{ t('formDesigner.emptyCanvasHint') }}</p>
          </div>
        </div>
      </main>

      <aside class="designer-column designer-properties">
        <FieldPropertiesPanel
          v-model="selectedField"
          :fields="definition.fields"
          :key-locked="selectedKeyLocked"
          :randomization-locked="selectedRandomizationLocked"
          :form-type="metadata.formType"
          @key-changed="handleFieldKeyChanged"
        />
      </aside>
    </section>
  </template>

  <el-drawer
    v-model="propertiesDrawerOpen"
    :title="t('formDesigner.fieldProperties')"
    size="min(620px, 94vw)"
    :close-on-click-modal="false"
  >
    <FieldPropertiesPanel
      v-model="selectedField"
      :fields="definition.fields"
      :key-locked="selectedKeyLocked"
      :randomization-locked="selectedRandomizationLocked"
      :form-type="metadata.formType"
      @key-changed="handleFieldKeyChanged"
    />
  </el-drawer>

  <el-dialog
    v-model="settingsOpen"
    :title="t('formDesigner.settings.title')"
    width="min(620px, 94vw)"
    :close-on-click-modal="false"
  >
    <el-form label-position="top">
      <div class="settings-grid">
        <el-form-item :label="t('formDesigner.settings.name')" required>
          <el-input v-model="metadata.name" maxlength="200" />
        </el-form-item>
        <el-form-item :label="t('formDesigner.settings.type')" required>
          <el-select
            v-model="metadata.formType"
            style="width: 100%"
            :disabled="metadata.formType === 'screening'"
            @change="handleFormTypeChange"
          >
            <el-option
              v-for="type in formTypeLabels"
              :key="type.value"
              :label="type.label"
              :value="type.value"
            />
          </el-select>
        </el-form-item>
      </div>
      <el-divider>{{ t('formDesigner.settings.entryBehavior') }}</el-divider>
      <p v-if="metadata.formType === 'screening'" class="muted-text">
        {{ t('formDesigner.settings.screeningRestrictions') }}
      </p>
      <div class="behavior-setting">
        <el-switch v-model="metadata.repeatable" :disabled="metadata.formType === 'screening'" />
        <div>
          <strong>{{ t('formDesigner.settings.repeatable') }}</strong>
          <p class="muted-text">{{ t('formDesigner.settings.repeatableHint') }}</p>
        </div>
      </div>
      <div class="behavior-setting">
        <el-switch v-model="metadata.bindVisits" :disabled="metadata.formType === 'screening'" />
        <div>
          <strong>{{ t('formDesigner.settings.bindVisits') }}</strong>
          <p class="muted-text">{{ t('formDesigner.settings.bindVisitsHint') }}</p>
        </div>
      </div>
      <el-form-item v-if="metadata.bindVisits" :label="t('formDesigner.settings.visits')" required>
        <el-select
          v-model="metadata.visitIds"
          multiple
          filterable
          style="width: 100%"
          :placeholder="t('formDesigner.settings.selectVisits')"
        >
          <el-option
            v-for="visit in visits"
            :key="visit.id"
            :label="`${visit.code} · ${visit.name}`"
            :value="visit.id"
          />
        </el-select>
        <div v-if="!visits.length" class="muted-text">
          {{ t('formDesigner.settings.noVisits') }}
        </div>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button type="primary" @click="settingsOpen = false">
        {{ t('formDesigner.settings.done') }}
      </el-button>
    </template>
  </el-dialog>

  <el-dialog
    v-model="previewOpen"
    :title="t('formDesigner.previewTitle', { name: metadata.name })"
    width="min(820px, 94vw)"
  >
    <FormPreview :definition="definition" />
  </el-dialog>
</template>

<style scoped>
.designer-toolbar {
  position: sticky;
  z-index: 35;
  top: var(--topbar-height);
  padding: 8px 0;
  background: var(--color-background);
}
.validation-summary {
  margin-bottom: 12px;
  padding: 12px 16px;
}
.validation-summary ul {
  margin: 8px 0 0;
  padding-left: 20px;
}
.validation-summary .is-error {
  color: var(--color-danger);
}
.validation-summary .is-warning {
  color: var(--color-warning);
}
.canvas-field.selected {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-primary) 16%, transparent);
}
.canvas-field-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}
.field-type {
  display: block;
  color: var(--color-text-secondary);
  font-size: 12px;
}
.field-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 4px;
}
.field-actions :deep(.el-button + .el-button) {
  margin-left: 0;
}
.required-mark {
  color: var(--color-danger);
}
.option-preview {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.structural-preview {
  padding: 10px;
  border-left: 3px solid var(--color-primary);
  background: var(--color-surface-subtle);
  color: var(--color-text-secondary);
}
.empty-canvas {
  display: grid;
  min-height: 320px;
  place-content: center;
  text-align: center;
}
.settings-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 16px;
}
.behavior-setting {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 16px;
}
.behavior-setting p {
  margin: 3px 0 0;
}
@media (max-width: 900px) {
  .canvas-field-header {
    flex-direction: column;
  }
  .field-actions {
    justify-content: flex-start;
  }
}
@media (max-width: 767px) {
  .settings-grid {
    grid-template-columns: 1fr;
  }
}
</style>
