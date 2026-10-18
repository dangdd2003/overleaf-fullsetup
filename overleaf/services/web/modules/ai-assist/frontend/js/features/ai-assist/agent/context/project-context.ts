import { renderAttachments } from './attachments'
import { escapeAttribute, neutraliseClosingTags } from './escape'
import {
  Attachment,
  ContextSnapshot,
  EnvelopeState,
  PdfAreaContext,
  PdfViewerSnapshot,
  fingerprintFiles,
} from './types'

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

const MAX_EXPLICIT_FILES = 50

/** The local date as "2026-09-24 (Thursday)". */
export function formatToday(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  const weekday = now.toLocaleDateString('en-US', { weekday: 'long' })
  return `${now.getFullYear()}-${month}-${day} (${weekday})`
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

  const open = snapshot.rootDocPath
    ? `<files root="${escapeAttribute(snapshot.rootDocPath)}" tex="${tex}" bib="${bib}" other="${other}">`
    : `<files tex="${tex}" bib="${bib}" other="${other}">`

  // For small projects (<= 50 files), list explicit file paths so the model knows what files exist
  if (snapshot.files.length <= MAX_EXPLICIT_FILES) {
    const rows = snapshot.files
      .map(file => {
        const safePath = neutraliseClosingTags(file.path)
        const tag = file.type === 'binary' ? 'binary' : file.path.endsWith('.tex') ? 'tex' : file.path.endsWith('.bib') ? 'bib' : 'doc'
        return `${safePath} [${tag}]`
      })
    return {
      text: [open, ...rows, '</files>'].join('\n'),
      fingerprint,
    }
  }

  // Fallback for large projects (> 50 files): aggregate by top-level directory
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
  const detail = errorCount > 0 ? ' (call get_compile_result for detail)' : ''
  return `<compile>${status} - ${counts}${detail}</compile>`
}

/** "3", or "3-4" for a run of consecutive pages, "" when there are none. */
export function formatPageRanges(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b)
  if (sorted.length === 0) return ''
  const ranges: string[] = []
  let start = sorted[0]
  let end = sorted[0]
  for (const page of sorted.slice(1)) {
    if (page === end + 1) {
      end = page
      continue
    }
    ranges.push(start === end ? `${start}` : `${start}-${end}`)
    start = end = page
  }
  ranges.push(start === end ? `${start}` : `${start}-${end}`)
  return ranges.join(',')
}

function pdfViewerFingerprint(view: PdfViewerSnapshot): string {
  return [view.buildId ?? '', view.pages.join(','), view.zoom, view.darkMode ? 'dark' : 'light'].join('|')
}

/**
 * The viewer line. Delta-encoded like the file listing: the same viewer as the
 * turn before is one short line, so an unchanged view costs no tokens and the
 * model still knows which turn it last saw in full.
 */
function renderPdfViewer(
  view: PdfViewerSnapshot | null | undefined,
  previous: EnvelopeState | null
): { text: string; fingerprint: string } | null {
  if (!view) return null
  const fingerprint = pdfViewerFingerprint(view)
  if (previous?.pdfViewerFingerprint === fingerprint) {
    return {
      text: `<pdf-viewer>unchanged since turn ${previous.turn}</pdf-viewer>`,
      fingerprint,
    }
  }
  const attributes = [
    view.buildId ? `build="${escapeAttribute(view.buildId)}"` : null,
    `pages="${formatPageRanges(view.pages)}"`,
    `zoom="${escapeAttribute(view.zoom)}"`,
    `dark-mode="${view.darkMode ? 'on' : 'off'}"`,
  ].filter(Boolean)
  return { text: `<pdf-viewer ${attributes.join(' ')} />`, fingerprint }
}

/**
 * A box the user drew. Its crop travels as an image on the message, never
 * in this text: `image` names which image on the message it is (1-based), or
 * says it is unavailable, and `path` and `line` appear only when synctex
 * resolved the box to source.
 */
function renderPdfArea(area: PdfAreaContext): string {
  const { rect, source } = area
  const box = `x="${rect.x.toFixed(2)}" y="${rect.y.toFixed(2)}" w="${rect.w.toFixed(2)}" h="${rect.h.toFixed(2)}"`
  const image = !area.image
    ? 'unavailable'
    : area.imageIndex
      ? String(area.imageIndex)
      : 'attached'
  const location = source
    ? ` path="${escapeAttribute(source.path)}" line="${source.line}" endLine="${source.endLine}"`
    : ''
  return `<pdf-area page="${area.page}" ${box} image="${image}"${location} />`
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
  const sections: string[] = []
  if (snapshot.today) sections.push(`<date>${escapeAttribute(snapshot.today)}</date>`)
  if (snapshot.mode) sections.push(`<mode>${escapeAttribute(snapshot.mode)}</mode>`)
  sections.push(files.text)
  if (outline) sections.push(outline.text)
  sections.push(renderCompile(snapshot))
  const pdfViewer = renderPdfViewer(snapshot.pdfViewer, previous)
  if (pdfViewer) sections.push(pdfViewer.text)

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
    const { path, from, to, text, ranges } = snapshot.selection
    if (ranges && ranges.length > 1) {
      for (const r of ranges) {
        sections.push(
          `<selection file="${escapeAttribute(path)}" lines="${r.from}-${r.to}">`,
          neutraliseClosingTags(r.text),
          '</selection>'
        )
      }
    } else {
      sections.push(
        `<selection file="${escapeAttribute(path)}" lines="${from}-${to}">`,
        neutraliseClosingTags(text),
        '</selection>'
      )
    }
  }

  for (const selection of snapshot.pdfSelections ?? []) {
    if (!selection.text) continue
    sections.push(
      `<pdf-selection page="${selection.page}">`,
      neutraliseClosingTags(selection.text),
      '</pdf-selection>'
    )
  }
  for (const area of snapshot.pdfAreas ?? []) {
    sections.push(renderPdfArea(area))
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
      ...(pdfViewer ? { pdfViewerFingerprint: pdfViewer.fingerprint } : {}),
    },
  }
}
