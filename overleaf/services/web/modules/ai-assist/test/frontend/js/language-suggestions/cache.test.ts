import { expect } from 'chai'
import {
  cacheKey,
  PERSIST_KEY,
  PERSISTED_SIZE,
  SuggestionCache,
} from '../../../../frontend/js/features/ai-assist/language-suggestions/cache'
import { PROMPT_VERSION } from '../../../../frontend/js/features/ai-assist/language-suggestions/prompt'

const EDIT = { from: 4, to: 9, original: 'shows', insert: 'show' }
const OTHER = { from: 20, to: 27, original: 'improve', insert: 'improves' }

describe('language suggestions: cache', function () {
  it('keys a result by model, English variant, style, prompt version and sentence', function () {
    expect(cacheKey({ slot: 'fast', model: 'qwen3:4b', variant: 'en-GB', style: false }, 'abc')).to.equal(
      `fast:qwen3:4b|en-GB|grammar|${PROMPT_VERSION}|abc`
    )
    expect(cacheKey({ slot: 'fast', model: 'qwen3:4b', variant: 'en-GB', style: true }, 'abc')).to.equal(
      `fast:qwen3:4b|en-GB|style|${PROMPT_VERSION}|abc`
    )
  })

  it('forgets the least recently used entry first', function () {
    const cache = new SuggestionCache(2)
    cache.set('a', { edits: [], rejected: [] })
    cache.set('b', { edits: [], rejected: [] })
    cache.get('a')
    cache.set('c', { edits: [], rejected: [] })
    expect([cache.has('a'), cache.has('b'), cache.has('c')]).to.deep.equal([true, false, true])
    expect(cache.size).to.equal(2)
  })

  it('leaves rejected edits out of what it shows', function () {
    const cache = new SuggestionCache()
    cache.set('k', { edits: [EDIT, OTHER], rejected: [] })
    cache.reject('k', [{ ...EDIT }])
    expect(cache.visible('k')).to.deep.equal([OTHER])
    expect(cache.visible('missing')).to.equal(undefined)
    cache.reject('missing', [EDIT])
    expect(cache.has('missing')).to.equal(false)
  })

  it('keeps checked sentences in the browser, with the edits dismissed on them', function () {
    const store = new Map<string, any>()
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: any) => store.set(key, JSON.parse(JSON.stringify(value))),
    }
    const first = new SuggestionCache(10, storage)
    first.set('clean', { edits: [], rejected: [] })
    first.set('k', { edits: [EDIT], rejected: [] })
    first.reject('k', [EDIT])
    first.persistNow()
    expect(store.get(PERSIST_KEY).entries).to.have.length(2)

    const reloaded = new SuggestionCache(10, storage)
    expect(reloaded.has('clean')).to.equal(true)
    expect(reloaded.get('k')!.edits).to.deep.equal([EDIT])
    expect(reloaded.visible('k')).to.deep.equal([])
  })

  it(`writes at most ${PERSISTED_SIZE} entries, the most recent`, function () {
    const store = new Map<string, any>()
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: any) => store.set(key, value),
    }
    const cache = new SuggestionCache(PERSISTED_SIZE + 10, storage)
    for (let i = 0; i < PERSISTED_SIZE + 10; i++) cache.set(`k${i}`, { edits: [], rejected: [] })
    cache.persistNow()
    const entries = store.get(PERSIST_KEY).entries
    expect(entries).to.have.length(PERSISTED_SIZE)
    expect(entries[0][0]).to.equal('k10')
  })

  it('ignores a stored copy it cannot read', function () {
    const cache = new SuggestionCache(10, { getItem: () => ({ v: 9 }), setItem: () => {} })
    expect(cache.size).to.equal(0)
  })
})
