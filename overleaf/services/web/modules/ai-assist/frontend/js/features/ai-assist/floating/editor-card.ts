import { EditorState } from '@codemirror/state'
import { EditorView, Rect, Tooltip, TooltipView } from '@codemirror/view'

/**
 * Placement for every AI box that floats over the editor (writing tools,
 * generators, inline popups, language suggestion cards). Instead of a fixed
 * "always below, 600px wide" box, a card:
 * - sits below the text it belongs to, and flips above when there is more
 *   room there (CodeMirror flips it, `strictSide: false`);
 * - is aligned with the start of its text (or centred on it, `align:
 *   'center'`), and kept inside the editor pane horizontally;
 * - never grows taller or wider than the room it has, which it reads from
 *   `--ai-floating-max-height` and `--ai-floating-max-width`;
 * - is never narrower than the rows it must keep on one line (`oneLine`),
 *   through `--ai-floating-min-width`; one wider than the pane is kept
 *   inside the window;
 * - beside text too tall to leave usable room, is laid over the text rather
 *   than squashed;
 * - exposes its side as `data-placement="top" | "bottom"` for styling.
 * CodeMirror observes the card's size, so it is placed again as it grows.
 */

export const FLOATING_GAP = 6
export const FLOATING_MARGIN = 16
/**
 * Below this beside the text the card would be squashed: it is laid over the
 * text instead, inside the visible editor.
 */
export const MIN_FLOATING_HEIGHT = 200

export type FloatingSide = 'top' | 'bottom'

/** Where the card sits along its text: from its start, or centred on it. */
export type FloatingAlign = 'start' | 'center'

export type FloatingRange = { from: number; to: number }

export type FloatingCardOptions = {
  /** Class names of the tooltip container. */
  className: string
  /** Space between the text and the card. */
  gap?: number
  /**
   * The text the card belongs to, read from the current state. The card
   * flips around all of it, not only the tooltip's `pos`.
   */
  range?: (state: EditorState) => FloatingRange | null
  align?: FloatingAlign
  /**
   * Rows that must stay on one line, such as a footer of buttons: the card
   * is never made narrower than they need.
   */
  oneLine?: string
}

/** How much wider than its box the widest of `rows` needs to be. */
export function rowOverflow(rows: Iterable<HTMLElement>): number {
  let overflow = 0
  for (const row of rows) {
    overflow = Math.max(overflow, row.scrollWidth - row.clientWidth)
  }
  return overflow
}

/** A card tooltip at `pos` that may flip to whichever side has room. */
export function floatingTooltip(
  pos: number,
  create: (view: EditorView) => TooltipView,
  side: FloatingSide = 'bottom'
): Tooltip {
  return { pos, above: side === 'top', strictSide: false, arrow: false, create }
}

type Box = { left: number; right: number; top: number; bottom: number }

/**
 * The visible part of `from..to` on screen. An edge scrolled out of view is
 * clamped to the scroller, so a long range keeps its card while any of it
 * shows. Horizontally it spans the range on one line, or the last line's
 * part of it otherwise.
 */
export function rangeCoords(
  view: EditorView,
  { from, to }: FloatingRange
): Rect | null {
  const start = view.coordsAtPos(from, 1)
  const end = view.coordsAtPos(to, -1)
  if (!start && !end) return null
  const scroller = view.scrollDOM.getBoundingClientRect()
  const top = start ? start.top : scroller.top
  const bottom = end ? end.bottom : scroller.bottom
  let left: number
  if (start && end && Math.abs(start.top - end.top) < 2) {
    left = start.left
  } else {
    const lineStart = view.state.doc.lineAt(to).from
    left =
      view.coordsAtPos(lineStart, 1)?.left ??
      view.contentDOM.getBoundingClientRect().left
  }
  const right = end ? Math.max(left, end.left) : left
  return { left, right, top, bottom }
}

/**
 * How far to move a box of `width` starting at `left` so it fits in
 * `bounds` less `margin`; it keeps its left edge in view when it cannot fit.
 */
export function horizontalShift(
  left: number,
  width: number,
  bounds: { left: number; right: number },
  margin = FLOATING_MARGIN
): number {
  const min = bounds.left + margin
  const max = bounds.right - margin
  let next = left
  if (next + width > max) next = max - width
  if (next < min) next = min
  return next - left
}

/**
 * How far to move a box of `height` starting at `top` so it fits in
 * `bounds` less `margin`; it keeps its top edge in view when it cannot fit.
 */
export function verticalShift(
  top: number,
  height: number,
  bounds: { top: number; bottom: number },
  margin = FLOATING_MARGIN / 2
): number {
  return horizontalShift(
    top,
    height,
    { left: bounds.top, right: bounds.bottom },
    margin
  )
}

/** The room a card has on `side` of `anchor` within `space`. */
export function verticalRoom(
  anchor: Box,
  space: Box,
  side: FloatingSide,
  gap = FLOATING_GAP,
  margin = FLOATING_MARGIN / 2
): number {
  const room =
    side === 'top' ? anchor.top - space.top : space.bottom - anchor.bottom
  return Math.max(0, room - gap - margin)
}

/**
 * A `create` for card tooltips. Keep the returned function stable for the
 * life of a card: CodeMirror keeps a tooltip's DOM (and the React tree
 * portalled into it) while the new tooltip has the same `create`.
 */
export function floatingCard(
  options: FloatingCardOptions
): (view: EditorView) => TooltipView {
  const gap = options.gap ?? FLOATING_GAP
  return view => {
    const dom = document.createElement('div')
    dom.className = `${options.className} ai-floating-card`
    const centred = options.align === 'center'
    // The card is placed at its text (its start, or its middle) and the
    // browser offsets it from there by its own live width: centred by -50%,
    // then kept inside the pane, then inside the window. Nothing depends on a
    // measured width, so it never shows at a stale offset, before its content
    // first renders or after it resizes
    const keep = (name: string, value: string, edge: string) =>
      `clamp(var(--ai-floating-${edge}-min, -1e5px), ${value}, calc(var(--ai-floating-${edge}-max, 1e5px) - 100%))`
    dom.style.transform = `translateX(${keep(
      'window',
      keep('pane', centred ? '-50%' : '0px', 'pane'),
      'window'
    )})`
    // Shown only once it is placed with its content measured, so the first
    // frame it appears in is its final position
    dom.style.opacity = '0'
    dom.style.pointerEvents = 'none'
    let shown = false
    let anchor: Rect | null = null
    // The pane's room when the minimum width was last raised
    let minWidthRoom: number | null = null

    // Written only on change, in CodeMirror's measure cycle (never from a
    // ResizeObserver): resizing the card there would loop with the observer
    // CodeMirror keeps on it
    const setVar = (name: string, value: number) => {
      const px = `${Math.round(value)}px`
      if (dom.style.getPropertyValue(name) !== px) {
        dom.style.setProperty(name, px)
      }
    }

    return {
      dom,
      overlap: true,
      offset: { x: 0, y: gap },
      // The card scrolls its own body; CodeMirror must not crop it
      resize: false,
      getCoords(pos) {
        const range = options.range?.(view.state)
        anchor = range ? rangeCoords(view, range) : view.coordsAtPos(pos)
        return anchor ?? { left: 0, right: 0, top: -1e9, bottom: -1e9 }
      },
      // Runs whenever CodeMirror places the card: on edits, scrolling, the
      // window or the editor pane resizing, and the card itself resizing
      positioned(space) {
        const side: FloatingSide = dom.classList.contains('cm-tooltip-above')
          ? 'top'
          : 'bottom'
        if (dom.dataset.placement !== side) dom.dataset.placement = side
        if (!anchor) return
        const pane = view.scrollDOM.getBoundingClientRect()
        // The card's own min-width keeps it usable in a very narrow pane
        const paneRoom = Math.max(0, pane.width - 2 * FLOATING_MARGIN)
        setVar('--ai-floating-max-width', paneRoom)
        if (options.oneLine) {
          // A wider pane may let the rows fit again: measure them afresh
          if (minWidthRoom !== null && paneRoom > minWidthRoom) {
            dom.style.removeProperty('--ai-floating-min-width')
            minWidthRoom = null
          }
          const overflow = rowOverflow(
            dom.querySelectorAll<HTMLElement>(options.oneLine)
          )
          if (overflow > 1) {
            const width = dom.getBoundingClientRect().width
            setVar('--ai-floating-min-width', Math.ceil(width + overflow))
            minWidthRoom = paneRoom
          }
        }
        // Beside the text, or over it when neither side leaves enough room
        const visible = space.bottom - space.top - FLOATING_MARGIN
        const beside = verticalRoom(anchor, space, side, gap)
        const over = beside < Math.min(MIN_FLOATING_HEIGHT, visible)
        setVar('--ai-floating-max-height', over ? visible : beside)
        // Back at its text: CodeMirror pulls it in by a width that may be stale
        const x = centred ? (anchor.left + anchor.right) / 2 : anchor.left
        const parent = dom.offsetParent
        const placed =
          (parent ? parent.getBoundingClientRect().left : 0) + dom.offsetLeft
        if (Math.abs(x - placed) > 0.5) {
          dom.style.left = `${parseFloat(dom.style.left || '0') + x - placed}px`
        }
        // The edges the transform keeps it within, relative to its text
        setVar('--ai-floating-pane-min', pane.left + FLOATING_MARGIN - x)
        setVar('--ai-floating-pane-max', pane.right - FLOATING_MARGIN - x)
        setVar('--ai-floating-window-min', space.left + FLOATING_MARGIN - x)
        setVar('--ai-floating-window-max', space.right - FLOATING_MARGIN - x)
        const rect = dom.getBoundingClientRect()
        if (over) {
          const lift = verticalShift(rect.top, rect.height, space)
          if (Math.abs(lift) > 0.5) {
            dom.style.top = `${parseFloat(dom.style.top || '0') + lift}px`
          }
        }
        // Empty until its content renders: it is placed again once that has
        // a size, and shows then, in the same frame
        if (!shown && rect.width > 0 && rect.height > 0) {
          shown = true
          dom.style.removeProperty('opacity')
          dom.style.removeProperty('pointer-events')
        }
      },
    }
  }
}

/**
 * Shared look of every card container: transparent and sized by its card,
 * which reads the room it has from `--ai-floating-max-width`.
 */
export const floatingCardTheme = EditorView.baseTheme({
  '.ai-floating-card.cm-tooltip': {
    backgroundColor: 'transparent',
    border: 'none',
  },
})
