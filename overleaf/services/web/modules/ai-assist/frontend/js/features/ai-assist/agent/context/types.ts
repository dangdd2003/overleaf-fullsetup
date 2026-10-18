import { CompileOutcome, ProjectFile } from '../project-handle'
import type { ChatImage } from '../../providers/types'
import { Outline } from './outline'

export type SelectionRange = {
  from: number
  to: number
  text: string
}

export type Selection = {
  path: string
  from: number
  to: number
  text: string
  ranges?: SelectionRange[]
}

/** Everything the envelope can describe, captured at one instant. */
export type ContextSnapshot = {
  rootDocPath: string | null
  files: ProjectFile[]
  openFile: { path: string; cursorLine: number | null } | null
  selection: Selection | null
  compile:
    | (Pick<CompileOutcome, 'status'> & {
        errorCount: number
        warningCount: number
      })
    | null
  outline?: Outline | null
  /**
   * The user's local date, e.g. "2026-09-24 (Thursday)". The model has no
   * other way to know it, and needs it for anything about the present.
   */
  today?: string
  /**
   * The composer's mode when the message was sent, named as the model reads
   * it. The system prompt no longer carries the mode, so this is where the
   * model learns it.
   */
  mode?: string
  /** What the PDF viewer shows. Absent unless the viewer context is enabled. */
  pdfViewer?: PdfViewerSnapshot | null
  /** Text the user selected inside the PDF, in the order added; one-shot. */
  pdfSelections?: PdfSelectionContext[]
  /** Boxes the user drew on PDF pages, in the order added; one-shot. */
  pdfAreas?: PdfAreaContext[]
}

/** The viewer state the user is looking at, read at send time. */
export type PdfViewerSnapshot = {
  /** The build on screen; the model compares it with the build it has seen. */
  buildId: string | null
  /** Visible page numbers, 1-based, ascending. */
  pages: number[]
  /** A named fit ("page-width") or a percentage such as "125%". */
  zoom: string
  darkMode: boolean
}

export type PdfSelectionContext = {
  page: number
  text: string
}

export type PdfAreaContext = {
  id?: string
  page: number
  /** Source lines under the box, from synctex; null when unresolved. */
  source: { path: string; line: number; endLine: number } | null
  /** The box in PDF points from the top-left of the page. */
  rect: { x: number; y: number; w: number; h: number }
  /** Crop of the rendered page, sent to the model as an image; null if the canvas could not be read. */
  image: ChatImage | null
  /**
   * Which image on the message is this crop, 1-based. Set when the message is
   * sent, since only then is it known what else the message carries.
   */
  imageIndex?: number
}

/** Carried on a user entry so the next turn can delta-encode against it. */
export type EnvelopeState = {
  turn: number
  filesFingerprint: string
  outlineFingerprint?: string
  pdfViewerFingerprint?: string
}

/** What the composer holds before the message is sent. */
export type AttachmentRef = {
  path: string
  from?: number
  to?: number
}

/** What the transcript holds after it. `text: null` means the file is gone. */
export type Attachment = AttachmentRef & { text: string | null }

export type { CacheHints, Limits } from '../../providers/types'

/**
 * A cheap identity for a file listing.
 *
 * Deliberately excludes byte size: it changes on every keystroke, and feeding
 * it in here would re-emit the whole listing every turn and defeat the cache.
 */
export function fingerprintFiles(files: ProjectFile[]): string {
  return files
    .map(file => `${file.path}:${file.type}:${file.lines ?? ''}`)
    .sort()
    .join('|')
}
