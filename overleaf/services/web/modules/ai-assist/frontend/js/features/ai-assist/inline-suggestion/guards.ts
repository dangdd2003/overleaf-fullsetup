import { completionStatus } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { texGptField } from '../texgpt/target'
import { writingSessionField } from '../writing-tools/extension'
import { equationField } from '../equation/session'
import { tableField } from '../table/session'
import { inlinePopupField } from './popup-field'

/** Vim in normal or visual mode: Space is a motion there, not text. */
export function vimBlocksTyping(view: EditorView): boolean {
  // @replit/codemirror-vim keeps its CodeMirror 5 adapter on the view
  const vim = (view as any).cm?.state?.vim
  return Boolean(vim) && !vim.insertMode
}

/**
 * TeXGPT, a Writing tools card, the equation or table generator, or our own
 * popup. `exceptNotice` leaves out a notice of ours at the cursor (an error,
 * the consent prompt): it is only a message, which Shift+Space replaces.
 */
export function otherAiUiOpen(
  state: EditorState,
  { exceptNotice = false }: { exceptNotice?: boolean } = {}
): boolean {
  const popup = state.field(inlinePopupField, false)
  return Boolean(
    state.field(texGptField, false) ||
      state.field(writingSessionField, false) ||
      state.field(equationField, false) ||
      state.field(tableField, false) ||
      (popup && !(exceptNotice && popup.mode === 'notice'))
  )
}

/**
 * What both shortcuts need before they take their key: an editable editor,
 * one plain cursor, no autocomplete list (Tab belongs to it), Vim in insert
 * mode, and no other AI popup.
 *
 * `takeOver` is Shift+Space asking for a completion: an autocomplete list,
 * open or still loading after a keystroke, and a notice of ours do not stop
 * it — the caller closes them once it knows a completion will run.
 */
export function canTriggerAt(
  view: EditorView,
  { takeOver = false }: { takeOver?: boolean } = {}
): boolean {
  const { state } = view
  if (!state.facet(EditorView.editable) || state.readOnly) return false
  if (state.selection.ranges.length > 1 || !state.selection.main.empty) return false
  if (!takeOver && completionStatus(state) !== null) return false
  if (vimBlocksTyping(view)) return false
  return !otherAiUiOpen(state, { exceptNotice: takeOver })
}
