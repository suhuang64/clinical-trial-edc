import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import { config } from '../config.js'
import { runMigrations } from './migrate.js'
import type { DatabaseSchema } from './types.js'
import { SqliteNumberingRepository } from './repositories/numbering-repository.js'

mkdirSync(dirname(config.databasePath), { recursive: true })

export const sqlite = new Database(config.databasePath)
sqlite.pragma('foreign_keys = ON')
sqlite.pragma('journal_mode = WAL')
sqlite.pragma('busy_timeout = 5000')
sqlite.pragma('synchronous = NORMAL')
runMigrations(sqlite)

export const db = new Kysely<DatabaseSchema>({ dialect: new SqliteDialect({ database: sqlite }) })
export const numberingRepository = new SqliteNumberingRepository(sqlite)

export async function closeDatabase() {
  await db.destroy()
}
