import { expect } from 'chai'
import sinon from 'sinon'
import {
  CACHE_SIZE,
  cacheKey,
  CompletionCache,
  RateGate,
} from '../../../../frontend/js/features/ai-assist/completion/rate'

describe('completion: request gap and cache', function () {
  let clock: sinon.SinonFakeTimers

  beforeEach(function () {
    clock = sinon.useFakeTimers({ now: 10000 })
  })

  afterEach(function () {
    clock.restore()
  })

  it('runs at once when no request started recently', function () {
    const gate = new RateGate()
    const run = sinon.spy()
    gate.schedule(run)
    expect(run.callCount).to.equal(1)
  })

  it('waits for the rest of the 1 s gap', function () {
    const gate = new RateGate()
    const first = sinon.spy()
    const second = sinon.spy()
    gate.schedule(first)
    clock.tick(200)
    gate.schedule(second)
    expect(second.callCount).to.equal(0)
    expect(gate.waiting).to.equal(true)
    clock.tick(799)
    expect(second.callCount).to.equal(0)
    clock.tick(1)
    expect(second.callCount).to.equal(1)
    expect(gate.waiting).to.equal(false)
  })

  it('a newer trigger replaces a waiting one', function () {
    const gate = new RateGate()
    const runs: string[] = []
    gate.schedule(() => runs.push('a'))
    clock.tick(100)
    gate.schedule(() => runs.push('b'))
    gate.schedule(() => runs.push('c'))
    clock.tick(2000)
    expect(runs).to.deep.equal(['a', 'c'])
  })

  it('cancel and reset drop a waiting trigger; reset also forgets the last start', function () {
    const gate = new RateGate()
    const late = sinon.spy()
    gate.schedule(() => {})
    gate.schedule(late)
    gate.cancel()
    clock.tick(2000)
    expect(late.callCount).to.equal(0)
    gate.schedule(() => {})
    gate.reset()
    const now = sinon.spy()
    gate.schedule(now)
    expect(now.callCount).to.equal(1)
  })

  it('keeps the 32 most recently used completions', function () {
    const cache = new CompletionCache()
    for (let i = 0; i < CACHE_SIZE; i++) cache.set(`k${i}`, `t${i}`)
    expect(cache.get('k0')).to.equal('t0') // now the most recent
    cache.set('new', 'x')
    expect(cache.get('k1')).to.equal(undefined)
    expect(cache.get('k0')).to.equal('t0')
    expect(cache.get('new')).to.equal('x')
    cache.clear()
    expect(cache.get('new')).to.equal(undefined)
  })

  it('keys on the model, the kind and the text nearest the cursor', function () {
    const key = cacheKey('m', 'prose', 'x'.repeat(1000) + 'end', 'start' + 'y'.repeat(1000))
    expect(key).to.equal(cacheKey('m', 'prose', 'z'.repeat(5) + 'x'.repeat(1000) + 'end', 'start' + 'y'.repeat(1000)))
    expect(key).to.not.equal(cacheKey('other', 'prose', 'x'.repeat(1000) + 'end', 'start' + 'y'.repeat(1000)))
    expect(key).to.not.equal(cacheKey('m', 'block', 'x'.repeat(1000) + 'end', 'start' + 'y'.repeat(1000)))
  })
})
