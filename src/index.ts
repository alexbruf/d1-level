import { AbstractLevel } from 'abstract-level'
import { SQLIterator } from './iterator.js'
import { buildClearSQL } from './utils.js'
import type { RangeOptions } from './utils.js'

export interface D1LevelOptions {
  /** Cloudflare D1 database binding from Worker env */
  d1: D1Database
  /** Table name prefix. Empty (default) → table 'kv'; 'tina' → table 'tina_kv' */
  namespace?: string
  /** Auto-create table on open. Default: true */
  createTable?: boolean
  [key: string]: unknown
}

type Cb = (err: Error | null) => void

export class D1Level extends AbstractLevel<string, string, string> {
  readonly #d1: D1Database
  readonly #table: string
  readonly #createTable: boolean

  constructor(options: D1LevelOptions) {
    const { d1, namespace, createTable = true, ...rest } = options
    super({ encodings: { utf8: true }, snapshots: false }, rest)
    this.#d1 = d1
    this.#table = namespace ? `${namespace}_kv` : 'kv'
    this.#createTable = createTable
  }

  _open(options: unknown, callback: Cb): void {
    if (!this.#createTable) return callback(null)
    this.#d1
      .exec(`CREATE TABLE IF NOT EXISTS "${this.#table}" (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`)
      .then(() => callback(null), callback)
  }

  _get(key: string, _options: unknown, callback: (err: Error | null, value?: string) => void): void {
    this.#d1
      .prepare(`SELECT value FROM "${this.#table}" WHERE key = ?`)
      .bind(key)
      .first<{ value: string }>()
      .then(row => {
        if (row == null) callback(notFound(key))
        else callback(null, row.value)
      }, callback)
  }

  _getMany(keys: string[], _options: unknown, callback: (err: Error | null, values?: Array<string | undefined>) => void): void {
    if (keys.length === 0) return callback(null, [])
    const placeholders = keys.map(() => '?').join(', ')
    this.#d1
      .prepare(`SELECT key, value FROM "${this.#table}" WHERE key IN (${placeholders})`)
      .bind(...keys)
      .all<{ key: string; value: string }>()
      .then(result => {
        const map = new Map(result.results.map(r => [r.key, r.value]))
        callback(null, keys.map(k => map.get(k)))
      }, callback)
  }

  _put(key: string, value: string, _options: unknown, callback: Cb): void {
    this.#d1
      .prepare(`INSERT OR REPLACE INTO "${this.#table}" (key, value) VALUES (?, ?)`)
      .bind(key, value)
      .run()
      .then(() => callback(null), callback)
  }

  _del(key: string, _options: unknown, callback: Cb): void {
    this.#d1
      .prepare(`DELETE FROM "${this.#table}" WHERE key = ?`)
      .bind(key)
      .run()
      .then(() => callback(null), callback)
  }

  _batch(
    operations: Array<{ type: 'put' | 'del'; key: string; value?: string }>,
    _options: unknown,
    callback: Cb
  ): void {
    if (operations.length === 0) return callback(null)
    const stmts = operations.map(op =>
      op.type === 'put'
        ? this.#d1.prepare(`INSERT OR REPLACE INTO "${this.#table}" (key, value) VALUES (?, ?)`).bind(op.key, op.value!)
        : this.#d1.prepare(`DELETE FROM "${this.#table}" WHERE key = ?`).bind(op.key)
    )
    this.#d1.batch(stmts).then(() => callback(null), callback)
  }

  _clear(options: RangeOptions, callback: Cb): void {
    const { sql, params } = buildClearSQL(this.#table, options)
    const stmt = params.length > 0
      ? this.#d1.prepare(sql).bind(...params)
      : this.#d1.prepare(sql)
    stmt.run().then(() => callback(null), callback)
  }

  _iterator(options: unknown): SQLIterator {
    return new SQLIterator(this, this.#d1, this.#table, options as any)
  }
}

function notFound(key: string): Error {
  const err = new Error(`Key ${key} was not found`)
  ;(err as any).code = 'LEVEL_NOT_FOUND'
  return err
}
