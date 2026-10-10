import { expect } from 'chai'
import { waitFor } from '@testing-library/react'
import { TabShare } from '../../../../frontend/js/features/ai-assist/language-suggestions/tab-share'

/** Tabs in one process: every open channel of a name hears the others, later. */
class FakeChannel {
  static open = new Set<FakeChannel>()
  onmessage: ((event: { data: unknown }) => void) | null = null
  constructor(readonly name: string) {
    FakeChannel.open.add(this)
  }

  postMessage(data: unknown) {
    for (const other of FakeChannel.open) {
      if (other !== this && other.name === this.name) {
        setTimeout(() => other.onmessage?.({ data: structuredClone(data) }))
      }
    }
  }

  close() {
    FakeChannel.open.delete(this)
  }
}

describe('language suggestions: sharing between tabs', function () {
  let tabs: TabShare[] = []
  const open = (listener: ConstructorParameters<typeof TabShare>[0]) =>
    new TabShare(listener, FakeChannel as unknown as typeof BroadcastChannel)

  afterEach(function () {
    tabs.forEach(tab => tab.close())
    tabs = []
  })

  it('does nothing where tabs cannot talk', function () {
    const tab = new TabShare(() => {}, null)
    tab.claim(['k'])
    tab.publish('k', { edits: [] })
    expect(tab.isBusy('k')).to.equal(false)
    tab.close()
  })

  it('tells other tabs what it is checking, and hands over results', async function () {
    const received: Array<[string | undefined, unknown]> = []
    const a = open(() => {})
    const b = open((key, entry) => received.push([key, entry]))
    tabs.push(a, b)

    a.claim(['k1', 'k2'])
    await waitFor(() => expect(b.isBusy('k1')).to.equal(true))
    a.publish('k1', { edits: [] })
    await waitFor(() => expect(received).to.deep.include(['k1', { edits: [] }]))
    expect(b.isBusy('k1')).to.equal(false)
    a.release(['k2'])
    await waitFor(() => expect(b.isBusy('k2')).to.equal(false))
  })

  it('tells a tab opened later, and frees everything when a tab closes', async function () {
    const a = open(() => {})
    tabs.push(a)
    a.claim(['k1'])
    const late = open(() => {})
    tabs.push(late)
    await waitFor(() => expect(late.isBusy('k1')).to.equal(true))
    a.close()
    await waitFor(() => expect(late.isBusy('k1')).to.equal(false))
  })
})
