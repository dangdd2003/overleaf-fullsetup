import {
  ChangeDesc,
  EditorState,
  Extension,
  Prec,
  StateEffect,
  StateField,
} from '@codemirror/state'
import { Decoration, EditorView, keymap, WidgetType } from '@codemirror/view'

/** A stretch of the document and the text it held when it was chosen. */
export type TexGptRange = { from: number; to: number; original: string }

export type TexGptTarget =
  | { mode: 'insert'; pos: number }
  | ({ mode: 'replace' } & TexGptRange)

export type TexGptState = {
  /** The cursor or the selection the popup was opened on. */
  target: TexGptTarget
  /** A generator's existing title, abstract or keywords, replaced instead. */
  block: TexGptRange | null
}

export const openTexGpt = StateEffect.define<{ from: number; to: number }>()
export const setTexGptBlock = StateEffect.define<TexGptRange | null>()
export const closeTexGpt = StateEffect.define<null>()

/**
 * Text typed at either edge stays outside the range; a deleted range stays
 * as an empty one, which no longer equals its original and so reads as stale.
 */
function mapRange(range: TexGptRange, changes: ChangeDesc): TexGptRange {
  const from = changes.mapPos(range.from, 1)
  const to = Math.max(from, changes.mapPos(range.to, -1))
  return { from, to, original: range.original }
}

/** The text changed since it was chosen: replacing it would clobber that edit. */
export function isStale(state: EditorState, range: TexGptRange): boolean {
  return state.sliceDoc(range.from, range.to) !== range.original
}

const targetMark = Decoration.mark({ class: 'ai-texgpt-target' })

/** Where Insert will put the code, visible while the editor is unfocused. */
class InsertionCaret extends WidgetType {
  eq() {
    return true
  }

  toDOM() {
    const caret = document.createElement('span')
    caret.className = 'ai-texgpt-caret'
    caret.setAttribute('aria-hidden', 'true')
    return caret
  }

  ignoreEvent() {
    return true
  }
}

const caretWidget = Decoration.widget({ widget: new InsertionCaret(), side: 1 })

function markOrNone(range: TexGptRange) {
  return range.to > range.from
    ? Decoration.set([targetMark.range(range.from, range.to)])
    : Decoration.none
}

/** Non-null exactly while the TeXGPT popup is open. */
export const texGptField = StateField.define<TexGptState | null>({
  create: () => null,
  update(value, tr) {
    let opened = false
    let blockSet = false
    for (const effect of tr.effects) {
      if (effect.is(closeTexGpt)) return null
      if (effect.is(openTexGpt)) {
        const { from, to } = effect.value
        value = {
          target:
            from === to
              ? { mode: 'insert', pos: from }
              : {
                  mode: 'replace',
                  from,
                  to,
                  original: tr.state.sliceDoc(from, to),
                },
          block: null,
        }
        opened = true
      } else if (effect.is(setTexGptBlock) && value) {
        value = { ...value, block: effect.value }
        blockSet = true
      }
    }
    if (!value) return null

    if (tr.docChanged && !opened) {
      const { target, block } = value
      value = {
        target:
          target.mode === 'insert'
            ? { mode: 'insert', pos: tr.changes.mapPos(target.pos, 1) }
            : { mode: 'replace', ...mapRange(target, tr.changes) },
        block: block && !blockSet ? mapRange(block, tr.changes) : block,
      }
    }

    // Clicking in the text chooses where Insert goes
    if (tr.selection && !opened && value.target.mode === 'insert') {
      value = {
        ...value,
        target: { mode: 'insert', pos: tr.state.selection.main.head },
      }
    }
    return value
  },
  provide: field =>
    EditorView.decorations.from(field, value => {
      if (!value) return Decoration.none
      if (value.block) return markOrNone(value.block)
      if (value.target.mode === 'replace') return markOrNone(value.target)
      return Decoration.set([caretWidget.range(value.target.pos)])
    }),
})

const texGptTheme = EditorView.baseTheme({
  '&light .ai-texgpt-target': {
    backgroundColor: 'rgba(56, 126, 245, 0.18)',
  },
  '&dark .ai-texgpt-target': {
    backgroundColor: 'rgba(122, 167, 255, 0.24)',
  },
  '.ai-texgpt-caret': {
    display: 'inline-block',
    width: '2px',
    height: '1.2em',
    margin: '0 -1px',
    verticalAlign: 'text-bottom',
    pointerEvents: 'none',
  },
  '&light .ai-texgpt-caret': { backgroundColor: '#387ef5' },
  '&dark .ai-texgpt-caret': { backgroundColor: '#7aa7ff' },
})

export function texGptExtension(): Extension {
  return [
    texGptField,
    texGptTheme,
    Prec.high(
      keymap.of([
        {
          key: 'Escape',
          run: view => {
            if (!view.state.field(texGptField, false)) return false
            view.dispatch({ effects: closeTexGpt.of(null) })
            return true
          },
        },
      ])
    ),
  ]
}
