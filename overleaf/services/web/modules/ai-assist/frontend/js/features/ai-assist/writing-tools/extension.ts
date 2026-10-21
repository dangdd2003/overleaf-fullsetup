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
} from '@codemirror/view'
import { WritingActionId } from './actions'
import { isWritingToolsAvailable } from './availability'
import {
  floatingCard,
  floatingCardTheme,
  floatingTooltip,
} from '../floating/editor-card'

export type WritingSession = {
  /** New for every session; the card keys its state on it. */
  id: number
  from: number
  to: number
  /** The selected text when the session opened, for the stale check. */
  original: string
  /** The selection was made from its end back to its start. */
  backward: boolean
  action: WritingActionId
  targetLanguage?: string
  tooltip: Tooltip
}

export type OpenWritingSession = {
  from: number
  to: number
  /** The selection's head was at `from`; restored by the card's back button. */
  backward?: boolean
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
 * edit. The card flips around the whole selection.
 */
const createCardContainer = floatingCard({
  className: 'ai-writing-tools-card-container',
  // The footer of buttons keeps to one line however narrow the pane
  oneLine: '.ai-card-footer',
  // Centred on its text, like the language suggestion cards
  align: 'center',
  range: state => {
    const session = state.field(writingSessionField, false)
    return session ? { from: session.from, to: session.to } : null
  },
})

/** Below the selection's last line, even when it ends at a line start. */
function anchorFor(state: EditorState, from: number, to: number): number {
  const lineAtTo = state.doc.lineAt(to)
  return lineAtTo.from === to && to > from ? to - 1 : to
}

function cardTooltip(state: EditorState, from: number, to: number): Tooltip {
  return floatingTooltip(anchorFor(state, from, to), createCardContainer)
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
          backward: effect.value.backward ?? false,
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
    floatingCardTheme,
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

// Ctrl or Cmd click adds a selection range on every platform, so several
// passages can be selected and sent to the assistant together.
const multiSelectionClick = EditorView.clickAddsSelectionRange.of(
  (event: MouseEvent) => event.ctrlKey || event.metaKey
)

/** Loaded by the editor through `sourceEditorExtensions`. */
export const extension = (): Extension =>
  isWritingToolsAvailable()
    ? [writingToolsExtension(), multiSelectionClick]
    : []
