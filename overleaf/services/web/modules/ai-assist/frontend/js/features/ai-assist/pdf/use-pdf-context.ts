import { useEffect, useRef, useSyncExternalStore } from 'react'
import { useProjectContext } from '@/shared/context/project-context'
import { useLocalCompileContext } from '@/shared/context/local-compile-context'
import {
  getPdfViewer,
  subscribePdfViewer,
} from '@/features/pdf-preview/util/viewer-bridge'
import getMeta from '@/utils/meta'
import type { PdfAreaContext } from '../agent/context/types'
import type { ChatImage } from '../providers/types'
import { sourceAtPdfPoint, SynctexContext, SourcePosition } from './sync'
import { cropCanvas } from './crop'
import { pagePointToPdf, PageBox, startBoxDrag } from './box-select'
import {
  cancelPdfBoxSelect,
  addPdfArea,
  updatePdfAreaSource,
  updatePdfTurnContext,
  usePdfTurnContext,
} from './turn-context'
import { PDF_RESULT_HIGHLIGHTS_EVENT } from './result-highlights'
import type PDFJSWrapper from '@/features/pdf-preview/util/pdf-js-wrapper'

export type AreaOptions = {
  /** The crop of the page, already taken when the box was released. */
  image?: ChatImage | null
  signal?: AbortSignal
}

/** The source lines the two edges of a box reach, when both are in one file. */
function sourceRange(
  atTop: SourcePosition | null,
  atBottom: SourcePosition | null
): PdfAreaContext['source'] {
  // Both ends should be in one file; if they are not, the top one decides
  const start = atTop ?? atBottom
  if (!start) return null
  const lines = [atTop, atBottom]
    .filter(position => position?.file === start.file)
    .map(position => (position as SourcePosition).line)
  return {
    path: start.file,
    line: Math.min(...lines),
    endLine: Math.max(...lines),
  }
}

/**
 * What a box the user drew means to the model: its rectangle in PDF points,
 * its crop, and, best-effort, the source lines its edges reach through
 * synctex. A synctex failure leaves `source` null and keeps the area. Null
 * only when there is neither a crop nor a source to send.
 */
export async function areaFromBox(
  wrapper: Pick<PDFJSWrapper, 'viewer'>,
  box: PageBox,
  projectId: string,
  context: SynctexContext,
  options: AreaOptions = {}
): Promise<PdfAreaContext | null> {
  const view = wrapper.viewer.getPageView(box.page - 1)
  if (!view?.viewport) return null
  const viewport = view.viewport
  const topLeft = pagePointToPdf(viewport, box.left, box.top)
  const bottomRight = pagePointToPdf(viewport, box.right, box.bottom)
  const h = (topLeft.h + bottomRight.h) / 2
  const top = Math.min(topLeft.v, bottomRight.v)
  const bottom = Math.max(topLeft.v, bottomRight.v)

  const lookup = (v: number) =>
    sourceAtPdfPoint(
      projectId,
      { page: box.page, h, v },
      context,
      options.signal
    ).catch(() => null)
  const [atTop, atBottom] = await Promise.all([lookup(top), lookup(bottom)])

  const image = options.image ?? null
  const source = sourceRange(atTop, atBottom)
  if (!image && !source) return null
  return {
    page: box.page,
    source,
    rect: {
      x: Math.min(topLeft.h, bottomRight.h),
      y: top,
      w: Math.abs(bottomRight.h - topLeft.h),
      h: bottom - top,
    },
    image,
  }
}

/** Whether the PDF features are on, which the AI-assist settings decide. */
function pdfFeaturesEnabled(): boolean {
  return Boolean(getMeta('ol-aiAssistEnabled'))
}

/** True while a PDF viewer is on screen and the assistant can use it. */
export function usePdfViewerAvailable(): boolean {
  const bridge = useSyncExternalStore(subscribePdfViewer, getPdfViewer)
  return Boolean(bridge) && pdfFeaturesEnabled()
}

/**
 * Keeps the PDF's contributions to the composer current: the boxes the user
 * draws, and the agent's highlights. A text selection is added only when the
 * user asks, through PdfSelectionAction.
 */
export function usePdfContext(): void {
  const { projectId } = useProjectContext()
  const { setHighlights, clsiServerId } = useLocalCompileContext()
  // Only box selection needs the viewer as state; the others read it on demand
  const bridge = useSyncExternalStore(subscribePdfViewer, getPdfViewer)
  const { boxSelecting } = usePdfTurnContext()

  // A box's crop and synctex lookup outlive the box mode that started them,
  // so they are cancelled only when the composer goes away
  const lifetime = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    return () => {
      controller.abort()
      cancelPdfBoxSelect()
    }
  }, [])

  useEffect(() => {
    const onHighlights = (event: Event) => {
      // Already validated where the event was dispatched
      const highlights = (event as CustomEvent).detail?.highlights
      if (Array.isArray(highlights) && highlights.length > 0) {
        setHighlights(highlights)
      }
    }
    window.addEventListener(PDF_RESULT_HIGHLIGHTS_EVENT, onHighlights)
    return () =>
      window.removeEventListener(PDF_RESULT_HIGHLIGHTS_EVENT, onHighlights)
  }, [setHighlights])

  useEffect(() => {
    if (!boxSelecting || !pdfFeaturesEnabled()) return
    if (!bridge) {
      cancelPdfBoxSelect()
      return
    }
    const { wrapper, editorId, buildId } = bridge
    const context: SynctexContext = { clsiServerId, editorId, buildId }
    return startBoxDrag(
      wrapper,
      (box, canvas) => {
        // Synchronously cropped now, so it appears immediately like selected text without blinking
        const image = cropCanvas(canvas, box)
        const view = wrapper.viewer.getPageView(box.page - 1)
        const viewport = view?.viewport
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

        const areaId = `pdf-area-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
        const initialArea: PdfAreaContext = {
          id: areaId,
          page: box.page,
          source: null,
          rect,
          image,
        }

        // Add area immediately and exit box selection in a single update
        updatePdfTurnContext({ boxSelecting: false })
        addPdfArea(initialArea)

        // Resolve synctex source line numbers in the background without blocking UI
        areaFromBox(wrapper, box, projectId, context, {
          image,
          signal: lifetime.current?.signal,
        })
          .then(area => {
            if (area?.source) {
              updatePdfAreaSource(areaId, area.source)
            }
          })
          .catch(() => undefined)
      },
      cancelPdfBoxSelect
    )
  }, [boxSelecting, bridge, clsiServerId, projectId])
}
