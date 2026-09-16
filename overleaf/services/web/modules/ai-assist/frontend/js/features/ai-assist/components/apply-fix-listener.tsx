import { useCallback, useEffect } from 'react'
import { useCodeMirrorViewContext } from '@/features/source-editor/components/codemirror-context'
import { useEditorOpenDocContext } from '@/features/ide-react/context/editor-open-doc-context'
import useEventListener from '@/shared/hooks/use-event-listener'
import getMeta from '@/utils/meta'

function lineRangeToOffsets(
  doc: { lines: number; line: (n: number) => { from: number; to: number } },
  from: number,
  to: number
): { from: number; to: number } | null {
  if (from < 1 || to > doc.lines || from > to) return null
  return {
    from: doc.line(from).from,
    to: doc.line(to).to,
  }
}

function ApplyFixListenerInner() {
  const view = useCodeMirrorViewContext()
  const { openDocName } = useEditorOpenDocContext()

  useEffect(() => {
    const handleSelectionChange = () => {
      const active = document.activeElement
      // If focus is in an input or textarea outside the CodeMirror editor view, ignore
      if (active && !view.dom.contains(active) && active !== document.body) {
        return
      }
      const { from, to } = view.state.selection.main
      if (from !== to) {
        const startLine = view.state.doc.lineAt(from).number
        const endLine = view.state.doc.lineAt(to).number
        const text = view.state.sliceDoc(from, to)
        const path = openDocName || 'main.tex'
        window.dispatchEvent(
          new CustomEvent('aiAssist:selectionChanged', {
            detail: { path, from: startLine, to: endLine, text },
          })
        )
      } else {
        window.dispatchEvent(
          new CustomEvent('aiAssist:selectionChanged', {
            detail: null,
          })
        )
      }
      window.dispatchEvent(
        new CustomEvent('aiAssist:agentCursor', {
          detail: { line: view.state.doc.lineAt(view.state.selection.main.head).number },
        })
      )
    }

    // Seed it once: until the user clicks or types in the editor, the agent's
    // context would carry no cursor line at all, and a first message sent
    // straight from the rail would have nothing to say where the user is.
    handleSelectionChange()

    const dom = view.dom
    dom.addEventListener('mouseup', handleSelectionChange)
    dom.addEventListener('keyup', handleSelectionChange)
    dom.addEventListener('pointerup', handleSelectionChange)
    document.addEventListener('selectionchange', handleSelectionChange)

    return () => {
      dom.removeEventListener('mouseup', handleSelectionChange)
      dom.removeEventListener('keyup', handleSelectionChange)
      dom.removeEventListener('pointerup', handleSelectionChange)
      document.removeEventListener('selectionchange', handleSelectionChange)
      window.dispatchEvent(
        new CustomEvent('aiAssist:selectionChanged', {
          detail: null,
        })
      )
    }
  }, [view, openDocName])

  const onAgentReadDoc = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent('aiAssist:agentReadDocResult', {
        detail: { text: view.state.doc.toString() },
      })
    )
  }, [view])

  const onAgentApplyEdit = useCallback(
    (event: Event) => {
      const { from, to, oldText, replacement } =
        (event as CustomEvent<any>).detail ?? {}

      const current = view.state.doc.toString().split('\n')
      const respond = (status: string) =>
        window.dispatchEvent(
          new CustomEvent('aiAssist:agentApplyEditResult', { detail: { status } })
        )

      // The user may have typed since the diff was rendered. Compare against the
      // anchor the model matched, not a stale snapshot.
      if (current.slice(from - 1, to).join('\n') !== oldText) {
        return respond('drifted')
      }

      const offsets = lineRangeToOffsets(view.state.doc, from, to)
      if (!offsets) return respond('drifted')

      view.dispatch({
        changes: { from: offsets.from, to: offsets.to, insert: replacement },
      })
      respond('applied')
    },
    [view]
  )

  const onAgentReadSelection = useCallback(() => {
    const { from, to } = view.state.selection.main
    window.dispatchEvent(
      new CustomEvent('aiAssist:agentSelection', {
        detail:
          from === to
            ? null
            : {
                path: openDocName || 'main.tex',
                from: view.state.doc.lineAt(from).number,
                to: view.state.doc.lineAt(to).number,
                text: view.state.sliceDoc(from, to),
              },
      })
    )
  }, [view, openDocName])

  const onJumpToLine = useCallback(
    (event: Event) => {
      const detail = (event as CustomEvent<{ line?: number; column?: number }>).detail
      if (typeof detail?.line === 'number' && view) {
        const lineNo = Math.min(Math.max(1, detail.line), view.state.doc.lines)
        const line = view.state.doc.line(lineNo)
        const col = typeof detail.column === 'number' ? Math.max(0, detail.column - 1) : 0
        const pos = Math.min(line.from + col, line.to)
        view.dispatch({
          selection: { anchor: pos, head: pos },
          scrollIntoView: true,
        })
      }
    },
    [view]
  )

  const onInsertSnippet = useCallback(
    (event: Event) => {
      const detail = (event as CustomEvent<{ text?: string; command?: string }>).detail
      const text = detail?.text ?? detail?.command
      if (typeof text !== "string" || !view) return

      view.focus()
      const { from, to } = view.state.selection.main
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length, head: from + text.length },
        scrollIntoView: true,
      })
    },
    [view]
  )

  useEventListener('aiAssist:agentReadDoc', onAgentReadDoc)
  useEventListener('aiAssist:agentApplyEdit', onAgentApplyEdit)
  useEventListener('aiAssist:agentReadSelection', onAgentReadSelection)
  useEventListener('aiAssist:jumpToLine', onJumpToLine)
  useEventListener('aiAssist:insertSnippet', onInsertSnippet)

  return null
}

/**
 * Bridges agent edits and editor state to the document.
 *
 * This lives in the `sourceEditorComponents` slot rather than in the log-entry
 * panel because useCodeMirrorViewContext throws outside its provider, and the
 * compile-log pane renders outside the source editor. The panel and agent therefore
 * talk to the editor through window events.
 */
export default function ApplyFixListener() {
  const isEnabled =
    Boolean(getMeta('ol-aiAssistEnabled')) &&
    getMeta('ol-showAiFeatures') !== false

  if (!isEnabled) {
    return null
  }

  return <ApplyFixListenerInner />
}
