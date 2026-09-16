import { escapeAttribute, neutraliseClosingTags } from './escape'
import { ProjectHandle } from '../project-handle'
import { Attachment, AttachmentRef } from './types'

function label(attachment: Attachment) {
  return attachment.from !== undefined && attachment.to !== undefined
    ? `<file path="${escapeAttribute(attachment.path)}" lines="${attachment.from}-${attachment.to}">`
    : `<file path="${escapeAttribute(attachment.path)}">`
}

/**
 * Renders what the user explicitly pinned to the turn.
 *
 * A missing file renders as a note rather than an error: a conversation should
 * survive the user deleting something it once referred to.
 */
export function renderAttachments(attachments: Attachment[]): string | null {
  if (attachments.length === 0) return null

  const body = attachments.map(attachment => {
    if (attachment.text === null) {
      return `<file path="${escapeAttribute(attachment.path)}">no longer in the project</file>`
    }
    return [
      label(attachment),
      neutraliseClosingTags(attachment.text),
      '</file>',
    ].join('\n')
  })

  return ['<attachments>', ...body, '</attachments>'].join('\n')
}

const RANGE_RE = /^(.*):(\d+)(?:-(\d+))?$/

/** Parses `path`, `path:12`, or `path:40-80` from an @-mention token. */
export function parseAttachmentRef(token: string): AttachmentRef | null {
  const trimmed = token.trim()
  if (!trimmed) return null

  const match = trimmed.match(RANGE_RE)
  if (!match) return { path: trimmed }

  const from = Number(match[2])
  const to = match[3] ? Number(match[3]) : from

  return {
    path: match[1],
    from: Math.min(from, to),
    to: Math.max(from, to),
  }
}

/**
 * Reads each attachment's text once, at send time.
 *
 * A file that has gone resolves to `text: null` rather than throwing: a
 * conversation should survive the user deleting something it referred to.
 */
export async function resolveAttachments(
  refs: AttachmentRef[],
  handle: ProjectHandle
): Promise<Attachment[]> {
  const files = await handle.listFiles()

  return Promise.all(
    refs.map(async ref => {
      const file = files.find(candidate => candidate.path === ref.path)
      if (!file || file.type === 'binary') return { ...ref, text: null }

      try {
        const range = ref.from && ref.to ? { from: ref.from, to: ref.to } : undefined
        const { lines } = await handle.readFile(ref.path, range)
        return { ...ref, text: lines.join('\n') }
      } catch {
        return { ...ref, text: null }
      }
    })
  )
}
