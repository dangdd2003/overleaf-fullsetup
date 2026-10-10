import { EditorView } from '@codemirror/view'
import { applyGenerated } from '../generator/apply'
import { closeEquation, EquationPassage } from './session'

/**
 * Writes the passage's new text as minimal word edits, plus any
 * `\usepackage` lines: one transaction, one undo step. False, with nothing
 * written, when the passage changed since Generate.
 */
export function applyEquation(
  view: EditorView,
  passage: EquationPassage,
  text: string,
  options: { packages?: string[]; cursorOffset?: number } = {}
): boolean {
  return applyGenerated(view, passage, text, {
    ...options,
    userEvent: 'input.ai-equation',
    close: closeEquation.of(null),
  })
}
