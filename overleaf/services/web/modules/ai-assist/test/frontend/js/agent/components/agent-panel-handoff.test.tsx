import { expect } from 'chai'
import sinon from 'sinon'
import { render, screen, waitFor } from '@testing-library/react'
import fetchMock from 'fetch-mock'
import customLocalStorage from '@/infrastructure/local-storage'
import { ProjectSnapshot } from '@/infrastructure/project-snapshot'
import { AgentPanel } from '../../../../../frontend/js/features/ai-assist/components/agent/agent-panel'
import {
  clearConversation,
  saveConversation,
} from '../../../../../frontend/js/features/ai-assist/agent/conversation-store'
import { requestChatHandoff } from '../../../../../frontend/js/features/ai-assist/agent/chat-handoff'
import { isChatBusy } from '../../../../../frontend/js/features/ai-assist/agent/chat-activity'
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

const HANDOFF = {
  entryId: 'entry-1',
  level: 'error' as const,
  file: 'chapter3.tex',
  line: 87,
  message: 'Undefined control sequence',
  text: "Let's keep working on the compile error in chapter3.tex, line 87.",
  contextText: '<prior-fix-run>the earlier run said graphicx</prior-fix-run>',
}

function sse(body: string) {
  return { body, headers: { 'Content-Type': 'text/event-stream' } }
}

/** The request bodies the panel actually sent to the provider. */
function sentBodies() {
  return fetchMock
    .callHistory
    .calls()
    .filter(call => call.url.includes('/runs') || call.url.includes('chat/completions'))
    .map(call => JSON.parse(String(call.options?.body ?? '{}')))
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

function setMeta() {
  resetMeta()
  window.metaAttributesCache.set('ol-aiAssistEnabled', true)
  window.metaAttributesCache.set('ol-showAiFeatures', true)
}

describe('AgentPanel receiving a compile-error handoff', function () {
  beforeEach(function () {
    setMeta()
    clearConversation(PROJECT_ID)
    fetchMock.removeRoutes().clearHistory()
    customLocalStorage.clear()
    customLocalStorage.setItem('ai-assist:provider', STORED_PROVIDER)
    customLocalStorage.setItem('ai-assist:consent', true)

    sinon.stub(ProjectSnapshot.prototype, 'refresh').resolves()
    sinon.stub(ProjectSnapshot.prototype, 'getDocPaths').returns(['main.tex'])
    sinon.stub(ProjectSnapshot.prototype, 'getDocContents').callsFake(() => 'hi')
    sinon
      .stub(ProjectSnapshot.prototype, 'getBinaryFilePathsWithHash')
      .returns([])

    fetchMock.post(
      '/ai-assist/providers/chat',
      sse(
        'data: {"choices":[{"delta":{"content":"Looking at it now."}}]}\n\n' +
          'data: [DONE]\n\n'
      )
    )
    fetchMock.post(new RegExp('/ai-assist/projects/.*/runs'), { runId: 'run-1' })
  })

  afterEach(function () {
    sinon.restore()
    clearConversation(PROJECT_ID)
    fetchMock.removeRoutes().clearHistory()
    customLocalStorage.clear()
  })

  it('collects a handoff parked before it was ever mounted', async function () {
    requestChatHandoff(PROJECT_ID, HANDOFF)

    renderPanel()

    await waitFor(() => {
      expect(screen.getByText(HANDOFF.text)).to.exist
    })
  })

  it('collects a handoff that arrives while it is already mounted', async function () {
    renderPanel()
    expect(screen.queryByText(HANDOFF.text)).to.equal(null)

    requestChatHandoff(PROJECT_ID, HANDOFF)

    await waitFor(() => {
      expect(screen.getByText(HANDOFF.text)).to.exist
    })
  })

  it('sends the request itself rather than staging it in the composer', async function () {
    requestChatHandoff(PROJECT_ID, HANDOFF)
    renderPanel()

    await waitFor(() => {
      expect(sentBodies()).to.have.length.greaterThan(0)
    })

    const sent = sentBodies()[0]
    const lastUser = sent.messages
      ? [...sent.messages].reverse().find((m: any) => m.role === 'user')?.content
      : [...sent.transcript].reverse().find((m: any) => m.role === 'user')
    const content = typeof lastUser === 'string' ? lastUser : `${lastUser?.contextText}\n${lastUser?.text}`
    expect(content).to.contain('the earlier run said graphicx')
    expect(content).to.contain(HANDOFF.text)
  })

  it('adds to the conversation already in progress instead of replacing it', async function () {
    saveConversation(PROJECT_ID, [
      { id: 'u0', role: 'user', text: 'what were we discussing?' },
      { id: 'a0', role: 'assistant', text: 'Your bibliography.', toolCalls: [] },
    ])
    requestChatHandoff(PROJECT_ID, HANDOFF)

    renderPanel()

    await waitFor(() => {
      expect(screen.getByText(HANDOFF.text)).to.exist
    })
    expect(screen.getByText('what were we discussing?')).to.exist
    expect(screen.getByText('Your bibliography.')).to.exist
  })

  it('appends the handoff last, keeping the cached prefix intact', async function () {
    saveConversation(PROJECT_ID, [
      { id: 'u0', role: 'user', text: 'what were we discussing?' },
      { id: 'a0', role: 'assistant', text: 'Your bibliography.', toolCalls: [] },
    ])
    requestChatHandoff(PROJECT_ID, HANDOFF)

    renderPanel()

    await waitFor(() => {
      expect(sentBodies()).to.have.length.greaterThan(0)
    })

    const sent = sentBodies()[0]
    const list = sent.messages ?? sent.transcript
    const last = list[list.length - 1]
    const first = list[0]
    const lastText = last.content ?? last.text
    const firstText = first.content ?? first.text
    expect(lastText).to.contain(HANDOFF.text)
    expect(firstText).to.not.contain(HANDOFF.text)
  })

  it('consumes the handoff once, not again on the next render', async function () {
    requestChatHandoff(PROJECT_ID, HANDOFF)
    renderPanel()

    await waitFor(() => {
      expect(sentBodies()).to.have.length.greaterThan(0)
    })
    const afterFirst = sentBodies().length

    window.dispatchEvent(
      new CustomEvent('aiAssist:chatHandoff', {
        detail: { projectId: PROJECT_ID },
      })
    )

    expect(sentBodies()).to.have.length(afterFirst)
  })

  it('ignores a handoff parked for a different project', async function () {
    requestChatHandoff('some-other-project', HANDOFF)

    renderPanel()

    await waitFor(() => {
      expect(screen.queryByText(HANDOFF.text)).to.equal(null)
    })
  })

  it('publishes its busy state so the log panel can refuse a second handoff', async function () {
    requestChatHandoff(PROJECT_ID, HANDOFF)
    renderPanel()

    await waitFor(() => {
      expect(screen.getByText(HANDOFF.text)).to.exist
    })
    await waitFor(() => {
      expect(isChatBusy(PROJECT_ID)).to.equal(false)
    })
  })
})
