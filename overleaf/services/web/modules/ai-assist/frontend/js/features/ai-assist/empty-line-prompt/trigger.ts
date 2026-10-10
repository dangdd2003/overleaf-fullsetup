import { EditorView } from '@codemirror/view'
import { readInlineSuggestionsPreferences } from '../inline-suggestion/preferences'
import { canTriggerAt } from '../inline-suggestion/guards'
import { suggestionField } from '../inline-suggestion/engine'
import { openInlinePopup } from '../inline-suggestion/popup-field'

/** Space on an empty line opens the prompt bar there; anywhere else it is a space. */
export function openPromptOnSpace(view: EditorView): boolean {
  if (!readInlineSuggestionsPreferences().emptyLineShortcut) return false
  if (!canTriggerAt(view) || view.state.field(suggestionField, false)) return false
  const pos = view.state.selection.main.head
  if (view.state.doc.lineAt(pos).length !== 0) return false
  view.dispatch({ effects: openInlinePopup.of({ pos, mode: 'prompt' }) })
  return true
}
