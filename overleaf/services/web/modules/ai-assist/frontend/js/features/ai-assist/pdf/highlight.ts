import type { HighlightData } from '@/features/pdf-preview/util/types'
import { pdfBoxesForSource, SynctexContext } from './sync'
import { parseHighlights } from './result-highlights'

export type HighlightRequest = {
  /** Boxes to show, 1-based pages in PDF points from the top. */
  boxes?: unknown
  /** Or a source range, resolved through synctex. */
  path?: unknown
  line?: unknown
  endLine?: unknown
}

export type HighlightResult =
  | { error: string }
  | { status: 'highlighted'; count: number; pages: number[] }

/**
 * Shows boxes in the user's PDF viewer, which scrolls to the first one. Pure
 * apart from the two calls it is given: the viewer's setter and the synctex
 * lookup, so the rules can be tested without a PDF on screen.
 */
export async function highlightInPdf({
  request,
  projectId,
  rootDocPath,
  context,
  pageCount,
  setHighlights,
  signal,
}: {
  request: HighlightRequest
  projectId: string
  rootDocPath: string | null
  context: SynctexContext
  pageCount: number | null
  setHighlights: (value: HighlightData[]) => void
  signal?: AbortSignal
}): Promise<HighlightResult> {
  let boxes: HighlightData[]

  if (request.boxes !== undefined) {
    const parsed = parseHighlights(request.boxes)
    if (!Array.isArray(request.boxes) || parsed.length === 0) {
      return { error: 'boxes must be a non-empty list of {page, h, v, width, height}.' }
    }
    if (
      pageCount !== null &&
      parsed.some(box => box.page > pageCount)
    ) {
      return { error: `The PDF has ${pageCount} pages.` }
    }
    boxes = parsed
  } else {
    const { path, line, endLine } = request
    if (typeof path !== 'string' || !path || !Number.isInteger(line) || (line as number) < 1) {
      return { error: 'Give either boxes, or a path and a line.' }
    }
    const start = line as number
    const end = Number.isInteger(endLine) ? (endLine as number) : start
    if (end < start) {
      return { error: 'endLine must not be before line.' }
    }
    boxes = await pdfBoxesForSource(
      projectId,
      { path, line: start, endLine: end },
      rootDocPath,
      context,
      signal
    )
    if (boxes.length === 0) {
      return { error: `${path} line ${start} is not in the PDF build on screen.` }
    }
  }

  setHighlights(boxes)
  const pages = [...new Set(boxes.map(box => box.page))].sort((a, b) => a - b)
  return { status: 'highlighted', count: boxes.length, pages }
}
