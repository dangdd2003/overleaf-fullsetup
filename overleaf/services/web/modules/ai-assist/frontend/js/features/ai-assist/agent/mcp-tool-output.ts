import { hostOf } from './web-sources'

/**
 * Connector tools (`mcp__<server>__<tool>`) and the reader that pages through
 * their long results. The backend is ConnectorRuntime: a result is
 * `{ result, isError }` or `{ error }`, and a long one starts with a
 * `[Result rN: 12,345 characters]` header and ends with a page trailer.
 */

export const READ_CONNECTOR_RESULT = 'read_connector_result'
export const SEARCH_CONNECTOR_TOOLS = 'search_connector_tools'

export function isMcpToolName(name: unknown): name is string {
  return typeof name === 'string' && name.startsWith('mcp__')
}

/** A tool that belongs to a connector, or the reader for their long results. */
export function isConnectorToolName(name: unknown): boolean {
  return (
    isMcpToolName(name) ||
    name === READ_CONNECTOR_RESULT ||
    name === SEARCH_CONNECTOR_TOOLS
  )
}

/** The server segment of `mcp__<server>__<tool>`, sanitised as the backend names it. */
export function mcpServerSegment(name: string): string {
  return name.split('__')[1] ?? ''
}

/** `my_server-x` reads as `My Server X`. */
export function humanizeServer(segment: string): string {
  return segment
    .split(/[_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/** The same sanitising ConnectorRuntime applies to a connector's name. */
export function sanitizeIdentifier(text: string): string {
  return text
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32)
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const ARG_SUMMARY_KEYS = [
  'query',
  'message',
  'channel',
  'repo',
  'url',
  'path',
  'title',
  'search',
  'text',
] as const

/**
 * The quiet line after a connector call's name: the first string argument
 * that says what the call is about. A URL shows as its host.
 */
export function mcpArgSummary(args: unknown): string | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined
  const record = args as Record<string, unknown>
  for (const key of ARG_SUMMARY_KEYS) {
    const value = record[key]
    if (typeof value !== 'string' || !value.trim()) continue
    if (key === 'url') return clip(hostOf(value.trim()) || value, 30)
    return clip(value, 40)
  }
  return undefined
}

export type ConnectorPage = {
  page: number
  pages: number
  /** Whether the assistant can call read_connector_result for the next page */
  more: boolean
}

const RESULT_HEADER = /^\[Result (r\d+): ([\d,]+) characters\]\r?\n\r?\n/
const PAGE_TRAILER =
  /\r?\n\r?\n\[Page (\d+) of (\d+) of result ([^\s\]]+?)(\. Call [^\]]*|: the end\.)\]\s*$/

export type SplitConnectorText = {
  body: string
  resultId?: string
  /** The character count the header reports, without its separators */
  chars?: number
  page?: ConnectorPage
}

/** Takes the paging header and trailer off a connector's text. */
export function splitConnectorText(text: string): SplitConnectorText {
  let body = text
  let resultId: string | undefined
  let chars: number | undefined
  let page: ConnectorPage | undefined

  const header = RESULT_HEADER.exec(body)
  if (header) {
    resultId = header[1]
    chars = Number(header[2].replace(/,/g, ''))
    body = body.slice(header[0].length)
  }

  const trailer = PAGE_TRAILER.exec(body)
  if (trailer) {
    page = {
      page: Number(trailer[1]),
      pages: Number(trailer[2]),
      more: trailer[4].startsWith('. Call'),
    }
    resultId = resultId ?? trailer[3]
    body = body.slice(0, trailer.index)
  }

  return { body, resultId, chars, page }
}

export type OutputSegment =
  | { kind: 'text'; text: string }
  | { kind: 'image'; mime: string }

const IMAGE_LINE = /^\[Image: ([^\]]*)\]$/

/** Text in order, with each `[Image: mime]` line as a segment of its own. */
export function outputSegments(body: string): OutputSegment[] {
  const segments: OutputSegment[] = []
  let buffer: string[] = []
  const flush = () => {
    if (buffer.some((line) => line.trim())) {
      segments.push({ kind: 'text', text: buffer.join('\n') })
    }
    buffer = []
  }
  for (const line of body.split('\n')) {
    const image = IMAGE_LINE.exec(line.trim())
    if (image) {
      flush()
      segments.push({ kind: 'image', mime: image[1] })
    } else {
      buffer.push(line)
    }
  }
  flush()
  return segments
}

/** The text as JSON, when it is a JSON object or array. */
export function parseJsonOutput(body: string): unknown {
  const trimmed = body.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined
  try {
    const value = JSON.parse(trimmed)
    return value && typeof value === 'object' ? value : undefined
  } catch {
    return undefined
  }
}

export type ConnectorOutcome = {
  /** The text the connector returned, with the paging taken off */
  body: string
  /** The raw text as it came back, for copying */
  raw: string
  /** Set when the tool failed; the message is `error` or the raw text */
  error?: string
  isError: boolean
  resultId?: string
  chars?: number
  page?: ConnectorPage
  /** The stored transcript cut this result short */
  truncated: boolean
  /** A note the harness added for the model, shown after the output */
  notice?: string
}

function parsePreview(preview: string): unknown {
  try {
    return JSON.parse(preview)
  } catch {
    return undefined
  }
}

/**
 * What a connector call returned, whichever shape it was stored in: the
 * `{ result, isError }` or `{ error }` the runtime gives, a bare string, or a
 * trimmed `{ truncated, preview }` from the saved history.
 */
export function connectorOutcome(
  result: unknown,
  callFailed = false
): ConnectorOutcome {
  let raw = ''
  let error: string | undefined
  let truncated = false
  let notice: string | undefined
  let isError = callFailed

  if (typeof result === 'string') {
    raw = result
  } else if (result && typeof result === 'object' && !Array.isArray(result)) {
    const record = result as Record<string, unknown>
    truncated = record.truncated === true
    if (typeof record.notice === 'string' && record.notice.trim()) {
      notice = record.notice.trim()
    }
    if (record.isError === true) isError = true
    if (typeof record.error === 'string') {
      error = record.error
      isError = true
    }

    if (typeof record.result === 'string') {
      raw = record.result
    } else if (typeof record.content === 'string') {
      raw = record.content
    } else if (typeof record.preview === 'string') {
      const parsed = parsePreview(record.preview) as
        | Record<string, unknown>
        | undefined
      raw =
        parsed && typeof parsed.result === 'string'
          ? parsed.result
          : record.preview
      truncated = true
    } else if (error === undefined) {
      const {
        notice: _notice,
        truncated: _truncated,
        isError: _isError,
        ...rest
      } = record
      if (Object.keys(rest).length > 0) raw = JSON.stringify(rest, null, 2)
    }
  } else if (result !== undefined && result !== null) {
    raw = JSON.stringify(result, null, 2)
  }

  if (isError && error === undefined) {
    // A failed call's text is its message
    return {
      body: raw,
      raw,
      error: raw,
      isError,
      truncated,
      notice,
    }
  }

  const split = splitConnectorText(raw)
  return {
    body: split.body,
    raw,
    error,
    isError,
    resultId: split.resultId,
    chars: split.chars,
    page: split.page,
    truncated,
    notice,
  }
}
