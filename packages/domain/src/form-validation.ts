import type { FieldType, FormDefinition, FormField } from '@edc/contracts'

export interface FormValidationIssue {
  code: string
  message: string
  fieldKey?: string
  severity: 'error' | 'warning'
}

const optionTypes = new Set<FieldType>(['radio', 'checkbox', 'select', 'scale'])
const calculationSourceTypes = new Set<FieldType>(['number', 'date', 'datetime', 'calculated'])
const compatibleConversions = new Set([
  'text:textarea',
  'textarea:text',
  'radio:select',
  'select:radio',
])

function duplicates(values: string[]) {
  const seen = new Set<string>()
  return [...new Set(values.filter((value) => (seen.has(value) ? true : (seen.add(value), false))))]
}

function dependencies(field: FormField) {
  return [
    ...(field.visibility?.rules.map((rule) => rule.fieldKey) ?? []),
    ...(field.requiredWhen?.rules.map((rule) => rule.fieldKey) ?? []),
    ...(field.calculation?.dependencies ?? []),
  ]
}

function cycleIssues(definition: FormDefinition) {
  const graph = new Map(definition.fields.map((field) => [field.key, dependencies(field)]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const path: string[] = []
  const issues: FormValidationIssue[] = []

  function visit(key: string) {
    if (visiting.has(key)) {
      const start = path.indexOf(key)
      const cycle = [...path.slice(start), key]
      issues.push({
        code: 'DEPENDENCY_CYCLE',
        message: `字段依赖存在循环：${cycle.join(' → ')}`,
        fieldKey: key,
        severity: 'error',
      })
      return
    }
    if (visited.has(key)) return
    visiting.add(key)
    path.push(key)
    for (const dependency of graph.get(key) ?? []) if (graph.has(dependency)) visit(dependency)
    path.pop()
    visiting.delete(key)
    visited.add(key)
  }

  for (const key of graph.keys()) visit(key)
  return issues
}

export function validateFormDefinition(definition: FormDefinition): FormValidationIssue[] {
  const issues: FormValidationIssue[] = []
  const keys = definition.fields.map((field) => field.key)
  const keySet = new Set(keys)

  for (const key of duplicates(keys)) {
    issues.push({
      code: 'DUPLICATE_FIELD_KEY',
      message: `字段 Key 重复：${key}`,
      fieldKey: key,
      severity: 'error',
    })
  }
  for (const key of duplicates(definition.retiredFieldKeys)) {
    issues.push({
      code: 'DUPLICATE_RETIRED_KEY',
      message: `停用字段 Key 重复：${key}`,
      fieldKey: key,
      severity: 'error',
    })
  }
  for (const key of keys.filter((key) => definition.retiredFieldKeys.includes(key))) {
    issues.push({
      code: 'RETIRED_KEY_REUSED',
      message: `已停用字段 Key 不得复用：${key}`,
      fieldKey: key,
      severity: 'error',
    })
  }

  for (const field of definition.fields) {
    if (optionTypes.has(field.type)) {
      if (!field.options.length) {
        issues.push({
          code: 'OPTIONS_REQUIRED',
          message: '该字段类型至少需要一个选项',
          fieldKey: field.key,
          severity: 'error',
        })
      }
      for (const value of duplicates(field.options.map((option) => option.value))) {
        issues.push({
          code: 'DUPLICATE_OPTION_VALUE',
          message: `选项值重复：${value}`,
          fieldKey: field.key,
          severity: 'error',
        })
      }
    } else if (field.options.length) {
      issues.push({
        code: 'OPTIONS_NOT_SUPPORTED',
        message: '该字段类型不支持选项',
        fieldKey: field.key,
        severity: 'error',
      })
    }

    if (field.type === 'calculated' && !field.calculation) {
      issues.push({
        code: 'CALCULATION_REQUIRED',
        message: '计算字段必须配置表达式',
        fieldKey: field.key,
        severity: 'error',
      })
    }
    if (
      field.type === 'calculated' &&
      field.calculation &&
      (!field.calculation.expression || !field.calculation.dependencies.length)
    ) {
      issues.push({
        code: 'CALCULATION_INCOMPLETE',
        message: '计算字段必须填写表达式并选择至少一个引用字段',
        fieldKey: field.key,
        severity: 'error',
      })
    }
    if (field.type !== 'calculated' && field.calculation) {
      issues.push({
        code: 'CALCULATION_NOT_SUPPORTED',
        message: '非计算字段不能配置计算表达式',
        fieldKey: field.key,
        severity: 'error',
      })
    }
    if (
      field.validation.minLength !== undefined &&
      field.validation.maxLength !== undefined &&
      field.validation.minLength > field.validation.maxLength
    ) {
      issues.push({
        code: 'INVALID_LENGTH_RANGE',
        message: '最小长度不能大于最大长度',
        fieldKey: field.key,
        severity: 'error',
      })
    }
    if (
      field.validation.minimum !== undefined &&
      field.validation.maximum !== undefined &&
      field.validation.minimum > field.validation.maximum
    ) {
      issues.push({
        code: 'INVALID_NUMBER_RANGE',
        message: '最小值不能大于最大值',
        fieldKey: field.key,
        severity: 'error',
      })
    }
    if (field.hidden && field.required) {
      issues.push({
        code: 'HIDDEN_REQUIRED_FIELD',
        message: '永久隐藏字段不能同时设为必填',
        fieldKey: field.key,
        severity: 'error',
      })
    }

    for (const dependency of dependencies(field)) {
      if (!keySet.has(dependency)) {
        issues.push({
          code: 'MISSING_DEPENDENCY',
          message: `引用字段不存在：${dependency}`,
          fieldKey: field.key,
          severity: 'error',
        })
      }
      if (dependency === field.key) {
        issues.push({
          code: 'SELF_DEPENDENCY',
          message: '字段不能引用自身',
          fieldKey: field.key,
          severity: 'error',
        })
      }
    }
    for (const dependency of field.calculation?.dependencies ?? []) {
      const source = definition.fields.find((candidate) => candidate.key === dependency)
      if (source && !calculationSourceTypes.has(source.type)) {
        issues.push({
          code: 'INCOMPATIBLE_CALCULATION_SOURCE',
          message: `计算字段不能引用 ${source.type} 类型字段：${dependency}`,
          fieldKey: field.key,
          severity: 'error',
        })
      }
    }
  }

  for (const section of definition.sections) {
    for (const key of section.fieldKeys) {
      if (!keySet.has(key))
        issues.push({
          code: 'SECTION_FIELD_MISSING',
          message: `分组引用字段不存在：${key}`,
          fieldKey: key,
          severity: 'error',
        })
    }
  }
  issues.push(...cycleIssues(definition))
  return issues
}

export function analyzeFormCompatibility(
  previous: FormDefinition | null,
  next: FormDefinition,
): FormValidationIssue[] {
  if (!previous) return []
  const issues: FormValidationIssue[] = []
  const nextByKey = new Map(next.fields.map((field) => [field.key, field]))

  for (const oldField of previous.fields) {
    const newField = nextByKey.get(oldField.key)
    if (!newField) {
      if (!next.retiredFieldKeys.includes(oldField.key)) {
        issues.push({
          code: 'REMOVED_KEY_NOT_RETIRED',
          message: `删除字段后必须保留停用 Key：${oldField.key}`,
          fieldKey: oldField.key,
          severity: 'error',
        })
      }
      continue
    }
    if (
      oldField.type !== newField.type &&
      !compatibleConversions.has(`${oldField.type}:${newField.type}`)
    ) {
      issues.push({
        code: 'INCOMPATIBLE_FIELD_TYPE',
        message: `字段 ${oldField.key} 不能从 ${oldField.type} 无损转换为 ${newField.type}`,
        fieldKey: oldField.key,
        severity: 'error',
      })
    }
    const nextOptions = new Set(newField.options.map((option) => option.value))
    for (const removed of oldField.options.filter((option) => !nextOptions.has(option.value))) {
      issues.push({
        code: 'OPTION_REMOVED',
        message: `选项 ${removed.label}（${removed.value}）将仅保留用于历史数据`,
        fieldKey: oldField.key,
        severity: 'warning',
      })
    }
  }
  return issues
}
