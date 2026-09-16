import React from 'react'
import { expect } from 'chai'
import sinon from 'sinon'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import fetchMock from 'fetch-mock'
import customLocalStorage from '@/infrastructure/local-storage'
import { resetMeta } from '../../../../../../test/frontend/helpers/reset-meta'
import { EditorProviders } from '../../../../../../test/frontend/helpers/editor-providers'
import { ProjectSnapshot } from '@/infrastructure/project-snapshot'
import { EditorManagerContext } from '@/features/ide-react/context/editor-manager-context'
import { LocalCompileContext } from '@/shared/context/local-compile-context'
import { clearFixStore } from "../../../../frontend/js/features/ai-assist/agent/fix-store"
import SuggestFixPanel from '../../../../frontend/js/features/ai-assist/components/suggest-fix-panel'

function setMeta({ enabled = true } = {}) {
  resetMeta()
  const exposed = window.metaAttributesCache.get('ol-ExposedSettings') || {}
  window.metaAttributesCache.set('ol-ExposedSettings', {
    ...exposed,
    validRootDocExtensions: ['tex', 'latex'],
  })
  if (enabled) {
    window.metaAttributesCache.set('ol-aiAssistEnabled', true)
    window.metaAttributesCache.set('ol-showAiFeatures', true)
  }
}

const STORED_PROVIDER = {
  type: 'openai' as const,
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-4o-mini',
}

const LOG_ENTRY = {
  key: 'entry-1',
  file: 'chapter3.tex',
  line: 87,
  level: 'error',
  message: 'Undefined control sequence',
  raw: 'l.87 \\includegraphics',
}

function sse(body: string) {
  return { body, headers: { 'Content-Type': 'text/event-stream' } }
}

function open() {
  window.dispatchEvent(
    new CustomEvent('aiAssist:suggestFix', { detail: { entryId: 'entry-1' } })
  )
}

const MockEditorManagerProvider: React.FC<React.PropsWithChildren> = ({
  children,
}) => {
  const value: any = {
    getEditorType: () => 'source',
    getCurrentDocValue: () => null,
    getCurrentDocumentId: () => '_root_doc_id',
    setIgnoringExternalUpdates: () => {},
    openDocWithId: async () => undefined,
    openDoc: async () => undefined,
    openDocs: {},
    openFileWithId: () => {},
    openInitialDoc: async () => undefined,
    isLoading: false,
    jumpToLine: () => {},
    debugTimers: { current: {} },
  }
  return (
    <EditorManagerContext.Provider value={value}>
      {children}
    </EditorManagerContext.Provider>
  )
}

const MockLocalCompileProvider: React.FC<React.PropsWithChildren> = ({
  children,
}) => {
  const value: any = {
    autoCompile: false,
    compiling: false,
    startCompile: async () => {},
    logEntries: [],
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
      mockCompileOnLoad={false}
      providers={{
        EditorManagerProvider: MockEditorManagerProvider,
        LocalCompileProvider: MockLocalCompileProvider,
      }}
    >
      <SuggestFixPanel logEntry={LOG_ENTRY} />
    </EditorProviders>
  )
}

describe('SuggestFixPanel on the agent harness', function () {
  let removeListeners: () => void

  beforeEach(function () {
    clearFixStore()
    fetchMock.removeRoutes().clearHistory()
    customLocalStorage.clear()
    customLocalStorage.setItem('ai-assist:provider', STORED_PROVIDER)
    customLocalStorage.setItem('ai-assist:consent', true)
    setMeta()
    document.body.innerHTML = ''

    sinon.stub(ProjectSnapshot.prototype, 'refresh').resolves()
    sinon
      .stub(ProjectSnapshot.prototype, 'getDocPaths')
      .returns(['main.tex', 'chapter3.tex'])
    sinon
      .stub(ProjectSnapshot.prototype, 'getDocContents')
      .callsFake(() => '\\documentclass{article}\n\\begin{document}\nhello\n\\end{document}')
    sinon
      .stub(ProjectSnapshot.prototype, 'getBinaryFilePathsWithHash')
      .returns([])

    const onReadDoc = () => {
      window.dispatchEvent(
        new CustomEvent('aiAssist:agentReadDocResult', {
          detail: {
            text: '\\documentclass{article}\n\\begin{document}\nhello\n\\end{document}',
          },
        })
      )
    }

    const onApplyEdit = () => {
      window.dispatchEvent(
        new CustomEvent('aiAssist:agentApplyEditResult', {
          detail: { status: 'applied' },
        })
      )
    }

    window.addEventListener('aiAssist:agentReadDoc', onReadDoc)
    window.addEventListener('aiAssist:agentApplyEdit', onApplyEdit)

    removeListeners = () => {
      window.removeEventListener('aiAssist:agentReadDoc', onReadDoc)
      window.removeEventListener('aiAssist:agentApplyEdit', onApplyEdit)
    }
  })

  afterEach(function () {
    sinon.restore()
    removeListeners?.()
    fetchMock.removeRoutes().clearHistory()
    customLocalStorage.clear()
  })

  it('renders the explanation as markdown, not as literal backticks', async function () {
    fetchMock.post(
      'https://api.openai.com/v1/chat/completions',
      sse(
        'data: {"choices":[{"delta":{"content":"Add `\\\\usepackage{graphicx}` to the preamble."}}]}\n\n' +
          'data: [DONE]\n\n'
      )
    )

    renderPanel()
    open()

    await waitFor(() => {
      expect(screen.getByText('\\usepackage{graphicx}').tagName).to.equal('CODE')
    })
  })

  it('collapses the investigation into one row that expands in order', async function () {
    let turn = 0
    fetchMock.post('https://api.openai.com/v1/chat/completions', () => {
      turn++
      if (turn === 1) {
        return sse(
          'data: {"choices":[{"delta":{"tool_calls":[' +
            '{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"path\\":\\"main.tex\\"}"}},' +
            '{"index":1,"id":"call_2","function":{"name":"get_references","arguments":"{}"}}' +
            ']},"finish_reason":"tool_calls"}]}\n\n' +
            'data: [DONE]\n\n'
        )
      }
      return sse(
        'data: {"choices":[{"delta":{"content":"Done."}}]}\n\n' +
          'data: [DONE]\n\n'
      )
    })

    const { container } = renderPanel()
    open()

    await waitFor(() =>
      expect(screen.getByText(/Read 1 file, checked references|Checked references, read 1 file/i)).to.exist
    )
    fireEvent.click(
      screen.getByText(/Read 1 file, checked references|Checked references, read 1 file/i).closest('button')!
    )

    const names = [...container.querySelectorAll('.ai-assist-tool-call')].map(
      node => node.textContent
    )
    expect(names[0]).to.contain('Read file')
    expect(names[1]).to.contain('Checked references')
  })

  it('renders a pending approval card for an edit_file call', async function () {
    fetchMock.post(
      'https://api.openai.com/v1/chat/completions',
      sse(
        'data: {"choices":[{"delta":{"tool_calls":[' +
          '{"index":0,"id":"call_1","function":{"name":"edit_file","arguments":"{\\"path\\":\\"main.tex\\",\\"oldText\\":\\"hello\\",\\"newText\\":\\"hello world\\"}"}}' +
          ']},"finish_reason":"tool_calls"}]}\n\n' +
          'data: [DONE]\n\n'
      )
    )

    const { container } = renderPanel()
    open()

    await waitFor(() => {
      expect(container.querySelector('.ai-assist-edit-approval')).to.exist
      expect(container.querySelector('.diff-line-ins')).to.exist
    })
  })

  it('collapses a decided edit to a one-line receipt', async function () {
    let turn = 0
    fetchMock.post('https://api.openai.com/v1/chat/completions', () => {
      turn++
      if (turn === 1) {
        return sse(
          'data: {"choices":[{"delta":{"tool_calls":[' +
            '{"index":0,"id":"call_1","function":{"name":"edit_file","arguments":"{\\"path\\":\\"main.tex\\",\\"oldText\\":\\"hello\\",\\"newText\\":\\"hello world\\"}"}}' +
            ']},"finish_reason":"tool_calls"}]}\n\n' +
            'data: [DONE]\n\n'
        )
      }
      return sse(
        'data: {"choices":[{"delta":{"content":"Applied fix."}}]}\n\n' +
          'data: [DONE]\n\n'
      )
    })

    const { container } = renderPanel()
    open()

    await waitFor(() => expect(screen.getByText(/Accept/)).to.exist)
    fireEvent.click(screen.getByText(/Accept/))

    await waitFor(() => {
      expect(screen.getByText(/applied/)).to.exist
      expect(container.querySelectorAll('.diff-line')).to.have.length(0)
    })
  })

  it('explains itself when it runs out of steps', async function () {
    fetchMock.post(
      'https://api.openai.com/v1/chat/completions',
      sse(
        'data: {"choices":[{"delta":{"tool_calls":[' +
          '{"index":0,"id":"call_loop","function":{"name":"list_files","arguments":"{}"}}' +
          ']},"finish_reason":"tool_calls"}]}\n\n' +
          'data: [DONE]\n\n'
      )
    )

    renderPanel()
    open()

    await waitFor(() => {
      expect(screen.getByText(/could not pin this down/i)).to.exist
    })
  })

  // Running out of steps after the suggestion is already on screen used to
  // print "I could not pin this down" underneath a complete answer, which
  // reads as a failure and hides a perfectly good fix.
  it('does not call a finished suggestion a failure when steps run out', async function () {
    fetchMock.post(
      'https://api.openai.com/v1/chat/completions',
      sse(
        'data: {"choices":[{"delta":{"content":"Add `\\\\usepackage{graphicx}` to the preamble."}}]}\n\n' +
          'data: {"choices":[{"delta":{"tool_calls":[' +
          '{"index":0,"id":"call_loop","function":{"name":"list_files","arguments":"{}"}}' +
          ']},"finish_reason":"tool_calls"}]}\n\n' +
          'data: [DONE]\n\n'
      )
    )

    renderPanel()
    open()

    // The explanation arrives, then the loop burns its budget on tool calls.
    await waitFor(() => {
      expect(screen.getAllByText(/usepackage\{graphicx\}/i)).to.not.be.empty
    })
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /stop/i })).to.be.null
    })

    expect(screen.queryByText(/could not pin this down/i)).to.be.null
  })

  it('persists output across unmount and remount without re-requesting the LLM', async function () {
    let requestCount = 0
    fetchMock.post('https://api.openai.com/v1/chat/completions', () => {
      requestCount++
      return sse(
        'data: {"choices":[{"delta":{"content":"Fix: replace with `htbp`."}}]}\n\n' +
          'data: [DONE]\n\n'
      )
    })

    // 1. Initial render and open
    const { unmount } = renderPanel()
    open()

    // 2. Wait for LLM fix to appear
    await waitFor(() => {
      expect(screen.getByText(/replace with/i)).to.exist
    })
    expect(requestCount).to.equal(1)

    // 3. Unmount (simulating user switching tab or toggling Back to PDF)
    unmount()

    // 4. Re-mount (simulating user switching back to tab or returning to Logs)
    renderPanel()

    // 5. Verify the fix is immediately visible WITHOUT dispatching open() or calling the LLM!
    await waitFor(() => {
      expect(screen.getByText(/replace with/i)).to.exist
    })
    expect(requestCount).to.equal(1)
  })
})
