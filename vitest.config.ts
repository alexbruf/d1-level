import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'
import { defineConfig } from 'vitest/config'

// Unit tests (mock-based, fast, Node env) and Workers integration tests live
// in separate configs. Run both via `vitest run`.
export default defineConfig({
  test: {
    projects: [
      // ── Unit tests: run in Node against the better-sqlite3 D1 mock ──────────
      {
        test: {
          name: 'unit',
          include: ['test/index.test.ts', 'test/abstract-suite.test.ts'],
          environment: 'node',
        },
      },

      // ── Integration tests: real D1 via Miniflare / Workers runtime ───────────
      defineWorkersConfig({
        test: {
          name: 'workers',
          include: ['test/workers.test.ts'],
          poolOptions: {
            workers: {
              wrangler: { configPath: './wrangler.jsonc' },
            },
          },
        },
      }),
    ],
  },
})
