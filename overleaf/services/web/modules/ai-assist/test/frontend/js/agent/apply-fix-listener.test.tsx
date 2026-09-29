import { expect } from 'chai'
import React from 'react'
import { render, cleanup } from '@testing-library/react'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { CodeMirrorViewContext } from '@/features/source-editor/components/codemirror-context'
import { EditorOpenDocContext } from '@/features/ide-react/context/editor-open-doc-context'
import ApplyFixListener from '../../../../frontend/js/features/ai-assist/components/apply-fix-listener'
import { resetMeta } from '../../../../../../test/frontend/helpers/reset-meta'

describe('ApplyFixListener', function () {
  let container: HTMLDivElement
  let view: EditorView

  function setupEditor(docText: string, openDocName = 'main.tex') {
    cleanup()
    container = document.createElement('div')
    document.body.appendChild(container)

    const state = EditorState.create({ doc: docText })
    view = new EditorView({ state, parent: container })

    window.metaAttributesCache.set('ol-aiAssistEnabled', true)
    window.metaAttributesCache.set('ol-showAiFeatures', true)

    const openDocContextValue: any = {
      openDocName,
      currentDocumentId: 'doc-1',
      currentDocument: { id: 'doc-1' },
      isPending: false,
      isPendingEditor: false,
    }

    render(
      <EditorOpenDocContext.Provider value={openDocContextValue}>
        <CodeMirrorViewContext.Provider value={view}>
          <ApplyFixListener />
        </CodeMirrorViewContext.Provider>
      </EditorOpenDocContext.Provider>
    )
  }

  function dispatchApplyEdit(detail: any): Promise<string> {
    return new Promise(resolve => {
      const onResult = (e: Event) => {
        window.removeEventListener('aiAssist:agentApplyEditResult', onResult)
        resolve((e as CustomEvent).detail?.status)
      }
      window.addEventListener('aiAssist:agentApplyEditResult', onResult)
      window.dispatchEvent(new CustomEvent('aiAssist:agentApplyEdit', { detail }))
    })
  }

  function dispatchReadDoc(detail?: any): Promise<any> {
    return new Promise(resolve => {
      const onResult = (e: Event) => {
        window.removeEventListener('aiAssist:agentReadDocResult', onResult)
        resolve((e as CustomEvent).detail)
      }
      window.addEventListener('aiAssist:agentReadDocResult', onResult)
      window.dispatchEvent(new CustomEvent('aiAssist:agentReadDoc', { detail }))
    })
  }

  beforeEach(function () {
    resetMeta()
  })

  afterEach(function () {
    cleanup()
    if (view) view.destroy()
    if (container && container.parentNode) {
      container.parentNode.removeChild(container)
    }
  })

  it('responds with document text when requested path matches active document', async function () {
    setupEditor('line 1\nline 2\nline 3\n', 'main.tex')

    const result = await dispatchReadDoc({ path: 'main.tex' })

    expect(result).to.not.equal(null)
    expect(result.text).to.be.a('string')
    expect(result.error).to.equal(undefined)
  })

  it('responds with null text and pathMismatch error when requested path differs from active document', async function () {
    setupEditor('line 1\nline 2\nline 3\n', 'main.tex')

    const result = await dispatchReadDoc({ path: 'chapters/intro.tex' })

    expect(result).to.not.equal(null)
    expect(result.text).to.equal(null)
    expect(result.error).to.equal('pathMismatch')
  })

  it('appends text to a document without trailing newline by prepending a newline', async function () {
    setupEditor('line 1\nline 2')

    const status = await dispatchApplyEdit({
      oldText: '',
      replacement: '\\section{Conclusion}',
      isAppend: true,
    })

    expect(status).to.equal('applied')
    expect(view.state.doc.toString()).to.equal(
      'line 1\nline 2\n\\section{Conclusion}'
    )
  })

  it('appends text to a document with a trailing newline without extra blank line', async function () {
    setupEditor('line 1\nline 2\n')

    const status = await dispatchApplyEdit({
      oldText: '',
      replacement: '\\section{Conclusion}\n',
      isAppend: true,
    })

    expect(status).to.equal('applied')
    expect(view.state.doc.toString()).to.equal(
      'line 1\nline 2\n\\section{Conclusion}\n'
    )
  })

  it('appends text to an empty document', async function () {
    setupEditor('')

    const status = await dispatchApplyEdit({
      oldText: '',
      replacement: '\\documentclass{article}',
      isAppend: true,
    })

    expect(status).to.equal('applied')
    expect(view.state.doc.toString()).to.equal('\\documentclass{article}')
  })

  it('performs surgical sub-line replacement without wiping surrounding text', async function () {
    const initialText = 'See \\cite{oldKey} for full details.'
    setupEditor(initialText)

    const oldText = '\\cite{oldKey}'
    const fromOffset = initialText.indexOf(oldText)
    const toOffset = fromOffset + oldText.length

    const status = await dispatchApplyEdit({
      fromOffset,
      toOffset,
      oldText,
      replacement: '\\cite{newKey}',
    })

    expect(status).to.equal('applied')
    expect(view.state.doc.toString()).to.equal(
      'See \\cite{newKey} for full details.'
    )
  })

  it('deletes an entire line cleanly without leaving a blank line', async function () {
    const initialText = 'line 1\nline 2\nline 3\n'
    setupEditor(initialText)

    const oldText = 'line 2'
    const fromOffset = initialText.indexOf(oldText)
    const toOffset = fromOffset + oldText.length

    const status = await dispatchApplyEdit({
      fromOffset,
      toOffset,
      oldText,
      replacement: '',
    })

    expect(status).to.equal('applied')
    expect(view.state.doc.toString()).to.equal('line 1\nline 3\n')
  })

  it('deletes the final line of a document cleanly without leaving trailing blank line', async function () {
    const initialText = 'line 1\nline 2'
    setupEditor(initialText)

    const oldText = 'line 2'
    const fromOffset = initialText.indexOf(oldText)
    const toOffset = fromOffset + oldText.length

    const status = await dispatchApplyEdit({
      fromOffset,
      toOffset,
      oldText,
      replacement: '',
    })

    expect(status).to.equal('applied')
    expect(view.state.doc.toString()).to.equal('line 1')
  })

  it('falls back to in-document search if offsets drifted but anchor is unique', async function () {
    setupEditor('alpha\nbeta\ngamma')

    const status = await dispatchApplyEdit({
      fromOffset: 0, // Stale offset
      toOffset: 5,
      oldText: 'beta',
      replacement: 'BETA',
    })

    expect(status).to.equal('applied')
    expect(view.state.doc.toString()).to.equal('alpha\nBETA\ngamma')
  })

  it('returns drifted if oldText cannot be found anywhere in the document', async function () {
    setupEditor('alpha\nbeta\ngamma')

    const status = await dispatchApplyEdit({
      oldText: 'delta',
      replacement: 'DELTA',
    })

    expect(status).to.equal('drifted')
    expect(view.state.doc.toString()).to.equal('alpha\nbeta\ngamma')
  })

  it('returns drifted if oldText is ambiguous and offsets do not match', async function () {
    setupEditor('alpha\nbeta\ngamma\nbeta\n')

    const status = await dispatchApplyEdit({
      fromOffset: 0, // Wrong offset
      toOffset: 4,
      oldText: 'beta',
      replacement: 'BETA',
    })

    expect(status).to.equal('drifted')
  })

  it('returns pathMismatch if target path does not match openDocName', async function () {
    setupEditor('content', 'main.tex')

    const status = await dispatchApplyEdit({
      path: 'chapters/intro.tex',
      oldText: 'content',
      replacement: 'new content',
    })

    expect(status).to.equal('pathMismatch')
    expect(view.state.doc.toString()).to.equal('content')
  })
})
