import {
  ChangeDesc,
  EditorState,
  Extension,
  Prec,
  Range,
  StateEffect,
  StateEffectType,
  StateField,
} from '@codemirror/state'
import {
  Decoration,
  DecorationSet,
  EditorView,
  keymap,
  showTooltip,
  Tooltip,
  TooltipView,
  WidgetType,
} from '@codemirror/view'
import { closeTexGpt } from '../texgpt/target'
import { closeWritingSession } from '../writing-tools/extension'

/** The cursor (`from === to`) or the selection a generator was opened on. */
export type GeneratorAnchor = { from: number; to: number }

/** The editable range, and its text when Generate was pressed. */
export type GeneratorPassage = { from: number; to: number; original: string }

export type GeneratorSession = {
  /** New for every opening; the host keys its request state on it. */
  id: number
  phase: 'dialog' | 'review'
  anchor: GeneratorAnchor
  /** Edit prompt: the dialog reopens with the last prompt and image. */
  keepDraft: boolean
  /** Set when Generate is pressed. */
  passage: GeneratorPassage | null
  /** The review card's tooltip; null while the dialog is open. */
  tooltip: Tooltip | null
}

export type GeneratorSessionKit = {
  field: StateField<GeneratorSession | null>
  openDialog: StateEffectType<{ from: number; to: number; keepDraft?: boolean }>
  startReview: StateEffectType<{ from: number; to: number }>
  close: StateEffectType<null>
  /** Opens the dialog on the main selection (or on `anchor`); every other AI surface closes. */
  open: (
    view: EditorView,
    options?: { anchor?: GeneratorAnchor; keepDraft?: boolean }
  ) => void
  extension: () => Extension
}

/** Closes every generator: one AI surface at a time. */
export const closeGenerators = StateEffect.define<null>()

let nextSessionId = 0

/**
 * Text typed at either edge stays outside the passage; a deleted passage
 * stays as an empty range, which no longer equals its original: stale.
 */
function mapPassage(passage: GeneratorPassage, changes: ChangeDesc): GeneratorPassage {
  const from = changes.mapPos(passage.from, 1)
  const to = Math.max(from, changes.mapPos(passage.to, -1))
  return { from, to, original: passage.original }
}

function mapAnchor(anchor: GeneratorAnchor, changes: ChangeDesc): GeneratorAnchor {
  if (anchor.from === anchor.to) {
    const pos = changes.mapPos(anchor.from, 1)
    return { from: pos, to: pos }
  }
  const from = changes.mapPos(anchor.from, 1)
  return { from, to: Math.max(from, changes.mapPos(anchor.to, -1)) }
}

/** The passage changed since Generate: applying would clobber that edit. */
export function isPassageStale(state: EditorState, passage: GeneratorPassage): boolean {
  return state.sliceDoc(passage.from, passage.to) !== passage.original
}

/** Where the result goes, visible while the editor is unfocused. */
class InsertionCaret extends WidgetType {
  constructor(readonly className: string) {
    super()
  }

  eq(other: InsertionCaret) {
    return other.className === this.className
  }

  toDOM() {
    const caret = document.createElement('span')
    caret.className = this.className
    caret.setAttribute('aria-hidden', 'true')
    return caret
  }

  ignoreEvent() {
    return true
  }
}

const generatorTheme = EditorView.baseTheme({
  '.ai-generator-card-container.cm-tooltip': {
    backgroundColor: 'transparent',
    border: 'none',
  },
  '&light .ai-generator-target': {
    backgroundColor: 'rgba(56, 126, 245, 0.18)',
  },
  '&dark .ai-generator-target': {
    backgroundColor: 'rgba(122, 167, 255, 0.24)',
  },
  '.ai-generator-caret': {
    display: 'inline-block',
    width: '2px',
    height: '1.2em',
    margin: '0 -1px',
    verticalAlign: 'text-bottom',
    pointerEvents: 'none',
  },
  '&light .ai-generator-caret': { backgroundColor: '#387ef5' },
  '&dark .ai-generator-caret': { backgroundColor: '#7aa7ff' },
})

/**
 * The state of one generator (equation, table…) while its dialog or review
 * card is open: the anchor, the passage fixed at Generate, the card's
 * tooltip. Class names derive from `name`.
 */
export function defineGeneratorSession(name: string): GeneratorSessionKit {
  const openDialog = StateEffect.define<{ from: number; to: number; keepDraft?: boolean }>()
  const startReview = StateEffect.define<{ from: number; to: number }>()
  const close = StateEffect.define<null>()

  /**
   * One function for every card tooltip. CodeMirror reuses a tooltip's DOM
   * while the new tooltip has the same `create`, so the card (portalled into
   * that DOM) keeps its React state when the passage moves after an edit.
   */
  const createCardContainer = (): TooltipView => {
    const dom = document.createElement('div')
    dom.className = `ai-generator-card-container ai-${name}-card-container`
    return { dom, overlap: true, offset: { x: 0, y: 6 } }
  }

  /** Below the passage's last line, even when it ends at a line start. */
  const cardTooltip = (state: EditorState, passage: GeneratorPassage): Tooltip => {
    const lineAtTo = state.doc.lineAt(passage.to)
    const pos =
      lineAtTo.from === passage.to && passage.to > passage.from
        ? passage.to - 1
        : passage.to
    return { pos, above: false, strictSide: true, arrow: false, create: createCardContainer }
  }

  const passageMark = Decoration.mark({ class: `ai-generator-target ai-${name}-target` })
  const caretWidget = Decoration.widget({
    widget: new InsertionCaret(`ai-generator-caret ai-${name}-caret`),
    side: 1,
  })

  const decorationsFor = (session: GeneratorSession | null): DecorationSet => {
    if (!session || session.phase !== 'review' || !session.passage) {
      return Decoration.none
    }
    const { passage, anchor } = session
    const ranges: Range<Decoration>[] = []
    if (passage.to > passage.from) {
      ranges.push(passageMark.range(passage.from, passage.to))
    }
    if (anchor.from === anchor.to) ranges.push(caretWidget.range(anchor.from))
    return Decoration.set(ranges, true)
  }

  /** Non-null exactly while the dialog or the review card is open. */
  const field = StateField.define<GeneratorSession | null>({
    create: () => null,
    update(session, tr) {
      // Opening wins over closing: `open` sends both in one transaction
      for (const effect of tr.effects) {
        if (effect.is(openDialog)) {
          const { from, to, keepDraft = false } = effect.value
          return {
            id: ++nextSessionId,
            phase: 'dialog',
            anchor: { from, to },
            keepDraft,
            passage: null,
            tooltip: null,
          }
        }
      }
      for (const effect of tr.effects) {
        if (effect.is(close) || effect.is(closeGenerators)) return null
      }
      if (!session) return null

      if (tr.docChanged) {
        const passage = session.passage && mapPassage(session.passage, tr.changes)
        session = {
          ...session,
          anchor: mapAnchor(session.anchor, tr.changes),
          passage,
          tooltip: passage ? cardTooltip(tr.state, passage) : null,
        }
      }

      for (const effect of tr.effects) {
        if (effect.is(startReview)) {
          const { from, to } = effect.value
          const passage = { from, to, original: tr.state.sliceDoc(from, to) }
          session = {
            ...session,
            phase: 'review',
            passage,
            tooltip: cardTooltip(tr.state, passage),
          }
        }
      }
      return session
    },
    provide: field => [
      showTooltip.from(field, session => session?.tooltip ?? null),
      EditorView.decorations.from(field, decorationsFor),
    ],
  })

  const escape = Prec.high(
    keymap.of([
      {
        key: 'Escape',
        run: view => {
          if (!view.state.field(field, false)) return false
          view.dispatch({ effects: close.of(null) })
          return true
        },
      },
    ])
  )

  const open: GeneratorSessionKit['open'] = (view, { anchor, keepDraft = false } = {}) => {
    const { from, to } = anchor ?? view.state.selection.main
    view.dispatch({
      effects: [
        closeTexGpt.of(null),
        closeWritingSession.of(null),
        closeGenerators.of(null),
        openDialog.of({ from, to, keepDraft }),
      ],
    })
  }

  return {
    field,
    openDialog,
    startReview,
    close,
    open,
    extension: () => [field, generatorTheme, escape],
  }
}
