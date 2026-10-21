import { ToolCallRecord, TranscriptEntry } from './agent-messages'

/**
 * A web page the agent saw, under the number the server gave it. The model
 * cites it as [n], and the chat renders that as a link to the page.
 */
export type WebSource = {
  n: number
  url: string
  title?: string
  published?: string
}

export type WebSources = Map<number, WebSource>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function addSource(sources: WebSources, item: unknown) {
  if (!isRecord(item)) return
  const { source, url, title, published } = item
  if (typeof source !== 'number' || !Number.isInteger(source)) return
  if (typeof url !== 'string') return
  // Citations are links: only a plain http(s) page may become one
  if (!safeHttpHref(url)) return
  const known = sources.get(source)
  sources.set(source, {
    n: source,
    url: known?.url ?? url,
    title: known?.title || (typeof title === 'string' ? title : undefined),
    published:
      known?.published || (typeof published === 'string' ? published : undefined),
  })
}

function addCall(sources: WebSources, call: ToolCallRecord | undefined) {
  const result = call?.result
  if (!call || !isRecord(result)) return
  if (call.name === 'web_search' && Array.isArray(result.results)) {
    result.results.forEach((item: unknown) => addSource(sources, item))
  } else if (call.name === 'web_fetch') {
    addSource(sources, result)
  }
}

/**
 * Every numbered source in the conversation. The server keeps a number for
 * one page across turns, so a later reply can cite a page an earlier turn
 * found.
 */
export function collectWebSources(entries: TranscriptEntry[]): WebSources {
  const sources: WebSources = new Map()
  for (const entry of entries) {
    if (entry.role !== 'assistant') continue
    for (const call of entry.toolCalls ?? []) addCall(sources, call)
    for (const block of entry.blocks ?? []) {
      if (block?.type === 'tool_call') addCall(sources, block.call)
    }
  }
  return sources
}

export function hostOf(url: unknown): string {
  if (typeof url !== 'string') return ''
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/**
 * Returns the URL only when it is plain http(s). Model- and web-derived URLs
 * are rendered as links, and a `javascript:` or `data:` href must never reach
 * the DOM.
 */
export function safeHttpHref(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.toString()
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Where the site's icon is served from: Overleaf's own route, which finds the
 * icon server-side. Null for anything that is not an http(s) page.
 */
export function faviconUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    return `/ai-assist/favicon?origin=${encodeURIComponent(parsed.origin)}`
  } catch {
    return null
  }
}

/**
 * The name a site goes by, for a citation chip: "en.wikipedia.org" is
 * "wikipedia", "bbc.co.uk" is "bbc".
 */
export function siteName(url: unknown): string {
  const host = hostOf(url)
  const parts = host.split('.').filter(Boolean)
  if (parts.length < 2) return host
  const last = parts[parts.length - 1]
  const second = parts[parts.length - 2]
  const countryPair = last.length === 2 && second.length <= 3 && parts.length >= 3
  return countryPair ? parts[parts.length - 3] : second
}
