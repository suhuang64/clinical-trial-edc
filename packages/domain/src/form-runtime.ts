import type { ConditionGroup, FormDefinition, FormField } from '@edc/contracts'

export type FormValue = string | number | boolean | string[] | null
export type FormValueMap = Record<string, FormValue | undefined>

export interface RecordValidationIssue {
  fieldKey: string
  code: string
  message: string
  params?: Record<string, string | number>
  customMessage?: boolean
}

export interface RecordValidationResult {
  values: FormValueMap
  issues: RecordValidationIssue[]
  visibleFieldKeys: string[]
}

type Token = { type: 'number' | 'identifier' | 'operator' | 'punctuation'; value: string }

function compare(left: unknown, right: unknown) {
  if (typeof left === 'number' && typeof right === 'number') return left - right
  return String(left ?? '').localeCompare(String(right ?? ''))
}

function isEmpty(value: unknown) {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  )
}

function evaluateRule(rule: ConditionGroup['rules'][number], values: FormValueMap) {
  const actual = values[rule.fieldKey]
  switch (rule.operator) {
    case 'eq':
      return actual === rule.value
    case 'neq':
      return actual !== rule.value
    case 'gt':
      return compare(actual, rule.value) > 0
    case 'gte':
      return compare(actual, rule.value) >= 0
    case 'lt':
      return compare(actual, rule.value) < 0
    case 'lte':
      return compare(actual, rule.value) <= 0
    case 'contains':
      return Array.isArray(actual)
        ? actual.includes(String(rule.value))
        : String(actual ?? '').includes(String(rule.value ?? ''))
    case 'not_contains':
      return Array.isArray(actual)
        ? !actual.includes(String(rule.value))
        : !String(actual ?? '').includes(String(rule.value ?? ''))
    case 'in':
      return Array.isArray(rule.value) && rule.value.includes(actual)
    case 'not_in':
      return Array.isArray(rule.value) && !rule.value.includes(actual)
    case 'is_empty':
      return isEmpty(actual)
    case 'is_not_empty':
      return !isEmpty(actual)
  }
}

export function evaluateCondition(group: ConditionGroup | undefined, values: FormValueMap) {
  if (!group) return true
  const results = group.rules.map((rule) => evaluateRule(rule, values))
  return group.logic === 'and' ? results.every(Boolean) : results.some(Boolean)
}

export function isFieldVisible(field: FormField, values: FormValueMap) {
  return !field.hidden && evaluateCondition(field.visibility, values)
}

export function isFieldRequired(field: FormField, values: FormValueMap) {
  if (!isFieldVisible(field, values)) return false
  return (
    field.required || Boolean(field.requiredWhen && evaluateCondition(field.requiredWhen, values))
  )
}

function tokenize(expression: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  while (index < expression.length) {
    const rest = expression.slice(index)
    const whitespace = /^\s+/.exec(rest)
    if (whitespace) {
      index += whitespace[0].length
      continue
    }
    const number = /^(?:\d+(?:\.\d+)?|\.\d+)/.exec(rest)
    if (number) {
      tokens.push({ type: 'number', value: number[0] })
      index += number[0].length
      continue
    }
    const identifier = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest)
    if (identifier) {
      tokens.push({ type: 'identifier', value: identifier[0] })
      index += identifier[0].length
      continue
    }
    const character = expression[index]!
    if ('+-*/'.includes(character)) tokens.push({ type: 'operator', value: character })
    else if ('(),'.includes(character)) tokens.push({ type: 'punctuation', value: character })
    else throw new Error(`表达式包含不支持的字符：${character}`)
    index += 1
  }
  return tokens
}

function dateValue(value: unknown) {
  if (typeof value !== 'string') throw new Error('日期函数只能接收日期或日期时间字段')
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error('日期字段值无效')
  return date
}

function callFunction(name: string, args: unknown[]) {
  switch (name) {
    case 'min':
      return Math.min(...args.map(Number))
    case 'max':
      return Math.max(...args.map(Number))
    case 'round':
      return Math.round(Number(args[0]))
    case 'abs':
      return Math.abs(Number(args[0]))
    case 'days_between':
      return Math.round((dateValue(args[0]).getTime() - dateValue(args[1]).getTime()) / 86_400_000)
    case 'add_days': {
      const date = dateValue(args[0])
      date.setUTCDate(date.getUTCDate() + Number(args[1]))
      return date.toISOString()
    }
    default:
      throw new Error(`不支持的计算函数：${name}`)
  }
}

export function evaluateCalculation(expression: string, values: FormValueMap): unknown {
  const tokens = tokenize(expression)
  let cursor = 0

  const current = () => tokens[cursor]
  const matches = (value: string) => current()?.value === value

  function consume(value?: string) {
    const token = tokens[cursor]
    if (!token || (value !== undefined && token.value !== value)) {
      throw new Error(value ? `表达式缺少 ${value}` : '表达式不完整')
    }
    cursor += 1
    return token
  }

  function primary(): unknown {
    const token = current()
    if (!token) throw new Error('表达式不完整')
    if (token.type === 'number') return Number(consume().value)
    if (token.value === '(') {
      consume('(')
      const value = addition()
      consume(')')
      return value
    }
    if (token.type === 'operator' && (token.value === '+' || token.value === '-')) {
      const operator = consume().value
      const value = Number(primary())
      return operator === '-' ? -value : value
    }
    if (token.type === 'identifier') {
      const name = consume().value
      if (matches('(')) {
        consume('(')
        const args: unknown[] = []
        if (!matches(')')) {
          do {
            args.push(addition())
            if (!matches(',')) break
            consume(',')
          } while (!matches(')'))
        }
        consume(')')
        return callFunction(name, args)
      }
      if (!(name in values)) throw new Error(`计算字段缺少引用值：${name}`)
      return values[name]
    }
    throw new Error(`表达式语法错误：${token.value}`)
  }

  function multiplication(): unknown {
    let left = primary()
    while (matches('*') || matches('/')) {
      const operator = consume().value
      const right = Number(primary())
      left = operator === '*' ? Number(left) * right : Number(left) / right
    }
    return left
  }

  function addition(): unknown {
    let left = multiplication()
    while (matches('+') || matches('-')) {
      const operator = consume().value
      const right = Number(multiplication())
      left = operator === '+' ? Number(left) + right : Number(left) - right
    }
    return left
  }

  const result = addition()
  if (cursor !== tokens.length) throw new Error(`表达式包含多余内容：${tokens[cursor]!.value}`)
  if (typeof result === 'number' && !Number.isFinite(result))
    throw new Error('计算结果不是有限数值')
  return result
}

function validateValue(field: FormField, value: FormValue | undefined): RecordValidationIssue[] {
  if (isEmpty(value)) return []
  const issue = (
    code: string,
    message: string,
    params?: Record<string, string | number>,
    customMessage = false,
  ): RecordValidationIssue[] => [
    {
      fieldKey: field.key,
      code,
      message,
      ...(params ? { params } : {}),
      ...(customMessage ? { customMessage: true } : {}),
    },
  ]
  if (
    ['text', 'textarea', 'radio', 'select', 'scale'].includes(field.type) &&
    typeof value !== 'string'
  ) {
    return issue('INVALID_TEXT_VALUE', '请输入文本值')
  }
  if (field.type === 'number' && typeof value !== 'number')
    return issue('INVALID_NUMBER_VALUE', '请输入有效数字')
  if (field.type === 'switch' && typeof value !== 'boolean')
    return issue('INVALID_BOOLEAN_VALUE', '请输入有效开关值')
  if (
    ['checkbox', 'file'].includes(field.type) &&
    (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
  ) {
    return issue('INVALID_LIST_VALUE', '请输入有效的多值列表')
  }
  if (field.type === 'date' && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))) {
    return issue('INVALID_DATE_VALUE', '请输入 YYYY-MM-DD 格式的日期')
  }
  if (
    field.type === 'datetime' &&
    (typeof value !== 'string' || Number.isNaN(new Date(value).getTime()))
  ) {
    return issue('INVALID_DATETIME_VALUE', '请输入有效的日期时间')
  }
  if (typeof value === 'string') {
    if (field.validation.minLength !== undefined && value.length < field.validation.minLength) {
      return issue(
        'MIN_LENGTH',
        field.validation.message || `至少输入 ${field.validation.minLength} 个字符`,
        { minimum: field.validation.minLength },
        Boolean(field.validation.message),
      )
    }
    if (field.validation.maxLength !== undefined && value.length > field.validation.maxLength) {
      return issue(
        'MAX_LENGTH',
        field.validation.message || `最多输入 ${field.validation.maxLength} 个字符`,
        { maximum: field.validation.maxLength },
        Boolean(field.validation.message),
      )
    }
    if (field.validation.pattern) {
      try {
        if (!new RegExp(field.validation.pattern).test(value))
          return issue(
            'PATTERN',
            field.validation.message || '输入格式不正确',
            undefined,
            Boolean(field.validation.message),
          )
      } catch {
        return issue('INVALID_PATTERN', '字段正则表达式无效')
      }
    }
  }
  if (typeof value === 'number') {
    if (field.validation.minimum !== undefined && value < field.validation.minimum) {
      return issue(
        'MINIMUM',
        field.validation.message || `数值不能小于 ${field.validation.minimum}`,
        { minimum: field.validation.minimum },
        Boolean(field.validation.message),
      )
    }
    if (field.validation.maximum !== undefined && value > field.validation.maximum) {
      return issue(
        'MAXIMUM',
        field.validation.message || `数值不能大于 ${field.validation.maximum}`,
        { maximum: field.validation.maximum },
        Boolean(field.validation.message),
      )
    }
  }
  if (['radio', 'select', 'scale'].includes(field.type)) {
    const option = field.options.find((candidate) => candidate.value === value)
    if (!option || option.disabled) return issue('INVALID_OPTION', '所选选项不可用')
  }
  if (field.type === 'checkbox') {
    const allowed = new Set(
      field.options.filter((option) => !option.disabled).map((option) => option.value),
    )
    if ((value as string[]).some((item) => !allowed.has(item)))
      return issue('INVALID_OPTION', '包含不可用选项')
  }
  return []
}

export function validateFormRecord(
  definition: FormDefinition,
  input: FormValueMap,
): RecordValidationResult {
  const values: FormValueMap = { ...input }
  const issues: RecordValidationIssue[] = []

  for (const field of definition.fields.filter((candidate) => candidate.type === 'calculated')) {
    if (!field.calculation) continue
    try {
      const result = evaluateCalculation(field.calculation.expression, values)
      if (field.calculation.resultType === 'number') values[field.key] = Number(result)
      else if (field.calculation.resultType === 'date')
        values[field.key] = dateValue(result).toISOString().slice(0, 10)
      else values[field.key] = dateValue(result).toISOString()
    } catch (error) {
      issues.push({
        fieldKey: field.key,
        code: 'CALCULATION_FAILED',
        message: (error as Error).message,
      })
    }
  }

  const visibleFields = definition.fields.filter((field) => isFieldVisible(field, values))
  for (const field of visibleFields) {
    if (['heading', 'note', 'calculated'].includes(field.type)) continue
    const value = values[field.key]
    if (isFieldRequired(field, values) && isEmpty(value)) {
      issues.push({
        fieldKey: field.key,
        code: 'REQUIRED',
        message: `${field.label}为必填项`,
        params: { label: field.label },
      })
      continue
    }
    issues.push(...validateValue(field, value))
  }
  return { values, issues, visibleFieldKeys: visibleFields.map((field) => field.key) }
}
