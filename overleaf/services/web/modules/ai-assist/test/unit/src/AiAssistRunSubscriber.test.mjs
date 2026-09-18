import { expect } from 'chai'
import sinon from 'sinon'
import { AiAssistRunSubscriber } from '../../../app/src/AiAssistRunSubscriber.mjs'

function fakeClient() {
  const handlers = []
  return {
    handlers,
    on: sinon.stub().callsFake((event, fn) => {
      if (event === 'message') handlers.push(fn)
    }),
    subscribe: sinon.stub().resolves(),
    unsubscribe: sinon.stub().resolves(),
    emit(channel, message) {
      for (const fn of handlers) fn(channel, message)
    },
  }
}

describe('AiAssistRunSubscriber', function () {
  it('opens exactly one Redis connection for many streams', async function () {
    const client = fakeClient()
    const clientFactory = sinon.stub().returns(client)
    const subscriber = new AiAssistRunSubscriber({ clientFactory })

    await subscriber.subscribe('chan-a', () => {})
    await subscriber.subscribe('chan-b', () => {})
    await subscriber.subscribe('chan-a', () => {})

    expect(clientFactory.callCount).to.equal(1)
    expect(client.on.withArgs('message').callCount).to.equal(1)
  })

  it('subscribes to a channel once and fans messages out to every listener', async function () {
    const client = fakeClient()
    const subscriber = new AiAssistRunSubscriber({ clientFactory: () => client })
    const first = sinon.spy()
    const second = sinon.spy()
    const other = sinon.spy()

    await subscriber.subscribe('chan-a', first)
    await subscriber.subscribe('chan-a', second)
    await subscriber.subscribe('chan-b', other)
    client.emit('chan-a', 'payload')

    expect(client.subscribe.withArgs('chan-a').callCount).to.equal(1)
    expect(first.calledOnceWith('payload')).to.equal(true)
    expect(second.calledOnceWith('payload')).to.equal(true)
    expect(other.called).to.equal(false)
  })

  it('unsubscribes from Redis only when the last listener leaves', async function () {
    const client = fakeClient()
    const subscriber = new AiAssistRunSubscriber({ clientFactory: () => client })
    const releaseFirst = await subscriber.subscribe('chan-a', () => {})
    const releaseSecond = await subscriber.subscribe('chan-a', () => {})

    releaseFirst()
    expect(client.unsubscribe.called).to.equal(false)

    releaseSecond()
    releaseSecond()
    expect(client.unsubscribe.withArgs('chan-a').callCount).to.equal(1)
  })

  it('stops delivering to a released listener', async function () {
    const client = fakeClient()
    const subscriber = new AiAssistRunSubscriber({ clientFactory: () => client })
    const listener = sinon.spy()
    const keep = sinon.spy()
    const release = await subscriber.subscribe('chan-a', listener)
    await subscriber.subscribe('chan-a', keep)

    release()
    client.emit('chan-a', 'later')

    expect(listener.called).to.equal(false)
    expect(keep.calledOnceWith('later')).to.equal(true)
  })

  it('does not keep a listener registered when SUBSCRIBE fails', async function () {
    const client = fakeClient()
    client.subscribe.rejects(new Error('redis down'))
    const subscriber = new AiAssistRunSubscriber({ clientFactory: () => client })
    const listener = sinon.spy()

    let caught = null
    try {
      await subscriber.subscribe('chan-a', listener)
    } catch (err) {
      caught = err
    }
    client.emit('chan-a', 'payload')

    expect(caught?.message).to.equal('redis down')
    expect(listener.called).to.equal(false)
  })

  it('keeps delivering to other listeners when one throws', async function () {
    const client = fakeClient()
    const subscriber = new AiAssistRunSubscriber({ clientFactory: () => client })
    const good = sinon.spy()
    await subscriber.subscribe('chan-a', () => {
      throw new Error('bad listener')
    })
    await subscriber.subscribe('chan-a', good)

    client.emit('chan-a', 'payload')

    expect(good.calledOnceWith('payload')).to.equal(true)
  })
})
