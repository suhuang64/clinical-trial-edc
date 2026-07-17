import { describe, expect, it } from 'vitest'
import { formDefinitionSchema } from '@edc/contracts'
import { evaluateCalculation, evaluateCondition, validateFormRecord } from './form-runtime.js'

describe('动态表单运行时', () => {
  it('计算表达式只允许白名单运算与函数', () => {
    expect(
      evaluateCalculation('weight / (height * height)', { weight: 70, height: 1.75 }),
    ).toBeCloseTo(22.857)
    expect(
      evaluateCalculation('round(days_between(end_date, start_date))', {
        start_date: '2026-01-01',
        end_date: '2026-01-11',
      }),
    ).toBe(10)
    expect(() => evaluateCalculation('globalThis.process.exit()', {})).toThrow('不支持的字符')
  })

  it('支持 AND 和 OR 条件组', () => {
    expect(
      evaluateCondition(
        {
          logic: 'and',
          rules: [
            { fieldKey: 'age', operator: 'gte', value: 18 },
            { fieldKey: 'eligible', operator: 'eq', value: true },
          ],
        },
        { age: 20, eligible: true },
      ),
    ).toBe(true)
    expect(
      evaluateCondition(
        {
          logic: 'or',
          rules: [
            { fieldKey: 'status', operator: 'eq', value: 'yes' },
            { fieldKey: 'reason', operator: 'is_not_empty' },
          ],
        },
        { status: 'no', reason: '特殊情况' },
      ),
    ).toBe(true)
  })

  it('隐藏字段不参与必填校验并计算只读字段', () => {
    const definition = formDefinitionSchema.parse({
      fields: [
        { key: 'height', type: 'number', label: '身高', required: true },
        { key: 'weight', type: 'number', label: '体重', required: true },
        {
          key: 'reason',
          type: 'text',
          label: '原因',
          required: true,
          visibility: { logic: 'and', rules: [{ fieldKey: 'weight', operator: 'gt', value: 100 }] },
        },
        {
          key: 'bmi',
          type: 'calculated',
          label: 'BMI',
          readOnly: true,
          calculation: {
            expression: 'weight / (height * height)',
            dependencies: ['weight', 'height'],
            resultType: 'number',
          },
        },
      ],
    })
    const valid = validateFormRecord(definition, { height: 1.75, weight: 70 })
    expect(valid.issues).toHaveLength(0)
    expect(valid.values.bmi).toBeCloseTo(22.857)
    expect(valid.visibleFieldKeys).not.toContain('reason')
  })

  it('在后端重新校验必填、类型、范围和选项', () => {
    const definition = formDefinitionSchema.parse({
      fields: [
        {
          key: 'age',
          type: 'number',
          label: '年龄',
          required: true,
          validation: { minimum: 18, maximum: 80 },
        },
        { key: 'group', type: 'select', label: '分组', options: [{ value: 'a', label: 'A' }] },
      ],
    })
    expect(
      validateFormRecord(definition, { age: 12, group: 'missing' }).issues.map(
        (issue) => issue.code,
      ),
    ).toEqual(['MINIMUM', 'INVALID_OPTION'])
    expect(validateFormRecord(definition, {}).issues).toEqual([
      expect.objectContaining({ fieldKey: 'age', code: 'REQUIRED' }),
    ])
  })
})
