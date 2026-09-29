import { useCallback, useEffect, useContext } from 'react'
import { useCodeMirrorViewContext } from '@/features/source-editor/components/codemirror-context'
import { useEditorOpenDocContext } from '@/features/ide-react/context/editor-open-doc-context'
import { FileTreeDataContext } from '@/shared/context/file-tree-data-context'
import { LocalCompileContext } from '@/shared/context/local-compile-context'
import { pathInFolder } from '@/features/file-tree/util/path'
import useEventListener from '@/shared/hooks/use-event-listener'
import getMeta from '@/utils/meta'
import { findUniqueSpan } from '../agent/use-project-handle'
import { setCompileLogEntries } from '../log-entry-levels'
import '../../../../stylesheets/ai-assist.scss'

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

function normalizePath(path: string | null | undefined): string {
  if (!path) return ''
  return path.replace(/^\//, '')
}

function ApplyFixListenerInner() {
  const view = useCodeMirrorViewContext()
  const { openDocName, currentDocumentId } = useEditorOpenDocContext()
  const fileTreeContext = useContext(FileTreeDataContext)
  const fileTreeData = fileTreeContext?.fileTreeData
  const logEntries = useContext(LocalCompileContext)?.logEntries

  // The inline "Suggest fix" in the editor tooltip only knows a diagnostic's
  // entry id; publish each entry's real level so it can apply the logs pane's
  // rule instead of the flattened diagnostic severity.
  useEffect(() => {
    setCompileLogEntries(logEntries?.all)
  }, [logEntries])

  // Full repo-relative path (e.g. 'sections/intro.tex') resolved via fileTreeData, falling back to openDocName
  const currentPath = normalizePath(
    (currentDocumentId && fileTreeData ? pathInFolder(fileTreeData, currentDocumentId) : null) ?? openDocName ?? 'main.tex'
  )

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
        const path = currentPath || 'main.tex'
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
  }, [view, currentPath])

  const onAgentReadDoc = useCallback(
    (event: Event) => {
      const detail = (event as CustomEvent<{ path?: string; docId?: string }> | undefined)?.detail
      const requestedPath = normalizePath(detail?.path)
      const requestedDocId = detail?.docId

      if (requestedPath && (!currentPath || requestedPath !== currentPath)) {
        return window.dispatchEvent(
          new CustomEvent('aiAssist:agentReadDocResult', {
            detail: {
              text: null,
              path: currentPath,
              docId: currentDocumentId,
              error: 'pathMismatch',
            },
          })
        )
      }

      if (requestedDocId && (!currentDocumentId || requestedDocId !== currentDocumentId)) {
        return window.dispatchEvent(
          new CustomEvent('aiAssist:agentReadDocResult', {
            detail: {
              text: null,
              path: currentPath,
              docId: currentDocumentId,
              error: 'docIdMismatch',
            },
          })
        )
      }

      window.dispatchEvent(
        new CustomEvent('aiAssist:agentReadDocResult', {
          detail: {
            text: view.state.doc.toString(),
            path: currentPath,
            docId: currentDocumentId,
          },
        })
      )
    },
    [view, currentPath, currentDocumentId]
  )

  const onAgentApplyEdit = useCallback(
    (event: Event) => {
      const detail = (event as CustomEvent<any>).detail ?? {}
      const {
        path,
        docId,
        from,
        to,
        fromOffset,
        toOffset,
        oldText,
        replacement = '',
        isAppend,
      } = detail

      const respond = (status: string, message?: string) =>
        window.dispatchEvent(
          new CustomEvent('aiAssist:agentApplyEditResult', { detail: { status, message } })
        )

      const requestedPath = normalizePath(path)

      if (requestedPath && (!currentPath || requestedPath !== currentPath)) {
        return respond(
          'pathMismatch',
          `Active editor document "${currentPath}" does not match target path "${requestedPath}".`
        )
      }

      if (docId && (!currentDocumentId || docId !== currentDocumentId)) {
        return respond(
          'docIdMismatch',
          `Active editor document ID "${currentDocumentId}" does not match target ID "${docId}".`
        )
      }

      const doc = view.state.doc
      const docText = doc.toString()

      // 1. Append mode: when oldText is empty or isAppend is true
      if (isAppend || oldText === '') {
        const docLen = doc.length
        let insertText = replacement
        // If the document is non-empty and does not end with a newline, prepend one
        if (docLen > 0 && !docText.endsWith('\n')) {
          insertText = '\n' + replacement
        }
        view.dispatch({
          changes: { from: docLen, to: docLen, insert: insertText },
        })
        return respond('applied')
      }

      // Helper to compute clean line deletion offsets
      const adjustForCleanLineDeletion = (cFrom: number, cTo: number) => {
        if (replacement !== '') return { cFrom, cTo }
        const isFullLineStart = cFrom === 0 || docText[cFrom - 1] === '\n'
        const isFullLineEnd =
          cTo === doc.length || docText[cTo - 1] === '\n' || docText[cTo] === '\n'
        if (isFullLineStart && isFullLineEnd) {
          // If the span already includes its trailing newline, no adjustment is needed
          if (cTo > cFrom && docText[cTo - 1] === '\n') {
            return { cFrom, cTo }
          }
          if (cTo < doc.length && docText[cTo] === '\n') {
            return { cFrom, cTo: cTo + 1 }
          } else if (cFrom > 0 && docText[cFrom - 1] === '\n') {
            return { cFrom: cFrom - 1, cTo }
          }
        }
        return { cFrom, cTo }
      }

      // 2. Character-offset resolution (Primary precision path)
      if (typeof fromOffset === 'number' && typeof toOffset === 'number') {
        if (
          fromOffset >= 0 &&
          toOffset <= doc.length &&
          fromOffset <= toOffset
        ) {
          const slice = view.state.sliceDoc(fromOffset, toOffset)
          const normSlice = slice
            .split('\n')
            .map((l: string) => l.trimEnd())
            .join('\n')
          const normOldText = oldText
            .split('\n')
            .map((l: string) => l.trimEnd())
            .join('\n')
          if (
            slice === oldText ||
            slice.trimEnd() === oldText.trimEnd() ||
            slice.trim() === oldText.trim() ||
            normSlice === normOldText
          ) {
            const { cFrom, cTo } = adjustForCleanLineDeletion(
              fromOffset,
              toOffset
            )
            view.dispatch({
              changes: { from: cFrom, to: cTo, insert: replacement },
            })
            return respond('applied')
          }
        }
      }

      // 3. Fallback: Search for oldText in live document (handles cursor/typing drift)
      if (typeof oldText === 'string' && oldText.length > 0) {
        const span = findUniqueSpan(docText, oldText)
        if (span.status === 'found') {
          const cFrom = span.index
          const cTo = span.index + (span.matchedLength ?? oldText.length)
          const { cFrom: adjFrom, cTo: adjTo } = adjustForCleanLineDeletion(
            cFrom,
            cTo
          )
          view.dispatch({
            changes: { from: adjFrom, to: adjTo, insert: replacement },
          })
          return respond('applied')
        } else if (span.status === 'ambiguous') {
          return respond('drifted', 'Anchor is ambiguous in the document.')
        }
      }

      // 4. Fallback: Line-range resolution (Legacy support)
      if (typeof from === 'number' && typeof to === 'number') {
        const offsets = lineRangeToOffsets(doc, from, to)
        if (!offsets) return respond('drifted', 'Line range out of document bounds.')

        const currentSlice = view.state.sliceDoc(offsets.from, offsets.to)
        if (
          currentSlice === oldText ||
          currentSlice.split('\n').map((l: string) => l.trimEnd()).join('\n') ===
            oldText.split('\n').map((l: string) => l.trimEnd()).join('\n')
        ) {
          const { cFrom, cTo } = adjustForCleanLineDeletion(
            offsets.from,
            offsets.to
          )
          view.dispatch({
            changes: { from: cFrom, to: cTo, insert: replacement },
          })
          return respond('applied')
        }
      }

      respond('drifted', 'Document content drifted before edit could be applied.')
    },
    [view, currentPath, currentDocumentId]
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
