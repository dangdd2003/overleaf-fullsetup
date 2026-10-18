import { expect } from 'chai'
import sinon from 'sinon'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import fetchMock from 'fetch-mock'
import customLocalStorage from '@/infrastructure/local-storage'
import { ProjectSnapshot } from '@/infrastructure/project-snapshot'
import { AgentPanel } from '../../../../../frontend/js/features/ai-assist/components/agent/agent-panel'
import {
  clearConversation,
  saveConversation,
} from '../../../../../frontend/js/features/ai-assist/agent/conversation-store'
import { setActiveChatId } from '../../../../../frontend/js/features/ai-assist/agent/chat-history-client'
import { TranscriptEntry } from '../../../../../frontend/js/features/ai-assist/agent/agent-messages'
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

const CHAT_ID = 'chat-a'

const TRANSCRIPT: TranscriptEntry[] = [
  { id: 'u0', role: 'user', text: 'first prompt' },
  { id: 'a0', role: 'assistant', text: 'reply one', toolCalls: [] },
  { id: 'u1', role: 'user', text: 'second prompt' },
  { id: 'a1', role: 'assistant', text: 'reply two', toolCalls: [] },
]

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

/** The bodies of the requests to the endpoint at the end of `suffix`. */
function bodiesTo(suffix: string) {
  return fetchMock.callHistory
    .calls()
    .filter(call => call.url.endsWith(suffix))
    .map(call => JSON.parse(String(call.options?.body ?? '{}')))
}

/** Opens the rewind dialog on a user message, as the message view does. */
function openRewind(entry: TranscriptEntry, willFork: boolean) {
  act(() => {
    window.dispatchEvent(
      new CustomEvent('aiAssist:rewindCode', { detail: { entry, willFork } })
    )
  })
}

describe('AgentPanel rewind and fork', function () {
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
    sinon.stub(ProjectSnapshot.prototype, 'getDocContents').callsFake(() => 'hi')
    sinon
      .stub(ProjectSnapshot.prototype, 'getBinaryFilePathsWithHash')
      .returns([])

    setActiveChatId(PROJECT_ID, CHAT_ID)
    saveConversation(PROJECT_ID, CHAT_ID, TRANSCRIPT)
    fetchMock.get(`/ai-assist/projects/${PROJECT_ID}/chats/${CHAT_ID}`, {
      id: CHAT_ID,
      title: 'Original',
      transcript: [],
    })
    fetchMock.post(new RegExp('/rewind/check$'), {
      canRewind: true,
      filesChanged: ['main.tex'],
      insertions: 1,
      deletions: 1,
    })
    fetchMock.post(new RegExp('/checkpoints/fork$'), { copied: ['u0'] })
  })

  afterEach(function () {
    sinon.restore()
    clearConversation(PROJECT_ID)
    fetchMock.removeRoutes().clearHistory()
    customLocalStorage.clear()
  })

  it('forks before the prompt, restores the prompt to the composer, and copies its checkpoints', async function () {
    renderPanel()

    await waitFor(() => {
      expect(screen.getByText('reply two')).to.exist
    })

    openRewind(TRANSCRIPT[2], true)

    await waitFor(() => {
      expect(screen.getByText('Restore conversation')).to.exist
    })
    fireEvent.click(screen.getByText('Restore conversation').closest('button')!)
    await waitFor(() => {
      expect(screen.queryByText('Checking code changes...')).to.not.exist
    })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() => {
      expect(screen.getByText('Original (Fork)')).to.exist
    })
    expect(screen.getByText('reply one')).to.exist
    expect(screen.queryByText('reply two')).to.equal(null)
    expect(screen.getByDisplayValue('second prompt')).to.exist

    expect(bodiesTo('/rewind/check')).to.deep.equal([
      { userMessageId: 'u1', userMessageIds: ['u1'] },
    ])
    const forks = bodiesTo('/checkpoints/fork')
    expect(forks).to.have.length(1)
    expect(forks[0].userMessageIds).to.deep.equal(['u0'])
    expect(forks[0].targetChatId).to.be.a('string').and.not.equal(CHAT_ID)
    // Conversation-only: no code restore request
    expect(bodiesTo('/rewind')).to.have.length(0)
  })

  it('keeps the chat and lists the files when the code restore fails', async function () {
    fetchMock.post(new RegExp('/rewind$'), {
      status: 500,
      body: {
        error: 'Could not restore',
        failedFiles: [{ path: 'main.tex', error: 'EACCES' }],
      },
    })

    renderPanel()

    await waitFor(() => {
      expect(screen.getByText('reply two')).to.exist
    })

    openRewind(TRANSCRIPT[2], false)

    await waitFor(() => {
      expect(screen.getByText('Restore code')).to.exist
    })
    const dialog = within(screen.getByRole('dialog'))
    fireEvent.click(dialog.getByRole('button', { name: 'Rewind' }))

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).to.contain(
        'Could not restore: main.tex'
      )
    })
    expect(screen.getByText('reply two')).to.exist
    expect(bodiesTo('/checkpoints/fork')).to.have.length(0)
    expect(bodiesTo('/rewind')[0]).to.deep.equal({
      userMessageId: 'u1',
      userMessageIds: ['u1'],
      restoreCode: true,
      restoreConversation: false,
    })
  })
})
