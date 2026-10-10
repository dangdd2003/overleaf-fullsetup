import { Extension, Prec } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { isWritingToolsAvailable } from '../writing-tools/availability'
import { emptyLineHint } from '../empty-line-prompt/hint'
import { openPromptOnSpace } from '../empty-line-prompt/trigger'
import { completeAtCursor } from '../completion/trigger'
import { autoCompletion } from '../completion/auto'
import { inlineSuggestionEngine } from './engine'
import { inlinePopupExtension } from './popup-field'

/**
 * The ghost-text engine, the popup, the empty-line hint, Automatic
 * completion and the two keys.
 * Each key reads its switch when pressed: off, it is an ordinary space.
 * The account's switches are loaded with the other AI preferences by the
 * language suggestions plugin at editor start.
 */
export function inlineSuggestionsExtension(): Extension {
  return [
    inlineSuggestionEngine(),
    inlinePopupExtension(),
    emptyLineHint,
    autoCompletion,
    Prec.high(
      keymap.of([
        { key: 'Space', run: openPromptOnSpace },
        { key: 'Shift-Space', run: completeAtCursor },
      ])
    ),
  ]
}

/** Loaded by the editor through `sourceEditorExtensions`. */
export const extension = (): Extension =>
  isWritingToolsAvailable() ? inlineSuggestionsExtension() : []
