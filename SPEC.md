# Serverless Level Adapters: `d1-level` + `turso-level`

## Goal

Build two `abstract-level` implementations backed by serverless SQLite platforms — Cloudflare D1 and Turso (libSQL) — enabling self-hosted TinaCMS on edge/serverless infrastructure without external database dependencies like MongoDB or Upstash Redis.

Both share ~90% of the same logic (they're both "SQL sorted KV stores") so the plan is to build a shared core and thin platform-specific wrappers.

---

## Architecture

```
abstract-level
    │
    ├── d1-level          ← accepts env.DB binding (Cloudflare Workers)
    │     └── sql-level-core (shared)
    │
    └── turso-level       ← accepts @libsql/client instance
          └── sql-level-core (shared)
```

### Shared Core: `sql-level-core`

An internal module (not published separately) that contains all the SQL generation and option-mapping logic. It accepts a generic async SQL executor interface:

```typescript
interface SQLExecutor {
  run(sql: string, params: any[]): Promise<void>
  get(sql: string, params: any[]): Promise<{ key: string; value: string } | null>
  all(sql: string, params: any[]): Promise<Array<{ key: string; value: string }>>
  batch(statements: Array<{ sql: string; params: any[] }>): Promise<void>
}
```

Each platform adapter just implements this interface by mapping to its own client SDK.

### Table Schema

Single table, identical for both:

```sql
CREATE TABLE IF NOT EXISTS {namespace}_kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
```

`WITHOUT ROWID` is a SQLite optimization for tables where the primary key IS the data — avoids the internal rowid indirection. Both D1 and Turso/libSQL support this.

---

## abstract-level Methods → SQL Mapping

Reference implementation template: `upstash-redis-level` (async, serverless-friendly).

### Core CRUD

| Method | SQL |
|--------|-----|
| `_open(options)` | `CREATE TABLE IF NOT EXISTS ...` |
| `_get(key, options)` | `SELECT value FROM kv WHERE key = ?` |
| `_getMany(keys, options)` | One `SELECT` with `WHERE key IN (?, ?, ...)` |
| `_put(key, value, options)` | `INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)` |
| `_del(key, options)` | `DELETE FROM kv WHERE key = ?` |
| `_batch(operations, options)` | Wrap all puts/dels in a batch/transaction |
| `_clear(options)` | `DELETE FROM kv` with optional range `WHERE` clause |

### Batch Implementation

Both D1 and Turso have native batched statement support (D1's `env.DB.batch()` and Turso's `client.batch()`), which execute as atomic transactions. This maps perfectly to Level's batch semantics.

```typescript
// D1
await db.batch(ops.map(op =>
  op.type === 'put'
    ? db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').bind(op.key, op.value)
    : db.prepare('DELETE FROM kv WHERE key = ?').bind(op.key)
))

// Turso
await client.batch(ops.map(op =>
  op.type === 'put'
    ? { sql: 'INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', args: [op.key, op.value] }
    : { sql: 'DELETE FROM kv WHERE key = ?', args: [op.key] }
), 'write')
```

### Iterator

The iterator is the most complex piece. `abstract-level` iterators support:
- Range bounds: `gt`, `gte`, `lt`, `lte`
- `reverse` (boolean)
- `limit` (number)
- `keys` / `values` (booleans — which columns to return)

All of this maps cleanly to SQL:

```sql
SELECT key, value FROM kv
WHERE key > ?    -- gt
  AND key <= ?   -- lte
ORDER BY key ASC -- or DESC for reverse
LIMIT ?
```

**Iterator strategy: prefetch in chunks.** Since both D1 and Turso are HTTP-based, we can't hold a cursor open. The `upstash-redis-level` approach works: fetch a page of results on first `_next()` / `_nextv()` call, yield from the buffer, fetch the next page using the last key as the new lower bound when exhausted.

```typescript
class SQLIterator extends AbstractIterator {
  private buffer: Array<[string, string]> = []
  private pageSize = 100  // configurable
  private finished = false
  private lastKey: string | null = null

  async _next(): Promise<[string, string] | undefined> {
    if (this.buffer.length === 0 && !this.finished) {
      await this.fetchPage()
    }
    return this.buffer.shift()
  }

  private async fetchPage() {
    // Build SQL with range options + lastKey cursor
    // If results < pageSize, set finished = true
  }
}
```

**`_nextv(size)` optimization:** For bulk reads, fetch exactly `size` rows in one query instead of paginating. This is the hot path for TinaCMS content indexing.

---

## Platform-Specific Adapters

### `d1-level`

```typescript
import { AbstractLevel } from 'abstract-level'

interface D1LevelOptions {
  d1: D1Database           // Cloudflare Worker binding
  namespace?: string       // key prefix / table name prefix (default: 'level')
}

class D1Level extends AbstractLevel<string, string> {
  constructor(options: D1LevelOptions) { ... }
}
```

**D1-specific notes:**
- D1 binding comes from Worker `env` — no URL/token config needed
- D1's `batch()` is transactional (all-or-nothing) — perfect for Level batches
- D1 has a 1MB response size limit per query — pagination handles this
- D1 read replicas: for read-heavy TinaCMS workloads, D1 Sessions API could be used for sequential consistency, but the default (primary reads) is fine to start

### `turso-level`

```typescript
import { AbstractLevel } from 'abstract-level'
import { Client } from '@libsql/client'

interface TursoLevelOptions {
  client: Client             // pre-configured @libsql/client instance
  namespace?: string         // table name prefix (default: 'level')
}

class TursoLevel extends AbstractLevel<string, string> {
  constructor(options: TursoLevelOptions) { ... }
}
```

**Turso-specific notes:**
- Use `@libsql/client/web` import for edge runtimes (Cloudflare Workers, Vercel Edge)
- Use `@libsql/client` for Node.js (supports local SQLite files too)
- Turso `batch()` with `'write'` mode = implicit transaction
- Embedded Replicas: users can pass a client configured with `syncUrl` for local-first reads — the adapter doesn't need to know or care, it just uses the client
- Turso's 5-second transaction timeout is irrelevant here since we use batches, not interactive transactions

---

## File Structure

Monorepo with shared code:

```
serverless-level/
├── packages/
│   ├── sql-level-core/        # Shared SQL logic
│   │   ├── src/
│   │   │   ├── index.ts       # SQLLevel base class + SQLExecutor interface
│   │   │   ├── iterator.ts    # SQLIterator (shared pagination logic)
│   │   │   └── utils.ts       # Range option → WHERE clause builder
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── d1-level/
│   │   ├── src/
│   │   │   └── index.ts       # D1Level class + D1 executor
│   │   ├── package.json       # deps: abstract-level, sql-level-core
│   │   └── tsconfig.json
│   │
│   └── turso-level/
│       ├── src/
│       │   └── index.ts       # TursoLevel class + libSQL executor
│       ├── package.json       # deps: abstract-level, sql-level-core, @libsql/client
│       └── tsconfig.json
│
├── test/
│   ├── shared.test.ts         # abstract-level test suite (run against both)
│   ├── d1.test.ts             # D1-specific (miniflare)
│   └── turso.test.ts          # Turso-specific (local libsql)
│
├── pnpm-workspace.yaml
├── package.json
└── tsconfig.json
```

**Alternative:** If the shared core is small enough (~100-150 lines), skip the monorepo and just have two standalone packages that copy-paste the core SQL logic. Less infra, faster shipping. Decide after writing the core.

---

## Implementation Order

### Phase 1: Core + turso-level (day 1)

Start with Turso because it's easier to test locally — `@libsql/client` can use `file:test.db` or `:memory:` with zero infrastructure.

1. Write `sql-level-core` — the SQL generator and base class
2. Wire up `turso-level` with `@libsql/client`
3. Run `abstract-level`'s test suite (they publish one — it's the canonical way to validate an implementation)
4. Validate with TinaCMS locally by swapping the database adapter

### Phase 2: d1-level (day 2)

1. Wire up `d1-level` using the same core
2. Test with Miniflare (Cloudflare's local dev runtime — has full D1 support)
3. Deploy a test TinaCMS backend as a Cloudflare Worker + Pages Function

### Phase 3: TinaCMS backend on Workers (day 2-3)

This is the actual integration work:

1. Port TinaCMS's backend handler to run as a Cloudflare Worker (or Hono route)
   - The backend is a GraphQL endpoint + Git provider (GitHub API calls)
   - Main challenge: any Node.js-only imports in TinaCMS server code
   - Cloudflare Workers has `nodejs_compat` flag which covers most of these
2. Wire up: `d1-level` as database adapter, GitHub as Git provider, Auth.js or Clerk for auth
3. Test the full loop: edit in TinaCMS → write to D1 → commit to GitHub

---

## Key Risks & Mitigations

**Risk: TinaCMS server code has Node.js-only dependencies**
- Mitigation: Workers `nodejs_compat` covers `crypto`, `Buffer`, `stream`, `path`. If there are hard blockers (e.g., `fs` usage), we can polyfill or patch.
- Mitigation: Turso path is a safer first bet — it works in standard Node.js serverless (Vercel, Netlify, Railway) with zero compat concerns.

**Risk: Iterator performance on large datasets**
- Mitigation: TinaCMS's content database is ephemeral (rebuilt from Git). Typical site has <10K entries. Pagination with 100-row pages is more than adequate.
- Mitigation: `_nextv(size)` bulk fetch for the indexing hot path.

**Risk: D1 row/response size limits**
- D1 max response size is 20MB, max rows per query is configurable. TinaCMS values are JSON-serialized content — typical values are 1-50KB. Not a concern for realistic content volumes.

**Risk: Concurrent writes**
- TinaCMS's write path is serialized (one edit at a time through the CMS UI). D1 and Turso both handle concurrent reads fine. Not a real concern for this use case.

---

## Usage Examples (end state)

### D1 (Cloudflare Worker)

```typescript
// database.ts
import { D1Level } from 'd1-level'
import { createDatabase } from '@tinacms/datalayer'

export function createTinaDatabase(env: { DB: D1Database }) {
  const level = new D1Level({ d1: env.DB })
  return createDatabase({ level })
}
```

### Turso (any serverless platform)

```typescript
// database.ts
import { TursoLevel } from 'turso-level'
import { createClient } from '@libsql/client/web'
import { createDatabase } from '@tinacms/datalayer'

const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
})

const level = new TursoLevel({ client })
export const database = createDatabase({ level })
```

### Turso with Embedded Replicas (Node.js — e.g., Railway, Fly.io)

```typescript
import { TursoLevel } from 'turso-level'
import { createClient } from '@libsql/client'

const client = createClient({
  url: 'file:local-replica.db',
  syncUrl: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
  syncInterval: 60,
})

const level = new TursoLevel({ client })
```

---

## Decisions (Resolved)

1. **Two standalone packages, no monorepo.** The shared core is ~150 lines (SQL executor interface, WHERE clause builder, iterator pagination). That's small enough to copy between the two packages without meaningful maintenance burden. A monorepo adds workspace config overhead and couples their release cycles for no real benefit. If both get traction and the shared code grows, refactor into a third package later. Ship now.

2. **Key-prefix in a single table.** One table (`kv`), keys prefixed with the namespace (`level:actualkey`). This matches what `upstash-redis-level` does, so TinaCMS's sublevel usage works without any adaptation. Table-per-namespace would mean dynamic `CREATE TABLE` / `DROP TABLE` which is heavier, and D1 has table count limits. SQLite's B-tree index on the `TEXT` primary key already makes prefix range scans efficient — `WHERE key >= 'level:' AND key < 'level;'` is an index seek, not a scan.

3. **Publish to npm immediately under unscoped names.** `d1-level` and `turso-level` — clean, match the existing convention (`mongodb-level`, `upstash-redis-level`). Apache-2.0 license. Publish from Handbook Enterprises / ViewEngine accounts. If the TinaCMS team wants to adopt them into the `tinacms` org later, transfer ownership then. Don't gate shipping on organizational alignment.

---

## README: `d1-level`

````markdown
# d1-level

An [`abstract-level`](https://github.com/Level/abstract-level) database backed by [Cloudflare D1](https://developers.cloudflare.com/d1/).

Built for running [TinaCMS](https://tina.io/docs/self-hosted/overview) (or anything that uses `abstract-level`) on Cloudflare Workers with zero external database dependencies.

> 📌 Which module should I use? What is `abstract-level`? Head over to the [FAQ](https://github.com/Level/community#faq).

## Install

```sh
npm install d1-level
```

## Database Setup

`d1-level` auto-creates its table on first open, but if you prefer explicit migrations (recommended for production), create the table yourself.

### Option A: Auto-create (development)

Pass `createTable: true` (the default). The table is created via `CREATE TABLE IF NOT EXISTS` on `_open()`. No manual steps needed.

### Option B: Manual migration (production)

Run this once against your D1 database:

```sh
npx wrangler d1 execute YOUR_DB_NAME --remote --command \
  "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;"
```

Or add it to a migration file:

```sh
mkdir -p migrations
```

```sql
-- migrations/0001_create_kv.sql
CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
```

```sh
npx wrangler d1 migrations apply YOUR_DB_NAME --remote
```

Then disable auto-creation:

```typescript
const level = new D1Level({ d1: env.DB, createTable: false })
```

### Custom namespace

If you're sharing a D1 database with other apps, use a namespace to prefix the table name:

```typescript
const level = new D1Level({ d1: env.DB, namespace: 'tina' })
```

This creates a table named `tina_kv` instead of `kv`. Adjust your migration accordingly:

```sql
CREATE TABLE IF NOT EXISTS tina_kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
```

### Wrangler config

Add the D1 binding to your `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "my-tina-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
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

## API

### `new D1Level(options)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `d1` | `D1Database` | **required** | Cloudflare D1 binding from Worker `env` |
| `namespace` | `string` | `''` | Table name prefix. Empty = table is `kv`, `'tina'` = table is `tina_kv` |
| `createTable` | `boolean` | `true` | Auto-create table on open |

All other options are passed through to `abstract-level`.

## How it works

D1 is SQLite. The adapter stores entries in a single two-column table (`key TEXT PRIMARY KEY, value TEXT`). Sorted iteration uses SQLite's B-tree index on the primary key. Batch operations use D1's native `batch()` which executes as an atomic transaction.

Since D1 is accessed over HTTP (or via Worker binding), iterators prefetch rows in pages and use cursor-based pagination internally.

## License

[Apache-2.0](LICENSE)
````

---

## README: `turso-level`

````markdown
# turso-level

An [`abstract-level`](https://github.com/Level/abstract-level) database backed by [Turso](https://turso.tech/) / [libSQL](https://github.com/tursodatabase/libsql).

Built for running [TinaCMS](https://tina.io/docs/self-hosted/overview) (or anything that uses `abstract-level`) on any serverless platform — Vercel, Netlify, Cloudflare Workers, Fly.io, Railway, or your own server.

> 📌 Which module should I use? What is `abstract-level`? Head over to the [FAQ](https://github.com/Level/community#faq).

## Install

```sh
npm install turso-level @libsql/client
```

## Database Setup

### Option A: Auto-create (development)

Pass `createTable: true` (the default). The table is created via `CREATE TABLE IF NOT EXISTS` on `_open()`. No manual steps needed — works with local SQLite files, in-memory databases, and remote Turso databases.

### Option B: Manual migration (production)

Using the Turso CLI:

```sh
turso db shell YOUR_DB_NAME
```

```sql
CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
```

Or using a migration tool like Drizzle, Kysely, or plain SQL files — whatever you already use.

Then disable auto-creation:

```typescript
const level = new TursoLevel({ client, createTable: false })
```

### Custom namespace

Use a namespace to prefix the table name when sharing a database:

```typescript
const level = new TursoLevel({ client, namespace: 'tina' })
```

Creates `tina_kv` instead of `kv`. Run the migration with the prefixed name:

```sql
CREATE TABLE IF NOT EXISTS tina_kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
```

### Creating a Turso database

If you don't have one yet:

```sh
# Install CLI
brew install tursodatabase/tap/turso  # or: curl -sSfL https://get.tur.so/install.sh | bash

# Auth
turso auth login

# Create database (pick a region close to your users)
turso db create my-tina-db --group default

# Get connection details
turso db show my-tina-db --url
turso db tokens create my-tina-db
```

Set these as environment variables:

```sh
TURSO_DATABASE_URL=libsql://my-tina-db-yourorg.turso.io
TURSO_AUTH_TOKEN=eyJ...
```

## Usage

### Remote database (edge/serverless)

```typescript
import { TursoLevel } from 'turso-level'
import { createClient } from '@libsql/client/web'  // use /web for edge runtimes

const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
})

const db = new TursoLevel({ client })

await db.put('hello', 'world')
const value = await db.get('hello') // 'world'

for await (const [key, value] of db.iterator({ gte: 'a', lte: 'z' })) {
  console.log(key, value)
}
```

### Local development (SQLite file)

```typescript
import { TursoLevel } from 'turso-level'
import { createClient } from '@libsql/client'  // Node.js import supports file: URLs

const client = createClient({ url: 'file:local.db' })
const db = new TursoLevel({ client })
```

### Embedded Replicas (Node.js — Fly.io, Railway, VPS)

Reads are local (microseconds). Writes go to the remote primary and sync back.

```typescript
import { TursoLevel } from 'turso-level'
import { createClient } from '@libsql/client'

const client = createClient({
  url: 'file:replica.db',
  syncUrl: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
  syncInterval: 60,  // auto-sync every 60s
})

const db = new TursoLevel({ client })
```

### With TinaCMS

```typescript
// tina/database.ts
import { TursoLevel } from 'turso-level'
import { createClient } from '@libsql/client/web'
import { createDatabase } from '@tinacms/datalayer'
import { GitHubProvider } from 'tinacms-gitprovider-github'

const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
})

export const database = createDatabase({
  level: new TursoLevel({ client }),
  gitProvider: new GitHubProvider({
    owner: process.env.GITHUB_OWNER,
    repo: process.env.GITHUB_REPO,
    token: process.env.GITHUB_PERSONAL_ACCESS_TOKEN,
    branch: process.env.GITHUB_BRANCH,
  }),
})
```

## API

### `new TursoLevel(options)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `client` | `Client` | **required** | A `@libsql/client` instance (from `createClient()`) |
| `namespace` | `string` | `''` | Table name prefix. Empty = `kv`, `'tina'` = `tina_kv` |
| `createTable` | `boolean` | `true` | Auto-create table on open |

All other options are passed through to `abstract-level`.

### Which `@libsql/client` import?

| Runtime | Import |
|---------|--------|
| Node.js, Bun, Deno | `@libsql/client` (supports `file:` URLs for local dev) |
| Cloudflare Workers, Vercel Edge, Netlify Edge | `@libsql/client/web` (HTTP only, no native deps) |

The adapter works identically with both — it only calls `client.execute()` and `client.batch()`.

## How it works

Turso is libSQL (a fork of SQLite) as a managed service. The adapter stores entries in a two-column table (`key TEXT PRIMARY KEY, value TEXT`). Range queries and sorted iteration use SQLite's B-tree index. Batch operations use Turso's `batch()` with `'write'` mode, which executes as an atomic transaction.

Iterators prefetch rows in pages and paginate using the last-seen key as a cursor, since libSQL's HTTP protocol is stateless.

## License

[Apache-2.0](LICENSE)
````

---

## Migration Reference (shared)

Quick reference for both platforms, covering the common scenarios.

### Fresh setup (no existing TinaCMS data)

Just configure the adapter and run your TinaCMS build. TinaCMS rebuilds its index from Git on first boot — the database starts empty and gets populated automatically.

### Migrating from another Level adapter (e.g., `mongodb-level`, `upstash-redis-level`)

TinaCMS's database is ephemeral — it's a cache/index of your Git content, not the source of truth. To migrate:

1. Swap the database adapter in `tina/database.ts`
2. Deploy
3. Trigger a content reindex (TinaCMS does this on first request if the DB is empty)

No data migration needed. The new database rebuilds from Git automatically.

### Resetting the database

If the index gets corrupted or you want a clean slate:

**D1:**
```sh
npx wrangler d1 execute YOUR_DB_NAME --remote --command "DELETE FROM kv;"
```

**Turso:**
```sh
turso db shell YOUR_DB_NAME "DELETE FROM kv;"
```

TinaCMS will rebuild on the next request.

### Multiple environments

Use separate databases (not namespaces) for staging vs production — keeps billing and access isolated.

**D1:**
```toml
# wrangler.toml
[[env.staging.d1_databases]]
binding = "DB"
database_name = "tina-staging"
database_id = "..."

[[env.production.d1_databases]]
binding = "DB"
database_name = "tina-production"
database_id = "..."
```

**Turso:**
```sh
turso db create tina-staging --group default
turso db create tina-production --group default
```

Set `TURSO_DATABASE_URL` per environment in your deployment platform.
