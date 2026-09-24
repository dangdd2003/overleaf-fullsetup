import { CompileOutcome, ProjectFile } from '../project-handle'
import { Outline } from './outline'

export type Selection = {
  path: string
  from: number
  to: number
  text: string
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
}

/** Carried on a user entry so the next turn can delta-encode against it. */
export type EnvelopeState = {
  turn: number
  filesFingerprint: string
  outlineFingerprint?: string
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
