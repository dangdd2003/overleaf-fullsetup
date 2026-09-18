import { expect } from 'chai'
import React from 'react'
import { render, act } from '@testing-library/react'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import ApplyFixListener from '../../../../frontend/js/features/ai-assist/components/apply-fix-listener'
import { CodeMirrorViewContext } from '@/features/source-editor/components/codemirror-context'
import { EditorOpenDocContext } from '@/features/ide-react/context/editor-open-doc-context'

describe('useProjectHandle & CodeMirror Bridge Integration', function () {
  let container: HTMLDivElement
  let view: EditorView

  beforeEach(function () {
    window.metaAttributesCache = new Map([
      ['ol-aiAssistEnabled', true as any],
      ['ol-showAiFeatures', true as any],
    ])
    container = document.createElement('div')
    document.body.appendChild(container)
    const state = EditorState.create({
      doc: '\\documentclass{article}\n\\begin{document}\nHello World\n\\end{document}',
    })
    view = new EditorView({ state, parent: container })
  })

  afterEach(function () {
    view.destroy()
    container.remove()
    window.metaAttributesCache = new Map()
  })

  it('handles aiAssist:agentApplyEdit and updates CodeMirror view', async function () {
    render(
      <CodeMirrorViewContext.Provider value={view}>
        <EditorOpenDocContext.Provider
          value={{ openDocName: 'main.tex', currentDocumentId: 'doc-1' } as any}
        >
          <ApplyFixListener />
        </EditorOpenDocContext.Provider>
      </CodeMirrorViewContext.Provider>
    )

    let resultStatus: string | null = null
    const onResult = (e: Event) => {
      resultStatus = (e as CustomEvent).detail?.status
    }
    window.addEventListener('aiAssist:agentApplyEditResult', onResult)

    act(() => {
      window.dispatchEvent(
        new CustomEvent('aiAssist:agentApplyEdit', {
          detail: {
            from: 3,
            to: 3,
            oldText: 'Hello World',
            replacement: 'Hello Overleaf',
          },
        })
      )
    })

    expect(resultStatus).to.equal('applied')
    expect(view.state.doc.toString()).to.include('Hello Overleaf')
    window.removeEventListener('aiAssist:agentApplyEditResult', onResult)
  })

  it('rejects drifted edit when text does not match oldText', async function () {
    render(
      <CodeMirrorViewContext.Provider value={view}>
        <EditorOpenDocContext.Provider
          value={{ openDocName: 'main.tex', currentDocumentId: 'doc-1' } as any}
        >
          <ApplyFixListener />
        </EditorOpenDocContext.Provider>
      </CodeMirrorViewContext.Provider>
    )

    let resultStatus: string | null = null
    const onResult = (e: Event) => {
      resultStatus = (e as CustomEvent).detail?.status
    }
    window.addEventListener('aiAssist:agentApplyEditResult', onResult)

    act(() => {
      window.dispatchEvent(
        new CustomEvent('aiAssist:agentApplyEdit', {
          detail: {
            from: 3,
            to: 3,
            oldText: 'Mismatch Text',
            replacement: 'Hello Overleaf',
          },
        })
      )
    })

    expect(resultStatus).to.equal('drifted')
    expect(view.state.doc.toString()).to.include('Hello World')
    window.removeEventListener('aiAssist:agentApplyEditResult', onResult)
  })
})
