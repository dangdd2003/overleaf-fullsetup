import { expect } from 'chai'
import sinon from 'sinon'
import { AiAssistRunStore } from '../../../app/src/AiAssistRunStore.mjs'

describe('AiAssistRunStore', function () {
  let mockRedis
  let store

  beforeEach(function () {
    const data = new Map()
    const lists = new Map()

    mockRedis = {
      hset: sinon.stub().callsFake(async (key, field, val) => {
        if (!data.has(key)) data.set(key, new Map())
        if (typeof field === 'object') {
          for (const [k, v] of Object.entries(field)) data.get(key).set(k, String(v))
        } else {
          data.get(key).set(field, String(val))
        }
      }),
      hgetall: sinon.stub().callsFake(async key => {
        if (!data.has(key)) return {}
        return Object.fromEntries(data.get(key).entries())
      }),
      incr: sinon.stub().callsFake(async key => {
        const curr = parseInt(data.get(key)?.get('val') || '0', 10) + 1
        if (!data.has(key)) data.set(key, new Map())
        data.get(key).set('val', String(curr))
        return curr
      }),
      rpush: sinon.stub().callsFake(async (key, val) => {
        if (!lists.has(key)) lists.set(key, [])
        lists.get(key).push(val)
        return lists.get(key).length
      }),
      lrange: sinon.stub().callsFake(async (key, start, stop) => {
        const arr = lists.get(key) || []
        const end = stop === -1 ? undefined : stop + 1
        return arr.slice(start, end)
      }),
      publish: sinon.stub().resolves(1),
      expire: sinon.stub().resolves(1),
    }

    store = new AiAssistRunStore(mockRedis)
  })

  it('creates a run with running status and TTL', async function () {
    await store.createRun({
      runId: 'run-123',
      projectId: 'proj-456',
      userId: 'user-789',
    })

    const run = await store.getRun('run-123')
    expect(run.status).to.equal('running')
    expect(run.projectId).to.equal('proj-456')
    expect(run.userId).to.equal('user-789')
    expect(mockRedis.expire.called).to.be.true
  })

  it('appends events with incrementing seq and publishes them', async function () {
    await store.createRun({ runId: 'run-123', projectId: 'p1', userId: 'u1' })

    const ev1 = { type: 'thinking', text: 'analyzing...' }
    const seq1 = await store.appendEvent('run-123', ev1)
    expect(seq1).to.equal(1)

    const ev2 = { type: 'text', text: 'Hello' }
    const seq2 = await store.appendEvent('run-123', ev2)
    expect(seq2).to.equal(2)

    const events = await store.getEvents('run-123', 0)
    expect(events).to.have.lengthOf(2)
    expect(events[0].seq).to.equal(1)
    expect(events[0].event).to.deep.equal(ev1)
    expect(events[1].seq).to.equal(2)
    expect(events[1].event).to.deep.equal(ev2)

    expect(mockRedis.publish.calledWith('ai-assist:run:run-123:channel')).to.be.true
  })

  it('filters events using sinceSeq parameter', async function () {
    await store.createRun({ runId: 'run-123', projectId: 'p1', userId: 'u1' })
    await store.appendEvent('run-123', { type: 'text', text: 'a' })
    await store.appendEvent('run-123', { type: 'text', text: 'b' })
    await store.appendEvent('run-123', { type: 'text', text: 'c' })

    const eventsAfter1 = await store.getEvents('run-123', 1)
    expect(eventsAfter1).to.have.lengthOf(2)
    expect(eventsAfter1[0].seq).to.equal(2)
    expect(eventsAfter1[1].seq).to.equal(3)
  })

  it('stores and retrieves pending approvals', async function () {
    await store.createRun({ runId: 'run-123', projectId: 'p1', userId: 'u1' })
    const edit = { path: 'main.tex', oldText: 'foo', newText: 'bar' }
    await store.setPendingApproval('run-123', { id: 'call-1', edit })

    const retrieved = await store.getPendingApproval('run-123')
    expect(retrieved).to.deep.equal({ id: 'call-1', edit })
  })
})
