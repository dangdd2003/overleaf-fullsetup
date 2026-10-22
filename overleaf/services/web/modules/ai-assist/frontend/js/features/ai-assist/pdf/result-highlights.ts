import type { HighlightData } from '@/features/pdf-preview/util/types'

/** Window event carrying highlight boxes for the PDF viewer to show. */
export const PDF_RESULT_HIGHLIGHTS_EVENT = 'aiAssist:pdfResultHighlights'

/** The colour of a region the AI changed, distinct from the sync highlight. */
export const CHANGED_BY_AI_COLOR = 'rgba(255, 140, 0, 0.55)'

export type PdfResultHighlightsDetail = {
  highlights: HighlightData[]
}

export function isFiniteBox(value: unknown): value is HighlightData {
  if (!value || typeof value !== 'object') return false
  const { page, h, v, width, height } = value as Record<string, unknown>
  return [page, h, v, width, height].every(
    n => typeof n === 'number' && Number.isFinite(n)
  )
}

/** Keeps only well-formed boxes; anything else from a result is ignored. */
export function parseHighlights(value: unknown): HighlightData[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): HighlightData[] => {
    if (!isFiniteBox(item)) return []
    if (item.page < 1 || item.width < 0 || item.height < 0) {
      return []
    }
    return [
      {
        page: item.page,
        h: item.h,
        v: item.v,
        width: item.width,
        height: item.height,
      },
    ]
  })
}

/**
 * Forwards the `highlights` a tool result carries (a visual diff marks the
 * regions that changed) to the viewer, as changed-by-AI boxes.
 *
 * Called for both live runs and background runs followed from elsewhere, so
 * the one place that shows them is the viewer, not the run that produced them.
 */
export function dispatchPdfResultHighlights(result: unknown): void {
  const highlights = parseHighlights((result as { highlights?: unknown })?.highlights)
  if (highlights.length === 0) return
  window.dispatchEvent(
    new CustomEvent<PdfResultHighlightsDetail>(PDF_RESULT_HIGHLIGHTS_EVENT, {
      detail: {
        highlights: highlights.map(box => ({ ...box, color: CHANGED_BY_AI_COLOR })),
      },
    })
  )
}
