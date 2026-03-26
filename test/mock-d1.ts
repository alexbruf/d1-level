/// <reference types="@cloudflare/workers-types" />
/**
 * In-memory D1Database mock backed by better-sqlite3.
 *
 * Covers the D1 surface used by d1-level:
 *   db.prepare(sql).bind(...).first<T>()
 *   db.prepare(sql).bind(...).all<T>()
 *   db.prepare(sql).bind(...).run()
 *   db.prepare(sql).run()        (no params)
 *   db.exec(sql)
 *   db.batch([stmt, ...])
 */
import Database from 'better-sqlite3'

const kDB = Symbol('db')
const kSQL = Symbol('sql')
const kParams = Symbol('params')

const META = {
  changed_db: false, changes: 0, duration: 0,
  last_row_id: 0, rows_read: 0, rows_written: 0, size_after: 0,
} satisfies D1Result['meta']

function mockResult(info?: Database.RunResult): D1Result {
  return {
    success: true,
    meta: { ...META, changed_db: true, changes: info?.changes ?? 0, last_row_id: info?.lastInsertRowid as number ?? 0 },
    results: [],
  }
}

class MockStatement {
  readonly [kDB]: Database.Database
  readonly [kSQL]: string
  readonly [kParams]: unknown[]

  constructor(db: Database.Database, sql: string, params: unknown[]) {
    this[kDB] = db
    this[kSQL] = sql
    this[kParams] = params
  }

  bind(...values: unknown[]): MockStatement {
    return new MockStatement(this[kDB], this[kSQL], [...this[kParams], ...values])
  }

  async first<T = Record<string, unknown>>(col?: string): Promise<T | null> {
    const row = this[kDB].prepare(this[kSQL]).get(...this[kParams]) as Record<string, unknown> | undefined
    if (row == null) return null
    return (col !== undefined ? (row[col] ?? null) : row) as T
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const rows = this[kDB].prepare(this[kSQL]).all(...this[kParams]) as T[]
    return { success: true, meta: META, results: rows }
  }

  async run(): Promise<D1Result> {
    const info = this[kDB].prepare(this[kSQL]).run(...this[kParams])
    return mockResult(info)
  }

  async raw<T extends unknown[] = unknown[]>(): Promise<T[]> {
    return this[kDB].prepare(this[kSQL]).raw().all(...this[kParams]) as T[]
  }

  /** Synchronous run used inside batch transactions. */
  _runSync(): void {
    this[kDB].prepare(this[kSQL]).run(...this[kParams])
  }
}

export function createD1Mock(sqlite?: Database.Database): D1Database {
  const db = sqlite ?? new Database(':memory:')

  return {
    prepare(sql: string) {
      return new MockStatement(db, sql, []) as unknown as D1PreparedStatement
    },

    async exec(sql: string): Promise<D1ExecResult> {
      db.exec(sql)
      return { count: 1, duration: 0 }
    },

    async batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      const results: D1Result<T>[] = []
      db.transaction(() => {
        for (const stmt of statements as unknown as MockStatement[]) {
          stmt._runSync()
          results.push({ success: true, meta: META, results: [] } as D1Result<T>)
        }
      })()
      return results
    },

    async dump(): Promise<ArrayBuffer> {
      return new ArrayBuffer(0)
    },

    withSession() {
      throw new Error('withSession not implemented in mock')
    },
  } as unknown as D1Database
}
