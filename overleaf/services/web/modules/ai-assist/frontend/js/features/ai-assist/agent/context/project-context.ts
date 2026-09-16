import { renderAttachments } from './attachments'
import { escapeAttribute, neutraliseClosingTags } from './escape'
import {
  Attachment,
  ContextSnapshot,
  EnvelopeState,
  fingerprintFiles,
} from './types'

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function renderFiles(snapshot: ContextSnapshot, previous: EnvelopeState | null) {
  const fingerprint = fingerprintFiles(snapshot.files)

  if (previous && previous.filesFingerprint === fingerprint) {
    return {
      text: `<files>unchanged since turn ${previous.turn}</files>`,
      fingerprint,
    }
  }

  const docs = snapshot.files.filter(file => file.type === 'doc')
  const tex = docs.filter(file => file.path.endsWith('.tex')).length
  const bib = docs.filter(file => file.path.endsWith('.bib')).length
  const other = snapshot.files.length - tex - bib

  const dirs = new Map<string, { tex: number; other: number }>()
  for (const file of snapshot.files) {
    const slash = file.path.indexOf('/')
    const top = slash === -1 ? null : file.path.slice(0, slash + 1)
    if (!top) continue
    const entry = dirs.get(top) ?? { tex: 0, other: 0 }
    if (file.type === 'doc' && file.path.endsWith('.tex')) entry.tex += 1
    else entry.other += 1
    dirs.set(top, entry)
  }

  const rows = [...dirs.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([dir, counts]) => {
      const parts = [
        counts.tex ? `${counts.tex} tex` : null,
        counts.other ? `${counts.other} other` : null,
      ].filter(Boolean)
      return `${neutraliseClosingTags(dir)}  ${parts.join(', ')}`
    })

  const open = snapshot.rootDocPath
    ? `<files root="${escapeAttribute(snapshot.rootDocPath)}" tex="${tex}" bib="${bib}" other="${other}">`
    : `<files tex="${tex}" bib="${bib}" other="${other}">`

  return {
    text: [open, ...rows, '</files>'].join('\n'),
    fingerprint,
  }
}

const MAX_OUTLINE_SECTIONS = 40

function renderOutline(snapshot: ContextSnapshot, previous: EnvelopeState | null) {
  const sections = snapshot.outline?.sections ?? []
  if (sections.length === 0) return null

  const fingerprint = sections
    .map(s => `${s.path}:${s.line}:${s.level}:${s.title}`)
    .join('|')

  if (previous?.outlineFingerprint === fingerprint) {
    return {
      text: `<outline>unchanged since turn ${previous.turn}</outline>`,
      fingerprint,
    }
  }

  const shown = sections.slice(0, MAX_OUTLINE_SECTIONS)
  const overflow = sections.length - shown.length
  const lines = shown.map(
    s =>
      `${'  '.repeat(Math.max(0, s.level - 1))}${neutraliseClosingTags(s.path)}:${s.line} ${neutraliseClosingTags(s.title)}`
  )
  if (overflow > 0) {
    lines.push(`  (+${overflow} more sections)`)
  }

  return {
    text: ['<outline>', ...lines, '</outline>'].join('\n'),
    fingerprint,
  }
}

function renderCompile(snapshot: ContextSnapshot) {
  if (!snapshot.compile) return '<compile>not compiled yet</compile>'
  const { status, errorCount, warningCount } = snapshot.compile
  const counts = `${plural(errorCount, 'error')}, ${plural(warningCount, 'warning')}`
  const pointer = errorCount > 0 ? ' (call get_compile_result for detail)' : ''
  return `<compile>${status} - ${counts}${pointer}</compile>`
}

/**
 * Renders the block that is prefixed onto a user message and then frozen.
 *
 * It is rendered once, at send time, and never re-derived: re-deriving it from
 * a later snapshot would produce different bytes for the same historical turn
 * and break the prefix cache this whole design exists to keep.
 */
export function renderEnvelope({
  snapshot,
  attachments,
  turn,
  previous,
}: {
  snapshot: ContextSnapshot
  attachments: Attachment[]
  turn: number
  previous: EnvelopeState | null
}): { text: string; state: EnvelopeState } {
  const files = renderFiles(snapshot, previous)
  const outline = renderOutline(snapshot, previous)

  // Stable first, volatile last, so the selection and attachments end up
  // adjacent to the user's own words.
  const sections: string[] = [files.text]
  if (outline) sections.push(outline.text)
  sections.push(renderCompile(snapshot))

  if (snapshot.openFile) {
    const { path, cursorLine } = snapshot.openFile
    const safePath = neutraliseClosingTags(path)
    sections.push(
      cursorLine === null
        ? `<open-file>${safePath}</open-file>`
        : `<open-file>${safePath}, cursor line ${cursorLine}</open-file>`
    )
  }

  if (snapshot.selection) {
    const { path, from, to, text } = snapshot.selection
    sections.push(
      `<selection file="${escapeAttribute(path)}" lines="${from}-${to}">`,
      neutraliseClosingTags(text),
      '</selection>'
    )
  }

  const rendered = renderAttachments(attachments)
  if (rendered) sections.push(rendered)

  return {
    text: [
      `<project-context turn="${turn}">`,
      ...sections,
      '</project-context>',
    ].join('\n'),
    state: {
      turn,
      filesFingerprint: files.fingerprint,
      ...(outline ? { outlineFingerprint: outline.fingerprint } : {}),
    },
  }
}
