import { expect } from 'chai'
import React, { useEffect } from 'react'
import sinon from 'sinon'
import { render, waitFor } from '@testing-library/react'
import { createFakeHandle } from './helpers/fake-handle'
import { EditorProviders } from '../../../../../../test/frontend/helpers/editor-providers'
import { useProjectHandle } from '../../../../frontend/js/features/ai-assist/agent/use-project-handle'
import {
  EditRequest,
  ProjectHandle,
} from '../../../../frontend/js/features/ai-assist/agent/project-handle'
import useEventListener from '@/shared/hooks/use-event-listener'
import { ProjectSnapshot } from '@/infrastructure/project-snapshot'
import { resetMeta } from '../../../../../../test/frontend/helpers/reset-meta'

describe('fake handle context accessors', function () {
  beforeEach(function () {
    resetMeta()
    const exposed = window.metaAttributesCache.get('ol-ExposedSettings') || {}
    window.metaAttributesCache.set('ol-ExposedSettings', {
      ...exposed,
      validRootDocExtensions: ['tex', 'latex'],
    })
  })
  it('reports no open file and no compile by default', function () {
    const { handle } = createFakeHandle({ docs: { 'main.tex': 'hello' } })
    expect(handle.openFile()).to.equal(null)
    expect(handle.lastCompile()).to.equal(null)
  })

  it('reports the configured open file and cursor line', function () {
    const { handle } = createFakeHandle({
      docs: { 'main.tex': 'a\nb\nc' },
      openFile: { path: 'main.tex', cursorLine: 2 },
    })
    expect(handle.openFile()).to.deep.equal({ path: 'main.tex', cursorLine: 2 })
  })

  it('reports the last compile including its raw log', function () {
    const { handle } = createFakeHandle({
      docs: { 'main.tex': 'x' },
      lastCompile: {
        status: 'failure',
        errors: [
          { message: 'Undefined control sequence', file: 'main.tex', line: 3 },
        ],
        warnings: [],
        rawLog: '! Undefined control sequence.\nl.3 \\foo',
      },
    })
    const compile = handle.lastCompile()
    expect(compile?.status).to.equal('failure')
    expect(compile?.errors).to.have.length(1)
    expect(compile?.rawLog).to.include('Undefined control sequence')
  })

  it('gives docs a line count in listFiles', async function () {
    const { handle } = createFakeHandle({ docs: { 'main.tex': 'a\nb\nc' } })
    const files = await handle.listFiles()
    expect(files[0].lines).to.equal(3)
  })

  it('tells the approver which line the edit starts on', async function () {
    // NOTE: this only proves the fake's own inline startLine arithmetic
    // (text.indexOf + split('\n').length, written directly in fake-handle.ts).
    // It would keep passing even if use-project-handle.ts's real proposeEdit
    // were never touched. It is kept because later tasks (8, 10) rely on
    // `approvalContexts` existing on the fake as a test fixture. The suite
    // below, "useProjectHandle (real) proposeEdit", is what actually proves
    // this task's production change.
    const { handle, approvalContexts } = createFakeHandle({
      docs: { 'main.tex': 'line one\nline two\nline three' },
    })

    await handle.proposeEdit({
      path: 'main.tex',
      oldText: 'line two',
      newText: 'line 2',
    })

    expect(approvalContexts).to.deep.equal([{ startLine: 2 }])
  })

  it('exposes a structural index built from the project snapshot', async function () {
    const { handle } = createFakeHandle({
      docs: { 'main.tex': '\\documentclass{article}\n\\section{Intro}\n' },
      rootDoc: 'main.tex',
    })

    const index = await handle.index()
    expect(index.outline.documentClass).to.equal('article')
    expect(index.outline.sections.map(s => s.title)).to.include('Intro')

    // Identity: an unchanged project returns the same object, so callers can
    // rely on referential equality as a cheap no-change signal.
    const again = await handle.index()
    expect(again).to.equal(index)
  })
})

/**
 * The real `proposeEdit` (in use-project-handle.ts) never reads document text
 * off scope, file-tree data, or a socket-backed snapshot directly. It
 * round-trips a pair of window events -- `aiAssist:agentReadDoc` answered by
 * `aiAssist:agentReadDocResult` -- because the panel that calls it renders
 * outside the source editor's React tree and can only reach whichever
 * CodeMirror view is mounted through that bridge. In production,
 * `apply-fix-listener.tsx` answers with `view.state.doc.toString()`, which
 * needs a live CodeMirror view. This component answers the same event with a
 * plain string the test controls, standing in for exactly the one thing
 * `apply-fix-listener.tsx` provides that this test needs and that EditorProviders
 * has no lighter-weight seam for.
 */
function FakeEditorBridge({ text }: { text: string }) {
  useEventListener('aiAssist:agentReadDoc', () => {
    window.dispatchEvent(
      new CustomEvent('aiAssist:agentReadDocResult', { detail: { text } })
    )
  })
  return null
}

function Probe({
  requestApproval,
  onHandle,
}: {
  requestApproval: (
    edit: EditRequest,
    context: { startLine: number }
  ) => Promise<{ accepted: boolean; note?: string }>
  onHandle: (handle: ProjectHandle) => void
}) {
  const handle = useProjectHandle({ requestApproval })
  useEffect(() => {
    onHandle(handle)
  }, [handle, onHandle])
  return null
}

describe('useProjectHandle (real) proposeEdit', function () {
  beforeEach(function () {
    resetMeta()
    const exposed = window.metaAttributesCache.get('ol-ExposedSettings') || {}
    window.metaAttributesCache.set('ol-ExposedSettings', {
      ...exposed,
      validRootDocExtensions: ['tex', 'latex'],
    })
  })

  it('tells the approver which line the edit starts on', async function () {
    const requestApproval = sinon.stub().resolves({ accepted: false })
    let handle: ProjectHandle | undefined

    render(
      React.createElement(
        EditorProviders,
        {
          scope: {
            editor: {
              currentDocumentId: '_root_doc_id',
              openDocName: 'main.tex',
            },
          },
        },
        React.createElement(FakeEditorBridge, {
          text: 'line one\nline two\nline three',
        }),
        React.createElement(Probe, {
          requestApproval,
          onHandle: (h: ProjectHandle) => {
            handle = h
          },
        })
      )
    )

    await waitFor(() => {
      expect(handle).to.not.equal(undefined)
    })

    const outcome = await handle!.proposeEdit({
      path: 'main.tex',
      oldText: 'line two',
      newText: 'line 2',
    })

    expect(requestApproval).to.have.been.calledOnce
    expect(requestApproval.firstCall.args[1]).to.deep.equal({ startLine: 2 })
    expect(outcome.status).to.equal('rejected')
  })
})

describe('useProjectHandle (real) listFiles', function () {
  afterEach(function () {
    sinon.restore()
  })

  it('refreshes the snapshot before reading it', async function () {
    // The snapshot starts empty and its instance is never replaced, so reading
    // it without refreshing first yields no files for the rest of the session.
    // That is what broke @-mentions and the attach menu, which list these paths.
    let refreshed = false
    const refresh = sinon.stub(ProjectSnapshot.prototype, 'refresh').callsFake(
      async () => {
        refreshed = true
      }
    )
    sinon
      .stub(ProjectSnapshot.prototype, 'getDocPaths')
      .callsFake(() => (refreshed ? ['/main.tex'] : []))
    sinon
      .stub(ProjectSnapshot.prototype, 'getDocContents')
      .callsFake(() => 'a\nb')

    let handle: ProjectHandle | undefined
    render(
      React.createElement(
        EditorProviders,
        {},
        React.createElement(Probe, {
          requestApproval: sinon.stub().resolves({ accepted: false }),
          onHandle: (h: ProjectHandle) => {
            handle = h
          },
        })
      )
    )

    await waitFor(() => {
      expect(handle).to.not.equal(undefined)
    })

    const files = await handle!.listFiles()

    expect(refresh).to.have.been.called
    expect(files.map(file => file.path)).to.include('main.tex')
  })
})
