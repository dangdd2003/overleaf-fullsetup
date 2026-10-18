import type PDFJSWrapper from '@/features/pdf-preview/util/pdf-js-wrapper'
import type { PdfViewerSnapshot } from '../agent/context/types'

const NAMED_ZOOM = ['auto', 'page-actual', 'page-fit', 'page-height', 'page-width']

/**
 * The 1-based numbers of the pages that overlap the visible part of the
 * viewer. Read at send time, so it costs one pass over the rendered pages.
 */
export function visiblePageNumbers(wrapper: PDFJSWrapper): number[] {
  const viewer = wrapper.viewer
  const count = viewer.pagesCount ?? 0
  const box = wrapper.container.getBoundingClientRect()
  const pages: number[] = []
  for (let index = 0; index < count; index++) {
    const div = viewer.getPageView(index)?.div
    if (!div) continue
    const rect = div.getBoundingClientRect()
    if (rect.bottom <= box.top) continue
    if (rect.top >= box.bottom) break
    pages.push(index + 1)
  }
  return pages.length > 0 ? pages : [viewer.currentPageNumber]
}

/** A named fit such as "page-width", otherwise the scale as a percentage. */
export function zoomLabel(wrapper: PDFJSWrapper): string {
  const value = wrapper.viewer.currentScaleValue
  if (value && NAMED_ZOOM.includes(value)) return value
  return `${Math.round(wrapper.viewer.currentScale * 100)}%`
}

/**
 * What the viewer shows right now, or null when no PDF is on screen. Never
 * throws: a viewer that is half torn down must not block a message.
 */
export function readPdfViewerSnapshot(
  wrapper: PDFJSWrapper | null | undefined,
  buildId: string | null,
  darkMode: boolean
): PdfViewerSnapshot | null {
  if (!wrapper) return null
  try {
    return {
      buildId,
      pages: visiblePageNumbers(wrapper),
      zoom: zoomLabel(wrapper),
      darkMode,
    }
  } catch {
    return null
  }
}
