import {
  autoUpdate,
  flip,
  offset,
  Placement,
  shift,
  size,
  useFloating,
} from '@floating-ui/react'
import { FLOATING_GAP, FLOATING_MARGIN } from './editor-card'

/**
 * Placement for AI boxes positioned in the page rather than by CodeMirror
 * (the TeXGPT popup, the writing tools menu, the PDF selection button, menus
 * and cards inside the chat panel). The box starts at `placement`, flips to
 * the other side when it does not fit, slides along to stay inside
 * `boundary`, and is kept to the room it has through
 * `--ai-floating-max-width` and `--ai-floating-max-height`. It follows its
 * anchor through scrolling, resizes and layout changes.
 *
 * Usage: `ref={refs.setFloating} style={floatingStyles}
 * data-placement={placement}` on the box; the anchor is set with
 * `refs.setReference(element)`, or `refs.setPositionReference(virtual)` for a
 * rect such as a text selection.
 */
export type FloatingBoxOptions = {
  open?: boolean
  placement?: Placement
  /** Sides to try, in order, when `placement` does not fit. */
  fallbackPlacements?: Placement[]
  gap?: number
  /** Distance kept from the boundary. */
  padding?: number
  /** The element the box must stay in; the viewport by default. */
  boundary?: Element | null
  /**
   * Whether the box may slide along the axis it opens on. Off for a submenu:
   * its anchor already spans the width of the menu it belongs to, so sliding
   * it back would drop it on top of that menu.
   */
  shiftMainAxis?: boolean
}

export function useFloatingBox({
  open = true,
  placement = 'bottom-start',
  fallbackPlacements,
  gap = FLOATING_GAP,
  padding = FLOATING_MARGIN,
  boundary,
  shiftMainAxis = true,
}: FloatingBoxOptions = {}) {
  const detect = {
    padding,
    ...(boundary ? { boundary } : {}),
  }
  return useFloating({
    open,
    placement,
    strategy: 'fixed',
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(gap),
      flip({ ...detect, fallbackPlacements }),
      shift({ ...detect, mainAxis: shiftMainAxis, crossAxis: true }),
      size({
        ...detect,
        apply({ availableWidth, availableHeight, elements }) {
          const { style } = elements.floating
          style.setProperty(
            '--ai-floating-max-width',
            `${Math.max(0, availableWidth)}px`
          )
          style.setProperty(
            '--ai-floating-max-height',
            `${Math.max(0, availableHeight)}px`
          )
        },
      }),
    ],
  })
}

/** The side a placement opens to, for `data-placement`. */
export function placementSide(placement: Placement): string {
  return placement.split('-')[0]
}
