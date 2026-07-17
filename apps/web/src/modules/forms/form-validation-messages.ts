import type { FormDefinition } from '@edc/contracts'
import type { RecordValidationIssue } from '@edc/domain/form-runtime'

type Translate = (key: string, params?: Record<string, unknown>) => string

const messageKeys: Record<string, string> = {
  REQUIRED: 'formRuntime.validation.required',
  INVALID_TEXT_VALUE: 'formRuntime.validation.invalidText',
  INVALID_NUMBER_VALUE: 'formRuntime.validation.invalidNumber',
  INVALID_BOOLEAN_VALUE: 'formRuntime.validation.invalidBoolean',
  INVALID_LIST_VALUE: 'formRuntime.validation.invalidList',
  INVALID_DATE_VALUE: 'formRuntime.validation.invalidDate',
  INVALID_DATETIME_VALUE: 'formRuntime.validation.invalidDateTime',
  MIN_LENGTH: 'formRuntime.validation.minLength',
  MAX_LENGTH: 'formRuntime.validation.maxLength',
  PATTERN: 'formRuntime.validation.pattern',
  INVALID_PATTERN: 'formRuntime.validation.invalidPattern',
  MINIMUM: 'formRuntime.validation.minimum',
  MAXIMUM: 'formRuntime.validation.maximum',
  INVALID_OPTION: 'formRuntime.validation.invalidOption',
  CALCULATION_FAILED: 'formRuntime.validation.calculationFailed',
}

export function formatRecordValidationIssue(
  issue: Pick<RecordValidationIssue, 'fieldKey' | 'code' | 'message' | 'params' | 'customMessage'>,
  definition: FormDefinition,
  t: Translate,
) {
  if (issue.customMessage) return issue.message
  const key = messageKeys[issue.code]
  if (!key) return issue.message
  const field = definition.fields.find((candidate) => candidate.key === issue.fieldKey)
  return t(key, {
    label: field?.label ?? issue.fieldKey,
    minimum: field?.validation.minLength ?? field?.validation.minimum,
    maximum: field?.validation.maxLength ?? field?.validation.maximum,
    ...issue.params,
  })
}
