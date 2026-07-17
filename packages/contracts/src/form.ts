import { z } from 'zod'

export const formTypeSchema = z.enum([
  'screening',
  'baseline',
  'followup',
  'adverse_event',
  'concomitant_medication',
  'protocol_deviation',
  'endpoint_event',
  'custom',
])
export type FormType = z.infer<typeof formTypeSchema>

export const fieldTypeSchema = z.enum([
  'text',
  'textarea',
  'number',
  'date',
  'datetime',
  'radio',
  'checkbox',
  'select',
  'switch',
  'file',
  'calculated',
  'scale',
  'note',
  'heading',
])
export type FieldType = z.infer<typeof fieldTypeSchema>

export const conditionOperatorSchema = z.enum([
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'not_contains',
  'in',
  'not_in',
  'is_empty',
  'is_not_empty',
])

export const conditionRuleSchema = z.object({
  fieldKey: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  operator: conditionOperatorSchema,
  value: z.unknown().optional(),
})

export const conditionGroupSchema = z.object({
  logic: z.enum(['and', 'or']).default('and'),
  rules: z.array(conditionRuleSchema).min(1).max(50),
})
export type ConditionGroup = z.infer<typeof conditionGroupSchema>

export const fieldOptionSchema = z.object({
  value: z.string().trim().min(1).max(100),
  label: z.string().trim().min(1).max(200),
  disabled: z.boolean().default(false),
})

export const fieldValidationSchema = z.object({
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().positive().optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  minDate: z.string().date().optional(),
  maxDate: z.string().date().optional(),
  pattern: z.string().max(500).optional(),
  message: z.string().max(300).optional(),
})

export const calculationSchema = z.object({
  expression: z.string().trim().max(1000),
  dependencies: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,63}$/)).max(50),
  resultType: z.enum(['number', 'date', 'datetime']),
  expressionVersion: z.number().int().positive().default(1),
})

export const formFieldSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  type: fieldTypeSchema,
  label: z.string().trim().min(1).max(200),
  helpText: z.string().max(500).default(''),
  placeholder: z.string().max(200).default(''),
  unit: z.string().max(50).default(''),
  defaultValue: z.unknown().optional(),
  required: z.boolean().default(false),
  readOnly: z.boolean().default(false),
  hidden: z.boolean().default(false),
  exportable: z.boolean().default(true),
  options: z.array(fieldOptionSchema).max(200).default([]),
  validation: fieldValidationSchema.default({}),
  visibility: conditionGroupSchema.optional(),
  requiredWhen: conditionGroupSchema.optional(),
  calculation: calculationSchema.optional(),
})
export type FormField = z.infer<typeof formFieldSchema>

export const formSectionSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(500).default(''),
  fieldKeys: z.array(z.string()).max(500),
})

export const formDefinitionSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  fields: z.array(formFieldSchema).max(500),
  sections: z.array(formSectionSchema).max(100).default([]),
  retiredFieldKeys: z.array(z.string()).max(2000).default([]),
})
export type FormDefinition = z.infer<typeof formDefinitionSchema>

export const createFormSchema = z.object({
  code: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(200),
  formType: formTypeSchema,
  repeatable: z.boolean().default(false),
  bindVisits: z.boolean().default(false),
  visitIds: z.array(z.string().uuid()).max(100).default([]),
  definition: formDefinitionSchema,
})
export type CreateFormInput = z.infer<typeof createFormSchema>

export const saveFormDraftSchema = createFormSchema.omit({ code: true }).extend({
  code: z.string().trim().min(1).max(80),
})
export type SaveFormDraftInput = z.infer<typeof saveFormDraftSchema>
