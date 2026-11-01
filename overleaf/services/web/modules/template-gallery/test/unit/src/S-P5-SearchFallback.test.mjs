import { describe, it, expect, afterEach, vi } from 'vitest'
import { setCollectionOverrideForTests } from '../../../app/src/persistence/Collections.mjs'
import SearchService from '../../../app/src/services/SearchService.mjs'

const FALLBACK_MAX_TIME_MS = 2_000
const MAX_RESULTS = 1000

// Records the options of every find and count; `$text` fails like a database
// without the tg_text index when `textIndex` is false.
function makeCollection({ total = 0, textIndex = true, countImpl } = {}) {
  const calls = { find: [], count: [] }
  const missingIndex = () =>
    Object.assign(new Error('text index required for $text query'), {
      code: 27,
    })
  return {
    calls,
    find(filter, options) {
      const call = { filter, options }
      calls.find.push(call)
      const cursor = {
        sort: () => cursor,
        skip: () => cursor,
        limit: () => cursor,
        async toArray() {
          if (filter.$text && !textIndex) throw missingIndex()
          return []
        },
      }
      return cursor
    },
    async countDocuments(filter, options) {
      calls.count.push({ filter, options })
      if (filter.$text && !textIndex) throw missingIndex()
      if (countImpl) return countImpl(options)
      return total
    },
  }
}

describe('S-P5 SearchService regex fallback bounds', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    setCollectionOverrideForTests(null)
  })

  it('bounds the fallback find and count with maxTimeMS and a count limit', async () => {
    const col = makeCollection({ textIndex: false, total: 3 })
    setCollectionOverrideForTests({ templateGalleryItems: col })

    await SearchService.search({ q: 'modern cv' })

    const fallbackFind = col.calls.find.at(-1)
    expect(fallbackFind.filter.$text).toBeUndefined()
    expect(fallbackFind.options).toMatchObject({
      maxTimeMS: FALLBACK_MAX_TIME_MS,
    })
    expect(fallbackFind.options.projection).toBeDefined()

    const fallbackCount = col.calls.count.at(-1)
    expect(fallbackCount.filter.$text).toBeUndefined()
    expect(fallbackCount.options).toEqual({
      limit: MAX_RESULTS,
      maxTimeMS: FALLBACK_MAX_TIME_MS,
    })
  })

  it('saturates the fallback hit count at the pagination limit', async () => {
    const col = makeCollection({
      textIndex: false,
      countImpl: options => Math.min(10498, options.limit),
    })
    setCollectionOverrideForTests({ templateGalleryItems: col })

    const result = await SearchService.search({ q: 'cv', page: 0 })
    expect(result.nbHits).toBe(MAX_RESULTS)
    expect(result.nbPages).toBe(100)
  })

  it('leaves the text index path unchanged', async () => {
    const col = makeCollection({ total: 7 })
    setCollectionOverrideForTests({ templateGalleryItems: col })

    const result = await SearchService.search({ q: 'cv' })
    expect(result.nbHits).toBe(7)
    expect(col.calls.find[0].options.maxTimeMS).toBeUndefined()
    expect(col.calls.count[0].options).toEqual({})
  })

  it('surfaces a fallback that runs past its time budget', async () => {
    const col = makeCollection({ textIndex: false })
    const timeout = Object.assign(new Error('operation exceeded time limit'), {
      code: 50,
    })
    col.countDocuments = async () => {
      throw timeout
    }
    setCollectionOverrideForTests({ templateGalleryItems: col })

    let error
    try {
      await SearchService.search({ q: 'cv' })
    } catch (err) {
      error = err
    }
    expect(error).toBe(timeout)
  })
})
