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
})
