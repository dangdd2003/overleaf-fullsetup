import { EditorSelection, StateEffect } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { planReplace, TextChange } from '../writing-tools/apply'
import { preambleChange } from '../texgpt/insert'
import { GeneratorPassage } from './session'
import { aiEdit } from '../ai-edit-glow/extension'

/**
 * Writes the passage's new text as minimal word edits (comments on untouched
 * words survive; track changes records only real edits), plus any
 * `\usepackage` lines, and closes the generator: one transaction, one undo
 * step. False, with nothing written, when the passage changed since Generate.
 */
export function applyGenerated(
  view: EditorView,
  passage: GeneratorPassage,
  text: string,
  {
    packages = [],
    cursorOffset,
    userEvent,
    close,
  }: {
    packages?: string[]
    /** Where the cursor ends, as an offset into `text`; its end by default. */
    cursorOffset?: number
    userEvent: string
    close: StateEffect<null>
  }
): boolean {
  const plan = planReplace(view.state, passage, text)
  if (!plan.ok) return false
  const changes: TextChange[] = [...plan.changes]
  const preamble = packages.length ? preambleChange(view.state.doc.toString(), packages) : null
  if (preamble) changes.push(preamble)

  const changeSet = view.state.changes(changes)
  // Where the new passage starts after every change, then into it
  const start = changeSet.mapPos(passage.from, -1)
  const cursor = start + Math.min(cursorOffset ?? text.length, text.length)
  view.dispatch({
    changes: changeSet,
    selection: EditorSelection.cursor(cursor),
    effects: close,
    userEvent,
    annotations: aiEdit.of(true),
    scrollIntoView: true,
  })
  view.focus()
  return true
}
