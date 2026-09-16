import { expect } from 'chai'
import sinon from 'sinon'
import {
  isChatBusy,
  setChatBusy,
} from '../../../../frontend/js/features/ai-assist/agent/chat-activity'

describe('chat activity signal', function () {
  afterEach(function () {
    setChatBusy('p1', false)
    setChatBusy('p2', false)
    sinon.restore()
  })

  it('reports idle for a project that has never run anything', function () {
    expect(isChatBusy('never-seen')).to.equal(false)
  })

  it('reports busy while the chat is running', function () {
    setChatBusy('p1', true)
    expect(isChatBusy('p1')).to.equal(true)
  })

  it('reports idle again once the run finishes', function () {
    setChatBusy('p1', true)
    setChatBusy('p1', false)
    expect(isChatBusy('p1')).to.equal(false)
  })

  it('keeps projects independent', function () {
    setChatBusy('p1', true)
    expect(isChatBusy('p2')).to.equal(false)
  })

  it('notifies subscribers when the flag changes', function () {
    const listener = sinon.stub()
    window.addEventListener('aiAssist:chatBusyChange', listener)

    setChatBusy('p1', true)

    window.removeEventListener('aiAssist:chatBusyChange', listener)
    expect(listener.calledOnce).to.equal(true)
  })

  it('does not notify when the flag is set to the value it already has', function () {
    setChatBusy('p1', true)

    const listener = sinon.stub()
    window.addEventListener('aiAssist:chatBusyChange', listener)
    setChatBusy('p1', true)
    window.removeEventListener('aiAssist:chatBusyChange', listener)

    expect(listener.called).to.equal(false)
  })
})
