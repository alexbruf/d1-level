/**
 * Minimal tape → vitest bridge.
 *
 * Handles the completion patterns used in abstract-level's suite:
 *   1. t.plan(n)       — auto-resolves after n successful assertions
 *   2. t.end(err)      — explicit completion; also used as a callback (err-first)
 *   3. async test fn   — resolves when the returned Promise settles
 */
import { it } from 'vitest'
import { expect } from 'vitest'

export interface T {
  plan(n: number): void
  end(err?: unknown): void
  error(err: unknown, msg?: string): void
  ifError(err: unknown, msg?: string): void
  ok(val: unknown, msg?: string): void
  notOk(val: unknown, msg?: string): void
  equal(a: unknown, b: unknown, msg?: string): void
  equals(a: unknown, b: unknown, msg?: string): void
  strictEqual(a: unknown, b: unknown, msg?: string): void
  is(a: unknown, b: unknown, msg?: string): void
  isNot(a: unknown, b: unknown, msg?: string): void
  deepEqual(a: unknown, b: unknown, msg?: string): void
  deepEquals(a: unknown, b: unknown, msg?: string): void
  same(a: unknown, b: unknown, msg?: string): void
  notDeepEqual(a: unknown, b: unknown, msg?: string): void
  notSame(a: unknown, b: unknown, msg?: string): void
  fail(msg?: string): void
  pass(msg?: string): void
  throws(fn: () => unknown, msg?: string): void
  doesNotThrow(fn: () => unknown, msg?: string): void
  test(name: string, fn: (t: T) => void): void
}

function makeT(resolve: () => void, reject: (e: unknown) => void): T {
  let done = false
  let planned = -1       // -1 = no plan
  let assertCount = 0

  function finish(err?: unknown) {
    if (done) return
    done = true
    if (err) reject(err)
    else resolve()
  }

  function assert(fn: () => void) {
    if (done) return
    try {
      fn()
      assertCount++
      if (planned >= 0 && assertCount >= planned) finish()
    } catch (e) {
      finish(e)
    }
  }

  const t: T = {
    plan(n) {
      planned = n
      // In case all assertions already happened before plan() was called
      if (assertCount >= planned) finish()
    },

    // t.end() / db.close(t.end.bind(t)) — err may be an Error or null/undefined
    end(err?: unknown) {
      if (err instanceof Error) finish(err)
      else finish()
    },

    error:   (err, msg) => assert(() => expect(err,  msg).toBeFalsy()),
    ifError: (err, msg) => assert(() => expect(err,  msg).toBeFalsy()),
    ok:      (val, msg) => assert(() => expect(val,  msg).toBeTruthy()),
    notOk:   (val, msg) => assert(() => expect(val,  msg).toBeFalsy()),

    equal:       (a, b, msg) => assert(() => expect(a, msg).toBe(b)),
    equals:      (a, b, msg) => assert(() => expect(a, msg).toBe(b)),
    strictEqual: (a, b, msg) => assert(() => expect(a, msg).toBe(b)),
    is:          (a, b, msg) => assert(() => expect(a, msg).toBe(b)),
    isNot:       (a, b, msg) => assert(() => expect(a, msg).not.toBe(b)),

    deepEqual:    (a, b, msg) => assert(() => expect(a, msg).toEqual(b)),
    deepEquals:   (a, b, msg) => assert(() => expect(a, msg).toEqual(b)),
    same:         (a, b, msg) => assert(() => expect(a, msg).toEqual(b)),
    notDeepEqual: (a, b, msg) => assert(() => expect(a, msg).not.toEqual(b)),
    notSame:      (a, b, msg) => assert(() => expect(a, msg).not.toEqual(b)),

    fail: (msg) => assert(() => expect.fail(msg ?? 'fail')),
    pass: () => assert(() => { /* always passes */ }),

    throws:       (fn, msg) => assert(() => expect(fn, msg).toThrow()),
    doesNotThrow: (fn, msg) => assert(() => expect(fn, msg).not.toThrow()),

    test: (name, fn) => registerTest(name, fn),
  }
  return t
}

function registerTest(name: string, fn: (t: T) => unknown): void {
  it(name, () =>
    new Promise<void>((resolve, reject) => {
      const t = makeT(resolve, reject)
      let result: unknown
      try { result = fn(t) } catch (e) { return reject(e) }
      // If fn is async, also forward its resolution so tests with no
      // t.plan/t.end (but that return a Promise) still complete.
      if (result != null && typeof (result as { then?: unknown }).then === 'function') {
        ;(result as Promise<unknown>).then(() => resolve(), reject)
      }
    })
  )
}

export function tapeRunner() {
  function test(name: string, fn: (t: T) => void) {
    registerTest(name, fn)
  }
  test.skip = (name: string, _fn: (t: T) => void) => it.skip(name, () => {})
  test.only = (name: string, fn: (t: T) => void) =>
    it.only(name, () => new Promise<void>((resolve, reject) => fn(makeT(resolve, reject))))
  return test
}
