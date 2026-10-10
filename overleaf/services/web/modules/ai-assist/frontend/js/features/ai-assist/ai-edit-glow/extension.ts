import {
  Annotation,
  ChangeSet,
  EditorState,
  Extension,
  StateEffect,
  StateField,
  Transaction,
} from '@codemirror/state'
import { Decoration, DecorationSet, EditorView, ViewPlugin } from '@codemirror/view'
import { isWritingToolsAvailable } from '../writing-tools/availability'

/** How long the glow plays; keep in step with `ai-edit-glow` in ai-assist.scss. */
export const GLOW_DURATION_MS = 2600

/**
 * Put on every transaction the AI writes into the editor. Whatever it
 * changed then glows, once, as soon as it is on screen.
 */
export const aiEdit = Annotation.define<boolean>()

type Glow = {
  id: number
  from: number
  to: number
  /** `pending` until the range is in the viewport, then `playing`. */
  playing: boolean
}

const playGlows = StateEffect.define<number[]>()
const endGlows = StateEffect.define<number[]>()
export const addGlows = StateEffect.define<Array<{ from: number; to: number }>>()

/**
 * Manually marks one or more text ranges in the editor to glow with the
 * AI modification animation (e.g. following a server-side agent edit).
 */
export function markAiGlow(
  view: EditorView,
  ranges: Array<{ from: number; to: number }>
) {
  const valid = ranges.filter(r => r.to > r.from)
  if (!valid.length) return
  view.dispatch({ effects: addGlows.of(valid) })
}

let nextId = 0

/**
 * The ranges the new document holds in place of what a change set touched.
 * A pure deletion has no text left, so its neighbouring character stands in.
 */
export function changedRanges(
  changes: ChangeSet,
  docLength: number
): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = []
  changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    if (toB > fromB) ranges.push({ from: fromB, to: toB })
    else if (docLength > 0) {
      ranges.push(
        fromB < docLength
          ? { from: fromB, to: fromB + 1 }
          : { from: fromB - 1, to: fromB }
      )
    }
  })
  return ranges
}

export const aiEditGlowField = StateField.define<Glow[]>({
  create: () => [],
  update(glows, tr) {
    let next = glows
    if (tr.docChanged && next.length) {
      next = next
        .map(glow => ({
          ...glow,
          from: tr.changes.mapPos(glow.from, 1),
          to: tr.changes.mapPos(glow.to, -1),
        }))
        .filter(glow => glow.to > glow.from)
    }
    for (const effect of tr.effects) {
      if (effect.is(addGlows)) {
        next = [
          ...next,
          ...effect.value.map(range => ({ ...range, id: nextId++, playing: false })),
        ]
      } else if (effect.is(playGlows)) {
        next = next.map(glow =>
          effect.value.includes(glow.id) ? { ...glow, playing: true } : glow
        )
      } else if (effect.is(endGlows)) {
        next = next.filter(glow => !effect.value.includes(glow.id))
      }
    }
    return next
  },
  provide: field =>
    EditorView.decorations.from(field, (glows): DecorationSet =>
      Decoration.set(
        glows
          .filter(glow => glow.playing)
          .map(glow =>
            Decoration.mark({ class: 'ai-edit-glow' }).range(glow.from, glow.to)
          ),
        true
      )
    ),
})

/** Whether a transaction is an AI edit or an automated insert (table, figure, generator, agent). */
export function isAiTransaction(tr: Transaction): boolean {
  if (!tr.docChanged) return false
  if (tr.annotation(aiEdit)) return true
  const userEvent = tr.annotation(Transaction.userEvent)
  if (
    typeof userEvent === 'string' &&
    (userEvent.includes('ai') || userEvent.includes('table'))
  ) {
    return true
  }
  // CodeMirror snippet completions with label 'Table' or 'Figure' (e.g. from toolbar or menu table insertion)
  const annotations = (tr as any).annotations
  if (Array.isArray(annotations)) {
    for (const ann of annotations) {
      if (
        ann.value &&
        typeof ann.value === 'object' &&
        ((ann.value as any).label === 'Table' || (ann.value as any).label === 'Figure')
      ) {
        return true
      }
    }
  }
  return false
}

/** Tags an AI transaction's changed ranges as glows. */
const collectGlows = EditorState.transactionExtender.of((tr: Transaction) => {
  if (!isAiTransaction(tr)) return null
  const ranges = changedRanges(tr.changes, tr.newDoc.length)
  return ranges.length ? { effects: addGlows.of(ranges) } : null
})

/** Whether any part of [from, to] is inside what the editor's scroller shows. */
export function isRangeOnScreen(view: EditorView, from: number, to: number) {
  const scroller = view.scrollDOM.getBoundingClientRect()
  if (scroller.height === 0) return false
  const first = view.lineBlockAt(from)
  const last = view.lineBlockAt(to)
  const top = view.documentTop + first.top
  const bottom = view.documentTop + last.bottom
  return bottom > scroller.top && top < scroller.bottom
}

/**
 * Smoothly scrolls the editor scroller to bring an edit range [from, to] into view.
 *
 * - If the edit is fully inside the viewport, does nothing (returns false).
 * - If the edit is above the viewport (UP), scrolls UP so the top of the edit is positioned at the top (with padding).
 * - If the edit is below the viewport (DOWN), scrolls DOWN so the bottom of the edit is positioned at the bottom (with padding).
 * - If the edit is taller than the viewport, aligns the top of the edit to the top (with padding) so the user can read from the start.
 * - Performs smooth scrolling via `scrollDOM.scrollTo({ top: targetScrollTop, behavior: 'smooth' })`.
 */
export function smoothScrollToEdit(
  view: EditorView,
  from: number,
  to: number,
  padding = 16
): boolean {
  const scroller = view.scrollDOM
  if (!scroller || scroller.clientHeight === 0) return false

  const docLen = view.state.doc.length
  const safeFrom = Math.max(0, Math.min(docLen, Math.min(from, to)))
  const safeTo = Math.max(0, Math.min(docLen, Math.max(from, to)))

  const firstBlock = view.lineBlockAt(safeFrom)
  const lastBlock = view.lineBlockAt(safeTo)

  // Document-relative vertical positions of edit range
  const editDocTop = firstBlock.top
  const editDocBottom = lastBlock.bottom
  const editHeight = editDocBottom - editDocTop

  // Viewport measurements
  const scrollerRect = scroller.getBoundingClientRect()
  const viewHeight = scroller.clientHeight
  const currentScrollTop = scroller.scrollTop

  // Absolute client coordinates relative to viewport
  const editTopClient = view.documentTop + editDocTop
  const editBottomClient = view.documentTop + editDocBottom
  const viewTopClient = scrollerRect.top
  const viewBottomClient = scrollerRect.bottom

  // Check if fully inside viewport (with padding tolerance)
  const isFullyInside =
    editTopClient >= viewTopClient + padding &&
    editBottomClient <= viewBottomClient - padding

  if (isFullyInside) {
    return false
  }

  const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
  let targetScrollTop: number

  const effectiveViewHeight = Math.max(0, viewHeight - 2 * padding)

  if (editHeight > effectiveViewHeight) {
    // Edit is taller than viewport: align top of edit with top of viewport (plus padding)
    targetScrollTop = editDocTop - padding
  } else if (editTopClient < viewTopClient + padding) {
    // Edit is above viewport (UP): align top of edit with top of viewport (plus padding)
    targetScrollTop = editDocTop - padding
  } else if (editBottomClient > viewBottomClient - padding) {
    // Edit is below viewport (DOWN): align bottom of edit with bottom of viewport (minus padding)
    targetScrollTop = editDocBottom - viewHeight + padding
  } else {
    // Within tolerance edges
    return false
  }

  // Clamp targetScrollTop
  targetScrollTop = Math.max(0, Math.min(maxScrollTop, targetScrollTop))

  if (Math.abs(targetScrollTop - currentScrollTop) < 2) {
    return false
  }

  try {
    if (typeof scroller.scrollTo === 'function') {
      scroller.scrollTo({ top: targetScrollTop, behavior: 'smooth' })
    } else {
      scroller.scrollTop = targetScrollTop
    }
  } catch {
    scroller.scrollTop = targetScrollTop
  }

  return true
}

/**
 * Starts the pending glows that scroll into view and ends the playing ones.
 * An edit made off screen waits here until the user gets to it.
 */
const glowDriver = ViewPlugin.fromClass(
  class {
    timers = new Set<ReturnType<typeof setTimeout>>()
    scheduled = false
    onScroll = () => this.schedule()
    view: EditorView

    constructor(view: EditorView) {
      this.view = view
      view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true })
      this.schedule()
    }

    update() {
      if (this.view.state.field(aiEditGlowField).some(glow => !glow.playing)) {
        this.schedule()
      }
    }

    schedule() {
      if (this.scheduled) return
      this.scheduled = true
      this.view.requestMeasure({
        read: view => {
          this.scheduled = false
          return view.state
            .field(aiEditGlowField)
            .filter(glow => !glow.playing && isRangeOnScreen(view, glow.from, glow.to))
            .map(glow => glow.id)
        },
        write: (ids: number[], view) => {
          if (!ids.length) return
          // Defers dispatch outside CodeMirror's update cycle to avoid recursion error
          queueMicrotask(() => {
            if ((view as any).isDestroyed) return
            view.dispatch({ effects: playGlows.of(ids) })
          })
          const timer = setTimeout(() => {
            this.timers.delete(timer)
            if ((view as any).isDestroyed) return
            view.dispatch({ effects: endGlows.of(ids) })
          }, GLOW_DURATION_MS)
          this.timers.add(timer)
        },
      })
    }

    destroy() {
      this.view.scrollDOM.removeEventListener('scroll', this.onScroll)
      this.timers.forEach(clearTimeout)
    }
  }
)

export const aiEditGlowExtension = (): Extension => [
  aiEditGlowField,
  collectGlows,
  glowDriver,
]

/** Loaded by the editor through `sourceEditorExtensions`; off with AI off. */
export const extension = (): Extension =>
  isWritingToolsAvailable() ? aiEditGlowExtension() : []
