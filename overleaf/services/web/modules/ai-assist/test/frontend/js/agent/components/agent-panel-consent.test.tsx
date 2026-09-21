import { expect } from 'chai'
import sinon from 'sinon'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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

const PROMPT = 'add a section about consent'

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

function sentBodies() {
  return fetchMock.callHistory
    .calls()
    .filter(
      call => call.url.includes('/runs') || call.url.includes('chat/completions')
    )
    .map(call => JSON.parse(String(call.options?.body ?? '{}')))
}

describe('AgentPanel first prompt before consent is given', function () {
  beforeEach(function () {
    resetMeta()
    window.metaAttributesCache.set('ol-aiAssistEnabled', true)
    window.metaAttributesCache.set('ol-showAiFeatures', true)
    clearConversation(PROJECT_ID)
    fetchMock.removeRoutes().clearHistory()
    customLocalStorage.clear()
    customLocalStorage.setItem('ai-assist:provider', {
      type: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
    })

    sinon.stub(ProjectSnapshot.prototype, 'refresh').resolves()
    sinon.stub(ProjectSnapshot.prototype, 'getDocPaths').returns(['main.tex'])
    sinon.stub(ProjectSnapshot.prototype, 'getDocContents').callsFake(() => 'hi')
    sinon
      .stub(ProjectSnapshot.prototype, 'getBinaryFilePathsWithHash')
      .returns([])

    fetchMock.post('/ai-assist/providers/chat', {
      body: 'data: {"choices":[{"delta":{"content":"Done."}}]}\n\ndata: [DONE]\n\n',
      headers: { 'Content-Type': 'text/event-stream' },
    })
    fetchMock.post(new RegExp('/ai-assist/projects/.*/runs'), {
      runId: 'run-1',
    })
  })

  afterEach(function () {
    sinon.restore()
    clearConversation(PROJECT_ID)
    fetchMock.removeRoutes().clearHistory()
    customLocalStorage.clear()
  })

  it('shows the prompt once, and sends it once, after Allow is clicked', async function () {
    render(
      <EditorProviders
        mockCompileOnLoad
        providers={{ LocalCompileProvider: MockLocalCompileProvider }}
      >
        <AgentPanel />
      </EditorProviders>
    )

    const input = screen.getByPlaceholderText(/what would you like to do/i)
    fireEvent.change(input, { target: { value: PROMPT } })
    fireEvent.keyDown(input, { key: 'Enter' })

    // Blocked on consent: nothing goes to the provider yet.
    const allow = await screen.findByRole('button', { name: /allow/i })
    expect(sentBodies()).to.have.length(0)

    fireEvent.click(allow)

    await waitFor(() => {
      expect(sentBodies()).to.have.length.greaterThan(0)
    })

    expect(screen.getAllByText(PROMPT)).to.have.length(1)
    const occurrences = JSON.stringify(sentBodies()[0]).split(PROMPT).length - 1
    expect(occurrences).to.equal(1)
  })
})
