import type PDFJSWrapper from '@/features/pdf-preview/util/pdf-js-wrapper'

/** A drawn box, in CSS pixels from the top-left of the page's canvas. */
export type PageBox = {
  page: number
  left: number
  top: number
  right: number
  bottom: number
}

/** Smaller drags are clicks, not boxes. */
export const MIN_BOX_PX = 6

const OVERLAY_CLASS = 'ai-assist-pdf-area-overlay'
const MODE_CLASS = 'ai-assist-pdf-box-mode'
const MODE_STYLE_ID = 'ai-assist-pdf-box-mode-style'

/**
 * Maps a CSS-pixel point on a page to PDF points, `v` measured from the top,
 * the same convention the viewer's own synctex clicks use.
 */
export function pagePointToPdf(
  viewport: { convertToPdfPoint(x: number, y: number): number[]; viewBox: number[] },
  x: number,
  y: number
): { h: number; v: number } {
  const [h, pdfY] = viewport.convertToPdfPoint(x, y)
  return { h, v: viewport.viewBox[3] - pdfY }
}

export function boxToPdfRect(
  viewport: { convertToPdfPoint(x: number, y: number): number[]; viewBox: number[] } | undefined,
  box: { left: number; top: number; right: number; bottom: number }
): {
  rect: { x: number; y: number; w: number; h: number }
  topLeft: { h: number; v: number }
  bottomRight: { h: number; v: number }
} {
  const topLeft = viewport
    ? pagePointToPdf(viewport, box.left, box.top)
    : { h: 0, v: 0 }
  const bottomRight = viewport
    ? pagePointToPdf(viewport, box.right, box.bottom)
    : { h: 0, v: 0 }
  const top = Math.min(topLeft.v, bottomRight.v)
  const bottom = Math.max(topLeft.v, bottomRight.v)
  const rect = {
    x: Math.min(topLeft.h, bottomRight.h),
    y: top,
    w: Math.abs(bottomRight.h - topLeft.h),
    h: bottom - top,
  }
  return { rect, topLeft, bottomRight }
}

/**
 * The box spanned by two points, clamped to a canvas of `size`. Pure, so the
 * geometry can be tested without a layout.
 */
export function boxBetween(
  a: { x: number; y: number },
  b: { x: number; y: number },
  size: { width: number; height: number }
): Omit<PageBox, 'page'> {
  const x1 = Math.min(Math.max(a.x, 0), size.width)
  const x2 = Math.min(Math.max(b.x, 0), size.width)
  const y1 = Math.min(Math.max(a.y, 0), size.height)
  const y2 = Math.min(Math.max(b.y, 0), size.height)
  return {
    left: Math.min(x1, x2),
    top: Math.min(y1, y2),
    right: Math.max(x1, x2),
    bottom: Math.max(y1, y2),
  }
}

/** Whether a drag is large enough to be a box rather than a click. */
export function isBigEnough(box: Omit<PageBox, 'page'>): boolean {
  return (
    box.right - box.left >= MIN_BOX_PX && box.bottom - box.top >= MIN_BOX_PX
  )
}

type Drag = {
  pointerId: number
  page: number
  pageElement: HTMLElement
  canvas: HTMLCanvasElement
  overlay: HTMLDivElement
  start: { x: number; y: number }
  current: { x: number; y: number }
}

/** A point in CSS pixels from the top-left of the canvas, which is the page's content. */
function canvasPoint(canvas: HTMLCanvasElement, event: PointerEvent) {
  const rect = canvas.getBoundingClientRect()
  return { x: event.clientX - rect.left, y: event.clientY - rect.top }
}

/**
 * Lets the user drag a box over a PDF page, with a mouse, a pen or a finger.
 * `onBox` is called once on release, with the canvas the box is over. A drag
 * that is only a click draws nothing and leaves the mode on. `onCancel` is
 * called on Esc.
 *
 * Returns a function that removes everything it added, including any box
 * still being drawn. Call it on every exit path.
 */
export function startBoxDrag(
  wrapper: Pick<PDFJSWrapper, 'container'>,
  onBox: (box: PageBox, canvas: HTMLCanvasElement) => void,
  onCancel: () => void = () => undefined
): () => void {
  const container = wrapper.container
  const previousTouchAction = container.style.touchAction
  let drag: Drag | null = null

  container.classList.add(MODE_CLASS)
  // Touch drags draw the box instead of scrolling the page
  container.style.touchAction = 'none'
  document.getElementById(MODE_STYLE_ID)?.remove()
  const style = document.createElement('style')
  style.id = MODE_STYLE_ID
  style.textContent = `.${MODE_CLASS}, .${MODE_CLASS} * { cursor: crosshair !important; user-select: none !important; }`
  document.head.append(style)

  const endDrag = () => {
    if (!drag) return
    drag.overlay.remove()
    try {
      drag.pageElement.releasePointerCapture(drag.pointerId)
    } catch {
      // Capture was never taken, or already released
    }
    drag = null
  }

  const updateOverlay = (current: Drag) => {
    const box = boxBetween(current.start, current.current, {
      width: current.canvas.clientWidth,
      height: current.canvas.clientHeight,
    })
    current.overlay.style.left = `${box.left}px`
    current.overlay.style.top = `${box.top}px`
    current.overlay.style.width = `${box.right - box.left}px`
    current.overlay.style.height = `${box.bottom - box.top}px`
  }

  const onDown = (event: PointerEvent) => {
    if (drag || event.button !== 0) return
    const target = event.target instanceof Element ? event.target : null
    const pageElement = target?.closest<HTMLElement>('.page[data-page-number]')
    const canvas = pageElement?.querySelector('canvas')
    if (!pageElement || !canvas) return
    event.preventDefault()
    event.stopPropagation()

    // The page's border is 9px of the .page box, so positions are taken from
    // the canvas, and the overlay sits over the canvas origin inside the page
    const overlay = document.createElement('div')
    overlay.className = OVERLAY_CLASS
    overlay.style.position = 'absolute'
    overlay.style.pointerEvents = 'none'
    overlay.style.border = '2px dashed rgb(79, 70, 229)'
    overlay.style.background = 'rgba(79, 70, 229, 0.12)'
    pageElement.append(overlay)

    const start = canvasPoint(canvas, event)
    drag = {
      pointerId: event.pointerId,
      page: Number(pageElement.dataset.pageNumber),
      pageElement,
      canvas,
      overlay,
      start,
      current: start,
    }
    try {
      pageElement.setPointerCapture(event.pointerId)
    } catch {
      // Without capture the drag still works while the pointer stays on the page
    }
    updateOverlay(drag)
  }

  const onMove = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return
    drag.current = canvasPoint(drag.canvas, event)
    updateOverlay(drag)
  }

  const onUp = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return
    const finished = drag
    finished.current = canvasPoint(finished.canvas, event)
    const box = boxBetween(finished.start, finished.current, {
      width: finished.canvas.clientWidth,
      height: finished.canvas.clientHeight,
    })
    endDrag()
    if (isBigEnough(box)) {
      onBox({ page: finished.page, ...box }, finished.canvas)
    }
  }

  const onPointerCancel = (event: PointerEvent) => {
    if (drag && event.pointerId === drag.pointerId) endDrag()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    endDrag()
    onCancel()
  }

  // Pointer events cover touch and pen too; the capture phase sees them first
  // and keeps pdf.js from starting a text selection under the drag
  container.addEventListener('pointerdown', onDown, true)
  window.addEventListener('pointermove', onMove as EventListener, true)
  window.addEventListener('pointerup', onUp as EventListener, true)
  window.addEventListener('pointercancel', onPointerCancel as EventListener, true)
  window.addEventListener('keydown', onKeyDown, true)

  return () => {
    container.removeEventListener('pointerdown', onDown, true)
    window.removeEventListener('pointermove', onMove as EventListener, true)
    window.removeEventListener('pointerup', onUp as EventListener, true)
    window.removeEventListener(
      'pointercancel',
      onPointerCancel as EventListener,
      true
    )
    window.removeEventListener('keydown', onKeyDown, true)
    endDrag()
    container.classList.remove(MODE_CLASS)
    container.style.touchAction = previousTouchAction
    document.getElementById(MODE_STYLE_ID)?.remove()
  }
}
