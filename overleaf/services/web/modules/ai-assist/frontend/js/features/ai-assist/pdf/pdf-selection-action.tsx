import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { getPdfViewer } from '@/features/pdf-preview/util/viewer-bridge'
import type { PdfSelectionContext } from '../agent/context/types'
import { placementSide, useFloatingBox } from '../floating/use-floating-box'
import { readPdfSelection } from './selection'
import { addPdfSelection } from './turn-context'

export const PDF_SELECTION_ACTION_CLASS = 'ai-assist-pdf-selection-action'

type Rect = { left: number; top: number; right: number; bottom: number }

/** The text selected in the PDF, and where its last line sits on screen. */
export type PdfSelectionTarget = {
  context: PdfSelectionContext
  end: Rect
}

/**
 * The selection the button acts on, or null when the button should be hidden:
 * empty, collapsed, or made outside the PDF's text layer. Pure over its
 * arguments, so the visibility rules can be tested without a viewer.
 */
export function pdfSelectionTarget(
  root: Element | null,
  selection: Selection | null
): PdfSelectionTarget | null {
  const context = readPdfSelection(root, selection)
  if (!context || !selection || selection.rangeCount === 0) return null
  const rects = selection.getRangeAt(0).getClientRects()
  const last = rects[rects.length - 1]
  if (!last) return null
  return {
    context,
    end: {
      left: last.left,
      top: last.top,
      right: last.right,
      bottom: last.bottom,
    },
  }
}

/** The selection's last line, as the rect the button is placed from. */
function endReference(end: Rect) {
  return {
    getBoundingClientRect: () => ({
      x: end.left,
      y: end.top,
      width: end.right - end.left,
      height: end.bottom - end.top,
      top: end.top,
      left: end.left,
      right: end.right,
      bottom: end.bottom,
    }),
  }
}

/** How long a keyboard selection must rest before the button shows. */
const KEYBOARD_SETTLE_MS = 300

/**
 * A floating "Add to chat" button for a text selection in the PDF. Clicking
 * it attaches that selection to the next message, and only then.
 *
 * It appears once the selection is finished (the pointer is released, or a
 * keyboard selection rests) and stays where it appeared: it does not follow
 * the pointer while the user is still selecting. It hides when a new
 * selection starts, when the selection collapses or leaves the PDF, and on
 * scroll or resize.
 */
export function PdfSelectionAction() {
  const { t } = useTranslation()
  const [target, setTarget] = useState<PdfSelectionTarget | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  // Below the end of the selection, lined up with its right edge; above when
  // there is no room below
  const { refs, floatingStyles, isPositioned, placement } = useFloatingBox({
    open: target !== null,
    placement: 'bottom-end',
    fallbackPlacements: ['top-end'],
  })
  const setButton = useCallback(
    (node: HTMLButtonElement | null) => {
      buttonRef.current = node
      refs.setFloating(node)
    },
    [refs]
  )

  useLayoutEffect(() => {
    if (target) refs.setPositionReference(endReference(target.end))
  }, [refs, target])

  useEffect(() => {
    let selecting = false
    let settle: number | undefined
    let frame: number | undefined

    const read = () =>
      pdfSelectionTarget(
        getPdfViewer()?.wrapper.container ?? null,
        window.getSelection()
      )
    const hide = () => setTarget(null)
    const show = () => {
      if (!selecting) setTarget(read())
    }

    const onPointerDown = (event: PointerEvent) => {
      if (buttonRef.current?.contains(event.target as Node)) return
      selecting = true
      window.clearTimeout(settle)
      hide()
    }
    const onPointerUp = () => {
      if (!selecting) return
      selecting = false
      // The browser settles the selection after pointerup (a click inside a
      // selection collapses it then), so read it on the next frame
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(show)
    }
    const onSelectionChange = () => {
      if (selecting) return
      // Only ever hides here; showing waits for the selection to finish
      if (!read()) {
        window.clearTimeout(settle)
        hide()
      }
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (!event.shiftKey && event.key !== 'Shift') return
      window.clearTimeout(settle)
      settle = window.setTimeout(show, KEYBOARD_SETTLE_MS)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide()
      else if (event.shiftKey) hide()
    }

    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('pointerup', onPointerUp, true)
    document.addEventListener('pointercancel', onPointerUp, true)
    document.addEventListener('selectionchange', onSelectionChange)
    document.addEventListener('keyup', onKeyUp, true)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)
    return () => {
      window.clearTimeout(settle)
      if (frame !== undefined) cancelAnimationFrame(frame)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('pointerup', onPointerUp, true)
      document.removeEventListener('pointercancel', onPointerUp, true)
      document.removeEventListener('selectionchange', onSelectionChange)
      document.removeEventListener('keyup', onKeyUp, true)
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('resize', hide)
    }
  }, [])

  if (!target) return null

  // Pressing the button must not clear the selection before the click lands
  return createPortal(
    <button
      ref={setButton}
      type="button"
      className={PDF_SELECTION_ACTION_CLASS}
      data-placement={placementSide(placement)}
      style={{
        ...floatingStyles,
        visibility: isPositioned ? undefined : 'hidden',
      }}
      onMouseDown={event => event.preventDefault()}
      onClick={() => {
        addPdfSelection(target.context)
        window.getSelection()?.removeAllRanges()
        setTarget(null)
      }}
    >
      {t('ai_assist_pdf_add_to_chat', { defaultValue: 'Add to chat' })}
    </button>,
    document.body
  )
}
