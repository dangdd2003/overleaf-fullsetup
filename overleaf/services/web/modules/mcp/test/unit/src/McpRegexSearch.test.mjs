import { describe, it, expect } from 'vitest'
import { regexSearchLines, MAX_CONCURRENT_SEARCHES } from '../../../app/src/McpRegexSearch.mjs'

describe('regexSearchLines', () => {
  it('returns zero-based document and line indexes of matching lines', async () => {
    const hits = await regexSearchLines({
      query: 'eq:',
      caseSensitive: false,
      docs: [['plain', '\\label{EQ:one}'], ['x', 'eq:two']],
      limit: 10,
    })
    expect(hits).toEqual([
      { doc: 0, line: 1 },
      { doc: 1, line: 1 },
    ])
  })

  it('stops after limit matches', async () => {
    const hits = await regexSearchLines({
      query: 'a',
      caseSensitive: true,
      docs: [['a', 'a', 'a', 'a']],
      limit: 2,
    })
    expect(hits).toHaveLength(2)
  })

  it('stops a search that runs past the timeout with RegexTimeoutError', async () => {
    // (a+)+$ on a long run of a's followed by a non-match backtracks for far
    // longer than the timeout.
    const err = await regexSearchLines({
      query: '(a+)+$',
      caseSensitive: true,
      docs: [[`${'a'.repeat(60)}!`]],
      limit: 1,
      timeoutMs: 200,
    }).catch(e => e)
    expect(err.name).toBe('RegexTimeoutError')
  }, 10000)

  it('rejects at once when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const err = await regexSearchLines({
      query: 'a',
      caseSensitive: true,
      docs: [['a']],
      limit: 1,
      signal: controller.signal,
    }).catch(e => e)
    expect(err.name).toBe('AbortError')
  })

  it('terminates a catastrophic search when the signal aborts', async () => {
    const controller = new AbortController()
    const started = Date.now()
    const search = regexSearchLines({
      query: '^(a+)+$',
      caseSensitive: true,
      docs: [[`${'a'.repeat(40)}!`]],
      limit: 1,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 100)
    const err = await search.catch(e => e)
    expect(err.name).toBe('AbortError')
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('does not take any time limit of its own', async () => {
    // A search that runs longer than the old 2 second cap still finishes.
    const docs = [Array.from({ length: 200000 }, (_, i) => `line ${i}`)]
    const hits = await regexSearchLines({
      query: 'line 199999$',
      caseSensitive: true,
      docs,
      limit: 1,
    })
    expect(hits).toEqual([{ doc: 0, line: 199999 }])
  })

  it('refuses a search beyond the concurrent-search cap with SearchBusyError', async () => {
    const controller = new AbortController()
    // Catastrophic patterns keep their workers busy until the signal aborts.
    const running = Array.from({ length: MAX_CONCURRENT_SEARCHES }, () =>
      regexSearchLines({
        query: '^(a+)+$',
        caseSensitive: true,
        docs: [[`${'a'.repeat(40)}!`]],
        limit: 1,
        signal: controller.signal,
      }).catch(e => e)
    )
    const err = await regexSearchLines({
      query: 'a',
      caseSensitive: true,
      docs: [['a']],
      limit: 1,
    }).catch(e => e)
    expect(err.name).toBe('SearchBusyError')
    controller.abort()
    const outcomes = await Promise.all(running)
    expect(outcomes.every(e => e.name === 'AbortError')).toBe(true)
    // The slots are free again once the running searches have ended.
    const hits = await regexSearchLines({
      query: 'a',
      caseSensitive: true,
      docs: [['a']],
      limit: 1,
    })
    expect(hits).toEqual([{ doc: 0, line: 0 }])
  })

  it('limits concurrent searches per owner while allowing searches from another owner', async () => {
    const controller = new AbortController()
    const ownerA = 'user_A'
    const ownerB = 'user_B'

    const running = [
      regexSearchLines({
        query: '^(a+)+$',
        caseSensitive: true,
        docs: [[`${'a'.repeat(40)}!`]],
        limit: 1,
        signal: controller.signal,
        ownerId: ownerA,
      }).catch(e => e),
      regexSearchLines({
        query: '^(a+)+$',
        caseSensitive: true,
        docs: [[`${'a'.repeat(40)}!`]],
        limit: 1,
        signal: controller.signal,
        ownerId: ownerA,
      }).catch(e => e),
    ]

    // Third search for ownerA should be rejected with SearchBusyError
    const errOwnerA = await regexSearchLines({
      query: 'a',
      caseSensitive: true,
      docs: [['a']],
      limit: 1,
      ownerId: ownerA,
    }).catch(e => e)
    expect(errOwnerA.name).toBe('SearchBusyError')

    // But ownerB should still be able to search successfully
    const hitsOwnerB = await regexSearchLines({
      query: 'a',
      caseSensitive: true,
      docs: [['a']],
      limit: 1,
      ownerId: ownerB,
    })
    expect(hitsOwnerB).toEqual([{ doc: 0, line: 0 }])

    controller.abort()
    const outcomes = await Promise.all(running)
    expect(outcomes.every(e => e.name === 'AbortError')).toBe(true)
  })
})
