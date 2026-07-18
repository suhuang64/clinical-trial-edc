import { describe, expect, it } from 'vitest'
import type { FormDefinition } from '@edc/contracts'
import { analyzeFormCompatibility, validateFormDefinition } from './form-validation.js'

function definition(
  fields: FormDefinition['fields'],
  retiredFieldKeys: string[] = [],
): FormDefinition {
  return { schemaVersion: 1, fields, sections: [], retiredFieldKeys }
}

function numberField(key: string): FormDefinition['fields'][number] {
  return {
    key,
    type: 'number',
    label: key,
    helpText: '',
    placeholder: '',
    unit: '',
    required: false,
    readOnly: false,
    hidden: false,
    exportable: true,
    randomizationFactor: false,
    options: [],
    validation: {},
  }
}

describe('动态表单发布校验', () => {
  it('拒绝条件和计算依赖形成的循环', () => {
    const form = definition([
      {
        ...numberField('field_a'),
        visibility: { logic: 'and', rules: [{ fieldKey: 'field_b', operator: 'gt', value: 0 }] },
      },
      {
        ...numberField('field_b'),
        type: 'calculated',
        readOnly: true,
        calculation: {
          expression: 'field_a + 1',
          dependencies: ['field_a'],
          resultType: 'number',
          expressionVersion: 1,
        },
      },
    ])
    expect(validateFormDefinition(form)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'DEPENDENCY_CYCLE', severity: 'error' }),
      ]),
    )
  })

  it('拒绝计算字段引用文本字段', () => {
    const form = definition([
      { ...numberField('diagnosis'), type: 'text' },
      {
        ...numberField('score'),
        type: 'calculated',
        readOnly: true,
        calculation: {
          expression: 'diagnosis',
          dependencies: ['diagnosis'],
          resultType: 'number',
          expressionVersion: 1,
        },
      },
    ])
    expect(validateFormDefinition(form)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'INCOMPATIBLE_CALCULATION_SOURCE' }),
      ]),
    )
  })

  it('允许文本和多行文本之间无损转换', () => {
    const previous = definition([{ ...numberField('comment'), type: 'text' }])
    const next = definition([{ ...numberField('comment'), type: 'textarea' }])
    expect(
      analyzeFormCompatibility(previous, next).filter((issue) => issue.severity === 'error'),
    ).toHaveLength(0)
  })

  it('拒绝字段类型破坏性转换和已删除 key 复用', () => {
    const previous = definition([{ ...numberField('age') }])
    const incompatible = definition([{ ...numberField('age'), type: 'date' }])
    expect(analyzeFormCompatibility(previous, incompatible)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'INCOMPATIBLE_FIELD_TYPE' })]),
    )
    expect(
      validateFormDefinition(definition([{ ...numberField('old_key') }], ['old_key'])),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'RETIRED_KEY_REUSED' })]))
  })
})
