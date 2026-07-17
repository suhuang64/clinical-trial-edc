import { describe, expect, it } from 'vitest'
import { formDefinitionSchema } from '@edc/contracts'
import { formatRecordValidationIssue } from './form-validation-messages'

const definition = formDefinitionSchema.parse({
  fields: [
    {
      key: 'age',
      type: 'number',
      label: '年龄',
      required: true,
      validation: { minimum: 18 },
    },
  ],
})

const translate = (key: string, params?: Record<string, unknown>) =>
  `${key}:${JSON.stringify(params)}`

describe('formatRecordValidationIssue', () => {
  it('uses a stable validation code and field metadata', () => {
    expect(
      formatRecordValidationIssue(
        { fieldKey: 'age', code: 'MINIMUM', message: '数值不能小于 18' },
        definition,
        translate,
      ),
    ).toContain('formRuntime.validation.minimum')
    expect(
      formatRecordValidationIssue(
        { fieldKey: 'age', code: 'MINIMUM', message: '数值不能小于 18' },
        definition,
        translate,
      ),
    ).toContain('"minimum":18')
  })

  it('preserves a study-defined custom validation message', () => {
    expect(
      formatRecordValidationIssue(
        {
          fieldKey: 'age',
          code: 'MINIMUM',
          message: '研究方案要求年龄不低于 18 岁',
          customMessage: true,
        },
        definition,
        translate,
      ),
    ).toBe('研究方案要求年龄不低于 18 岁')
  })

  it('keeps unknown server validation messages as a safe fallback', () => {
    expect(
      formatRecordValidationIssue(
        { fieldKey: 'age', code: 'CUSTOM_SERVER_RULE', message: 'Fallback message' },
        definition,
        translate,
      ),
    ).toBe('Fallback message')
  })
})
