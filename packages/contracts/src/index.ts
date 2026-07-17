import { z } from 'zod'

export * from './form.js'

export const localeSchema = z.enum(['zh-CN', 'en-US'])
export type AppLocale = z.infer<typeof localeSchema>

export const themeSchema = z.enum(['light', 'dark', 'system'])
export type ThemePreference = z.infer<typeof themeSchema>

export const roleSchema = z.enum([
  'system_admin',
  'study_admin',
  'site_admin',
  'investigator',
  'readonly',
])
export type RoleCode = z.infer<typeof roleSchema>

export const subjectStatusSchema = z.enum([
  'screening',
  'screen_failed',
  'pending_enrollment',
  'enrolled',
  'completed',
  'withdrawn',
  'lost_to_followup',
])
export type SubjectStatus = z.infer<typeof subjectStatusSchema>

export const randomizationMethodSchema = z.enum([
  'simple',
  'permuted_block',
  'stratified_block',
  'minimization',
])
export type RandomizationMethod = z.infer<typeof randomizationMethodSchema>

export const apiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
  requestId: z.string(),
})
export type ApiError = z.infer<typeof apiErrorSchema>
