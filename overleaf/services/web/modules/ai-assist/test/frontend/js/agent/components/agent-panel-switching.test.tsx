import { expect } from 'chai'
import sinon from 'sinon'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import fetchMock from 'fetch-mock'
import customLocalStorage from '@/infrastructure/local-storage'
import { ProjectSnapshot } from '@/infrastructure/project-snapshot'
import { AgentPanel } from '../../../../../frontend/js/features/ai-assist/components/agent/agent-panel'
import {
  clearConversation,
  loadConversation,
  saveConversation,
} from '../../../../../frontend/js/features/ai-assist/agent/conversation-store'
import { stopFollowingRun } from '../../../../../frontend/js/features/ai-assist/agent/background/detached-run-follower'
import { LocalCompileContext } from '@/shared/context/local-compile-context'
import {
  EditorProviders,
  PROJECT_ID,
} from '../../../../../../../test/frontend/helpers/editor-providers'
import { resetMeta } from '../../../../../../../test/frontend/helpers/reset-meta'

const STORED_PROVIDER = {
  type: 'openai' as const,
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-4o-mini',
}

const RUNS = /\/ai-assist\/projects\/[^/]+\/runs$/
const STOP = /\/ai-assist\/runs\/[^/]+\/stop$/

/** Stands in for a run's event stream; `emit` delivers an event to the panel. */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  onmessage: ((message: { data: string }) => void) | null = null
  onerror: ((err: unknown) => void) | null = null
  seq = 0
  constructor(public url: string) {
    // The server sends only the events after `since`, numbered on from there
    this.seq = Number(/[?&]since=(\d+)/.exec(url)?.[1] ?? 0)
    FakeEventSource.instances.push(this)
  }

  close() {}

  /** The server has sent every event the run had sent before this stream. */
  caughtUp() {
    act(() => {
      this.onmessage?.({ data: JSON.stringify({ caughtUp: true }) })
    })
  }

  emit(event: Record<string, unknown>) {
    act(() => {
      this.onmessage?.({
        data: JSON.stringify({ seq: ++this.seq, event }),
      })
    })
  }
}

const MockLocalCompileProvider: React.FC<React.PropsWithChildren> = ({
  children,
}) => {
  const value: any = {
    autoCompile: false,
    compiling: false,
    startCompile: async () => {},
    logEntries: { all: [], errors: [], warnings: [], typesetting: [] },
    rawLog: '',
  }
  return (
    <LocalCompileContext.Provider value={value}>
      {children}
    </LocalCompileContext.Provider>
  )
}

function renderPanel() {
  return render(
    <EditorProviders
      mockCompileOnLoad
      providers={{ LocalCompileProvider: MockLocalCompileProvider }}
    >
      <AgentPanel />
    </EditorProviders>
  )
}

function callsTo(matcher: RegExp) {
  return fetchMock.callHistory.calls().filter(call => matcher.test(call.url))
}

function composer() {
  return screen.getByPlaceholderText(
    /what would you like to do/i
  ) as HTMLTextAreaElement
}

function typeAndSend(text: string) {
  fireEvent.change(composer(), { target: { value: text } })
  fireEvent.keyDown(composer(), { key: 'Enter' })
}

const CHATS = /\/ai-assist\/projects\/[^/]+\/chats\/[^/]+$/

const activeChatId = () =>
  customLocalStorage.getItem(`ai-assist:chat-id:${PROJECT_ID}`) as string

function savesOf(chatId: string) {
  return fetchMock.callHistory
    .calls()
    .filter(
      call =>
        call.url.endsWith(`/chats/${chatId}`) &&
        call.options?.method?.toUpperCase() === 'PUT'
    )
    .map(call => JSON.parse(String(call.options?.body ?? '{}')))
}

function liveStreams() {
  return FakeEventSource.instances.filter(es => !es.url.includes('watch=0'))
}

function passiveStreams() {
  return FakeEventSource.instances.filter(es => es.url.includes('watch=0'))
}

describe('AgentPanel switching chats', function () {
  let originalEventSource: any

  beforeEach(function () {
    resetMeta()
    window.metaAttributesCache.set('ol-aiAssistEnabled', true)
    window.metaAttributesCache.set('ol-showAiFeatures', true)
    clearConversation(PROJECT_ID)
    fetchMock.removeRoutes().clearHistory()
    customLocalStorage.clear()
    customLocalStorage.setItem('ai-assist:provider', STORED_PROVIDER)
    customLocalStorage.setItem('ai-assist:consent', true)
    customLocalStorage.setItem(`ai-assist:chat-id:${PROJECT_ID}`, 'chat_first')

    sinon.stub(ProjectSnapshot.prototype, 'refresh').resolves()
    sinon.stub(ProjectSnapshot.prototype, 'getDocPaths').returns(['main.tex'])
    sinon
      .stub(ProjectSnapshot.prototype, 'getDocContents')
      .callsFake(() => 'hi')
    sinon
      .stub(ProjectSnapshot.prototype, 'getBinaryFilePathsWithHash')
      .returns([])

    fetchMock.put(CHATS, { id: 'saved' })
    fetchMock.post(STOP, { ok: true })

    FakeEventSource.instances = []
    originalEventSource = globalThis.EventSource
    globalThis.EventSource = FakeEventSource as any
  })

  afterEach(function () {
    for (const id of ['chat_first', 'chat_other']) {
      stopFollowingRun(PROJECT_ID, id)
    }
    sinon.restore()
    globalThis.EventSource = originalEventSource
    clearConversation(PROJECT_ID)
    fetchMock.removeRoutes().clearHistory()
    customLocalStorage.clear()
  })

  it('keeps and saves a chat whose first message has no reply yet when New chat is clicked', async function () {
    fetchMock.get(CHATS, 404)
    // The provider request never comes back
    fetchMock.post(RUNS, () => new Promise(() => {}))
    renderPanel()

    typeAndSend('first question')
    await waitFor(() => expect(callsTo(RUNS)).to.have.length(1))
    fireEvent.click(screen.getByLabelText('New chat'))

    expect(activeChatId()).to.not.equal('chat_first')
    await waitFor(() => expect(savesOf('chat_first')).to.have.length(1))
    const [saved] = savesOf('chat_first')
    expect(saved.transcript.map((entry: any) => entry.text)).to.include(
      'first question'
    )
    expect(
      loadConversation(PROJECT_ID, 'chat_first').map(entry => entry.text)
    ).to.include('first question')
    // Nothing of the chat left is shown in the new one
    expect(screen.queryByText('first question')).to.equal(null)
    expect(callsTo(STOP)).to.have.length(0)
  })

  it("lets the left chat's run go on in parallel and saves its reply when it lands", async function () {
    fetchMock.get(CHATS, 404)
    fetchMock.post(RUNS, { runId: 'run-left' })
    renderPanel()

    typeAndSend('write the intro')
    await waitFor(() => expect(liveStreams()).to.have.length(1))
    liveStreams()[0].emit({ type: 'text', text: 'Working on' })

    fireEvent.click(screen.getByLabelText('New chat'))
    expect(callsTo(STOP)).to.have.length(0)
    await waitFor(() => expect(passiveStreams()).to.have.length(1))
    const follower = passiveStreams()[0]
    // Carries on from the last event the panel had, not from the start
    expect(follower.url).to.include('/runs/run-left/stream?since=1')

    follower.emit({ type: 'text', text: ' it. Done.' })
    follower.emit({ type: 'turnFinished', reason: 'stop' })

    await waitFor(() => {
      const saves = savesOf('chat_first')
      const last = saves.at(-1)
      expect(last?.transcript.at(-1)).to.deep.include({
        role: 'assistant',
        text: 'Working on it. Done.',
      })
    })
    expect(
      customLocalStorage.getItem(`ai-assist:detached-runs:${PROJECT_ID}`)
    ).to.not.have.property('chat_first')
    expect(screen.queryByText(/Working on it/)).to.equal(null)
  })

  it('gives a run started as its chat was left to that chat, not the new one', async function () {
    fetchMock.get(CHATS, 404)
    let respond: (value: any) => void = () => {}
    fetchMock.post(RUNS, () => new Promise(resolve => (respond = resolve)))
    renderPanel()

    typeAndSend('check the bibliography')
    await waitFor(() => expect(callsTo(RUNS)).to.have.length(1))
    fireEvent.click(screen.getByLabelText('New chat'))
    await act(async () => {
      respond({ runId: 'run-late' })
    })

    await waitFor(() =>
      expect(
        customLocalStorage.getItem(`ai-assist:detached-runs:${PROJECT_ID}`)
      ).to.have.nested.property('chat_first.runId', 'run-late')
    )
    expect(liveStreams()).to.have.length(0)
    expect(passiveStreams()).to.have.length(1)
    expect(
      customLocalStorage.getItem(`ai-assist:active-run:${PROJECT_ID}`)
    ).to.equal(null)
  })

  it('opens a chat from the history at once, without waiting for the server', async function () {
    saveConversation(PROJECT_ID, 'chat_other', [
      { id: 'u0', role: 'user', text: 'an older question' },
    ])
    fetchMock.get(`/ai-assist/projects/${PROJECT_ID}/chats`, {
      chats: [
        {
          id: 'chat_other',
          title: 'Older chat',
          createdAt: 1,
          updatedAt: 2,
          messageCount: 1,
        },
      ],
    })
    let respond: (value: any) => void = () => {}
    fetchMock.get(
      `/ai-assist/projects/${PROJECT_ID}/chats/chat_other`,
      () => new Promise(resolve => (respond = resolve))
    )
    fetchMock.get(CHATS, 404)
    renderPanel()

    fireEvent.click(screen.getByRole('button', { name: 'Chat history' }))
    fireEvent.click(await screen.findByText('Older chat'))

    // Shown from this browser's copy while the server's is still on its way
    expect(activeChatId()).to.equal('chat_other')
    expect(screen.getByText('an older question')).to.exist

    await act(async () => {
      respond({
        id: 'chat_other',
        title: 'Older chat',
        createdAt: 1,
        updatedAt: 2,
        messageCount: 2,
        transcript: [
          { id: 'u0', role: 'user', text: 'an older question' },
          { id: 'a1', role: 'assistant', text: 'its answer', toolCalls: [] },
        ],
      })
    })
    expect(await screen.findByText('its answer')).to.exist
    expect(
      fetchMock.callHistory
        .calls()
        .filter(call =>
          call.url.endsWith(
            `/ai-assist/projects/${PROJECT_ID}/chats/chat_other`
          )
        )
    ).to.have.length(1)
  })

  /** The history lists chat_first; its server copy is the last one saved. */
  function serveFirstChatFromHistory() {
    fetchMock.get(`/ai-assist/projects/${PROJECT_ID}/chats`, {
      chats: [
        {
          id: 'chat_first',
          title: 'First chat',
          createdAt: 1,
          updatedAt: 2,
          messageCount: 2,
        },
      ],
    })
    fetchMock.get(`/ai-assist/projects/${PROJECT_ID}/chats/chat_first`, () => ({
      id: 'chat_first',
      title: 'First chat',
      createdAt: 1,
      updatedAt: 2,
      messageCount: 2,
      transcript: savesOf('chat_first').at(-1)?.transcript ?? [],
    }))
    fetchMock.get(CHATS, 404)
  }

  async function openFromHistory(title: string) {
    fireEvent.click(screen.getByRole('button', { name: 'Chat history' }))
    fireEvent.click(await screen.findByText(title))
  }

  const fetchesOf = (chatId: string) =>
    fetchMock.callHistory
      .calls()
      .filter(
        call =>
          call.url.endsWith(`/chats/${chatId}`) &&
          (call.options?.method ?? 'get').toUpperCase() === 'GET'
      )

  it('reopens a chat whose run is still going where it was, showing its question once', async function () {
    serveFirstChatFromHistory()
    fetchMock.post(RUNS, { runId: 'run-a' })
    renderPanel()

    typeAndSend('Scan this project')
    await waitFor(() => expect(liveStreams()).to.have.length(1))
    liveStreams()[0].emit({ type: 'text', text: 'Reading main.tex' })

    fireEvent.click(screen.getByLabelText('New chat'))
    await waitFor(() => expect(passiveStreams()).to.have.length(1))
    passiveStreams()[0].emit({ type: 'text', text: ' and refs.bib.' })

    const fetchedBefore = fetchesOf('chat_first').length
    await openFromHistory('First chat')

    // The reply as far as it has come off screen, followed on from there
    await waitFor(() => expect(liveStreams()).to.have.length(2))
    expect(liveStreams()[1].url).to.include('/runs/run-a/stream?since=2')

    // The server's copy, saved as the chat was left, arrives meanwhile
    await waitFor(() =>
      expect(fetchesOf('chat_first')).to.have.length(fetchedBefore + 1)
    )
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    liveStreams()[1].emit({ type: 'text', text: ' Done.' })
    liveStreams()[1].emit({ type: 'turnFinished', reason: 'stop' })

    // The reply written on screen, off it, and on screen again: once, after
    // its question, which is shown and saved once
    await waitFor(
      () => {
        const saved = savesOf('chat_first').at(-1)?.transcript
        expect(saved.map((entry: any) => entry.role)).to.deep.equal([
          'user',
          'assistant',
        ])
        expect(saved[1].text).to.equal('Reading main.tex and refs.bib. Done.')
      },
      { timeout: 3000 }
    )
    expect(screen.getAllByText('Scan this project')).to.have.length(1)
  })

  it('shows how long a chat that finished off screen took when it is opened again', async function () {
    serveFirstChatFromHistory()
    fetchMock.post(RUNS, { runId: 'run-a' })
    const { container } = renderPanel()

    typeAndSend('write the intro')
    await waitFor(() => expect(liveStreams()).to.have.length(1))
    liveStreams()[0].emit({ type: 'text', text: 'Intro written.' })

    fireEvent.click(screen.getByLabelText('New chat'))
    await waitFor(() => expect(passiveStreams()).to.have.length(1))
    passiveStreams()[0].emit({ type: 'turnFinished', reason: 'stop' })
    await waitFor(() =>
      expect(savesOf('chat_first').at(-1)?.transcript.at(-1)).to.have.property(
        'durationMs'
      )
    )

    await openFromHistory('First chat')

    await waitFor(() => {
      const line = container.querySelector('.ai-assist-status-line.is-completed')
      expect(line?.textContent).to.match(/ for \d+s/)
    })
  })

  it("sends a new chat's first message at once while the chat left is still sending", async function () {
    fetchMock.get(CHATS, 404)
    let started = 0
    fetchMock.post(RUNS, () =>
      ++started === 1 ? new Promise(() => {}) : { runId: 'run-b' }
    )
    renderPanel()

    typeAndSend('first chat question')
    await waitFor(() => expect(callsTo(RUNS)).to.have.length(1))
    fireEvent.click(screen.getByLabelText('New chat'))
    typeAndSend('second chat question')

    await waitFor(() => expect(callsTo(RUNS)).to.have.length(2))
    const body = JSON.parse(String(callsTo(RUNS)[1].options?.body))
    expect(body.chatId).to.equal(activeChatId())
    expect(body.transcript.map((entry: any) => entry.text)).to.deep.equal([
      'second chat question',
    ])
    await waitFor(() => expect(liveStreams()).to.have.length(1))
    expect(liveStreams()[0].url).to.include('/runs/run-b/')
  })

  it("does not stream another chat's run into the chat on screen after a reload", async function () {
    fetchMock.get(CHATS, 404)
    customLocalStorage.setItem(`ai-assist:active-run:${PROJECT_ID}`, 'run-other')
    customLocalStorage.setItem(
      `ai-assist:active-run-chat:${PROJECT_ID}`,
      'chat_other'
    )
    saveConversation(PROJECT_ID, 'chat_other', [
      { id: 'u0', role: 'user', text: 'the other question' },
    ])
    renderPanel()

    await waitFor(() => expect(passiveStreams()).to.have.length(1))
    expect(passiveStreams()[0].url).to.include('/runs/run-other/')
    expect(liveStreams()).to.have.length(0)
    passiveStreams()[0].emit({ type: 'text', text: 'the other reply' })
    expect(screen.queryByText(/the other reply/)).to.equal(null)
    expect(
      customLocalStorage.getItem(`ai-assist:detached-runs:${PROJECT_ID}`)
    ).to.have.nested.property('chat_other.runId', 'run-other')
  })

  // The reveal animation only moves on animation frames, which never come
  // here: a reply being typed out from the start shows as empty.
  const replyShown = () =>
    (document.querySelector('.ai-assist-message-assistant')?.textContent ?? '').trim()

  it('shows the reply so far of a chat reopened mid-run at once, not typed out again', async function () {
    serveFirstChatFromHistory()
    fetchMock.post(RUNS, { runId: 'run-a' })
    renderPanel()

    typeAndSend('Scan this project')
    await waitFor(() => expect(liveStreams()).to.have.length(1))
    liveStreams()[0].emit({ type: 'text', text: 'Reading main.tex' })

    fireEvent.click(screen.getByLabelText('New chat'))
    await waitFor(() => expect(passiveStreams()).to.have.length(1))
    passiveStreams()[0].emit({ type: 'text', text: ' and refs.bib.' })

    await openFromHistory('First chat')
    await waitFor(() => expect(liveStreams()).to.have.length(2))
    expect(replyShown()).to.equal('Reading main.tex and refs.bib.')

    // Streaming on from there, the text already shown stays shown
    liveStreams()[1].caughtUp()
    expect(replyShown()).to.equal('Reading main.tex and refs.bib.')
  })

  it('shows the reply rebuilt from a replayed run at once, not typed out again', async function () {
    fetchMock.get(CHATS, 404)
    customLocalStorage.setItem(`ai-assist:active-run:${PROJECT_ID}`, 'run-a')
    customLocalStorage.setItem(
      `ai-assist:active-run-chat:${PROJECT_ID}`,
      'chat_first'
    )
    saveConversation(PROJECT_ID, 'chat_first', [
      { id: 'u0', role: 'user', text: 'Scan this project' },
    ])
    renderPanel()

    // After a reload the run is replayed from its first event
    await waitFor(() => expect(liveStreams()).to.have.length(1))
    expect(liveStreams()[0].url).to.include('/runs/run-a/stream?since=0')
    liveStreams()[0].emit({ type: 'text', text: 'Reading main.tex' })
    liveStreams()[0].emit({ type: 'text', text: ' and refs.bib.' })
    expect(replyShown()).to.equal('Reading main.tex and refs.bib.')

    liveStreams()[0].caughtUp()
    expect(replyShown()).to.equal('Reading main.tex and refs.bib.')
  })
})
