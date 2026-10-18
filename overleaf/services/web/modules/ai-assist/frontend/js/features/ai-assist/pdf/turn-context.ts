import { useSyncExternalStore } from 'react'
import type {
  PdfAreaContext,
  PdfSelectionContext,
} from '../agent/context/types'

/**
 * What the user pointed at in the PDF, waiting for the next message.
 *
 * Selections and areas collect, the way editor selections do: each one the
 * user adds joins the list, in order, until a message is sent and takes them
 * all. The chips in the composer show them until then, and each can be
 * removed on its own.
 */
export type PdfTurnContext = {
  selections: PdfSelectionContext[]
  areas: PdfAreaContext[]
  /** Boxes drawn and still being cropped and resolved. */
  pendingAreas: number
  /** The user is drawing a box on the PDF. A mode, not an item. */
  boxSelecting: boolean
}

/** The one-shot items, as a message carries them. */
export type PdfTurnContextSnapshot = Pick<PdfTurnContext, 'selections' | 'areas'>

/** Most of each kind one message carries; adding past it drops the oldest. */
export const MAX_PDF_ITEMS = 10

const EMPTY: PdfTurnContext = {
  selections: [],
  areas: [],
  pendingAreas: 0,
  boxSelecting: false,
}

let current: PdfTurnContext = EMPTY
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function getPdfTurnContext(): PdfTurnContext {
  return current
}

export function updatePdfTurnContext(patch: Partial<PdfTurnContext>) {
  current = { ...current, ...patch }
  emit()
}

const newest = <T>(items: T[]) => items.slice(-MAX_PDF_ITEMS)

/** Adds a selection, unless the same text on the same page is already there. */
export function addPdfSelection(selection: PdfSelectionContext) {
  const duplicate = current.selections.some(
    item => item.page === selection.page && item.text === selection.text
  )
  if (duplicate) return
  updatePdfTurnContext({ selections: newest([...current.selections, selection]) })
}

export function removePdfSelection(index: number) {
  updatePdfTurnContext({
    selections: current.selections.filter((_, at) => at !== index),
  })
}

export function addPdfArea(area: PdfAreaContext) {
  updatePdfTurnContext({ areas: newest([...current.areas, area]) })
}

/** Updates the resolved source code lines for an existing area in place without replacing it. */
export function updatePdfAreaSource(
  id: string,
  source: { path: string; line: number; endLine: number } | null
) {
  let changed = false
  const updatedAreas = current.areas.map(area => {
    if (area.id === id) {
      changed = true
      return { ...area, source }
    }
    return area
  })
  if (changed) {
    updatePdfTurnContext({ areas: updatedAreas })
  }
}

export function removePdfArea(index: number) {
  updatePdfTurnContext({ areas: current.areas.filter((_, at) => at !== index) })
}

/** Counts a box being captured, until `finishPdfArea` is called for it. */
export function beginPdfArea() {
  updatePdfTurnContext({ pendingAreas: current.pendingAreas + 1 })
}

/** Ends one capture, adding its area when it produced one. */
export function finishPdfArea(area: PdfAreaContext | null) {
  updatePdfTurnContext({
    pendingAreas: Math.max(current.pendingAreas - 1, 0),
    ...(area ? { areas: newest([...current.areas, area]) } : {}),
  })
}

/**
 * Returns what is pending for the message being sent and clears the one-shot
 * items. Box selection and captures still running are left as they are.
 */
export function takePdfTurnContext(): PdfTurnContextSnapshot {
  const { selections, areas } = current
  if (selections.length > 0 || areas.length > 0) {
    current = { ...current, selections: [], areas: [] }
    emit()
  }
  return { selections, areas }
}

/** Puts the viewer into box selection until a box is drawn or Esc is pressed. */
export function startPdfBoxSelect() {
  if (!current.boxSelecting) updatePdfTurnContext({ boxSelecting: true })
}

/** Leaves box selection without drawing anything. */
export function cancelPdfBoxSelect() {
  if (current.boxSelecting) updatePdfTurnContext({ boxSelecting: false })
}

export function subscribePdfTurnContext(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function usePdfTurnContext(): PdfTurnContext {
  return useSyncExternalStore(subscribePdfTurnContext, getPdfTurnContext)
}

/** Test seam: forget everything, as a fresh page load would. */
export function resetPdfTurnContext() {
  current = EMPTY
  emit()
}
