import { diffWordsWithSpace } from 'diff'
import { EditorState } from '@codemirror/state'

export type TextChange = { from: number; to: number; insert: string }

export type WritingTarget = { from: number; to: number; original: string }

export type ReplacePlan =
  | { ok: true; changes: TextChange[] }
  | { ok: false; reason: 'stale' }

/**
 * The word-level edits that turn `original` (starting at document offset
 * `from`) into `result`. Unchanged words are never rewritten, so comments
 * anchored on them survive and track changes records only real edits.
 * Offsets are in the original document, ascending and non-overlapping: the
 * form one CodeMirror transaction takes.
 */
export function minimalChanges(
  original: string,
  result: string,
  from: number
): TextChange[] {
  const changes: TextChange[] = []
  let position = from
  let pending: TextChange | null = null
  for (const part of diffWordsWithSpace(original, result)) {
    if (part.added) {
      pending = pending ?? { from: position, to: position, insert: '' }
      pending.insert += part.value
    } else if (part.removed) {
      pending = pending ?? { from: position, to: position, insert: '' }
      position += part.value.length
      pending.to = position
    } else {
      if (pending) changes.push(pending)
      pending = null
      position += part.value.length
    }
  }
  if (pending) changes.push(pending)
  return changes
}

/** The edits for Replace, or `stale` when the target text changed meanwhile. */
export function planReplace(
  state: EditorState,
  target: WritingTarget,
  result: string
): ReplacePlan {
  if (state.sliceDoc(target.from, target.to) !== target.original) {
    return { ok: false, reason: 'stale' }
  }
  return {
    ok: true,
    changes: minimalChanges(target.original, result, target.from),
  }
}

/** What one click keeps or takes: a phrase, or a whole sentence. */
export type EditUnit = 'phrase' | 'sentence'

/**
 * Text both versions share, or one change. `group` is the click target:
 * with sentence units, one group spans every change in a sentence, and the
 * shared text between them carries the group too.
 */
export type DiffSegment =
  | { kind: 'same'; text: string; group?: number }
  | { kind: 'change'; group: number; original: string; insert: string }

type SameSegment = Extract<DiffSegment, { kind: 'same' }>

/**
 * Shared text that ends a sentence or a line, which closes a sentence group.
 * At its very end too: the space after it may belong to the next change.
 */
const SENTENCE_END = /[.!?]['")\]}]*(\s|$)|\n/

/**
 * `original` → `result` as the phrases that changed. Changes split only by
 * a space are one phrase ("To begin" → "First,"), so a single click keeps
 * or takes the whole of it, not half a word pair. With `sentence` units,
 * every change up to the next sentence end is one group: a restructured
 * sentence is taken or kept whole, so it always reads as written.
 */
export function diffSegments(
  original: string,
  result: string,
  unit: EditUnit = 'phrase'
): DiffSegment[] {
  const parts = diffWordsWithSpace(original, result)
  const segments: DiffSegment[] = []
  let change: { original: string; insert: string } | null = null
  let group = -1
  /** Shared text since the last change, still in its sentence. */
  let between: SameSegment[] = []
  let sentenceOpen = false
  const flush = () => {
    if (!change) return
    if (unit === 'phrase' || !sentenceOpen) group++
    else for (const same of between) same.group = group
    segments.push({ kind: 'change', group, ...change })
    change = null
    between = []
    sentenceOpen = true
  }
  parts.forEach((part, i) => {
    if (part.added || part.removed) {
      change = change ?? { original: '', insert: '' }
      if (part.added) change.insert += part.value
      else change.original += part.value
      return
    }
    const next = parts[i + 1]
    if (change && /^\s+$/.test(part.value) && (next?.added || next?.removed)) {
      // A space between two changes: part of the phrase, on both sides
      change.original += part.value
      change.insert += part.value
      return
    }
    flush()
    const same: SameSegment = { kind: 'same', text: part.value }
    segments.push(same)
    if (SENTENCE_END.test(part.value)) sentenceOpen = false
    else between.push(same)
  })
  flush()
  return segments
}

/** The text with every change taken except the groups in `kept`. */
export function composeText(segments: DiffSegment[], kept: Set<number>): string {
  return segments
    .map(segment =>
      segment.kind === 'same'
        ? segment.text
        : kept.has(segment.group)
          ? segment.original
          : segment.insert
    )
    .join('')
}
