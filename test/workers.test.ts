/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database
  }
}
import { D1Level } from '../src/index.js'

/** Each call gets an isolated table via a unique namespace. */
let ns = 0
function makeDB(): D1Level {
  return new D1Level({ d1: env.DB, namespace: `w${ns++}` })
}

async function withDB(fn: (db: D1Level) => Promise<void>): Promise<void> {
  const db = makeDB()
  await db.open()
  try {
    await fn(db)
  } finally {
    await db.close()
  }
}

async function collect(iter: AsyncIterable<[string, string]>): Promise<Array<[string, string]>> {
  const results: Array<[string, string]> = []
  for await (const e of iter) results.push(e)
  return results
}

describe('D1Level (Workers runtime / real D1)', () => {
  it('put and get', async () => {
    await withDB(async db => {
      await db.put('hello', 'world')
      expect(await db.get('hello')).toBe('world')
    })
  })

  it('LEVEL_NOT_FOUND for missing key', async () => {
    await withDB(async db => {
      await expect(db.get('nope')).rejects.toMatchObject({ code: 'LEVEL_NOT_FOUND' })
    })
  })

  it('del', async () => {
    await withDB(async db => {
      await db.put('k', 'v')
      await db.del('k')
      await expect(db.get('k')).rejects.toMatchObject({ code: 'LEVEL_NOT_FOUND' })
    })
  })

  it('getMany', async () => {
    await withDB(async db => {
      await db.put('a', '1')
      await db.put('b', '2')
      expect(await db.getMany(['b', 'a', 'missing'])).toEqual(['2', '1', undefined])
    })
  })

  it('batch put + del', async () => {
    await withDB(async db => {
      await db.put('old', 'x')
      await db.batch([
        { type: 'put', key: 'a', value: '1' },
        { type: 'del', key: 'old' },
      ])
      expect(await db.get('a')).toBe('1')
      await expect(db.get('old')).rejects.toMatchObject({ code: 'LEVEL_NOT_FOUND' })
    })
  })

  it('iterator - ascending order', async () => {
    await withDB(async db => {
      await db.batch(
        ['c', 'a', 'b'].map((k, i) => ({ type: 'put' as const, key: k, value: `${i}` }))
      )
      const keys = (await collect(db.iterator() as any)).map(([k]) => k)
      expect(keys).toEqual(['a', 'b', 'c'])
    })
  })

  it('iterator - gte + lte range', async () => {
    await withDB(async db => {
      await db.batch(
        ['a', 'b', 'c', 'd', 'e'].map((k, i) => ({ type: 'put' as const, key: k, value: `${i}` }))
      )
      const keys = (await collect(db.iterator({ gte: 'b', lte: 'd' }) as any)).map(([k]) => k)
      expect(keys).toEqual(['b', 'c', 'd'])
    })
  })

  it('iterator - reverse + limit', async () => {
    await withDB(async db => {
      await db.batch(
        ['a', 'b', 'c', 'd', 'e'].map((k, i) => ({ type: 'put' as const, key: k, value: `${i}` }))
      )
      const keys = (await collect(db.iterator({ reverse: true, limit: 3 }) as any)).map(([k]) => k)
      expect(keys).toEqual(['e', 'd', 'c'])
    })
  })

  it('clear', async () => {
    await withDB(async db => {
      await db.batch(
        ['a', 'b', 'c'].map((k, i) => ({ type: 'put' as const, key: k, value: `${i}` }))
      )
      await db.clear({ gte: 'a', lte: 'b' })
      const keys = (await collect(db.iterator() as any)).map(([k]) => k)
      expect(keys).toEqual(['c'])
    })
  })

  it('sublevel isolation', async () => {
    await withDB(async db => {
      const sub = db.sublevel('s')
      await sub.put('key', 'sub')
      await db.put('key', 'root')
      expect(await sub.get('key')).toBe('sub')
      expect(await db.get('key')).toBe('root')
    })
  })

  it('namespace isolation', async () => {
    const d1 = env.DB
    const db1 = new D1Level({ d1, namespace: `iso1_${ns}` })
    const db2 = new D1Level({ d1, namespace: `iso2_${ns++}` })
    await db1.open()
    await db2.open()
    await db1.put('k', 'from-db1')
    await expect(db2.get('k')).rejects.toMatchObject({ code: 'LEVEL_NOT_FOUND' })
    await db1.close()
    await db2.close()
  })
})
