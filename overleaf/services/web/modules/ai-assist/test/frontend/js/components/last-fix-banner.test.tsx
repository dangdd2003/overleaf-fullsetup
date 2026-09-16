import React from 'react'
import { expect } from 'chai'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { resetMeta } from '../../../../../../test/frontend/helpers/reset-meta'
import {
  EditorProviders,
  PROJECT_ID,
} from '../../../../../../test/frontend/helpers/editor-providers'
import { EditorManagerContext } from '@/features/ide-react/context/editor-manager-context'
import { LocalCompileContext } from '@/shared/context/local-compile-context'
import {
  clearFixStore,
  saveStoredFix,
  recordLastCompletedFix,
} from '../../../../frontend/js/features/ai-assist/agent/fix-store'
import LastFixBanner from '../../../../frontend/js/features/ai-assist/components/last-fix-banner'

function setMeta() {
  resetMeta()
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

function makeLocalCompileProvider(currentLogEntries: any[] = []) {
  const MockLocalCompileProvider: React.FC<React.PropsWithChildren> = ({
    children,
  }) => {
    const value: any = {
      autoCompile: false,
      compiling: false,
      startCompile: async () => {},
      logEntries: {
        all: currentLogEntries,
        errors: currentLogEntries.filter(e => e.level === 'error'),
        warnings: currentLogEntries.filter(e => e.level === 'warning'),
        typesetting: [],
      },
      rawLog: '',
    }
    return (
      <LocalCompileContext.Provider value={value}>
        {children}
      </LocalCompileContext.Provider>
    )
  }
  return MockLocalCompileProvider
}

function renderBanner(currentLogEntries: any[] = []) {
  return render(
    <EditorProviders
      mockCompileOnLoad={false}
      providers={{
        EditorManagerProvider: MockEditorManagerProvider,
        LocalCompileProvider: makeLocalCompileProvider(currentLogEntries),
      }}
    >
      <LastFixBanner />
    </EditorProviders>
  )
}

const FINGERPRINT = 'chapter3.tex:87:Undefined control sequence'

const STORED_FIX = {
  entryId: 'entry-1',
  fingerprint: FINGERPRINT,
  open: true,
  transcript: [
    {
      id: 'a1' as const,
      role: 'assistant' as const,
      text: 'Add \\usepackage{graphicx} to the preamble.',
      toolCalls: [],
    },
  ],
  decidedEdits: {},
  updatedAt: Date.now(),
}

const SUMMARY = {
  entryId: 'entry-1',
  fingerprint: FINGERPRINT,
  file: 'chapter3.tex',
  line: 87,
  message: 'Undefined control sequence',
  level: 'error' as const,
}

describe('LastFixBanner', function () {
  beforeEach(function () {
    clearFixStore()
    setMeta()
    document.body.innerHTML = ''
  })

  it('renders nothing when no fix has completed this session', function () {
    const { container } = renderBanner()
    expect(container.textContent).to.equal('')
  })

  it('surfaces the last completed fix after its log entry disappears, and reopens it folded', async function () {
    // The real flow: the entry's own panel saved the finished fix under this
    // entryId+fingerprint before recompiling made the entry (and its panel)
    // vanish. The banner is the only thing left holding a pointer to it. Its
    // live panel was left *expanded* (collapsed: false) when it disappeared —
    // the banner must still come up folded rather than resurrecting that.
    saveStoredFix(PROJECT_ID, { ...STORED_FIX, collapsed: false })

    // Nothing in the current compile log any more: the fix worked.
    renderBanner([])
    expect(screen.queryByText(/Last suggested fix/i)).to.not.exist

    recordLastCompletedFix(PROJECT_ID, SUMMARY)
    fireEvent(window, new CustomEvent('aiAssist:suggestDone', { detail: {} }))

    await waitFor(() =>
      expect(screen.getByText(/Last suggested fix/i)).to.exist
    )
    expect(screen.getByText('./chapter3.tex, 87')).to.exist
    // Folded: the full explanation is not shown until Re-open is clicked.
    expect(screen.queryByText(/Add \\usepackage/)).to.not.exist

    fireEvent.click(screen.getByRole('button', { name: /re-open/i }))

    await waitFor(() =>
      expect(
        screen.getByText(/Add \\usepackage\{graphicx\} to the preamble\./)
      ).to.exist
    )
  })

  it('does not duplicate the fix while its log entry is still present in the log', async function () {
    saveStoredFix(PROJECT_ID, { ...STORED_FIX, collapsed: true })

    // The same problem (by fingerprint) is still in the current compile log —
    // its own inline panel is still mounted under that entry and already
    // shows this fix, so the global banner must stay out of the way.
    renderBanner([
      {
        key: 'entry-1',
        file: 'chapter3.tex',
        line: 87,
        level: 'error',
        message: 'Undefined control sequence',
      },
    ])

    recordLastCompletedFix(PROJECT_ID, SUMMARY)
    fireEvent(window, new CustomEvent('aiAssist:suggestDone', { detail: {} }))

    await new Promise(resolve => setTimeout(resolve, 10))
    expect(screen.queryByText(/Last suggested fix/i)).to.not.exist
  })
})
