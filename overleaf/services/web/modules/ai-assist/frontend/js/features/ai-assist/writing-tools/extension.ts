import {
  EditorState,
  Extension,
  Prec,
  StateEffect,
  StateField,
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  keymap,
  showTooltip,
  Tooltip,
  TooltipView,
} from '@codemirror/view'
import { WritingActionId } from './actions'
import { isWritingToolsAvailable } from './availability'

export type WritingSession = {
  /** New for every session; the card keys its state on it. */
  id: number
  from: number
  to: number
  /** The selected text when the session opened, for the stale check. */
  original: string
  action: WritingActionId
  targetLanguage?: string
  tooltip: Tooltip
}

export type OpenWritingSession = {
  from: number
  to: number
  action: WritingActionId
  targetLanguage?: string
}

export const openWritingSession = StateEffect.define<OpenWritingSession>()
export const closeWritingSession = StateEffect.define<null>()

let nextSessionId = 0

/**
 * One function for every card tooltip. CodeMirror reuses a tooltip's DOM
 * while the new tooltip has the same `create`, so the card (portalled into
 * that DOM) keeps its React state when the session is re-anchored after an
 * edit.
 */
const createCardContainer = (): TooltipView => {
  const dom = document.createElement('div')
  dom.className = 'ai-writing-tools-card-container'
  return { dom, overlap: true, offset: { x: 0, y: 6 } }
}

/** Below the selection's last line, even when it ends at a line start. */
function anchorFor(state: EditorState, from: number, to: number): number {
  const lineAtTo = state.doc.lineAt(to)
  return lineAtTo.from === to && to > from ? to - 1 : to
}

function cardTooltip(state: EditorState, from: number, to: number): Tooltip {
  return {
    pos: anchorFor(state, from, to),
    above: false,
    strictSide: true,
    arrow: false,
    create: createCardContainer,
  }
}

const targetMark = Decoration.mark({ class: 'ai-writing-tools-target' })

export const writingSessionField = StateField.define<WritingSession | null>({
  create: () => null,
  update(session, tr) {
    for (const effect of tr.effects) {
      if (effect.is(closeWritingSession)) return null
      if (effect.is(openWritingSession)) {
        const { from, to, action, targetLanguage } = effect.value
        return {
          id: ++nextSessionId,
          from,
          to,
          original: tr.state.sliceDoc(from, to),
          action,
          targetLanguage,
          tooltip: cardTooltip(tr.state, from, to),
        }
      }
    }
    if (!session || !tr.docChanged) return session
    // Text typed right at either edge stays outside the target
    const from = tr.changes.mapPos(session.from, 1)
    const to = tr.changes.mapPos(session.to, -1)
    if (to <= from) return null
    return { ...session, from, to, tooltip: cardTooltip(tr.state, from, to) }
  },
  provide: field => [
    showTooltip.from(field, session => session?.tooltip ?? null),
    EditorView.decorations.from(field, session =>
      session
        ? Decoration.set([targetMark.range(session.from, session.to)])
        : Decoration.none
    ),
  ],
})

const writingToolsTheme = EditorView.baseTheme({
  '.ai-writing-tools-card-container.cm-tooltip': {
    backgroundColor: 'transparent',
    border: 'none',
  },
  '&light .ai-writing-tools-target': {
    backgroundColor: 'rgba(56, 126, 245, 0.18)',
  },
  '&dark .ai-writing-tools-target': {
    backgroundColor: 'rgba(122, 167, 255, 0.24)',
  },
})

export function writingToolsExtension(): Extension {
  return [
    writingSessionField,
    writingToolsTheme,
    Prec.high(
      keymap.of([
        {
          key: 'Escape',
          run: view => {
            if (!view.state.field(writingSessionField, false)) return false
            view.dispatch({ effects: closeWritingSession.of(null) })
            return true
          },
        },
      ])
    ),
  ]
}

/** Loaded by the editor through `sourceEditorExtensions`. */
export const extension = (): Extension =>
  isWritingToolsAvailable() ? writingToolsExtension() : []
