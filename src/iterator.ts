import { AbstractIterator } from 'abstract-level'
import { buildRangeSQL } from './utils.js'
import type { RangeOptions } from './utils.js'

const PAGE_SIZE = 100

type RawEntry = [string, string]
type MaskedEntry = [string | undefined, string | undefined]
type NextCb = (err: Error | null, key?: string | undefined, value?: string | undefined) => void
type ManyCb = (err: Error | null, entries?: MaskedEntry[]) => void

export class SQLIterator extends AbstractIterator<any, string, string> {
  readonly #d1: D1Database
  readonly #table: string
  readonly #options: RangeOptions & { keys?: boolean; values?: boolean }
  #buffer: RawEntry[] = []
  #finished = false
  #lastKey: string | null = null

  constructor(db: any, d1: D1Database, table: string, options: RangeOptions & { keys?: boolean; values?: boolean }) {
    super(db, options as any)
    this.#d1 = d1
    this.#table = table
    this.#options = options
  }

  _next(callback: NextCb): void {
    if (this.#buffer.length > 0) {
      const [k, v] = this.#mask(this.#buffer.shift()!)
      return callback(null, k, v)
    }
    if (this.#finished) {
      return callback(null)
    }
    this.#fetchPage(PAGE_SIZE).then(() => {
      if (this.#buffer.length > 0) {
        const [k, v] = this.#mask(this.#buffer.shift()!)
        callback(null, k, v)
      } else {
        callback(null)
      }
    }, callback as (err: Error) => void)
  }

  _nextv(size: number, _options: unknown, callback: ManyCb): void {
    const go = (): void => {
      if (this.#buffer.length >= size || this.#finished) {
        return callback(null, this.#buffer.splice(0, size).map(e => this.#mask(e)))
      }
      this.#fetchPage(Math.max(size, PAGE_SIZE)).then(go, callback as (err: Error) => void)
    }
    go()
  }

  async #fetchPage(size: number): Promise<void> {
    const { sql, params } = buildRangeSQL(this.#table, this.#options, this.#lastKey, size)
    const result = await this.#d1.prepare(sql).bind(...params).all<{ key: string; value: string }>()
    const rows = result.results

    if (rows.length < size) this.#finished = true

    if (rows.length > 0) {
      this.#lastKey = rows[rows.length - 1].key
      for (const row of rows) {
        this.#buffer.push([row.key, row.value])
      }
    }
  }

  #mask(entry: RawEntry): MaskedEntry {
    return [
      this.#options.keys !== false ? entry[0] : undefined,
      this.#options.values !== false ? entry[1] : undefined,
    ]
  }
}
