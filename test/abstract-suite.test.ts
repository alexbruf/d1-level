/**
 * Runs abstract-level's official compliance suite against D1Level.
 *
 * The suite validates every abstract-level contract: put/get/del, getMany,
 * batch, chained-batch, iterators (range, reverse, limit, seek…), clear,
 * sublevels, encodings, deferred open, and more.
 */
import suite from 'abstract-level/test'
import { tapeRunner } from './tape-bridge.js'
import { createD1Mock } from './mock-d1.js'
import { D1Level } from '../src/index.js'

suite({
  // Each tape test becomes a vitest `it` via the bridge
  test: tapeRunner(),

  // Each factory call gets a fresh in-memory SQLite DB → full isolation
  factory(options?: Record<string, unknown>) {
    return new D1Level({ d1: createD1Mock(), ...options })
  },
})
