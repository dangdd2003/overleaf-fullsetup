import type { PdfSelectionContext } from '../agent/context/types'

/** Enough for a paragraph or two; a whole page of text is not a selection. */
export const MAX_PDF_SELECTION_CHARS = 4000

/**
 * The 1-based page a DOM node sits on, when it sits in the PDF's text layer
 * under `root`. Null for anything else, including the editor.
 */
export function pdfPageOf(node: Node | null, root: Element): number | null {
  const element = node instanceof Element ? node : (node?.parentElement ?? null)
  if (!element || !root.contains(element)) return null
  if (!element.closest('.textLayer')) return null
  const page = element.closest<HTMLElement>('.page[data-page-number]')
  const number = Number(page?.dataset.pageNumber)
  return Number.isInteger(number) && number > 0 ? number : null
}

/**
 * The text the user selected inside the PDF, with its page. Null when the
 * selection is empty or was made anywhere else.
 */
export function readPdfSelection(
  root: Element | null,
  selection: Selection | null
): PdfSelectionContext | null {
  if (!root || !selection || selection.isCollapsed) return null
  const page = pdfPageOf(selection.anchorNode, root)
  if (page === null) return null
  const text = selection.toString().trim()
  if (!text) return null
  return { page, text: text.slice(0, MAX_PDF_SELECTION_CHARS) }
}
