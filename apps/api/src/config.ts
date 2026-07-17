import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url))

function integer(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function boolean(value: string | undefined, fallback: boolean) {
  if (value === undefined) return fallback
  return value.toLowerCase() === 'true'
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  host: process.env.HOST ?? '127.0.0.1',
  port: integer(process.env.PORT, 3000),
  databasePath: resolve(workspaceRoot, process.env.DATABASE_PATH ?? 'storage/data/edc.sqlite'),
  uploadRoot: resolve(workspaceRoot, process.env.UPLOAD_ROOT ?? 'storage/uploads'),
  quarantineRoot: resolve(workspaceRoot, process.env.QUARANTINE_ROOT ?? 'storage/quarantine'),
  exportRoot: resolve(workspaceRoot, process.env.EXPORT_ROOT ?? 'storage/exports'),
  sessionCookieName: process.env.SESSION_COOKIE_NAME ?? 'edc_session',
  sessionTtlHours: integer(process.env.SESSION_TTL_HOURS, 12),
  trustProxy: boolean(process.env.TRUST_PROXY, false),
  isProduction: process.env.NODE_ENV === 'production',
} as const
