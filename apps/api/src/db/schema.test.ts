import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { initializeSchema } from './schema.js'

const siteScopedTables = [
  'membership_sites',
  'subjects',
  'data_records',
  'randomization_assignments',
  'uploaded_files',
  'subject_events',
  'export_jobs',
] as const

describe('latest database schema', () => {
  let sqlite: Database.Database | undefined

  afterEach(() => sqlite?.close())

  it('creates only the current UUID-based site relationships', () => {
    sqlite = new Database(':memory:')
    sqlite.pragma('foreign_keys = ON')
    initializeSchema(sqlite)

    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name)
    expect(tables).not.toContain('schema_migrations')

    for (const table of siteScopedTables) {
      const columns = sqlite
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => (row as { name: string }).name)
      expect(columns, table).toContain('site_id')
      expect(columns, table).not.toContain('site_name')
    }

    const auditColumns = sqlite
      .prepare('PRAGMA table_info(audit_events)')
      .all()
      .map((row) => (row as { name: string }).name)
    expect(auditColumns).toContain('site_id')
    expect(auditColumns).toContain('site_name_snapshot')
    expect(auditColumns).not.toContain('site_name')
    expect(sqlite.pragma('foreign_key_check')).toEqual([])
  })

  it('rejects an old name-keyed site schema instead of migrating it', () => {
    sqlite = new Database(':memory:')
    sqlite.exec(`
      CREATE TABLE sites (
        name TEXT PRIMARY KEY,
        study_id TEXT NOT NULL,
        principal_investigator TEXT,
        enrollment_target INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `)

    expect(() => initializeSchema(sqlite!)).toThrow('Database schema is outdated')
  })
})
