<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useI18n } from 'vue-i18n'
import type { FormDefinition, FormField } from '@edc/contracts'
import { validateFormRecord, type FormValue, type FormValueMap } from '@edc/domain/form-runtime'
import { apiRequest, ApiClientError } from '@/api/client'
import { formatRecordValidationIssue } from './form-validation-messages'

interface FileContext {
  studyId: string
  subjectId: string
  recordId?: string
}

interface UploadedFileInfo {
  id: string
  recordId: string | null
  fieldKey: string
  originalName: string
  mimeType: string
  sizeBytes: number
  sha256: string
  createdAt: string
}

const values = defineModel<FormValueMap>({ required: true })
const { t } = useI18n()
const props = withDefaults(
  defineProps<{
    definition: FormDefinition
    disabled?: boolean
    showErrors?: boolean
    serverErrors?: Record<string, string[]>
    fileContext?: FileContext | undefined
  }>(),
  { disabled: false, showErrors: false, serverErrors: () => ({}), fileContext: undefined },
)
const fileRows = ref<UploadedFileInfo[]>([])
const uploadingFields = ref(new Set<string>())

const runtime = computed(() => validateFormRecord(props.definition, values.value))
const visibleFields = computed(() => {
  const visible = new Set(runtime.value.visibleFieldKeys)
  return props.definition.fields.filter((field) => visible.has(field.key))
})
const errors = computed(() => {
  const result: Record<string, string[]> = Object.fromEntries(
    Object.entries(props.serverErrors).map(([key, messages]) => [key, [...messages]]),
  )
  if (props.showErrors) {
    for (const issue of runtime.value.issues) {
      ;(result[issue.fieldKey] ??= []).push(formatRecordValidationIssue(issue, props.definition, t))
    }
  }
  return result
})
const errorSummary = computed(() =>
  Object.entries(errors.value).flatMap(([fieldKey, messages]) => {
    const field = props.definition.fields.find((candidate) => candidate.key === fieldKey)
    return messages.map((message) => ({ fieldKey, label: field?.label ?? fieldKey, message }))
  }),
)

function focusField(fieldKey: string) {
  const container = document.getElementById(`form-field-${fieldKey}`)
  container
    ?.querySelector<HTMLElement>('input, textarea, button, [tabindex]:not([tabindex="-1"])')
    ?.focus()
}

function modelValue(field: FormField) {
  if (field.type === 'calculated') return runtime.value.values[field.key]
  return values.value[field.key]
}

function setValue(fieldKey: string, value: FormValue | undefined) {
  values.value = { ...values.value, [fieldKey]: value }
}

function isRequired(field: FormField) {
  return field.required || Boolean(field.requiredWhen)
}

function fileIds(field: FormField) {
  const value = modelValue(field)
  return Array.isArray(value) ? value : []
}

function filesFor(field: FormField) {
  const ids = new Set(fileIds(field))
  return fileRows.value.filter((file) => file.fieldKey === field.key && ids.has(file.id))
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function openFilePicker(fieldKey: string) {
  document.getElementById(`file-input-${fieldKey}`)?.click()
}

async function loadFileMetadata() {
  if (!props.fileContext) {
    fileRows.value = []
    return
  }
  const ids = props.definition.fields
    .filter((field) => field.type === 'file')
    .flatMap((field) => fileIds(field))
  if (!ids.length) {
    fileRows.value = []
    return
  }
  try {
    const response = await apiRequest<{ items: UploadedFileInfo[] }>(
      `/studies/${props.fileContext.studyId}/subjects/${props.fileContext.subjectId}/files?ids=${encodeURIComponent(ids.join(','))}`,
    )
    fileRows.value = response.items
  } catch (error) {
    ElMessage.error(
      error instanceof ApiClientError ? error.message : t('formRuntime.fileMetadataFailed'),
    )
  }
}

async function uploadFiles(field: FormField, event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (!props.fileContext || !files.length) return
  uploadingFields.value = new Set(uploadingFields.value).add(field.key)
  try {
    const currentIds = [...fileIds(field)]
    for (const file of files) {
      const body = new FormData()
      body.append('file', file)
      const recordQuery = props.fileContext.recordId
        ? `?recordId=${encodeURIComponent(props.fileContext.recordId)}`
        : ''
      const uploaded = await apiRequest<UploadedFileInfo>(
        `/studies/${props.fileContext.studyId}/subjects/${props.fileContext.subjectId}/files/${field.key}${recordQuery}`,
        { method: 'POST', body },
      )
      currentIds.push(uploaded.id)
      fileRows.value = [...fileRows.value, uploaded]
    }
    setValue(field.key, currentIds)
    ElMessage.success(
      files.length === 1
        ? t('formRuntime.fileUploaded')
        : t('formRuntime.filesUploaded', { count: files.length }),
    )
  } catch (error) {
    ElMessage.error(
      error instanceof ApiClientError ? error.message : t('formRuntime.fileUploadFailed'),
    )
  } finally {
    const next = new Set(uploadingFields.value)
    next.delete(field.key)
    uploadingFields.value = next
  }
}

async function deleteFile(field: FormField, file: UploadedFileInfo) {
  if (!props.fileContext) return
  const confirmed = await ElMessageBox.confirm(
    t('formRuntime.deleteFileWarning'),
    t('formRuntime.deleteFileTitle', { name: file.originalName }),
    {
      type: 'warning',
      confirmButtonText: t('formRuntime.confirmDelete'),
      cancelButtonText: t('common.cancel'),
    },
  ).catch(() => null)
  if (!confirmed) return
  try {
    await apiRequest(
      `/studies/${props.fileContext.studyId}/subjects/${props.fileContext.subjectId}/files/${file.id}`,
      { method: 'DELETE' },
    )
    fileRows.value = fileRows.value.filter((item) => item.id !== file.id)
    setValue(
      field.key,
      fileIds(field).filter((id) => id !== file.id),
    )
    ElMessage.success(t('formRuntime.fileDeleted'))
  } catch (error) {
    ElMessage.error(
      error instanceof ApiClientError ? error.message : t('formRuntime.fileDeleteFailed'),
    )
  }
}

watch(
  () => [
    props.fileContext?.studyId,
    props.fileContext?.subjectId,
    props.fileContext?.recordId,
    props.definition.fields
      .filter((field) => field.type === 'file')
      .flatMap((field) => fileIds(field))
      .join(','),
  ],
  loadFileMetadata,
  { immediate: true },
)
</script>

<template>
  <el-form label-position="top" class="dynamic-form" @submit.prevent>
    <section
      v-if="errorSummary.length"
      class="form-error-summary"
      role="alert"
      aria-live="assertive"
      aria-atomic="true"
    >
      <h3>{{ t('formRuntime.errorSummaryTitle', { count: errorSummary.length }) }}</h3>
      <ul>
        <li v-for="item in errorSummary" :key="`${item.fieldKey}-${item.message}`">
          <a :href="`#form-field-${item.fieldKey}`" @click.prevent="focusField(item.fieldKey)">
            {{ item.label }}：{{ item.message }}
          </a>
        </li>
      </ul>
    </section>
    <template v-for="field in visibleFields" :key="field.key">
      <h3 v-if="field.type === 'heading'" class="form-heading">{{ field.label }}</h3>
      <el-alert
        v-else-if="field.type === 'note'"
        :title="field.label"
        :description="field.helpText"
        type="info"
        :closable="false"
      />
      <el-form-item
        v-else
        :id="`form-field-${field.key}`"
        :data-field-key="field.key"
        :label="`${field.label}${field.unit ? `（${field.unit}）` : ''}`"
        :required="isRequired(field)"
        :error="errors[field.key]?.[0]"
      >
        <el-input
          v-if="field.type === 'text'"
          :model-value="modelValue(field) as string"
          :placeholder="field.placeholder"
          :disabled="disabled || field.readOnly"
          @update:model-value="setValue(field.key, $event)"
        />
        <el-input
          v-else-if="field.type === 'textarea'"
          type="textarea"
          :rows="3"
          :model-value="modelValue(field) as string"
          :placeholder="field.placeholder"
          :disabled="disabled || field.readOnly"
          @update:model-value="setValue(field.key, $event)"
        />
        <el-input-number
          v-else-if="field.type === 'number'"
          :model-value="modelValue(field) as number"
          :placeholder="field.placeholder"
          :min="field.validation.minimum"
          :max="field.validation.maximum"
          :disabled="disabled || field.readOnly"
          controls-position="right"
          style="width: 100%"
          @update:model-value="setValue(field.key, $event ?? null)"
        />
        <el-date-picker
          v-else-if="field.type === 'date'"
          type="date"
          value-format="YYYY-MM-DD"
          :model-value="modelValue(field) as string"
          :placeholder="field.placeholder || t('formRuntime.selectDate')"
          :disabled="disabled || field.readOnly"
          style="width: 100%"
          @update:model-value="setValue(field.key, $event)"
        />
        <el-date-picker
          v-else-if="field.type === 'datetime'"
          type="datetime"
          value-format="YYYY-MM-DDTHH:mm:ss"
          :model-value="modelValue(field) as string"
          :placeholder="field.placeholder || t('formRuntime.selectDateTime')"
          :disabled="disabled || field.readOnly"
          style="width: 100%"
          @update:model-value="setValue(field.key, $event)"
        />
        <el-radio-group
          v-else-if="field.type === 'radio' || field.type === 'scale'"
          :model-value="modelValue(field) as string"
          :disabled="disabled || field.readOnly"
          @update:model-value="setValue(field.key, $event)"
        >
          <el-radio
            v-for="option in field.options"
            :key="option.value"
            :value="option.value"
            :disabled="option.disabled"
          >
            {{ option.label }}
          </el-radio>
        </el-radio-group>
        <el-checkbox-group
          v-else-if="field.type === 'checkbox'"
          :model-value="(modelValue(field) as string[]) ?? []"
          :disabled="disabled || field.readOnly"
          @update:model-value="setValue(field.key, $event)"
        >
          <el-checkbox
            v-for="option in field.options"
            :key="option.value"
            :value="option.value"
            :disabled="option.disabled"
          >
            {{ option.label }}
          </el-checkbox>
        </el-checkbox-group>
        <el-select
          v-else-if="field.type === 'select'"
          :model-value="modelValue(field) as string"
          :placeholder="field.placeholder || t('formRuntime.selectOption')"
          :disabled="disabled || field.readOnly"
          clearable
          style="width: 100%"
          @update:model-value="setValue(field.key, $event)"
        >
          <el-option
            v-for="option in field.options"
            :key="option.value"
            :label="option.label"
            :value="option.value"
            :disabled="option.disabled"
          />
        </el-select>
        <el-switch
          v-else-if="field.type === 'switch'"
          :data-field-key="field.key"
          :model-value="Boolean(modelValue(field))"
          :disabled="disabled || field.readOnly"
          @update:model-value="setValue(field.key, $event)"
        />
        <div v-else-if="field.type === 'file'" class="file-field">
          <input
            :id="`file-input-${field.key}`"
            class="visually-hidden"
            type="file"
            multiple
            accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.xls,.xlsx"
            :aria-label="t('formRuntime.selectFieldFile', { field: field.label })"
            :disabled="disabled || field.readOnly || !fileContext"
            @change="uploadFiles(field, $event)"
          />
          <div class="file-actions">
            <el-button
              :loading="uploadingFields.has(field.key)"
              :disabled="disabled || field.readOnly || !fileContext"
              @click="openFilePicker(field.key)"
            >
              {{ t('formRuntime.uploadFile') }}
            </el-button>
            <span class="muted-text">{{ t('formRuntime.fileHint') }}</span>
          </div>
          <ul v-if="filesFor(field).length" class="file-list">
            <li v-for="file in filesFor(field)" :key="file.id">
              <a
                :href="`/api/v1/studies/${fileContext?.studyId}/subjects/${fileContext?.subjectId}/files/${file.id}/download`"
                >{{ file.originalName }}</a
              >
              <span class="muted-text">{{ formatBytes(file.sizeBytes) }}</span>
              <el-button
                v-if="!disabled && !field.readOnly"
                link
                type="danger"
                :aria-label="t('formRuntime.deleteFileLabel', { name: file.originalName })"
                @click="deleteFile(field, file)"
              >
                {{ t('formRuntime.delete') }}
              </el-button>
            </li>
          </ul>
        </div>
        <el-input
          v-else-if="field.type === 'calculated'"
          :model-value="String(modelValue(field) ?? '')"
          readonly
          :aria-label="t('formRuntime.calculatedResult')"
        />
        <div v-if="field.helpText && field.type !== 'file'" class="field-help">
          {{ field.helpText }}
        </div>
      </el-form-item>
    </template>
  </el-form>
</template>

<style scoped>
.form-error-summary {
  margin-bottom: 16px;
  padding: 12px 16px;
  border: 1px solid var(--color-danger);
  border-radius: 8px;
  background: color-mix(in srgb, var(--color-danger) 8%, var(--color-surface));
}
.form-error-summary h3 {
  margin: 0 0 8px;
  color: var(--color-danger);
  font-size: 16px;
}
.form-error-summary ul {
  margin: 0;
  padding-left: 20px;
}
.form-error-summary a {
  color: var(--color-text);
  line-height: 1.7;
  text-decoration: underline;
  text-underline-offset: 2px;
}
</style>

<style scoped>
.dynamic-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 16px;
}
.dynamic-form > :deep(.el-alert),
.dynamic-form > :deep(.form-heading),
.dynamic-form > .form-error-summary {
  grid-column: 1 / -1;
}
.form-heading {
  margin: 12px 0 16px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--color-border);
}
.field-help {
  color: var(--color-text-secondary);
  font-size: 13px;
}
.file-field {
  width: 100%;
}
.file-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.file-list {
  display: grid;
  gap: 8px;
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
}
.file-list li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-surface-subtle);
}
.file-list a {
  overflow: hidden;
  color: var(--color-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
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
@media (max-width: 767px) {
  .dynamic-form {
    grid-template-columns: 1fr;
  }
}
</style>
