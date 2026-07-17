import type Database from 'better-sqlite3'

export type CounterType = 'screening' | 'subject' | 'randomization'

export interface CounterRule {
  prefix: string
  padLength: number
  currentValue: number
}

export type CounterConfiguration = Record<CounterType, CounterRule>

export interface NumberingRepository {
  getConfiguration(studyId: string): CounterConfiguration
  updateConfiguration(
    studyId: string,
    rules: Record<CounterType, Omit<CounterRule, 'currentValue'>>,
  ): { before: CounterConfiguration; after: CounterConfiguration }
  allocateNextNumber(studyId: string, type: CounterType): string
}

export class NumberingRuleFrozenError extends Error {
  constructor(
    readonly counterType: CounterType,
    readonly currentValue: number,
  ) {
    super(`Counter rule ${counterType} is frozen after ${currentValue} allocations`)
  }
}

const defaults: CounterConfiguration = {
  screening: { prefix: 'SCR-', padLength: 4, currentValue: 0 },
  subject: { prefix: 'SUB-', padLength: 4, currentValue: 0 },
  randomization: { prefix: 'RND-', padLength: 4, currentValue: 0 },
}

export class SqliteNumberingRepository implements NumberingRepository {
  constructor(private readonly database: Database.Database) {}

  getConfiguration(studyId: string): CounterConfiguration {
    const configuration = structuredClone(defaults)
    const rows = this.database
      .prepare(
        `SELECT counter_type, current_value, prefix, pad_length
         FROM study_counters WHERE study_id = ? ORDER BY counter_type`,
      )
      .all(studyId) as Array<{
      counter_type: CounterType
      current_value: number
      prefix: string
      pad_length: number
    }>
    for (const row of rows)
      configuration[row.counter_type] = {
        prefix: row.prefix,
        padLength: row.pad_length,
        currentValue: row.current_value,
      }
    return configuration
  }

  updateConfiguration(
    studyId: string,
    rules: Record<CounterType, Omit<CounterRule, 'currentValue'>>,
  ) {
    const before = this.getConfiguration(studyId)
    for (const type of ['screening', 'subject', 'randomization'] as const) {
      const current = before[type]
      const next = rules[type]
      if (
        current.currentValue > 0 &&
        (current.prefix !== next.prefix || current.padLength !== next.padLength)
      )
        throw new NumberingRuleFrozenError(type, current.currentValue)
    }
    const upsert = this.database.prepare(
      `INSERT INTO study_counters
       (study_id, counter_type, current_value, prefix, pad_length)
       VALUES (?, ?, 0, ?, ?)
       ON CONFLICT(study_id, counter_type) DO UPDATE SET
         prefix = excluded.prefix, pad_length = excluded.pad_length`,
    )
    this.database.transaction(() => {
      for (const type of ['screening', 'subject', 'randomization'] as const)
        upsert.run(studyId, type, rules[type].prefix, rules[type].padLength)
    })()
    return { before, after: this.getConfiguration(studyId) }
  }

  allocateNextNumber(studyId: string, type: CounterType) {
    this.database
      .prepare(
        `INSERT OR IGNORE INTO study_counters
         (study_id, counter_type, current_value, prefix, pad_length)
         VALUES (?, ?, 0, ?, ?)`,
      )
      .run(studyId, type, defaults[type].prefix, defaults[type].padLength)
    this.database
      .prepare(
        `UPDATE study_counters SET current_value = current_value + 1
         WHERE study_id = ? AND counter_type = ?`,
      )
      .run(studyId, type)
    const counter = this.database
      .prepare(
        `SELECT current_value, prefix, pad_length FROM study_counters
         WHERE study_id = ? AND counter_type = ?`,
      )
      .get(studyId, type) as { current_value: number; prefix: string; pad_length: number }
    return `${counter.prefix}${String(counter.current_value).padStart(counter.pad_length, '0')}`
  }
}
