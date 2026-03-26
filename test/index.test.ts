import { describe, it, expect } from 'vitest'
import { createD1Mock } from './mock-d1.js'
import { D1Level } from '../src/index.js'

function makeDB(): D1Level {
  // Each call gets a fresh in-memory SQLite database → full isolation
  return new D1Level({ d1: createD1Mock() })
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
  for await (const entry of iter) results.push(entry)
  return results
}

// ─── put / get / del ───────────────────────────────────────────────────────

describe('put / get / del', () => {
  it('puts and gets a value', async () => {
    await withDB(async db => {
      await db.put('hello', 'world')
      expect(await db.get('hello')).toBe('world')
    })
  })

  it('overwrites an existing key', async () => {
    await withDB(async db => {
      await db.put('k', 'v1')
      await db.put('k', 'v2')
      expect(await db.get('k')).toBe('v2')
    })
  })

  it('throws LEVEL_NOT_FOUND for a missing key', async () => {
    await withDB(async db => {
      await expect(db.get('nope')).rejects.toMatchObject({ code: 'LEVEL_NOT_FOUND' })
    })
  })

  it('deletes a key', async () => {
    await withDB(async db => {
      await db.put('x', 'y')
      await db.del('x')
      await expect(db.get('x')).rejects.toMatchObject({ code: 'LEVEL_NOT_FOUND' })
    })
  })

  it('del on a missing key does not throw', async () => {
    await withDB(async db => {
      await expect(db.del('nonexistent')).resolves.toBeUndefined()
    })
  })
})

// ─── getMany ───────────────────────────────────────────────────────────────

describe('getMany', () => {
  it('returns values in key order with undefined for missing', async () => {
    await withDB(async db => {
      await db.put('a', '1')
      await db.put('b', '2')
      await db.put('c', '3')
      expect(await db.getMany(['c', 'a', 'missing', 'b'])).toEqual(['3', '1', undefined, '2'])
    })
  })

  it('returns empty array for empty key list', async () => {
    await withDB(async db => {
      expect(await db.getMany([])).toEqual([])
    })
  })
})

// ─── batch ─────────────────────────────────────────────────────────────────

describe('batch', () => {
  it('executes put and del atomically', async () => {
    await withDB(async db => {
      await db.put('existing', 'old')
      await db.batch([
        { type: 'put', key: 'a', value: '1' },
        { type: 'put', key: 'b', value: '2' },
        { type: 'del', key: 'existing' },
      ])
      expect(await db.get('a')).toBe('1')
      expect(await db.get('b')).toBe('2')
      await expect(db.get('existing')).rejects.toMatchObject({ code: 'LEVEL_NOT_FOUND' })
    })
  })

  it('empty batch does nothing', async () => {
    await withDB(async db => {
      await expect(db.batch([])).resolves.toBeUndefined()
    })
  })
})

// ─── iterator — basic ──────────────────────────────────────────────────────

describe('iterator — basic', () => {
  it('iterates all entries in ascending order', async () => {
    await withDB(async db => {
      await db.batch([
        { type: 'put', key: 'c', value: '3' },
        { type: 'put', key: 'a', value: '1' },
        { type: 'put', key: 'b', value: '2' },
      ])
      expect(await collect(db.iterator() as any)).toEqual([['a', '1'], ['b', '2'], ['c', '3']])
    })
  })

  it('returns empty when database is empty', async () => {
    await withDB(async db => {
      expect(await collect(db.iterator() as any)).toEqual([])
    })
  })
})

// ─── iterator — range bounds ───────────────────────────────────────────────

describe('iterator — range bounds', () => {
  async function withKeys(fn: (db: D1Level) => Promise<void>): Promise<void> {
    await withDB(async db => {
      await db.batch(
        ['a', 'b', 'c', 'd', 'e'].map((k, i) => ({ type: 'put' as const, key: k, value: `${i + 1}` }))
      )
      await fn(db)
    })
  }

  const keys = (entries: Array<[string, string]>) => entries.map(([k]) => k)

  it('gte', () => withKeys(async db => {
    expect(keys(await collect(db.iterator({ gte: 'b' }) as any))).toEqual(['b', 'c', 'd', 'e'])
  }))

  it('gt', () => withKeys(async db => {
    expect(keys(await collect(db.iterator({ gt: 'b' }) as any))).toEqual(['c', 'd', 'e'])
  }))

  it('lte', () => withKeys(async db => {
    expect(keys(await collect(db.iterator({ lte: 'c' }) as any))).toEqual(['a', 'b', 'c'])
  }))

  it('lt', () => withKeys(async db => {
    expect(keys(await collect(db.iterator({ lt: 'c' }) as any))).toEqual(['a', 'b'])
  }))

  it('gte + lte', () => withKeys(async db => {
    expect(keys(await collect(db.iterator({ gte: 'b', lte: 'd' }) as any))).toEqual(['b', 'c', 'd'])
  }))

  it('gt + lt', () => withKeys(async db => {
    expect(keys(await collect(db.iterator({ gt: 'a', lt: 'e' }) as any))).toEqual(['b', 'c', 'd'])
  }))
})

// ─── iterator — reverse ────────────────────────────────────────────────────

describe('iterator — reverse', () => {
  it('iterates in descending order', async () => {
    await withDB(async db => {
      await db.batch(
        ['a', 'b', 'c', 'd', 'e'].map((k, i) => ({ type: 'put' as const, key: k, value: `${i + 1}` }))
      )
      const keys = (await collect(db.iterator({ reverse: true }) as any)).map(([k]: [string, string]) => k)
      expect(keys).toEqual(['e', 'd', 'c', 'b', 'a'])
    })
  })

  it('reverse with range', async () => {
    await withDB(async db => {
      await db.batch(
        ['a', 'b', 'c', 'd', 'e'].map((k, i) => ({ type: 'put' as const, key: k, value: `${i + 1}` }))
      )
      const keys = (await collect(db.iterator({ gte: 'b', lte: 'e', reverse: true }) as any)).map(([k]: [string, string]) => k)
      expect(keys).toEqual(['e', 'd', 'c', 'b'])
    })
  })
})

// ─── iterator — limit ──────────────────────────────────────────────────────

describe('iterator — limit', () => {
  it('respects limit', async () => {
    await withDB(async db => {
      await db.batch(
        ['a', 'b', 'c', 'd', 'e'].map((k, i) => ({ type: 'put' as const, key: k, value: `${i + 1}` }))
      )
      const keys = (await collect(db.iterator({ limit: 3 }) as any)).map(([k]: [string, string]) => k)
      expect(keys).toEqual(['a', 'b', 'c'])
    })
  })

  it('reverse + range + limit', async () => {
    await withDB(async db => {
      await db.batch(
        ['a', 'b', 'c', 'd', 'e'].map((k, i) => ({ type: 'put' as const, key: k, value: `${i + 1}` }))
      )
      const keys = (await collect(db.iterator({ gte: 'b', lte: 'e', reverse: true, limit: 2 }) as any)).map(([k]: [string, string]) => k)
      expect(keys).toEqual(['e', 'd'])
    })
  })
})

// ─── iterator — pagination ─────────────────────────────────────────────────

describe('iterator — pagination (> PAGE_SIZE = 100)', () => {
  it('correctly iterates 200 entries', async () => {
    await withDB(async db => {
      const ops = Array.from({ length: 200 }, (_, i) => ({
        type: 'put' as const,
        key: String(i).padStart(3, '0'),
        value: `v${i}`,
      }))
      // Insert in batches to avoid SQLite variable limit (~999)
      for (let i = 0; i < ops.length; i += 50) {
        await db.batch(ops.slice(i, i + 50))
      }
      const keys = (await collect(db.iterator() as any)).map(([k]: [string, string]) => k)
      expect(keys).toHaveLength(200)
      expect(keys[0]).toBe('000')
      expect(keys[199]).toBe('199')
    })
  })
})

// ─── iterator — keys / values options ─────────────────────────────────────

describe('iterator — keys / values options', () => {
  it('keys: false returns only values', async () => {
    await withDB(async db => {
      await db.put('a', '1')
      await db.put('b', '2')
      const entries = await collect(db.iterator({ keys: false }) as any)
      expect(entries).toEqual([[undefined, '1'], [undefined, '2']])
    })
  })

  it('values: false returns only keys', async () => {
    await withDB(async db => {
      await db.put('a', '1')
      await db.put('b', '2')
      const entries = await collect(db.iterator({ values: false }) as any)
      expect(entries).toEqual([['a', undefined], ['b', undefined]])
    })
  })
})

// ─── clear ─────────────────────────────────────────────────────────────────

describe('clear', () => {
  async function withKeys(fn: (db: D1Level) => Promise<void>): Promise<void> {
    await withDB(async db => {
      await db.batch(
        ['a', 'b', 'c', 'd', 'e'].map((k, i) => ({ type: 'put' as const, key: k, value: `${i + 1}` }))
      )
      await fn(db)
    })
  }

  const keys = (entries: Array<[string, string]>) => entries.map(([k]) => k)

  it('clears all entries', () => withKeys(async db => {
    await db.clear()
    expect(await collect(db.iterator() as any)).toEqual([])
  }))

  it('clears a gte + lte range', () => withKeys(async db => {
    await db.clear({ gte: 'b', lte: 'd' })
    expect(keys(await collect(db.iterator() as any))).toEqual(['a', 'e'])
  }))

  it('clears with gt + lt', () => withKeys(async db => {
    await db.clear({ gt: 'a', lt: 'e' })
    expect(keys(await collect(db.iterator() as any))).toEqual(['a', 'e'])
  }))

  it('clears with limit', () => withKeys(async db => {
    await db.clear({ limit: 2 })
    expect(keys(await collect(db.iterator() as any))).toEqual(['c', 'd', 'e'])
  }))
})

// ─── sublevel ──────────────────────────────────────────────────────────────

describe('sublevel', () => {
  it('namespaces keys so they do not collide with parent', async () => {
    await withDB(async db => {
      const sub = db.sublevel('prefix')
      await sub.put('key', 'subval')
      await db.put('key', 'parentval')
      expect(await sub.get('key')).toBe('subval')
      expect(await db.get('key')).toBe('parentval')
    })
  })

  it('iterates only sublevel keys', async () => {
    await withDB(async db => {
      const sub = db.sublevel('s')
      await sub.put('a', '1')
      await sub.put('b', '2')
      await db.put('z', 'root')
      const entries = await collect(sub.iterator() as any)
      expect(entries).toHaveLength(2)
      expect(entries[0][1]).toBe('1')
      expect(entries[1][1]).toBe('2')
    })
  })
})

// ─── namespace option ──────────────────────────────────────────────────────

describe('namespace option', () => {
  it('uses a prefixed table name', async () => {
    const d1 = createD1Mock()
    const db = new D1Level({ d1, namespace: 'myapp' })
    await db.open()
    await db.put('x', '1')
    expect(await db.get('x')).toBe('1')
    await db.close()
  })

  it('two different namespaces are isolated', async () => {
    const d1 = createD1Mock()
    const db1 = new D1Level({ d1, namespace: 'ns1' })
    const db2 = new D1Level({ d1, namespace: 'ns2' })
    await db1.open()
    await db2.open()
    await db1.put('key', 'from-ns1')
    await expect(db2.get('key')).rejects.toMatchObject({ code: 'LEVEL_NOT_FOUND' })
    await db1.close()
    await db2.close()
  })
})
