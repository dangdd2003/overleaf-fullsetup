import { expect } from 'chai'
import sinon from 'sinon'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import fetchMock from 'fetch-mock'
import customLocalStorage from '@/infrastructure/local-storage'
import { ProjectSnapshot } from '@/infrastructure/project-snapshot'
import { AgentPanel } from '../../../../../frontend/js/features/ai-assist/components/agent/agent-panel'
import { clearConversation } from '../../../../../frontend/js/features/ai-assist/agent/conversation-store'
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
const MESSAGE = /\/runs\/[^/]+\/message$/
const TAKE_BACK = /\/runs\/[^/]+\/message\/[^/]+$/
const STOP = /\/ai-assist\/runs\/[^/]+\/stop$/

/** Stands in for a run's event stream; `emit` delivers an event to the panel. */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  onmessage: ((message: { data: string }) => void) | null = null
  onerror: ((err: unknown) => void) | null = null
  seq = 0
  constructor(public url: string) {
    FakeEventSource.instances.push(this)
  }

  close() {}

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

function routes({ message = { ok: true } as any } = {}) {
  let runs = 0
  fetchMock.post(MESSAGE, message)
  fetchMock.delete(TAKE_BACK, { ok: true })
  fetchMock.post(STOP, { ok: true })
  fetchMock.post(RUNS, () => ({ runId: `run-${++runs}` }))
}

function callsTo(matcher: RegExp) {
  return fetchMock.callHistory.calls().filter(call => matcher.test(call.url))
}

function bodiesTo(matcher: RegExp) {
  return callsTo(matcher).map(call =>
    JSON.parse(String(call.options?.body ?? '{}'))
  )
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

async function startRun(text = 'fix the preamble') {
  typeAndSend(text)
  await waitFor(() => expect(callsTo(RUNS)).to.have.length(1))
  await waitFor(() => expect(FakeEventSource.instances).to.have.length(1))
  return FakeEventSource.instances[0]
}

describe('AgentPanel messages sent while a run is going', function () {
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

    sinon.stub(ProjectSnapshot.prototype, 'refresh').resolves()
    sinon.stub(ProjectSnapshot.prototype, 'getDocPaths').returns(['main.tex'])
    sinon
      .stub(ProjectSnapshot.prototype, 'getDocContents')
      .callsFake(() => 'hi')
    sinon
      .stub(ProjectSnapshot.prototype, 'getBinaryFilePathsWithHash')
      .returns([])

    FakeEventSource.instances = []
    originalEventSource = globalThis.EventSource
    globalThis.EventSource = FakeEventSource as any
  })

  afterEach(function () {
    sinon.restore()
    globalThis.EventSource = originalEventSource
    clearConversation(PROJECT_ID)
    fetchMock.removeRoutes().clearHistory()
    customLocalStorage.clear()
  })

  it('queues the message and stores the turn the run was sent, for the next run to resend', async function () {
    routes()
    renderPanel()
    const stream = await startRun()
    stream.emit({ type: 'text', text: 'Reading main.tex.' })

    typeAndSend('also the date')
    await waitFor(() => expect(callsTo(MESSAGE)).to.have.length(1))
    const queued = bodiesTo(MESSAGE)[0]
    expect(queued.text).to.equal('also the date')
    expect(queued.contextText).to.include('<project-context turn="2"')
    expect(callsTo(RUNS)).to.have.length(1)
    expect(screen.getByText('Queued')).to.exist

    // Read by the run: no longer greyed
    stream.emit({
      type: 'userMessage',
      id: queued.id,
      text: queued.text,
      contextText: queued.contextText,
    })
    expect(screen.queryByText('Queued')).to.equal(null)
    stream.emit({ type: 'text', text: 'Done.' })
    stream.emit({ type: 'turnFinished', reason: 'stop' })

    typeAndSend('thanks')
    await waitFor(() => expect(callsTo(RUNS)).to.have.length(2))
    const transcript = bodiesTo(RUNS)[1].transcript
    // In the order the run read it, with the envelope it was sent
    expect(transcript.map((entry: any) => entry.role)).to.deep.equal([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ])
    expect(transcript[2]).to.deep.include({
      id: queued.id,
      text: 'also the date',
      contextText: queued.contextText,
      sentDuringRun: true,
    })
    expect(transcript[2].pending).to.equal(undefined)
  })

  it('hands messages typed in quick succession to the run in order, each built on the one before', async function () {
    routes()
    renderPanel()
    await startRun()

    typeAndSend('one')
    typeAndSend('two')
    typeAndSend('three')

    await waitFor(() => expect(callsTo(MESSAGE)).to.have.length(3))
    const sent = bodiesTo(MESSAGE)
    expect(sent.map(body => body.text)).to.deep.equal(['one', 'two', 'three'])
    expect(
      sent.map(body => body.contextText.match(/turn="(\d+)"/)?.[1])
    ).to.deep.equal(['2', '3', '4'])
    expect(callsTo(RUNS)).to.have.length(1)
  })

  it('starts a run for a message the finishing run turned away, once its reply has landed', async function () {
    routes({ message: 409 })
    renderPanel()
    const stream = await startRun()

    typeAndSend('one more thing')
    await waitFor(() => expect(callsTo(MESSAGE)).to.have.length(1))
    // The run that refused it is still delivering its last events
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(callsTo(RUNS)).to.have.length(1)

    stream.emit({ type: 'text', text: 'Finished the first.' })
    stream.emit({ type: 'turnFinished', reason: 'stop' })

    await waitFor(() => expect(callsTo(RUNS)).to.have.length(2))
    const transcript = bodiesTo(RUNS)[1].transcript
    expect(transcript.map((entry: any) => entry.text)).to.deep.equal([
      'fix the preamble',
      'Finished the first.',
      'one more thing',
    ])
    expect(transcript[2].pending).to.equal(undefined)
  })

  it('sends what was queued next when the run is stopped, as Claude Code does', async function () {
    routes()
    renderPanel()
    const stream = await startRun()

    typeAndSend('do this instead')
    await waitFor(() => expect(callsTo(MESSAGE)).to.have.length(1))

    fireEvent.click(screen.getByLabelText('Stop (Esc)'))
    await waitFor(() => expect(callsTo(STOP)).to.have.length(1))
    // A result the run had before it saw the stop arrives after it: the next
    // run waits for the stopped one to end, and is sent it
    stream.emit({
      type: 'toolCallStarted',
      id: 'r1',
      name: 'read_file',
      args: { path: 'main.tex' },
      step: 1,
    })
    stream.emit({
      type: 'toolCallFinished',
      id: 'r1',
      result: { content: 'x' },
      isError: false,
    })
    expect(callsTo(RUNS)).to.have.length(1)
    stream.emit({ type: 'turnFinished', reason: 'aborted' })

    await waitFor(() => expect(callsTo(RUNS)).to.have.length(2))
    expect(callsTo(STOP)).to.have.length(1)
    const sent = bodiesTo(RUNS)[1].transcript
    expect(
      sent.find((entry: any) => entry.role === 'assistant').toolCalls[0]
    ).to.deep.include({ id: 'r1', result: { content: 'x' } })
    const transcript = bodiesTo(RUNS)[1].transcript
    expect(transcript.at(-1)).to.deep.include({ text: 'do this instead' })
    expect(transcript.at(-1).pending).to.equal(undefined)
  })

  it('takes a queued message back into the composer before the run reads it', async function () {
    routes()
    renderPanel()
    const stream = await startRun()

    typeAndSend('wrong idea')
    await waitFor(() => expect(callsTo(MESSAGE)).to.have.length(1))
    const queued = bodiesTo(MESSAGE)[0]

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))

    await waitFor(() => expect(composer().value).to.equal('wrong idea'))
    const takeBack = callsTo(TAKE_BACK)
    expect(takeBack).to.have.length(1)
    expect(takeBack[0].options?.method?.toUpperCase()).to.equal('DELETE')
    expect(takeBack[0].url).to.include(`/message/${queued.id}`)
    expect(screen.queryByText('Queued')).to.equal(null)

    // Nothing is left for the run to have missed, so nothing is resent
    stream.emit({ type: 'turnFinished', reason: 'stop' })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(callsTo(RUNS)).to.have.length(1)
  })
})
