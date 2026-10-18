import type PDFJSWrapper from './pdf-js-wrapper'

/**
 * The PDF viewer that is on screen, published for other features (the AI
 * assistant reads what the user is looking at and drives highlights through
 * it). Null while no PDF is shown.
 *
 * A plain module-level store rather than React context: the viewer publishes
 * from one effect, and readers only look at it when they need a value, so
 * nothing here re-renders anything.
 */
export type PdfViewerBridge = {
  wrapper: PDFJSWrapper
  /** The build the viewer is showing, if the PDF came from a compile. */
  buildId: string | null
  /** The CLSI editor id for this PDF, which synctex requests need. */
  editorId: string | null
}

let current: PdfViewerBridge | null = null
const listeners = new Set<() => void>()

export function publishPdfViewer(bridge: PdfViewerBridge | null) {
  current = bridge
  for (const listener of listeners) listener()
}

export function getPdfViewer(): PdfViewerBridge | null {
  return current
}

export function subscribePdfViewer(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
