import { escapeAttribute, neutraliseClosingTags } from '../context/escape'
import { renderCompileEntry } from '../context/compile-error'
import {
  PREAMBLE_MAX_LINES,
  numbered,
  renderPreamble,
  renderSourceWindow,
  windowFor,
} from '../context/fix-source'
import { LogEntrySummary, ProjectHandle } from '../project-handle'
import { getPackagesTool } from '../tools/get-packages'
import { SlashCommandDefinition, SlashCommandGatherer } from './types'

/**
 * The context a slash command reads at send time and freezes into its block.
 *
 * The point is to spare the model the tool round trips it would spend finding
 * the same things: the compile errors, the preamble, the section being edited,
 * the outline, the project's macros.
 * Each gatherer is best-effort. A failure leaves its block out and never the
 * turn, and every one is capped, because the block is paid for on every turn
 * the conversation carries it, and a large paper would otherwise bury the
 * request in context.
 *
 * Deterministic for the same project state: same lists, same order, same
 * truncation points, so rebuilding the block from the same state gives the
 * same bytes.
 */

/** Compile entries whose source windows are included; the rest are counted. */
const MAX_LOG_ENTRIES = 6
/** Lines of the window around the cursor or selection. */
const MAX_WINDOW_LINES = 40
/** Sections listed in the outline block. */
const MAX_OUTLINE_SECTIONS = 80
/** Macro definitions listed; a style file can define hundreds. */
const MAX_MACROS = 60
/** Files scanned for macro definitions. */
const MAX_MACRO_FILES = 40
/** Lines of the section around the cursor. Longer sections are cut and say so. */
const MAX_SECTION_LINES = 120
/** Names listed per group in the labels block before the rest are counted. */
const MAX_LABEL_NAMES = 40
/** Keys listed in the bib block; a bibliography can run to thousands. */
const MAX_BIB_KEYS = 100
/** Lines of get_packages output kept; a package list rarely needs more. */
const MAX_PACKAGE_LINES = 60

/** The selection as the handle reports it: 1-based inclusive line range. */
type GatherSelection = {
  path: string
  from: number
  to: number
  text: string
} | null

type Gatherer = (
  handle: ProjectHandle,
  selection: GatherSelection
) => Promise<string | null>

/**
 * One rendered block per gatherer that produced something, in the command's
 * own order. A gatherer that found nothing, failed, or was not applicable
 * contributes nothing.
 */
export async function gatherSlashContext({
  handle,
  command,
  selection,
}: {
  handle: ProjectHandle
  command: SlashCommandDefinition
  selection: GatherSelection
}): Promise<string[]> {
  const blocks = await Promise.all(
    command.gather.map(name => runGatherer(name, handle, selection))
  )
  return blocks.filter((block): block is string => block !== null)
}

async function runGatherer(
  name: SlashCommandGatherer,
  handle: ProjectHandle,
  selection: GatherSelection
): Promise<string | null> {
  try {
    return await GATHERERS[name](handle, selection)
  } catch {
    return null
  }
}

const GATHERERS: Record<SlashCommandGatherer, Gatherer> = {
  compileErrors,
  layoutWarnings,
  preamble,
  currentSection,
  cursorWindow,
  outline,
  bibKeys,
  labels,
  packages,
  macros,
}

function wrap(tag: string, body: string): string {
  return [`<${tag}>`, body, `</${tag}>`].join('\n')
}

/**
 * The source around a line, numbered, or null when there is nothing to show.
 * Used for one-off windows; a missing or unreadable file is not an error here.
 */
async function sourceWindow(
  handle: ProjectHandle,
  path: string,
  line: number
): Promise<string | null> {
  const range = windowFor(line)
  try {
    const { lines } = await handle.readFile(path, range)
    return renderSourceWindow({ path, from: range.from, lines, caret: line }) || null
  } catch {
    return null
  }
}

type LogEntry = { level: string; entry: LogEntrySummary }

/**
 * Compile entries with the source each points at, after one line that places
 * every entry, so the model can tell a root cause from its cascade.
 */
async function renderLogEntries(
  handle: ProjectHandle,
  tag: string,
  entries: LogEntry[],
  omittedNote: (count: number) => string,
  trailer: string | null = null
): Promise<string | null> {
  if (entries.length === 0) return null
  const locations = entries.map(({ entry }) =>
    entry.file ? (entry.line === null ? entry.file : `${entry.file}:${entry.line}`) : '?'
  )
  const blocks = [
    `${entries.length} in all: ${listed(locations, MAX_LABEL_NAMES)}`,
  ]
  const shown = entries.slice(0, MAX_LOG_ENTRIES)
  const windows = await Promise.all(
    shown.map(({ entry }) =>
      entry.file && entry.line !== null
        ? sourceWindow(handle, entry.file, entry.line)
        : Promise.resolve(null)
    )
  )
  for (let i = 0; i < shown.length; i++) {
    const { level, entry } = shown[i]
    blocks.push(
      renderCompileEntry({
        level,
        message: entry.message,
        raw: entry.excerpt ?? null,
        file: entry.file,
        line: entry.line,
      })
    )
    const block = windows[i]
    if (block) blocks.push(block)
  }

  const omitted = entries.length - MAX_LOG_ENTRIES
  if (omitted > 0) blocks.push(omittedNote(omitted))
  if (trailer) blocks.push(trailer)
  return wrap(tag, blocks.join('\n'))
}

/** The errors of the last compile. Warnings are only counted: /fix leaves them. */
async function compileErrors(handle: ProjectHandle): Promise<string | null> {
  const last = handle.lastCompile()
  if (!last || last.errors.length === 0) return null
  const trailer =
    last.warnings.length > 0
      ? `(${last.warnings.length} warnings not shown)`
      : null
  return renderLogEntries(
    handle,
    'compile-errors',
    last.errors.map(entry => ({ level: 'error', entry })),
    count => `(${count} more errors not shown; get_compile_result lists them all)`,
    trailer
  )
}

const LAYOUT_WARNING =
  /overfull|underfull|float too large|float specifier changed|contains only floats|unprocessed floats/i

/** Box, float and page warnings of the last compile. */
async function layoutWarnings(handle: ProjectHandle): Promise<string | null> {
  const last = handle.lastCompile()
  if (!last) return null
  return renderLogEntries(
    handle,
    'layout-warnings',
    [...last.errors, ...last.warnings]
      .filter(entry => LAYOUT_WARNING.test(entry.message))
      .map(entry => ({ level: 'warning', entry })),
    count =>
      `(${count} more layout warnings not shown; get_compile_result lists them all)`
  )
}

async function preamble(handle: ProjectHandle): Promise<string | null> {
  const rootPath = handle.rootDocPath()
  if (!rootPath) return null
  const { lines } = await handle.readFile(rootPath, {
    from: 1,
    to: PREAMBLE_MAX_LINES,
  })
  return renderPreamble({ path: rootPath, lines }) || null
}

/**
 * The section holding the selection, or else the cursor line. The section is
 * the nearest heading at or above that line, and it runs to the next heading
 * of the same or a higher level, as get_outline reads it. Skipped when the
 * selection already covers the whole of it, since the model has that text.
 */
async function currentSection(
  handle: ProjectHandle,
  selection: GatherSelection
): Promise<string | null> {
  const target = selection
    ? { path: selection.path.replace(/^\//, ''), line: selection.from }
    : cursorTarget(handle)
  if (!target) return null

  const path = target.path
  const outline = (await handle.index()).outline
  const headings = outline.sections
    .filter(section => section.path === path)
    .sort((a, b) => a.line - b.line)
  const start = headings.filter(section => section.line <= target.line).at(-1)
  // A file with no heading above the target: the window around it instead
  if (!start) return cursorWindow(handle, selection)

  const next = headings.find(
    section => section.line > start.line && section.level <= start.level
  )
  const fileEntry = (await handle.listFiles()).find(file => file.path === path)
  const lastLine = next ? next.line - 1 : (fileEntry?.lines ?? null)
  if (lastLine === null) return null
  if (lastLine < start.line) return null

  if (
    selection &&
    selection.from <= start.line &&
    selection.to >= lastLine
  ) {
    return null
  }

  const to = Math.min(lastLine, start.line + MAX_SECTION_LINES - 1)
  const { lines } = await handle.readFile(path, { from: start.line, to })
  if (lines.length === 0) return null

  const entry =
    target.line >= start.line && target.line <= to
      ? ` entry-line="${target.line}"`
      : ''
  const body = [
    `<section path="${escapeAttribute(path)}" lines="${start.line}-${to}"${entry}>`,
    numbered(lines, start.line),
    '</section>',
  ]
  if (to < lastLine) {
    body.push(`(section continues past line ${to}; read_file for the rest)`)
  }
  return body.join('\n')
}

function cursorTarget(
  handle: ProjectHandle
): { path: string; line: number } | null {
  const open = handle.openFile()
  if (!open?.path || open.cursorLine === null) return null
  return { path: open.path.replace(/^\//, ''), line: open.cursorLine }
}

/**
 * The numbered lines around the selection, or else the cursor line: where an
 * insert command puts its result and the text it takes it from.
 */
async function cursorWindow(
  handle: ProjectHandle,
  selection: GatherSelection
): Promise<string | null> {
  const target = selection
    ? {
        path: selection.path.replace(/^\//, ''),
        line: selection.from,
        to: selection.to,
      }
    : cursorTarget(handle)
  if (!target) return null
  const path = target.path
  const around = windowFor(target.line)
  const end = 'to' in target ? Math.max(around.to, target.to + 6) : around.to
  const range = {
    from: around.from,
    to: Math.min(end, around.from + MAX_WINDOW_LINES - 1),
  }
  const { lines } = await handle.readFile(path, range)
  return (
    renderSourceWindow({ path, from: range.from, lines, caret: target.line }) ||
    null
  )
}

/**
 * The section tree, one line per heading with its file and line range, so a
 * command can read_file a section without asking get_outline first.
 */
async function outline(handle: ProjectHandle): Promise<string | null> {
  const { outline } = await handle.index()
  if (outline.sections.length === 0) return null
  const fileLines = new Map(
    (await handle.listFiles()).map(file => [file.path, file.lines])
  )

  const lines = [`documentclass: ${outline.documentClass ?? 'unknown'}`]
  const shown = outline.sections.slice(0, MAX_OUTLINE_SECTIONS)
  for (const section of shown) {
    const next = outline.sections.find(
      other =>
        other.path === section.path &&
        other.line > section.line &&
        other.level <= section.level
    )
    const end = next ? next.line - 1 : fileLines.get(section.path)
    const range = end ? `${section.line}-${end}` : `${section.line}`
    lines.push(
      `${'  '.repeat(Math.max(0, section.level))}${section.path}:${range} ${section.title}`
    )
  }
  if (outline.sections.length > shown.length) {
    lines.push(`+${outline.sections.length - shown.length} more sections; get_outline lists them`)
  }
  return wrap('outline', neutraliseClosingTags(lines.join('\n')))
}

async function bibKeys(handle: ProjectHandle): Promise<string | null> {
  const index = await handle.index()
  const { bibKeys: defined, citations } = index.references
  if (defined.length === 0 && citations.length === 0) return null

  const citedCount = new Map<string, number>()
  for (const use of citations) {
    citedCount.set(use.key, (citedCount.get(use.key) ?? 0) + 1)
  }

  const lines = [
    `${defined.length} defined, ${citedCount.size} distinct keys cited`,
  ]
  for (const entry of defined.slice(0, MAX_BIB_KEYS)) {
    const uses = citedCount.get(entry.key) ?? 0
    lines.push(
      `${entry.key}  ${entry.path}:${entry.line}  ${uses ? `cited ${uses}x` : 'uncited'}`
    )
  }
  if (defined.length > MAX_BIB_KEYS) {
    lines.push(`+${defined.length - MAX_BIB_KEYS} more keys not listed`)
  }

  // A document that hand-rolls its bibliography needs no .bib, so keys it
  // cites are not missing there.
  if (!index.hasThebibliography) {
    const definedKeys = new Set(defined.map(entry => entry.key))
    const missing = [
      ...new Set(
        citations
          .filter(use => !definedKeys.has(use.key))
          .map(use => use.key)
      ),
    ]
    if (missing.length > 0) {
      lines.push(`cited but not defined: ${listed(missing, MAX_LABEL_NAMES)}`)
    }
  }

  return wrap('bib-keys', neutraliseClosingTags(lines.join('\n')))
}

async function labels(handle: ProjectHandle): Promise<string | null> {
  const { labels: defined, refs, duplicateLabels } =
    (await handle.index()).references
  if (defined.length === 0 && refs.length === 0) return null

  const referenced = new Set(refs.map(use => use.key))
  const undefinedRefs = refs.filter(use => !use.resolved)
  const unused = defined
    .map(label => label.key)
    .filter(key => !referenced.has(key))
  const unique = [...new Set(defined.map(label => label.key))]

  const lines = [
    `defined (${unique.length}): ${listed(unique, MAX_LABEL_NAMES)}`,
    `${refs.length} references, ${undefinedRefs.length} undefined, ${unused.length} unused`,
  ]
  if (undefinedRefs.length > 0) {
    const shown = undefinedRefs
      .slice(0, MAX_LABEL_NAMES)
      .map(use => `\\${use.command}{${use.key}} ${use.path}:${use.line}`)
    lines.push('undefined:', ...shown)
    if (undefinedRefs.length > shown.length) {
      lines.push(`+${undefinedRefs.length - shown.length} more undefined`)
    }
  }
  if (unused.length > 0) {
    lines.push(`unused: ${listed(unused, MAX_LABEL_NAMES)}`)
  }
  if (duplicateLabels.length > 0) {
    lines.push(`duplicate: ${listed(duplicateLabels, MAX_LABEL_NAMES)}`)
  }

  return wrap('labels', neutraliseClosingTags(lines.join('\n')))
}

async function packages(handle: ProjectHandle): Promise<string | null> {
  const result = await getPackagesTool.execute({}, handle)
  const text = getPackagesTool.render?.(result) ?? ''
  if (!text) return null

  const lines = text.split('\n')
  const shown = lines.slice(0, MAX_PACKAGE_LINES)
  if (lines.length > shown.length) {
    shown.push(`+${lines.length - shown.length} more lines not shown`)
  }
  return wrap('packages', neutraliseClosingTags(shown.join('\n')))
}

const MACRO_DEFINITION =
  /\\(?:(?:re)?newcommand\*?|providecommand\*?|DeclareMathOperator\*?|DeclarePairedDelimiter|NewDocumentCommand|newacronym|def)\s*\{?\\?[A-Za-z@]+/

/**
 * Macro and acronym definitions across the project's .tex, .sty and .cls
 * files, one line each, so notation is reused instead of reinvented.
 */
async function macros(handle: ProjectHandle): Promise<string | null> {
  const files = (await handle.listFiles())
    .filter(file => file.type === 'doc' && /\.(tex|sty|cls)$/i.test(file.path))
    .slice(0, MAX_MACRO_FILES)

  const fileContents = await Promise.all(
    files.map(async file => {
      try {
        const { lines } = await handle.readFile(file.path)
        return { file, lines }
      } catch {
        return null
      }
    })
  )

  const found: string[] = []
  let total = 0
  for (const item of fileContents) {
    if (!item) continue
    const { file, lines } = item
    lines.forEach((text, index) => {
      const code = text.replace(/(?<!\\)%.*$/, '').trim()
      if (!MACRO_DEFINITION.test(code)) return
      total += 1
      if (found.length < MAX_MACROS) {
        found.push(`${file.path}:${index + 1}: ${code.slice(0, 160)}`)
      }
    })
  }
  if (found.length === 0) return null
  if (total > found.length) {
    found.push(`+${total - found.length} more definitions not listed`)
  }
  return wrap('macros', neutraliseClosingTags(found.join('\n')))
}

/** Comma-separated names, cut after `max` with the count of the rest. */
function listed(names: string[], max: number): string {
  const shown = names.slice(0, max).join(', ')
  return names.length > max ? `${shown}, +${names.length - max} more` : shown
}
