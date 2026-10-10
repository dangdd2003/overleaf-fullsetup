import { stripFences, withoutReasoning } from '../writing-tools/parse-output'
import { matchingBrace } from '../texgpt/latex-text'
import { notesIn, packagesIn, tagSection } from '../generator/reply'
import { findTabulars } from './columns'

export type ParsedTable =
  | {
      kind: 'table'
      /** As written; null when missing. The harness coerces it. */
      env: string | null
      spec: string | null
      label: string | null
      wide: boolean
      float: boolean
      caption: string | null
      /** The rows so far. */
      body: string
      bodyComplete: boolean
      packages: string[]
      notes: string | null
      /** False when the reply was read from raw LaTeX instead of the tags. */
      tagged: boolean
      complete: boolean
    }
  | { kind: 'cannot'; reason: string; complete: boolean }

type TableReply = Extract<ParsedTable, { kind: 'table' }>

/** Up to three lines of notes. */
const MAX_NOTES = 600
const TABLE_OPEN = /<table\b([^>]*)>/
const FENCE = /```[a-zA-Z]*[ \t]*\n([\s\S]*?)\n?```/

function attribute(attributes: string, name: string): string | null {
  return new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(attributes)?.[1] ?? null
}

function cleanLabel(label: string | null): string | null {
  return (label ?? '').replace(/[^A-Za-z0-9:_.\-]/g, '') || null
}

/** The argument of the first `\name{…}`, an optional `[…]` skipped. */
function commandArgument(text: string, name: string): string | null {
  const match = new RegExp(`\\\\${name}\\s*(?:\\[[^\\]]*\\]\\s*)?\\{`).exec(text)
  if (!match) return null
  const open = match.index + match[0].length - 1
  const close = matchingBrace(text, open)
  return close === -1 ? null : text.slice(open + 1, close).trim() || null
}

/** A model that ignored the format: its first tabular, and the caption and label around it. */
function fallbackOf(raw: string) {
  const text = FENCE.exec(raw)?.[1] ?? raw
  const [tabular] = findTabulars(text)
  if (!tabular) return null
  return {
    env: tabular.env,
    spec: tabular.spec,
    body: tabular.body.trim(),
    caption: commandArgument(text, 'caption'),
    label: cleanLabel(commandArgument(text, 'label')),
  }
}

/**
 * Reads a table reply, complete or still streaming. The contract is
 * `<table env spec label wide float>` holding `<caption>` and `<body>`, then
 * optional `<packages>` and `<notes>`; or `<cannot>`.
 */
export function parseTableReply(reply: string, done: boolean): ParsedTable {
  const empty: TableReply = {
    kind: 'table',
    env: null,
    spec: null,
    label: null,
    wide: false,
    float: true,
    caption: null,
    body: '',
    bodyComplete: false,
    packages: [],
    notes: null,
    tagged: true,
    complete: done,
  }
  const raw = withoutReasoning(reply, done)
  if (raw === null) return { ...empty, complete: false }

  const open = TABLE_OPEN.exec(raw)
  const cannotAt = raw.indexOf('<cannot>')
  if (cannotAt !== -1 && (!open || cannotAt < open.index)) {
    const { body, closed } = tagSection(raw, cannotAt, '<cannot>'.length, '</cannot>', done)
    return { kind: 'cannot', reason: body.trim(), complete: done || closed }
  }
  if (!open) {
    const fallback = done ? fallbackOf(raw) : null
    if (!fallback) return empty
    return {
      ...empty,
      ...fallback,
      bodyComplete: true,
      tagged: false,
      packages: packagesIn(raw),
      notes: notesIn(raw, MAX_NOTES),
    }
  }

  const attributes = open[1]
  let caption: string | null = null
  const captionAt = raw.indexOf('<caption>', open.index)
  if (captionAt !== -1) {
    const found = tagSection(raw, captionAt, '<caption>'.length, '</caption>', done)
    if (found.closed || done) caption = found.body.trim() || null
  }
  let body = ''
  let bodyComplete = done
  const bodyAt = raw.indexOf('<body>', open.index)
  if (bodyAt !== -1) {
    const found = tagSection(raw, bodyAt, '<body>'.length, '</body>', done)
    body = stripFences(found.body).replace(/^\s*\n/, '')
    bodyComplete = done || found.closed
  }

  return {
    kind: 'table',
    env: attribute(attributes, 'env')?.trim() || null,
    spec: attribute(attributes, 'spec')?.replace(/\s*\n\s*/g, ' ').trim() || null,
    label: cleanLabel(attribute(attributes, 'label')),
    wide: attribute(attributes, 'wide')?.trim() === 'true',
    float: attribute(attributes, 'float')?.trim() !== 'false',
    caption,
    body: bodyComplete ? body.trim() : body,
    bodyComplete,
    packages: packagesIn(raw),
    notes: notesIn(raw, MAX_NOTES),
    tagged: true,
    complete: done,
  }
}
