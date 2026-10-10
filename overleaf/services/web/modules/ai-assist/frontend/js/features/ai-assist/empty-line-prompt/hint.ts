import { EditorState, StateEffect } from '@codemirror/state'
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from '@codemirror/view'
import { INLINE_SUGGESTIONS_CHANGED_EVENT } from '../provider-store'
import { readInlineSuggestionsPreferences } from '../inline-suggestion/preferences'
import { inlinePopupField } from '../inline-suggestion/popup-field'
import { suggestionField } from '../inline-suggestion/engine'

export const EMPTY_LINE_HINT = "Press 'Space' for help writing"

/** Redraws the hint after the switch changes in Settings. */
const refreshHint = StateEffect.define<null>()

class HintWidget extends WidgetType {
  eq() {
    return true
  }

  toDOM() {
    const hint = document.createElement('span')
    // CodeMirror's own placeholder look
    hint.className = 'cm-placeholder ai-empty-line-hint'
    hint.setAttribute('aria-hidden', 'true')
    hint.textContent = EMPTY_LINE_HINT
    return hint
  }

  ignoreEvent() {
    return true
  }
}

const hintDecoration = Decoration.widget({ widget: new HintWidget(), side: 1 })

/** The start of the empty line to hint on, or null. */
export function hintLineAt(state: EditorState, focused: boolean): number | null {
  if (!focused || !readInlineSuggestionsPreferences().emptyLineShortcut) return null
  if (!state.facet(EditorView.editable) || state.readOnly) return null
  const { selection } = state
  if (selection.ranges.length > 1 || !selection.main.empty) return null
  if (state.field(inlinePopupField, false) || state.field(suggestionField, false)) {
    return null
  }
  const line = state.doc.lineAt(selection.main.head)
  return line.length === 0 ? line.from : null
}

function hintFor(view: EditorView): DecorationSet {
  const at = hintLineAt(view.state, view.hasFocus)
  return at === null ? Decoration.none : Decoration.set([hintDecoration.range(at)])
}

export const emptyLineHint = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    private onPreferences = () =>
      this.view.dispatch({ effects: refreshHint.of(null) })

    constructor(readonly view: EditorView) {
      this.decorations = hintFor(view)
      window.addEventListener(INLINE_SUGGESTIONS_CHANGED_EVENT, this.onPreferences)
    }

    update(update: ViewUpdate) {
      this.decorations = hintFor(update.view)
    }

    destroy() {
      window.removeEventListener(INLINE_SUGGESTIONS_CHANGED_EVENT, this.onPreferences)
    }
  },
  { decorations: plugin => plugin.decorations }
)
