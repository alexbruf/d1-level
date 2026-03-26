# d1-level

An [`abstract-level`](https://github.com/Level/abstract-level) database backed by [Cloudflare D1](https://developers.cloudflare.com/d1/).

Use any library from the [`level`](https://github.com/Level/community) ecosystem — or anything that accepts an `abstract-level` database — on Cloudflare Workers with no external database dependencies.

> 📌 New to `abstract-level`? Head over to the [Level FAQ](https://github.com/Level/community#faq).

[![Tests](https://img.shields.io/badge/tests-887%20passing-brightgreen)](#tests)
[![abstract-level](https://img.shields.io/badge/abstract--level-compliant-blue)](https://github.com/Level/abstract-level)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

## Install

```sh
npm install d1-level
```

## Usage

```typescript
import { D1Level } from 'd1-level'

export default {
  async fetch(request: Request, env: { DB: D1Database }) {
    const db = new D1Level({ d1: env.DB })

    await db.put('hello', 'world')
    const value = await db.get('hello') // 'world'

    await db.batch([
      { type: 'put', key: 'a', value: '1' },
      { type: 'put', key: 'b', value: '2' },
    ])

    for await (const [key, value] of db.iterator({ gte: 'a', lte: 'b' })) {
      console.log(key, value)
    }

    return new Response('ok')
  }
}
```

### With TinaCMS

```typescript
// tina/database.ts
import { D1Level } from 'd1-level'
import { createDatabase } from '@tinacms/datalayer'
import { GitHubProvider } from 'tinacms-gitprovider-github'

export function createTinaDatabase(env: { DB: D1Database }) {
  return createDatabase({
    level: new D1Level({ d1: env.DB }),
    gitProvider: new GitHubProvider({
      owner: process.env.GITHUB_OWNER,
      repo: process.env.GITHUB_REPO,
      token: process.env.GITHUB_PERSONAL_ACCESS_TOKEN,
      branch: process.env.GITHUB_BRANCH,
    }),
  })
}
```

## Setup

### Wrangler config

Add the D1 binding to your `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "my-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

### Table creation

The default `createTable: true` runs `CREATE TABLE IF NOT EXISTS` on open — no migrations needed for development.

For production, create the table explicitly:

```sh
wrangler d1 execute MY_DB --remote --command \
  "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;"
```

Or add a migration file:

```sql
-- migrations/0001_create_kv.sql
CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
```

```sh
wrangler d1 migrations apply MY_DB --remote
```

Then pass `createTable: false`:

```typescript
const db = new D1Level({ d1: env.DB, createTable: false })
```

### Namespace (shared databases)

Use `namespace` to isolate this adapter's table when sharing a D1 database:

```typescript
const db = new D1Level({ d1: env.DB, namespace: 'tina' })
// → uses table "tina_kv" instead of "kv"
```

## API

### `new D1Level(options)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `d1` | `D1Database` | **required** | Cloudflare D1 binding from Worker `env` |
| `namespace` | `string` | `''` | Table name prefix. `''` → table `kv`; `'tina'` → table `tina_kv` |
| `createTable` | `boolean` | `true` | Run `CREATE TABLE IF NOT EXISTS` on open |

All other options are forwarded to [`abstract-level`](https://github.com/Level/abstract-level#db--new-abstractlevelmanifest-options).

`D1Level` inherits the full `abstract-level` API: `put`, `get`, `del`, `getMany`, `batch`, `iterator`, `keys`, `values`, `clear`, `sublevel`, and more.

## How it works

D1 is SQLite under the hood. Entries are stored in a two-column table:

```sql
CREATE TABLE kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
```

`WITHOUT ROWID` is a SQLite optimization for tables where the primary key is the data — it avoids the internal rowid indirection and keeps the B-tree compact.

**Iteration** uses cursor-based pagination. Since D1 is accessed over HTTP, there's no persistent server-side cursor. Instead, the iterator fetches rows in pages of 100, using `WHERE key > lastKey` to advance between pages. This is transparent to callers.

**Batches** use D1's native `batch()` which executes all statements as a single atomic transaction.

**Sublevels** are handled entirely by `abstract-level` via key prefixing — no extra SQL machinery needed.

### Limitations

- **No snapshot isolation** — iterators read live data. If you write to the database while iterating, the iterator may see the changes. This is declared via `supports.snapshots = false` in the manifest.
- **No `seek()`** — repositioning an open iterator is not implemented.
- **UTF-8 keys and values only** — binary encodings are not supported (D1 TEXT columns only). Use base64 encoding for binary data.

## Tests

887 tests pass across three suites:

| Suite | Count | Environment |
|-------|-------|-------------|
| Unit tests | 32 | Node.js (better-sqlite3 mock) |
| abstract-level compliance | 844 | Node.js (better-sqlite3 mock) |
| Integration tests | 11 | Miniflare (real D1 via `vitest-pool-workers`) |

The compliance suite is the [official `abstract-level` test suite](https://github.com/Level/abstract-level/tree/main/test) that all level implementations run against. All applicable tests pass (snapshot and seek tests are skipped via manifest flags, consistent with how other implementations handle unsupported features).

```sh
bun test
```

## License

[Apache-2.0](LICENSE)
