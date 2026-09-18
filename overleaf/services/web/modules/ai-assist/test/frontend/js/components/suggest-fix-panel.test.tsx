import React from 'react'
import { expect } from 'chai'
import sinon from 'sinon'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import fetchMock from 'fetch-mock'
import customLocalStorage from '@/infrastructure/local-storage'
import { resetMeta } from '../../../../../../test/frontend/helpers/reset-meta'
import {
  EditorProviders,
  PROJECT_ID,
} from '../../../../../../test/frontend/helpers/editor-providers'
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

const CHAT = '/ai-assist/providers/chat'

/** Chunks as the Overleaf server relays them from the provider. */
function ndjson(...chunks: object[]) {
  return {
    body: [...chunks, { type: 'done' }].map(c => JSON.stringify(c) + '\n').join(''),
    headers: { 'Content-Type': 'application/x-ndjson' },
  }
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

function renderPanel(logEntry: any = LOG_ENTRY) {
  return render(
    <EditorProviders
      mockCompileOnLoad={false}
      providers={{
        EditorManagerProvider: MockEditorManagerProvider,
        LocalCompileProvider: MockLocalCompileProvider,
      }}
    >
      <SuggestFixPanel logEntry={logEntry} />
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

  it('never starts a hidden run for an entry the logs pane offers no fix for', async function () {
    fetchMock.post(CHAT, ndjson({ type: 'text', text: 'should not run' }))
    for (const level of ['info', 'typesetting']) {
      const { container, unmount } = renderPanel({ ...LOG_ENTRY, level })
      open()
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(container.innerHTML).to.equal('')
      unmount()
    }
    expect(fetchMock.callHistory.calls(CHAT)).to.have.length(0)
  })

  it('renders the explanation as markdown, not as literal backticks', async function () {
    // Prose with no edit earns one follow-up turn asking for edit_file.
    let turn = 0
    fetchMock.post(CHAT, () =>
      ++turn === 1
        ? ndjson({ type: 'text', text: 'Add `\\usepackage{graphicx}` to the preamble.' })
        : ndjson({ type: 'text', text: 'No edit.' })
    )

    renderPanel()
    open()

    await waitFor(() => {
      expect(screen.getByText('\\usepackage{graphicx}').tagName).to.equal('CODE')
    })
  })

  it('collapses the investigation into one row that expands in order', async function () {
    let turn = 0
    fetchMock.post(CHAT, () => {
      turn++
      if (turn === 1) {
        return ndjson(
          { type: 'tool_call', id: 'call_1', name: 'read_file', args: { path: 'main.tex' } },
          { type: 'tool_call', id: 'call_2', name: 'get_references', args: {} }
        )
      }
      return ndjson({ type: 'text', text: 'Done.' })
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
      CHAT,
      ndjson(
        { type: 'tool_call', id: 'call_1', name: 'edit_file', args: { path: 'main.tex', oldText: 'hello', newText: 'hello world' } }
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
    fetchMock.post(CHAT, () => {
      turn++
      if (turn === 1) {
        return ndjson(
          { type: 'tool_call', id: 'call_1', name: 'edit_file', args: { path: 'main.tex', oldText: 'hello', newText: 'hello world' } }
        )
      }
      return ndjson({ type: 'text', text: 'Applied fix.' })
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

  it('persists output across unmount and remount without re-requesting the LLM', async function () {
    let requestCount = 0
    fetchMock.post(CHAT, () => {
      requestCount++
      // Prose with no edit earns one follow-up turn asking for edit_file.
      return requestCount === 1
        ? ndjson({ type: 'text', text: 'Fix: replace with `htbp`.' })
        : ndjson({ type: 'text', text: 'No edit.' })
    })

    // 1. Initial render and open
    const { unmount } = renderPanel()
    open()

    // 2. Wait for LLM fix to appear
    await waitFor(() => {
      expect(screen.getByText(/replace with/i)).to.exist
      expect(requestCount).to.equal(2)
    })

    // 3. Unmount (simulating user switching tab or toggling Back to PDF)
    unmount()

    // 4. Re-mount (simulating user switching back to tab or returning to Logs)
    renderPanel()

    // 5. Verify the fix is immediately visible WITHOUT dispatching open() or calling the LLM!
    await waitFor(() => {
      expect(screen.getByText(/replace with/i)).to.exist
    })
    expect(requestCount).to.equal(2)
  })

  it('aborts the in-page run when the panel unmounts', async function () {
    fetchMock.post(
      CHAT,
      () => new Promise(() => {})
    )

    const { unmount } = renderPanel()
    open()
    await waitFor(() => expect(screen.getByText(/stop/i)).to.exist)

    const [fetchCall] = fetchMock.callHistory.calls()
    expect(fetchCall.options.signal.aborted).to.be.false

    unmount()
    expect(fetchCall.options.signal.aborted).to.be.true
  })

  it('stopping an in-page fix run does not clear stored active run id for main chat', async function () {
    customLocalStorage.setItem('ai-assist:active-run:' + PROJECT_ID, 'run-main')

    fetchMock.post(
      CHAT,
      () => new Promise(() => {})
    )

    renderPanel()
    open()
    await waitFor(() => expect(screen.getByText(/stop/i)).to.exist)
    fireEvent.click(screen.getByText(/stop/i))

    expect(customLocalStorage.getItem('ai-assist:active-run:' + PROJECT_ID)).to.equal('run-main')
  })

  it('aborts prior controller when starting a new in-page run on the same hook', async function () {
    const abortSpy = sinon.spy(AbortController.prototype, 'abort')
    fetchMock.post(
      CHAT,
      () => new Promise(() => {})
    )

    renderPanel()
    open()
    await waitFor(() => expect(screen.getByText(/stop/i)).to.exist)

    // Trigger second fix run via event
    open()

    await waitFor(() => expect(abortSpy.called).to.be.true)
    abortSpy.restore()
  })
})
