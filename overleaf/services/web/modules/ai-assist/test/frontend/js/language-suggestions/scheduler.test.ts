import { expect } from 'chai'
import sinon from 'sinon'
import {
  Scheduler,
  SchedulerDeps,
} from '../../../../frontend/js/features/ai-assist/language-suggestions/scheduler'
import { cacheKey, SuggestionCache } from '../../../../frontend/js/features/ai-assist/language-suggestions/cache'
import { hashUnit } from '../../../../frontend/js/features/ai-assist/language-suggestions/units'
import { checkBatch } from '../../../../frontend/js/features/ai-assist/language-suggestions/check-batch'
import { editsForRewrite } from '../../../../frontend/js/features/ai-assist/language-suggestions/edits'
import type { ResolvedModel } from '../../../../frontend/js/features/ai-assist/language-suggestions/model-choice'
import type {
  CheckStatus,
  UnitSuggestions,
} from '../../../../frontend/js/features/ai-assist/language-suggestions/state'
import {
  ProviderError,
  ProviderSettings,
  ProviderType,
} from '../../../../frontend/js/features/ai-assist/providers/types'

const SETTINGS: ProviderSettings = {
  type: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'k',
  model: 'tiny',
}

type Call = {
  args: Parameters<typeof checkBatch>[0]
  resolve: (outcome: { malformed: boolean }) => void
  reject: (error: unknown) => void
}

function numbered(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, i) => `${prefix} sentence number ${i + 1} is here.`).join(' ')
}

function harness(
  initialDoc: string,
  options: {
    slot?: 'fast' | 'main'
    storedType?: ProviderType
    viewport?: { from: number; to: number }
    cursor?: number
    holdFor?: SchedulerDeps['holdFor']
  } = {}
) {
  const box = {
    doc: initialDoc,
    active: true,
    attended: true,
    cursor: options.cursor ?? -1,
    edits: { local: null as number | null, remote: null as number | null },
  }
  const calls: Call[] = []
  const delivered: UnitSuggestions[][] = []
  const statuses: CheckStatus[] = []
  const cache = new SuggestionCache()
  const model: ResolvedModel = {
    slot: options.slot ?? 'fast',
    model: 'tiny',
    storedType: options.storedType ?? 'openai',
    settings: SETTINGS,
  }
  const deps: SchedulerDeps = {
    getDoc: () => box.doc,
    getViewport: () => options.viewport ?? { from: 0, to: box.doc.length },
    getCursor: () => box.cursor,
    getEditPositions: () => box.edits,
    isActive: () => box.active,
    isAttended: () => box.attended,
    resolve: () => ({ model, variant: 'en-US', style: false }),
    deliver: units => delivered.push(units),
    onStatus: status => statuses.push(status),
    cache,
    check: args => new Promise((resolve, reject) => calls.push({ args, resolve, reject })),
    holdFor: options.holdFor,
  }
  return { scheduler: new Scheduler(deps), box, calls, delivered, statuses, cache }
}

const targetTexts = (call: Call) => call.args.targets.map(t => t.masked.text)

/** Reports every target (with an edit where `rewrites` has one), then finishes. */
function answer(call: Call, rewrites: Record<string, string> = {}) {
  for (const target of call.args.targets) {
    const rewrite = rewrites[target.masked.text]
    call.args.onResult({
      id: target.id,
      edits: rewrite ? editsForRewrite(target.masked, rewrite) ?? [] : [],
    })
  }
  call.resolve({ malformed: false })
}

describe('language suggestions: scheduler', function () {
  let clock: sinon.SinonFakeTimers

  beforeEach(function () {
    clock = sinon.useFakeTimers()
    ;(clock as any).tickAsync = async (ms: number) => {
      for (let i = 0; i < 10; i++) await Promise.resolve()
      clock.tick(ms)
      for (let i = 0; i < 10; i++) await Promise.resolve()
      clock.tick(0)
      for (let i = 0; i < 10; i++) await Promise.resolve()
    }
  })

  afterEach(function () {
    clock.restore()
  })

  it('checks the whole file once, what is in view first, and never again unchanged', async function () {
    const doc = `${numbered('Alpha', 12)}\n\nBeta sentence one is here. Beta sentence two is here.`
    const { scheduler, calls } = harness(doc, {
      slot: 'main',
      viewport: { from: doc.indexOf('Beta'), to: doc.length },
    })
    scheduler.schedule(0)
    await clock.tickAsync(0)
    expect(calls).to.have.length(1)
    expect(targetTexts(calls[0])).to.include.members([
      'Beta sentence one is here.',
      'Beta sentence two is here.',
    ])
    answer(calls[0])
    await clock.tickAsync(0)
    expect(calls).to.have.length(2)
    answer(calls[1])
    await clock.tickAsync(0)
    expect(calls).to.have.length(2)
    // No timer brings it back, however long the page stays open
    await clock.tickAsync(60 * 60 * 1000)
    scheduler.schedule(0)
    await clock.tickAsync(0)
    expect(calls).to.have.length(2)
  })

  it('shows results as they arrive and does not ask twice', async function () {
    const { scheduler, calls, delivered } = harness('The results shows a gain. The method is fast.')
    scheduler.schedule(0)
    await clock.tickAsync(0)
    answer(calls[0], { 'The results shows a gain.': 'The results show a gain.' })
    await clock.tickAsync(0)
    const shown = delivered.at(-1)!
    expect(shown.map(u => u.edits.map(e => [e.original, e.insert]))).to.deep.equal([
      [['shows', 'show']],
    ])
    scheduler.schedule(0)
    await clock.tickAsync(0)
    expect(calls).to.have.length(1)
    expect(delivered.at(-1)).to.have.length(1)
  })

  it('leaves the sentence being typed alone', async function () {
    const doc = 'The first sentence is done. And this one is still being typ'
    const { scheduler, calls, box } = harness(doc, { cursor: doc.length })
    box.edits.local = doc.length
    scheduler.schedule(0)
    await clock.tickAsync(0)
    expect(targetTexts(calls[0])).to.deep.equal(['The first sentence is done.'])
  })

  it('runs two requests at once on the fast model, one on the main model', async function () {
    const fast = harness(numbered('Gamma', 25))
    fast.scheduler.schedule(0)
    await clock.tickAsync(0)
    expect(fast.calls).to.have.length(2)
    answer(fast.calls[0])
    await clock.tickAsync(0)
    expect(fast.calls).to.have.length(3)

    const main = harness(numbered('Delta', 25), { slot: 'main' })
    main.scheduler.schedule(0)
    await clock.tickAsync(0)
    expect(main.calls).to.have.length(1)
  })

  it('sends nothing while held, and waits out a timed hold', async function () {
    let hold = Infinity
    const { scheduler, calls } = harness(numbered('Eta', 3), { holdFor: () => hold })
    scheduler.schedule(0)
    await clock.tickAsync(1000)
    expect(calls).to.have.length(0)
    hold = 500
    scheduler.schedule(0)
    await clock.tickAsync(0)
    expect(calls).to.have.length(0)
    hold = 0
    await clock.tickAsync(500)
    expect(calls).to.have.length(1)
  })

  it('lets a request in flight finish while held, then waits', async function () {
    let hold = 0
    const { scheduler, calls } = harness(numbered('Iota', 25), { slot: 'main', holdFor: () => hold })
    scheduler.schedule(0)
    await clock.tickAsync(0)
    expect(calls).to.have.length(1)
    hold = Infinity
    answer(calls[0])
    await clock.tickAsync(1000)
    expect(calls[0].args.signal!.aborted).to.equal(false)
    expect(calls).to.have.length(1)
    hold = 0
    scheduler.schedule(0)
    await clock.tickAsync(0)
    expect(calls).to.have.length(2)
  })

  it('does not retry a failure on a timer, only after the next edit', async function () {
    const { scheduler, calls, statuses, box } = harness('The results shows a gain.')
    scheduler.schedule(0)
    await clock.tickAsync(0)
    calls[0].reject(new ProviderError('providerError', 'Upstream down.'))
    await clock.tickAsync(0)
    expect(statuses.at(-1)).to.deep.equal({
      kind: 'error',
      message: 'Upstream down. Checking again after your next edit.',
    })
    await clock.tickAsync(60 * 60 * 1000)
    expect(calls).to.have.length(1)
    // A collaborator's edit does not retry it either
    scheduler.noteEdit({ remote: true })
    await clock.tickAsync(1000)
    expect(calls).to.have.length(1)
    box.doc = 'The results shows a gain. We are done.'
    scheduler.noteEdit()
    await clock.tickAsync(800)
    expect(calls).to.have.length(2)
  })

  it('stops on a rejected key until the settings change', async function () {
    const { scheduler, calls, statuses } = harness('The results shows a gain.')
    scheduler.schedule(0)
    await clock.tickAsync(0)
    calls[0].reject(new ProviderError('providerAuth', 'Invalid API key.'))
    await clock.tickAsync(0)
    expect(statuses.at(-1)).to.deep.equal({ kind: 'stopped', message: 'Invalid API key.' })
    await clock.tickAsync(600000)
    expect(calls).to.have.length(1)
    scheduler.reset()
    await clock.tickAsync(0)
    expect(calls).to.have.length(2)
  })

  it('retries the rest of a cut-off reply in halves', async function () {
    const { scheduler, calls } = harness(
      'One sentence is here now. Two sentence is here now. Three sentence is here now.'
    )
    scheduler.schedule(0)
    await clock.tickAsync(0)
    calls[0].args.onResult({ id: 's1', edits: [] })
    calls[0].reject(new ProviderError('outputTruncated', 'Cut off.'))
    await clock.tickAsync(0)
    expect(calls).to.have.length(3)
    expect(targetTexts(calls[1])).to.deep.equal(['Two sentence is here now.'])
    expect(targetTexts(calls[2])).to.deep.equal(['Three sentence is here now.'])
  })

  it('gives up on a sentence after two replies off the contract', async function () {
    const { scheduler, calls, delivered } = harness('The results shows a gain.')
    scheduler.schedule(0)
    await clock.tickAsync(0)
    calls[0].resolve({ malformed: true })
    await clock.tickAsync(0)
    expect(calls).to.have.length(2)
    calls[1].resolve({ malformed: true })
    await clock.tickAsync(0)
    scheduler.schedule(0)
    await clock.tickAsync(0)
    expect(calls).to.have.length(2)
    expect(delivered.at(-1)).to.deep.equal([])
  })

  it('ignores results that arrive after a reset', async function () {
    const { scheduler, calls, delivered } = harness('The results shows a gain.')
    scheduler.schedule(0)
    await clock.tickAsync(0)
    scheduler.reset()
    expect(calls[0].args.signal?.aborted).to.equal(true)
    const before = delivered.length
    answer(calls[0], { 'The results shows a gain.': 'The results show a gain.' })
    await clock.tickAsync(0)
    expect(delivered.slice(before).flat()).to.deep.equal([])
  })

  it('shows nothing for a sentence edited while it was being checked', async function () {
    const { scheduler, calls, delivered, box } = harness('The results shows a gain. The method is fast.')
    scheduler.schedule(0)
    await clock.tickAsync(0)
    box.doc = 'The results shows a big gain. The method is fast.'
    answer(calls[0], { 'The results shows a gain.': 'The results show a gain.' })
    await clock.tickAsync(0)
    expect(delivered.at(-1)!.map(u => u.masked.text)).to.not.include('The results shows a gain.')
  })

  it('checks a repeated sentence once and shows it on both', async function () {
    const doc = 'The results shows a gain. The method is fast. The results shows a gain.'
    const { scheduler, calls, delivered } = harness(doc)
    scheduler.schedule(0)
    await clock.tickAsync(0)
    expect(targetTexts(calls[0])).to.deep.equal([
      'The results shows a gain.',
      'The method is fast.',
    ])
    answer(calls[0], { 'The results shows a gain.': 'The results show a gain.' })
    await clock.tickAsync(0)
    expect(delivered.at(-1)!.map(u => u.from)).to.deep.equal([0, doc.lastIndexOf('The results')])
  })

  it('caps batches at 600 words for an Ollama fast model', async function () {
    // Capitalised, so no sentence break looks false and joins them
    const doc = Array.from({ length: 12 }, (_, i) => `Word ${'word '.repeat(99)}end ${i}.`).join(' ')
    const ollama = harness(doc, { storedType: 'ollama' })
    ollama.scheduler.schedule(0)
    await clock.tickAsync(0)
    expect(ollama.calls[0].args.targets).to.have.length(5)

    const openai = harness(doc)
    openai.scheduler.schedule(0)
    await clock.tickAsync(0)
    expect(openai.calls[0].args.targets).to.have.length(10)
  })

  it('clears the underlines and sends nothing when turned off', async function () {
    const { scheduler, calls, delivered, statuses, box } = harness('The results shows a gain.')
    box.active = false
    scheduler.schedule(0)
    await clock.tickAsync(0)
    expect(calls).to.have.length(0)
    expect(delivered.at(-1)).to.deep.equal([])
    expect(statuses.at(-1) ?? { kind: 'idle' }).to.deep.equal({ kind: 'idle' })
  })

  it('sends nothing while the author is away from the page, and catches up on return', async function () {
    const { scheduler, calls, statuses, box } = harness('The results shows a gain.')
    box.attended = false
    scheduler.schedule(0)
    await clock.tickAsync(0)
    expect(calls).to.have.length(0)
    expect(statuses.at(-1) ?? { kind: 'idle' }).to.deep.equal({ kind: 'idle' })
    box.attended = true
    scheduler.schedule(0)
    await clock.tickAsync(0)
    expect(calls).to.have.length(1)
  })

  /** Checks `doc` and answers everything clean; returns the harness, ready for edits. */
  async function checked(doc: string, options: Parameters<typeof harness>[1] = {}) {
    const h = harness(doc, { slot: 'main', ...options })
    h.scheduler.schedule(0)
    await clock.tickAsync(0)
    while (h.calls.length > 0 && h.calls.at(-1)!.args.targets.length > 0 && !(h.calls.at(-1) as any).done) {
      const call = h.calls.at(-1)! as any
      call.done = true
      answer(call)
      await clock.tickAsync(0)
    }
    return h
  }

  async function edit(h: Awaited<ReturnType<typeof checked>>, doc: string, opts: { remote?: boolean } = {}) {
    h.box.doc = doc
    h.scheduler.noteEdit(opts)
    await clock.tickAsync(800)
  }

  const PARAGRAPH =
    'We trained the model on three datasets. The results shows a clear gain. Training took two days on one GPU.'

  it('asks nothing for changes a check would not read', async function () {
    const h = await checked(PARAGRAPH)
    expect(h.calls).to.have.length(1)
    // Spacing and line breaks
    await edit(h, PARAGRAPH.replace('The results', 'The   results').replace('. Training', '.\nTraining'))
    // Curly quotes
    await edit(h, h.box.doc.replace('clear gain', 'clear \u201Cgain\u201D'))
    await edit(h, h.box.doc.replace('clear \u201Cgain\u201D', 'clear "gain"'))
    expect(h.calls).to.have.length(2)
  })

  it('keeps showing an edit on a sentence whose spacing changed', async function () {
    const h = harness(PARAGRAPH, { slot: 'main' })
    h.scheduler.schedule(0)
    await clock.tickAsync(0)
    answer(h.calls[0], { 'The results shows a clear gain.': 'The results show a clear gain.' })
    await clock.tickAsync(0)
    await edit(h, PARAGRAPH.replace('results shows', 'results  shows'))
    expect(h.calls).to.have.length(1)
    const shown = h.delivered.at(-1)!
    expect(shown).to.have.length(1)
    const unit = shown[0]
    const e = unit.edits[0]
    expect(unit.masked.text.slice(e.from, e.to)).to.equal(e.original)
    expect([e.original, e.insert]).to.deep.equal(['shows', 'show'])
  })

  it('checks only the sentence whose words changed, not the file', async function () {
    const doc = `${PARAGRAPH}\n\n${numbered('Other', 15)}`
    const h = await checked(doc)
    const before = h.calls.length
    await edit(h, doc.replace('took two days', 'took three days'))
    expect(h.calls).to.have.length(before + 1)
    expect(targetTexts(h.calls.at(-1)!)).to.deep.equal(['Training took three days on one GPU.'])
  })

  it('checks a sentence again when a neighbour is rewritten, not for a fixed typo next door', async function () {
    const h = await checked(PARAGRAPH)
    // A typo fixed in the first sentence: only that sentence is checked
    await edit(h, PARAGRAPH.replace('three datasets', 'three data sets'))
    expect(targetTexts(h.calls.at(-1)!)).to.deep.equal(['We trained the model on three data sets.'])
    answer(h.calls.at(-1)!)
    await clock.tickAsync(0)
    // The first sentence rewritten: its neighbour reads differently now
    const rewritten = h.box.doc.replace(
      'We trained the model on three data sets.',
      'Nobody expected any improvement from this approach at first.'
    )
    await edit(h, rewritten)
    expect(targetTexts(h.calls.at(-1)!)).to.have.members([
      'Nobody expected any improvement from this approach at first.',
      'The results shows a clear gain.',
    ])
  })

  it('waits while the author edits a sentence, until the cursor leaves or it is ended', async function () {
    const h = await checked(PARAGRAPH)
    const count = h.calls.length
    const doc = `${PARAGRAPH} A new sentence is being writ`
    h.box.cursor = doc.length
    h.box.edits.local = doc.length
    await edit(h, doc)
    expect(h.calls).to.have.length(count)
    // Ended with a full stop, cursor at its end: checked at once
    const ended = `${doc}ten.`
    h.box.cursor = ended.length
    h.box.edits.local = ended.length
    await edit(h, ended)
    expect(h.calls).to.have.length(count + 1)
    expect(targetTexts(h.calls.at(-1)!)).to.deep.equal(['A new sentence is being written.'])
  })

  it('checks an edited sentence once the cursor leaves it', async function () {
    const h = await checked(PARAGRAPH)
    const count = h.calls.length
    const doc = PARAGRAPH.replace('took two days', 'took nearly two days')
    const at = doc.indexOf('nearly') + 6
    h.box.cursor = at
    h.box.edits.local = at
    await edit(h, doc)
    expect(h.calls).to.have.length(count)
    h.box.cursor = 0
    h.scheduler.schedule()
    await clock.tickAsync(800)
    expect(h.calls).to.have.length(count + 1)
  })

  it("waits for a collaborator to move on from the sentence they are typing", async function () {
    const h = await checked(PARAGRAPH)
    const count = h.calls.length
    let doc = `${PARAGRAPH} Someone else is typ`
    h.box.edits.remote = doc.length
    await edit(h, doc, { remote: true })
    expect(h.calls).to.have.length(count)
    // They edit elsewhere: their sentence is left, and checked
    doc = doc.replace('three datasets', 'three big datasets')
    h.box.edits.remote = doc.indexOf('big') + 3
    await edit(h, doc, { remote: true })
    expect(h.calls).to.have.length(count + 1)
    expect(targetTexts(h.calls.at(-1)!)).to.deep.equal(['Someone else is typ'])
  })

  it('remembers results across a reload: nothing is asked again', async function () {
    const h = await checked(PARAGRAPH)
    const again = harness(PARAGRAPH, { slot: 'main' })
    ;(again as any).scheduler = new Scheduler({
      ...(again.scheduler as any).deps,
      cache: h.cache,
    })
    again.scheduler.schedule(0)
    await clock.tickAsync(0)
    expect(again.calls).to.have.length(0)
  })

  describe('shared with collaborators and other tabs', function () {
    const KEY_CONTEXT = { slot: 'main' as const, model: 'tiny', variant: 'en-US' as const, style: false }
    const keyOf = (text: string) => cacheKey(KEY_CONTEXT, hashUnit('text', text))

    function sharedHarness(doc: string, stored: Record<string, any> = {}) {
      const lookups: string[][] = []
      const saved: Array<{ key: string; entry: any }> = []
      const shared = {
        lookup: async (keys: string[]) => {
          lookups.push(keys)
          return Object.fromEntries(keys.filter(k => stored[k]).map(k => [k, stored[k]]))
        },
        store: async (entries: Array<{ key: string; entry: any }>) => {
          saved.push(...entries)
        },
      }
      const h = harness(doc, { slot: 'main' })
      h.scheduler = new Scheduler({ ...(h.scheduler as any).deps, shared })
      return { ...h, lookups, saved }
    }

    it("uses a collaborator's result instead of asking the model", async function () {
      const doc = 'The results shows a gain. The method is fast.'
      const h = sharedHarness(doc, {
        [keyOf('The results shows a gain.')]: {
          edits: [{ from: 12, to: 17, original: 'shows', insert: 'show' }],
          text: 'The results shows a gain.',
        },
      })
      h.scheduler.schedule(0)
      await clock.tickAsync(0)
      expect(h.lookups).to.have.length(1)
      expect(h.calls).to.have.length(1)
      expect(targetTexts(h.calls[0])).to.deep.equal(['The method is fast.'])
      expect(h.delivered.at(-1)!.map(u => u.edits[0].insert)).to.deep.equal(['show'])
      answer(h.calls[0])
      await clock.tickAsync(0)
      // The new result is saved for the others, without dismissals
      expect(h.saved.map(item => item.key)).to.deep.equal([keyOf('The method is fast.')])
      expect(h.saved[0].entry).to.not.have.property('rejected')
      // Each sentence is looked up once
      h.scheduler.schedule(0)
      await clock.tickAsync(0)
      expect(h.lookups).to.have.length(1)
    })

    it('asks the model when the shared results cannot be reached', async function () {
      const h = harness('The results shows a gain.', { slot: 'main' })
      h.scheduler = new Scheduler({
        ...(h.scheduler as any).deps,
        shared: { lookup: () => Promise.reject(new Error('down')), store: async () => {} },
      })
      h.scheduler.schedule(0)
      await clock.tickAsync(0)
      expect(h.calls).to.have.length(1)
    })

    it('leaves sentences another tab is checking to that tab', async function () {
      const busy = new Set([keyOf('The results shows a gain.')])
      const claimed: string[][] = []
      const released: string[][] = []
      const tabs = {
        isBusy: (key: string) => busy.has(key),
        claim: (keys: string[]) => claimed.push(keys),
        release: (keys: string[]) => released.push(keys),
        publish: () => {},
      }
      const h = harness('The results shows a gain. The method is fast.', { slot: 'main' })
      h.scheduler = new Scheduler({ ...(h.scheduler as any).deps, tabs: tabs as any })
      h.scheduler.schedule(0)
      await clock.tickAsync(0)
      expect(targetTexts(h.calls[0])).to.deep.equal(['The method is fast.'])
      expect(claimed).to.deep.equal([[keyOf('The method is fast.')]])
      answer(h.calls[0])
      await clock.tickAsync(0)
      expect(released).to.deep.equal(claimed)
      // The other tab's result arrives: nothing is asked for that sentence
      h.scheduler.adopt(keyOf('The results shows a gain.'), { edits: [] })
      busy.clear()
      h.scheduler.schedule(0)
      await clock.tickAsync(0)
      expect(h.calls).to.have.length(1)
    })
  })

  it('reports progress through a large check', async function () {
    const { scheduler, calls, statuses } = harness(numbered('Zeta', 30), { slot: 'main' })
    scheduler.schedule(0)
    await clock.tickAsync(0)
    expect(statuses.at(-1)).to.deep.equal({ kind: 'checking', progress: { checked: 0, total: 30 } })
    answer(calls[0])
    await clock.tickAsync(0)
    expect(statuses.some(s => s.kind === 'checking' && s.progress?.checked === 10)).to.equal(true)
    answer(calls[1])
    await clock.tickAsync(0)
    answer(calls[2])
    await clock.tickAsync(0)
    expect(statuses.at(-1)).to.deep.equal({ kind: 'idle' })
  })

  it('shows no progress for a small check', async function () {
    const { scheduler, statuses } = harness('The results shows a gain.')
    scheduler.schedule(0)
    await clock.tickAsync(0)
    expect(statuses.at(-1)).to.deep.equal({ kind: 'checking' })
  })
})
