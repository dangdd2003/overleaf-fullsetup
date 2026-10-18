import { describe, it, expect } from 'vitest'

const { BoundedLru } =
  await import('../../../../../app/src/Features/PdfInspection/PdfCache.mjs')

describe('BoundedLru', () => {
  it('keeps the most recent entries and drops the least recently used', () => {
    const cache = new BoundedLru({ maxEntries: 2 })
    cache.set('a', 1).set('b', 2)
    expect(cache.get('a')).toBe(1)
    cache.set('c', 3)
    expect(cache.has('b')).toBe(false)
    expect([cache.get('a'), cache.get('c')]).toEqual([1, 3])
    expect(cache.size).toBe(2)
  })

  it('drops old entries until the bytes it holds fit the budget', () => {
    const cache = new BoundedLru({
      maxBytes: 10,
      sizeOf: value => value.length,
    })
    cache.set('a', 'xxxx')
    cache.set('b', 'xxxx')
    cache.set('c', 'xxxx')
    expect(cache.has('a')).toBe(false)
    expect(cache.bytes).toBe(8)
  })

  it('does not keep a single value larger than the whole budget', () => {
    const cache = new BoundedLru({ maxBytes: 4, sizeOf: value => value.length })
    cache.set('big', 'xxxxxxxx')
    expect(cache.size).toBe(0)
    expect(cache.bytes).toBe(0)
  })

  it('reclaims the bytes of a value that is replaced or deleted', () => {
    const cache = new BoundedLru({
      maxBytes: 100,
      sizeOf: value => value.length,
    })
    cache.set('a', 'xxxx')
    cache.set('a', 'xx')
    expect(cache.bytes).toBe(2)
    expect(cache.delete('a')).toBe(true)
    expect(cache.bytes).toBe(0)
    expect(cache.delete('a')).toBe(false)
  })

  it('is empty after clear', () => {
    const cache = new BoundedLru({ maxEntries: 5 })
    cache.set('a', 1)
    cache.clear()
    expect(cache.size).toBe(0)
    expect(cache.get('a')).toBeUndefined()
  })
})
