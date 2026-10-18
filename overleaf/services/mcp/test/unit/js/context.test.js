import { expect } from 'chai'
import { mapLimit } from '../../../src/context.js'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

describe('mapLimit', function () {
  it('keeps results in input order even when items finish out of order', async function () {
    const out = await mapLimit([30, 10, 20], 2, async (ms, index) => {
      await delay(ms)
      return `${index}:${ms}`
    })
    expect(out).to.deep.equal(['0:30', '1:10', '2:20'])
  })

  it('never has more calls in flight than the limit', async function () {
    let inFlight = 0
    let peak = 0
    await mapLimit(Array.from({ length: 10 }, (_, i) => i), 3, async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await delay(2)
      inFlight--
    })
    expect(peak).to.equal(3)
  })

  it('rejects with the first failure and starts no further items', async function () {
    const started = []
    let caught = null
    try {
      await mapLimit([1, 2, 3, 4, 5], 1, async n => {
        started.push(n)
        if (n === 2) throw new Error('boom')
        return n
      })
    } catch (err) {
      caught = err
    }
    expect(caught.message).to.equal('boom')
    expect(started).to.deep.equal([1, 2])
  })

  it('resolves an empty list without calling the function', async function () {
    expect(await mapLimit([], 4, async () => 'never')).to.deep.equal([])
  })
})
