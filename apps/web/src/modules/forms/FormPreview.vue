<script setup lang="ts">
import type { FormDefinition } from '@edc/contracts'
import { useI18n } from 'vue-i18n'

defineProps<{ definition: FormDefinition }>()
const { t } = useI18n()
</script>

<template>
  <el-form label-position="top" class="form-preview">
    <template v-for="field in definition.fields" :key="field.key">
      <h3 v-if="field.type === 'heading'">{{ field.label }}</h3>
      <el-alert
        v-else-if="field.type === 'note'"
        :title="field.label"
        :description="field.helpText"
        type="info"
        :closable="false"
      />
      <el-form-item
        v-else
        :label="`${field.label}${field.unit ? `（${field.unit}）` : ''}`"
        :required="field.required"
      >
        <el-input
          v-if="field.type === 'text'"
          :placeholder="field.placeholder"
          :disabled="field.readOnly"
        />
        <el-input
          v-else-if="field.type === 'textarea'"
          type="textarea"
          :rows="3"
          :placeholder="field.placeholder"
          :disabled="field.readOnly"
        />
        <el-input-number
          v-else-if="field.type === 'number'"
          :placeholder="field.placeholder"
          :disabled="field.readOnly"
          style="width: 100%"
        />
        <el-date-picker
          v-else-if="field.type === 'date'"
          type="date"
          :placeholder="field.placeholder || t('formDesigner.preview.selectDate')"
          :disabled="field.readOnly"
          style="width: 100%"
        />
        <el-date-picker
          v-else-if="field.type === 'datetime'"
          type="datetime"
          :placeholder="field.placeholder || t('formDesigner.preview.selectDateTime')"
          :disabled="field.readOnly"
          style="width: 100%"
        />
        <el-radio-group
          v-else-if="field.type === 'radio' || field.type === 'scale'"
          :disabled="field.readOnly"
        >
          <el-radio v-for="option in field.options" :key="option.value" :value="option.value">
            {{ option.label }}
          </el-radio>
        </el-radio-group>
        <el-checkbox-group v-else-if="field.type === 'checkbox'" :disabled="field.readOnly">
          <el-checkbox v-for="option in field.options" :key="option.value" :value="option.value">
            {{ option.label }}
          </el-checkbox>
        </el-checkbox-group>
        <el-select
          v-else-if="field.type === 'select'"
          :placeholder="field.placeholder || t('formDesigner.preview.selectOption')"
          :disabled="field.readOnly"
          style="width: 100%"
        >
          <el-option
            v-for="option in field.options"
            :key="option.value"
            :label="option.label"
            :value="option.value"
          />
        </el-select>
        <el-switch v-else-if="field.type === 'switch'" :disabled="field.readOnly" />
        <el-upload
          v-else-if="field.type === 'file'"
          action="#"
          :auto-upload="false"
          :disabled="field.readOnly"
        >
          <el-button>{{ t('formDesigner.preview.selectFile') }}</el-button>
        </el-upload>
        <el-input
          v-else-if="field.type === 'calculated'"
          :model-value="t('formDesigner.preview.calculated')"
          disabled
        />
        <div class="field-meta">
          <span v-if="field.helpText">{{ field.helpText }}</span>
          <el-tag v-if="field.visibility" size="small" effect="plain">
            {{ t('formDesigner.preview.conditional') }}
          </el-tag>
          <el-tag v-if="field.hidden" size="small" type="info">
            {{ t('formDesigner.preview.permanentlyHidden') }}
          </el-tag>
        </div>
      </el-form-item>
    </template>
    <el-empty
      v-if="!definition.fields.length"
      :description="t('formDesigner.preview.noFields')"
      :image-size="64"
    />
  </el-form>
</template>

<style scoped>
.form-preview {
  max-width: 720px;
  margin: 0 auto;
}
.field-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--color-text-secondary);
  font-size: 13px;
}
</style>
