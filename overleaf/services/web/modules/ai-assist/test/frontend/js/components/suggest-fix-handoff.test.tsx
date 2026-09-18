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
import {
  clearFixStore,
  saveStoredFix,
} from '../../../../frontend/js/features/ai-assist/agent/fix-store'
import { takePendingHandoff } from '../../../../frontend/js/features/ai-assist/agent/chat-handoff'
import { setChatBusy } from '../../../../frontend/js/features/ai-assist/agent/chat-activity'
import SuggestFixPanel from '../../../../frontend/js/features/ai-assist/components/suggest-fix-panel'

const LOG_ENTRY = {
  key: 'entry-1',
  file: 'chapter3.tex',
  line: 87,
  level: 'error',
  message: 'Undefined control sequence',
  raw: 'l.87 \\includegraphics',
}

const STORED_PROVIDER = {
  type: 'openai' as const,
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-4o-mini',
}

/** A finished fix run, as the panel would have left it in storage. */
const FINISHED_TRANSCRIPT = [
  {
    id: 'u0',
    role: 'user' as const,
    text: '<task>fix it</task>',
    contextText:
      '<compile-error file="chapter3.tex" line="87" level="error">\n' +
      'Undefined control sequence\n</compile-error>',
  },
  {
    id: 'a0',
    role: 'assistant' as const,
    text: '',
    toolCalls: [
      { id: 'c1', name: 'edit_file', args: { path: 'main.tex', from: 3 } },
    ],
    blocks: [
      {
        type: 'tool_call' as const,
        call: { id: 'c1', name: 'edit_file', args: { path: 'main.tex', from: 3 } },
      },
      { type: 'text' as const, text: 'The graphicx package is missing.' },
    ],
  },
]

function setMeta() {
  resetMeta()
  const exposed = window.metaAttributesCache.get('ol-ExposedSettings') || {}
  window.metaAttributesCache.set('ol-ExposedSettings', {
    ...exposed,
    validRootDocExtensions: ['tex', 'latex'],
  })
  window.metaAttributesCache.set('ol-aiAssistEnabled', true)
  window.metaAttributesCache.set('ol-showAiFeatures', true)
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
    logEntries: { all: [], errors: [], warnings: [], typesetting: [] },
    rawLog: '',
  }
  return (
    <LocalCompileContext.Provider value={value}>
      {children}
    </LocalCompileContext.Provider>
  )
}

function renderPanel(props: Record<string, unknown> = {}) {
  return render(
    <EditorProviders
      mockCompileOnLoad={false}
      providers={{
        EditorManagerProvider: MockEditorManagerProvider,
        LocalCompileProvider: MockLocalCompileProvider,
      }}
    >
      <SuggestFixPanel logEntry={LOG_ENTRY} {...props} />
    </EditorProviders>
  )
}

function storeFinishedFix() {
  saveStoredFix(PROJECT_ID, {
    entryId: 'entry-1',
    fingerprint: '',
    open: true,
    collapsed: false,
    transcript: FINISHED_TRANSCRIPT,
    running: false,
    decidedEdits: {},
    updatedAt: Date.now(),
  } as any)
}

describe('SuggestFixPanel handoff to the main chat', function () {
  beforeEach(function () {
    clearFixStore()
    setChatBusy(PROJECT_ID, false)
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
      .callsFake(() => '\\documentclass{article}\n\\begin{document}\nhi\n\\end{document}')
    sinon
      .stub(ProjectSnapshot.prototype, 'getBinaryFilePathsWithHash')
      .returns([])
  })

  afterEach(function () {
    sinon.restore()
    setChatBusy(PROJECT_ID, false)
    fetchMock.removeRoutes().clearHistory()
    customLocalStorage.clear()
  })

  it('offers the handoff once a finished run is showing', function () {
    storeFinishedFix()
    renderPanel()

    expect(screen.getByRole('button', { name: /continue in chat/i })).to.exist
  })

  it('shows Stop instead while the run is still going', async function () {
    fetchMock.post('/ai-assist/providers/chat', () => {
      return new Promise(() => {}) as any
    })

    renderPanel()
    window.dispatchEvent(
      new CustomEvent('aiAssist:suggestFix', { detail: { entryId: 'entry-1' } })
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /stop/i })).to.exist
    })
    expect(screen.queryByRole('button', { name: /continue in chat/i })).to.equal(
      null
    )
  })

  it('offers nothing to hand off before a run has produced anything', function () {
    renderPanel()
    window.dispatchEvent(
      new CustomEvent('aiAssist:suggestFix', { detail: { entryId: 'entry-1' } })
    )

    expect(screen.queryByRole('button', { name: /continue in chat/i })).to.equal(
      null
    )
  })

  it('parks the whole run, original context included, for the chat', function () {
    storeFinishedFix()
    renderPanel()

    fireEvent.click(screen.getByRole('button', { name: /continue in chat/i }))

    const handoff = takePendingHandoff(PROJECT_ID)
    expect(handoff).to.not.equal(null)
    expect(handoff!.entryId).to.equal('entry-1')
    expect(handoff!.contextText).to.contain('<compile-error')
    expect(handoff!.contextText).to.contain('The graphicx package is missing.')
    expect(handoff!.contextText).to.contain('<handoff>')
    expect(handoff!.text).to.contain('chapter3.tex')
  })

  it('opens the assistant panel on the rail', function () {
    storeFinishedFix()
    const opened = sinon.stub()
    window.addEventListener('ui:select-rail-tab', opened)

    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /continue in chat/i }))

    window.removeEventListener('ui:select-rail-tab', opened)
    expect(opened.calledOnce).to.equal(true)
    expect(opened.firstCall.args[0].detail).to.deep.equal({
      tab: 'ai-assist',
      open: true,
    })
  })

  it('refuses and warns while the assistant is busy with another request', function () {
    storeFinishedFix()
    setChatBusy(PROJECT_ID, true)
    renderPanel()

    fireEvent.click(screen.getByRole('button', { name: /continue in chat/i }))

    expect(screen.getByRole('alert').textContent).to.match(/busy/i)
    expect(takePendingHandoff(PROJECT_ID)).to.equal(null)
  })

  it('drops the busy warning once the assistant goes idle', async function () {
    storeFinishedFix()
    setChatBusy(PROJECT_ID, true)
    renderPanel()

    fireEvent.click(screen.getByRole('button', { name: /continue in chat/i }))
    expect(screen.getByRole('alert')).to.exist

    setChatBusy(PROJECT_ID, false)

    await waitFor(() => {
      expect(screen.queryByRole('alert')).to.equal(null)
    })
  })

  it('offers the handoff from the folded history card too', function () {
    storeFinishedFix()
    renderPanel({ forceCollapsed: true })

    expect(screen.getByRole('button', { name: /re-open/i })).to.exist
    expect(screen.getByRole('button', { name: /continue in chat/i })).to.exist
  })

  it('hands off the stored run from the folded card without re-reading files', function () {
    storeFinishedFix()
    renderPanel({ forceCollapsed: true })

    fireEvent.click(screen.getByRole('button', { name: /continue in chat/i }))

    const handoff = takePendingHandoff(PROJECT_ID)
    expect(handoff!.contextText).to.contain('<compile-error')
    expect(handoff!.contextText).to.contain('The graphicx package is missing.')
  })
})
