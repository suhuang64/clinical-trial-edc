<script setup lang="ts">
import { computed, watch } from 'vue'
import type { FormField, FormType } from '@edc/contracts'
import { useI18n } from 'vue-i18n'

const field = defineModel<FormField | null>({ required: true })
const props = defineProps<{ fields: FormField[]; keyLocked: boolean; formType: FormType }>()
const { t } = useI18n()

const optionTypes = new Set(['radio', 'checkbox', 'select', 'scale'])
const operators = computed(
  () =>
    [
      ['eq', t('formDesigner.properties.operators.eq')],
      ['neq', t('formDesigner.properties.operators.neq')],
      ['gt', t('formDesigner.properties.operators.gt')],
      ['gte', t('formDesigner.properties.operators.gte')],
      ['lt', t('formDesigner.properties.operators.lt')],
      ['lte', t('formDesigner.properties.operators.lte')],
      ['contains', t('formDesigner.properties.operators.contains')],
      ['is_empty', t('formDesigner.properties.operators.isEmpty')],
      ['is_not_empty', t('formDesigner.properties.operators.isNotEmpty')],
    ] as const,
)
const referenceFields = computed(() =>
  props.fields.filter((candidate) => candidate.key !== field.value?.key),
)
const calculationFields = computed(() =>
  referenceFields.value.filter((candidate) =>
    ['number', 'date', 'datetime', 'calculated'].includes(candidate.type),
  ),
)

watch(
  () => field.value?.type,
  (type) => {
    if (!field.value || !type) return
    if (optionTypes.has(type) && !field.value.options.length) {
      field.value.options = [
        {
          value: 'option_1',
          label: t('formDesigner.properties.optionNumber', { number: 1 }),
          disabled: false,
        },
        {
          value: 'option_2',
          label: t('formDesigner.properties.optionNumber', { number: 2 }),
          disabled: false,
        },
      ]
    } else if (!optionTypes.has(type)) {
      field.value.options = []
    }
    if (type === 'calculated') {
      field.value.readOnly = true
      field.value.calculation ??= {
        expression: '',
        dependencies: [],
        resultType: 'number',
        expressionVersion: 1,
      }
    } else {
      delete field.value.calculation
    }
  },
)

function addOption() {
  if (!field.value) return
  const index = field.value.options.length + 1
  field.value.options.push({
    value: `option_${index}`,
    label: t('formDesigner.properties.optionNumber', { number: index }),
    disabled: false,
  })
}

function addVisibilityRule() {
  if (!field.value || !referenceFields.value.length) return
  field.value.visibility ??= { logic: 'and', rules: [] }
  field.value.visibility.rules.push({
    fieldKey: referenceFields.value[0]!.key,
    operator: 'eq',
    value: '',
  })
}
</script>

<template>
  <div v-if="field" class="properties-panel">
    <h3>{{ t('formDesigner.properties.title') }}</h3>
    <el-form label-position="top">
      <el-form-item :label="t('formDesigner.properties.label')" required>
        <el-input v-model="field.label" maxlength="200" />
      </el-form-item>
      <el-form-item :label="t('formDesigner.properties.key')" required>
        <el-input v-model="field.key" :disabled="keyLocked" />
        <div class="muted-text">{{ t('formDesigner.properties.keyLocked') }}</div>
      </el-form-item>
      <el-form-item :label="t('formDesigner.properties.helpText')">
        <el-input v-model="field.helpText" type="textarea" :rows="2" maxlength="500" />
      </el-form-item>
      <el-form-item :label="t('formDesigner.properties.placeholder')">
        <el-input v-model="field.placeholder" maxlength="200" />
      </el-form-item>
      <el-form-item :label="t('formDesigner.properties.unit')">
        <el-input v-model="field.unit" maxlength="50" />
      </el-form-item>
      <div class="switch-grid">
        <el-checkbox v-model="field.required">
          {{ t('formDesigner.properties.required') }}
        </el-checkbox>
        <el-checkbox v-model="field.readOnly">
          {{ t('formDesigner.properties.readOnly') }}
        </el-checkbox>
        <el-checkbox v-model="field.hidden">{{ t('formDesigner.properties.hidden') }}</el-checkbox>
        <el-checkbox v-model="field.exportable">
          {{ t('formDesigner.properties.exportable') }}
        </el-checkbox>
        <el-checkbox
          v-if="props.formType === 'screening'"
          v-model="field.randomizationFactor"
          :disabled="!['text', 'number', 'date', 'datetime', 'radio', 'select', 'switch', 'scale'].includes(field.type)"
          @change="field.randomizationFactor && (field.required = true)"
        >
          {{ t('formDesigner.properties.randomizationFactor') }}
        </el-checkbox>
      </div>

      <template v-if="['text', 'textarea'].includes(field.type)">
        <el-divider>{{ t('formDesigner.properties.textValidation') }}</el-divider>
        <div class="two-column">
          <el-form-item :label="t('formDesigner.properties.minLength')">
            <el-input-number
              v-model="field.validation.minLength"
              :min="0"
              controls-position="right"
            />
          </el-form-item>
          <el-form-item :label="t('formDesigner.properties.maxLength')">
            <el-input-number
              v-model="field.validation.maxLength"
              :min="1"
              controls-position="right"
            />
          </el-form-item>
        </div>
        <el-form-item :label="t('formDesigner.properties.pattern')">
          <el-input
            v-model="field.validation.pattern"
            :placeholder="t('formDesigner.properties.optional')"
          />
        </el-form-item>
      </template>

      <template v-if="field.type === 'number'">
        <el-divider>{{ t('formDesigner.properties.numberValidation') }}</el-divider>
        <div class="two-column">
          <el-form-item :label="t('formDesigner.properties.minimum')">
            <el-input-number v-model="field.validation.minimum" controls-position="right" />
          </el-form-item>
          <el-form-item :label="t('formDesigner.properties.maximum')">
            <el-input-number v-model="field.validation.maximum" controls-position="right" />
          </el-form-item>
        </div>
      </template>

      <template v-if="optionTypes.has(field.type)">
        <el-divider>{{ t('formDesigner.properties.options') }}</el-divider>
        <div v-for="(option, index) in field.options" :key="index" class="option-row">
          <el-input
            v-model="option.value"
            :aria-label="t('formDesigner.properties.optionValue')"
            :placeholder="t('formDesigner.properties.value')"
          />
          <el-input
            v-model="option.label"
            :aria-label="t('formDesigner.properties.optionText')"
            :placeholder="t('formDesigner.properties.displayText')"
          />
          <el-button
            :aria-label="t('formDesigner.properties.deleteOption')"
            @click="field.options.splice(index, 1)"
          >
            {{ t('formDesigner.properties.delete') }}
          </el-button>
        </div>
        <el-button plain class="full-button" @click="addOption">
          {{ t('formDesigner.properties.addOption') }}
        </el-button>
      </template>

      <template v-if="field.type === 'calculated' && field.calculation">
        <el-divider>{{ t('formDesigner.properties.calculation') }}</el-divider>
        <el-form-item :label="t('formDesigner.properties.dependencies')" required>
          <el-select
            v-model="field.calculation.dependencies"
            multiple
            filterable
            style="width: 100%"
          >
            <el-option
              v-for="source in calculationFields"
              :key="source.key"
              :label="`${source.label} · ${source.key}`"
              :value="source.key"
            />
          </el-select>
        </el-form-item>
        <el-form-item :label="t('formDesigner.properties.expression')" required>
          <el-input
            v-model="field.calculation.expression"
            type="textarea"
            :rows="3"
            :placeholder="t('formDesigner.properties.expressionPlaceholder')"
          />
        </el-form-item>
        <el-form-item :label="t('formDesigner.properties.resultType')">
          <el-select v-model="field.calculation.resultType" style="width: 100%">
            <el-option :label="t('formDesigner.properties.number')" value="number" />
            <el-option :label="t('formDesigner.properties.date')" value="date" />
            <el-option :label="t('formDesigner.properties.datetime')" value="datetime" />
          </el-select>
        </el-form-item>
      </template>

      <el-divider>{{ t('formDesigner.properties.conditional') }}</el-divider>
      <template v-if="field.visibility">
        <el-form-item :label="t('formDesigner.properties.ruleLogic')">
          <el-radio-group v-model="field.visibility.logic">
            <el-radio-button value="and">
              {{ t('formDesigner.properties.allRules') }}
            </el-radio-button>
            <el-radio-button value="or">{{ t('formDesigner.properties.anyRule') }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <div v-for="(rule, index) in field.visibility.rules" :key="index" class="condition-row">
          <el-select
            v-model="rule.fieldKey"
            :aria-label="t('formDesigner.properties.conditionField')"
          >
            <el-option
              v-for="source in referenceFields"
              :key="source.key"
              :label="source.label"
              :value="source.key"
            />
          </el-select>
          <el-select
            v-model="rule.operator"
            :aria-label="t('formDesigner.properties.conditionOperator')"
          >
            <el-option
              v-for="operator in operators"
              :key="operator[0]"
              :label="operator[1]"
              :value="operator[0]"
            />
          </el-select>
          <el-input
            v-if="!['is_empty', 'is_not_empty'].includes(rule.operator)"
            v-model="rule.value"
            :aria-label="t('formDesigner.properties.conditionValue')"
            :placeholder="t('formDesigner.properties.comparisonValue')"
          />
          <el-button
            :aria-label="t('formDesigner.properties.deleteCondition')"
            @click="field.visibility.rules.splice(index, 1)"
          >
            {{ t('formDesigner.properties.delete') }}
          </el-button>
        </div>
      </template>
      <el-button
        plain
        class="full-button"
        :disabled="!referenceFields.length"
        @click="addVisibilityRule"
      >
        {{ t('formDesigner.properties.addCondition') }}
      </el-button>
    </el-form>
  </div>
  <div v-else class="empty-properties">
    <p>{{ t('formDesigner.properties.selectFieldHint') }}</p>
  </div>
</template>

<style scoped>
.properties-panel h3 {
  margin-top: 0;
}
.switch-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
}
.two-column {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.two-column :deep(.el-input-number) {
  width: 100%;
}
.option-row,
.condition-row {
  display: grid;
  grid-template-columns: 1fr 1.25fr auto;
  gap: 6px;
  margin-bottom: 8px;
}
.condition-row {
  grid-template-columns: 1.2fr 1fr 1fr auto;
}
.full-button {
  width: 100%;
}
.empty-properties {
  display: grid;
  min-height: 240px;
  place-items: center;
  color: var(--color-text-secondary);
  text-align: center;
}
@media (max-width: 700px) {
  .condition-row,
  .option-row {
    grid-template-columns: 1fr;
  }
}
</style>
