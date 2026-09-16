import { expect } from 'chai'
import sinon from 'sinon'
import customLocalStorage from '@/infrastructure/local-storage'
import {
  HANDOFF_TTL_MS,
  requestChatHandoff,
  takePendingHandoff,
} from '../../../../frontend/js/features/ai-assist/agent/chat-handoff'

const PAYLOAD = {
  entryId: 'entry-1',
  level: 'error' as const,
  file: 'chapter3.tex',
  line: 87,
  message: 'Undefined control sequence',
  text: "Let's keep working on this error.",
  contextText: '<compile-error/>',
}

describe('chat handoff store', function () {
  beforeEach(function () {
    customLocalStorage.clear()
  })

  afterEach(function () {
    sinon.restore()
    customLocalStorage.clear()
  })

  it('hands a stored payload back to the chat', function () {
    requestChatHandoff('p1', PAYLOAD)

    const taken = takePendingHandoff('p1')
    expect(taken).to.include({ entryId: 'entry-1', file: 'chapter3.tex' })
    expect(taken?.contextText).to.equal('<compile-error/>')
  })

  it('clears the payload once taken, so it is consumed exactly once', function () {
    requestChatHandoff('p1', PAYLOAD)

    expect(takePendingHandoff('p1')).to.not.equal(null)
    expect(takePendingHandoff('p1')).to.equal(null)
  })

  it('notifies an already-mounted chat panel', function () {
    const listener = sinon.stub()
    window.addEventListener('aiAssist:chatHandoff', listener)

    requestChatHandoff('p1', PAYLOAD)

    window.removeEventListener('aiAssist:chatHandoff', listener)
    expect(listener.calledOnce).to.equal(true)
  })

  it('keeps handoffs from different projects apart', function () {
    requestChatHandoff('p1', PAYLOAD)

    expect(takePendingHandoff('p2')).to.equal(null)
    expect(takePendingHandoff('p1')).to.not.equal(null)
  })

  it('replaces an unconsumed handoff rather than queueing behind it', function () {
    requestChatHandoff('p1', PAYLOAD)
    requestChatHandoff('p1', { ...PAYLOAD, entryId: 'entry-2' })

    expect(takePendingHandoff('p1')?.entryId).to.equal('entry-2')
    expect(takePendingHandoff('p1')).to.equal(null)
  })

  it('drops a handoff that has gone stale', function () {
    const clock = sinon.useFakeTimers(Date.now())
    requestChatHandoff('p1', PAYLOAD)

    clock.tick(HANDOFF_TTL_MS + 1)

    expect(takePendingHandoff('p1')).to.equal(null)
    clock.restore()
  })

  it('degrades to null rather than throwing on unreadable storage', function () {
    sinon.stub(customLocalStorage, 'getItem').throws(new Error('denied'))

    expect(() => takePendingHandoff('p1')).to.not.throw()
    expect(takePendingHandoff('p1')).to.equal(null)
  })
})
