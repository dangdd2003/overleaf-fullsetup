import { describe, it } from 'vitest'
import { expect } from 'chai'
import sinon from 'sinon'
import { countActiveRunsForUser } from '../../../app/src/AiAssistRunLimits.mjs'

describe('countActiveRunsForUser', function () {
  const storeWith = (runIds, runs) => ({
    getActiveRunsForUser: sinon.stub().resolves(runIds),
    getRun: sinon.stub().callsFake(async runId => {
      const run = runs[runId]
      if (run instanceof Error) throw run
      return run ?? null
    }),
    removeActiveRunForUser: sinon.stub().resolves(),
  })

  it("counts every live run in the user's own index", async function () {
    const runIds = Array.from({ length: 250 }, (_, i) => `r${i}`)
    const runs = Object.fromEntries(
      runIds.map(id => [id, { userId: 'u1', status: 'running' }])
    )
    const store = storeWith(runIds, runs)
    expect(await countActiveRunsForUser('u1', { store })).to.equal(250)
    expect(store.getActiveRunsForUser.calledWith('u1')).to.be.true
  })

  it('drops finished, missing and foreign runs from the index', async function () {
    const store = storeWith(['live', 'done', 'gone', 'other', 'flaky'], {
      live: { userId: 'u1', status: 'awaiting_approval' },
      done: { userId: 'u1', status: 'done' },
      other: { userId: 'u2', status: 'running' },
      flaky: new Error('redis blip'),
    })
    expect(await countActiveRunsForUser('u1', { store })).to.equal(1)
    const removed = store.removeActiveRunForUser.args.map(args => args[1])
    // A run that could not be read is kept: it may still be going
    expect(removed).to.have.members(['done', 'gone', 'other'])
  })

  it('counts nothing without a user', async function () {
    const store = storeWith(['r1'], { r1: { userId: 'u1', status: 'running' } })
    expect(await countActiveRunsForUser(null, { store })).to.equal(0)
    expect(store.getActiveRunsForUser.called).to.be.false
  })
})
