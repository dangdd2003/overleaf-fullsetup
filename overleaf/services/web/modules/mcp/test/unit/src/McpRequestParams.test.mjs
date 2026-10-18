import { describe, it, expect } from 'vitest'
import {
  ACCESS_BUCKETS,
  hasDotSegment,
  invalid,
  isTrueParam,
  parseIntParam,
} from '../../../app/src/McpRequestParams.mjs'

function res() {
  return {
    statusCode: 200,
    body: null,
    status(s) {
      this.statusCode = s
      return this
    },
    json(b) {
      this.body = b
      return this
    },
    setHeader() {},
  }
}

describe('parseIntParam', () => {
  it('returns the fallback when the value is absent', () => {
    expect(parseIntParam(undefined, 7, { min: 1 })).toBe(7)
    expect(parseIntParam(null, 7, { min: 1 })).toBe(7)
    expect(parseIntParam('', 7, { min: 1 })).toBe(7)
  })

  it('parses whole numbers at or above min, with no upper bound', () => {
    expect(parseIntParam('3', 0, { min: 1 })).toBe(3)
    expect(parseIntParam(5, 0, { min: 0 })).toBe(5)
    expect(parseIntParam('100000', 0, { min: 1 })).toBe(100000)
  })

  it('returns null for values that are not safe integers at or above min', () => {
    for (const value of ['0', '-1', '1.5', 'abc', 'NaN', '1e400', '9007199254740993']) {
      expect(parseIntParam(value, 0, { min: 1 }), value).toBeNull()
    }
  })
})

describe('isTrueParam', () => {
  it('accepts true and the string true only', () => {
    expect(isTrueParam(true)).toBe(true)
    expect(isTrueParam('true')).toBe(true)
    for (const value of ['false', '1', 'yes', undefined, ['true']]) {
      expect(isTrueParam(value), String(value)).toBe(false)
    }
  })
})

describe('hasDotSegment', () => {
  it('flags . and .. segments only', () => {
    expect(hasDotSegment('/a/../b')).toBe(true)
    expect(hasDotSegment('/a/./b')).toBe(true)
    expect(hasDotSegment('/a/..b/c.tex')).toBe(false)
    expect(hasDotSegment('/a/b.tex')).toBe(false)
  })
})

describe('invalid', () => {
  it('sends a validation error, with allowed values as details', () => {
    const r = res()
    invalid(r, 'bad', { allowed: ['x', 'y'], hint: 'pick one' })
    expect(r.statusCode).toBe(400)
    expect(r.body).toEqual({
      code: 'validation_error',
      message: 'bad',
      hint: 'pick one',
      details: { allowed: ['x', 'y'] },
    })
  })
})

describe('ACCESS_BUCKETS', () => {
  it('lists every bucket once, most privileged first', () => {
    const names = ACCESS_BUCKETS.map(([bucket]) => bucket)
    expect(new Set(names).size).toBe(names.length)
    expect(names[0]).toBe('owned')
  })
})
