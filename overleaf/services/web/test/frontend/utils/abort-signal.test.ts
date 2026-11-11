import { expect } from 'chai'
import { signalWithTimeout } from '@/utils/abort-signal'

// The test bootstrap swaps AbortController for jsdom's, which the native
// AbortSignal.any rejects, so these cases use signals from AbortSignal itself.
describe('signalWithTimeout', function () {
  it('returns a live signal when called without arguments', function () {
    expect(signalWithTimeout().aborted).to.be.false
  })

  it('is aborted with the caller reason when the caller signal is already aborted', function () {
    const reason = new Error('cancelled')
    const signal = signalWithTimeout(AbortSignal.abort(reason), 60000)
    expect(signal.aborted).to.be.true
    expect(signal.reason).to.equal(reason)
  })

  it('aborts with a TimeoutError after the timeout', async function () {
    const signal = signalWithTimeout(undefined, 10)
    expect(signal.aborted).to.be.false
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(signal.aborted).to.be.true
    expect((signal.reason as DOMException).name).to.equal('TimeoutError')
  })
})
