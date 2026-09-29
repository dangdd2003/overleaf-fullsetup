import React from 'react'
import { expect } from 'chai'
import sinon from 'sinon'
import { render, screen, fireEvent } from '@testing-library/react'
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

/** A finished fix run that both thought and used tools. */
const TRANSCRIPT = [
  { id: 'u0', role: 'user' as const, text: '<task>fix</task>', contextText: 'ctx' },
  {
    id: 'a0',
    role: 'assistant' as const,
    text: '',
    thinkingElapsedMs: 4000,
    toolCalls: [
      {
        id: 'c1',
        name: 'read_file',
        args: { path: 'main.tex' },
        result: { content: 'x' },
      },
      { id: 'c2', name: 'list_references', args: {}, result: {} },
    ],
    blocks: [
      {
        type: 'thinking' as const,
        thinking: 'The preamble never loads graphicx.',
        elapsedMs: 4000,
      },
      {
        type: 'tool_call' as const,
        call: {
          id: 'c1',
          name: 'read_file',
          args: { path: 'main.tex' },
          result: { content: 'x' },
        },
      },
      {
        type: 'tool_call' as const,
        call: { id: 'c2', name: 'list_references', args: {}, result: {} },
      },
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

/**
 * The compile-error panel and the main chat are two views of the same agent,
 * so they must render its activity with the same component. They used to have
 * separate ones, and the error panel's could not show a thought process.
 */
describe('the error panel renders activity like the main chat', function () {
  beforeEach(function () {
    clearFixStore()
    fetchMock.removeRoutes().clearHistory()
    customLocalStorage.clear()
    customLocalStorage.setItem('ai-assist:provider', STORED_PROVIDER)
    customLocalStorage.setItem('ai-assist:consent', true)
    setMeta()
    document.body.innerHTML = ''

    sinon.stub(ProjectSnapshot.prototype, 'refresh').resolves()
    sinon.stub(ProjectSnapshot.prototype, 'getDocPaths').returns(['main.tex'])
    sinon.stub(ProjectSnapshot.prototype, 'getDocContents').callsFake(() => 'hi')
    sinon
      .stub(ProjectSnapshot.prototype, 'getBinaryFilePathsWithHash')
      .returns([])

    saveStoredFix(PROJECT_ID, {
      entryId: 'entry-1',
      fingerprint: '',
      open: true,
      collapsed: false,
      transcript: TRANSCRIPT,
      running: false,
      decidedEdits: {},
      updatedAt: Date.now(),
    } as any)
  })

  afterEach(function () {
    sinon.restore()
    fetchMock.removeRoutes().clearHistory()
    customLocalStorage.clear()
  })

  it('uses the same activity component the main chat uses', function () {
    const { container } = renderPanel()

    expect(container.querySelector('.ai-assist-subresult-group')).to.exist
  })

  it('summarises what the run did, not just that it thought', function () {
    renderPanel()

    expect(screen.getByText(/Read 1 file/)).to.exist
    expect(screen.getByText(/Thought for 4s/)).to.exist
  })

  it('exposes the thought process when the row is expanded', function () {
    renderPanel()

    fireEvent.click(screen.getByText(/Read 1 file/))

    expect(screen.getByText(/The preamble never loads graphicx/)).to.exist
  })
})
