import { describe, it, beforeEach, afterEach, before, after } from 'node:test'
import assert from 'node:assert/strict'

function expect(actual) {
  return {
    toBe(expected) {
      if (typeof actual === 'boolean' || typeof expected === 'boolean') {
        assert.strictEqual(Boolean(actual), Boolean(expected))
        return
      }
      assert.strictEqual(actual, expected)
    },
    toEqual(expected) {
      assert.deepStrictEqual(actual, expected)
    },
    deepEqual(expected) {
      assert.deepStrictEqual(actual, expected)
    },
    toStrictEqual(expected) {
      assert.deepStrictEqual(actual, expected)
    },
    toBeNull() {
      assert.strictEqual(actual, null)
    },
    toBeDefined() {
      assert.notStrictEqual(actual, undefined)
    },
    toBeUndefined() {
      assert.strictEqual(actual, undefined)
    },
    toBeTruthy() {
      assert.ok(actual)
    },
    toBeFalsy() {
      assert.ok(!actual)
    },
    toBeGreaterThan(expected) {
      assert.ok(actual > expected)
    },
    toBeLessThan(expected) {
      assert.ok(actual < expected)
    },
    toHaveLength(len) {
      assert.strictEqual(actual?.length, len)
    },
    toContain(expected) {
      if (Array.isArray(actual) || typeof actual === 'string') {
        assert.ok(actual.includes(expected))
        return
      }
      if (typeof actual === 'object' && actual !== null) {
        assert.ok(expected in actual)
      }
    },
    toMatch(regex) {
      assert.match(actual, regex)
    },
    resolves: {
      toEqual(expected) {
        return actual.then(val => assert.deepStrictEqual(val, expected))
      },
    },
    rejects: {
      toThrow() {
        return assert.rejects(actual)
      },
    },
    to: {
      get be() {
        return {
          get true() {
            assert.strictEqual(Boolean(actual), true)
            return true
          },
          get false() {
            assert.strictEqual(Boolean(actual), false)
            return true
          },
          get null() {
            assert.strictEqual(actual, null)
            return true
          },
          get undefined() {
            assert.strictEqual(actual, undefined)
            return true
          },
        }
      },
      deep: {
        equal(expected) {
          assert.deepStrictEqual(actual, expected)
        },
      },
    },
  }
}

const vi = {
  fn: impl => {
    const stub = (...args) => {
      stub.mock.calls.push(args)
      if (impl) return impl(...args)
    }
    stub.mock = { calls: [] }
    return stub
  },
  spyOn: (obj, method) => {
    const original = obj[method]
    const spy = (...args) => {
      spy.mock.calls.push(args)
      return original.apply(obj, args)
    }
    spy.mock = { calls: [] }
    obj[method] = spy
    return spy
  },
}

export { describe, it, beforeEach, afterEach, before, after, expect, vi }
export default {
  describe,
  it,
  beforeEach,
  afterEach,
  before,
  after,
  expect,
  vi,
}
