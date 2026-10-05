import { describe, it, beforeEach } from 'vitest'
import { expect } from 'chai'
import { AiAssistRunStore } from '../../../app/src/AiAssistRunStore.mjs'

describe('AiAssistRunStore mode support', () => {
  let mockRedis
  let store

  beforeEach(() => {
    const data = new Map()
    mockRedis = {
      hset: async (key, fieldOrObj, val) => {
        let entry = data.get(key) || {}
        if (typeof fieldOrObj === 'object') {
          entry = { ...entry, ...fieldOrObj }
        } else {
          entry[fieldOrObj] = val
        }
        data.set(key, entry)
      },
      hgetall: async key => data.get(key) || {},
      hincrby: async (key, field, by) => {
        const entry = data.get(key) || {}
        entry[field] = String(Number(entry[field] || 0) + by)
        data.set(key, entry)
        return Number(entry[field])
      },
      sadd: async () => {},
      srem: async () => {},
      expire: async () => {},
    }
    store = new AiAssistRunStore(mockRedis)
  })

  it('stores and retrieves mode on createRun', async () => {
    await store.createRun({
      runId: 'run_123',
      projectId: 'proj_1',
      userId: 'user_1',
      mode: 'plan',
    })

    const run = await store.getRun('run_123')
    expect(run).to.not.be.null
    expect(run.mode).to.equal('plan')
  })

  it('defaults mode to manual when omitted on createRun', async () => {
    await store.createRun({
      runId: 'run_def',
      projectId: 'proj_1',
      userId: 'user_1',
    })

    const run = await store.getRun('run_def')
    expect(run.mode).to.equal('manual')
  })

  it('updates mode via setMode', async () => {
    await store.createRun({
      runId: 'run_456',
      projectId: 'proj_1',
      userId: 'user_1',
      mode: 'manual',
    })

    await store.setMode('run_456', 'acceptEdits')
    const run = await store.getRun('run_456')
    expect(run.mode).to.equal('acceptEdits')
  })

  it('keeps the orphan clock stopped while a follower is left', async () => {
    await store.createRun({ runId: 'run_f', projectId: 'p', userId: 'u' })
    await store.addWatcher('run_f')
    await store.addWatcher('run_f', { follower: true })
    await store.removeWatcher('run_f')

    let run = await store.getRun('run_f')
    expect(Number(run.watchers)).to.equal(0)
    expect(Number(run.followers)).to.equal(1)
    expect(run.zeroSince).to.equal('')
    expect(await store.getWatcherCount('run_f')).to.equal(0)

    await store.removeWatcher('run_f', { follower: true })
    run = await store.getRun('run_f')
    expect(Number(run.followers)).to.equal(0)
    expect(Number(run.zeroSince)).to.be.greaterThan(0)
  })
})
