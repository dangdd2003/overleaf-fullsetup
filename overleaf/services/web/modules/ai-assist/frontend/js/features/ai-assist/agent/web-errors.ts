/**
 * Turns a failed web tool's error into something a person can read.
 *
 * The server words these errors for the model: a fetch that fails every route
 * says `Could not read <url>: websearchapi: HTTP 401 · ollama: HTTP 404 ·
 * browser-raw: the browser sidecar is unavailable · …`. That is accurate and
 * useless to the user, so the card shows a verdict, what to fix and, folded
 * away, what was tried. Parsed from the message, so chats saved before this
 * existed read the same way.
 */

export type AttemptKind =
  | 'blocked' // the site refused an automated reader
  | 'not_found' // the page is not there
  | 'rate_limited'
  | 'site_error' // the site's server failed
  | 'timeout'
  | 'no_text' // answered, but nothing readable (or a script-only page)
  | 'no_copy' // an archive has no saved copy
  | 'skipped' // not tried: it was refused a moment ago
  | 'service_down' // the browser sidecar is off
  | 'bad_key' // a reader or search provider rejected its credentials
  | 'bad_endpoint' // a provider URL that answers 404, i.e. wrong
  | 'quota' // a provider's limit or credit ran out
  | 'other'

export type Attempt = {
  route: string
  label: string
  kind: AttemptKind
  /** What happened, in a few words. */
  summary: string
  /** The raw reason, for the folded details. */
  raw: string
}

export type WebFailure = {
  /** The one-line verdict. */
  title: string
  /** One sentence on why, or what it means. */
  explanation: string
  /** Things the user can fix, most useful first. */
  fixes: string[]
  /** What was tried, empty when the error does not list routes. */
  attempts: Attempt[]
  /** The model-facing text, for the details. */
  raw: string
}

const ROUTE_LABELS: Record<string, string> = {
  direct: 'Direct request',
  'browser-raw': 'Browser (plain request)',
  'browser-render': 'Browser (full render)',
  wayback: 'Wayback Machine',
  'archive.today': 'archive.today',
  ollama: 'Ollama',
  websearchapi: 'WebSearchAPI.ai',
  tavily: 'Tavily',
  firecrawl: 'Firecrawl',
  firecrawlSelfHosted: 'Firecrawl (self-hosted)',
  jina: 'Jina Reader',
  exa: 'Exa',
}

const PAGE_ROUTES = new Set(['direct', 'browser-raw', 'browser-render'])
const ARCHIVE_ROUTES = new Set(['wayback', 'archive.today'])

function routeLabel(route: string) {
  return ROUTE_LABELS[route] ?? route
}

function isReader(route: string) {
  return !PAGE_ROUTES.has(route) && !ARCHIVE_ROUTES.has(route)
}

const SUMMARIES: Record<AttemptKind, string> = {
  blocked: 'Blocked by the site',
  not_found: 'Page not found',
  rate_limited: 'Rate limited',
  site_error: 'Site error',
  timeout: 'Timed out',
  no_text: 'No readable text',
  no_copy: 'No saved copy',
  skipped: 'Skipped (blocked a moment ago)',
  service_down: 'Browser service offline',
  bad_key: 'API key rejected',
  bad_endpoint: 'Endpoint not found',
  quota: 'Limit or credit used up',
  other: 'Failed',
}

function statusOf(reason: string): number | null {
  const m = /\bHTTP (\d{3})\b/.exec(reason)
  return m ? Number(m[1]) : null
}

function classify(route: string, reason: string): AttemptKind {
  const text = reason.toLowerCase()
  const status = statusOf(reason)
  if (text.includes('sidecar is unavailable')) return 'service_down'
  if (text.includes('skipped (recently blocked)')) return 'skipped'
  if (text.includes('timed out') || text.includes('out of time')) {
    return 'timeout'
  }
  if (
    text.includes('too little text') ||
    text.includes('metadata only') ||
    text.includes('bot check')
  ) {
    return text.includes('bot check') ? 'blocked' : 'no_text'
  }
  if (isReader(route)) {
    if (status === 401 || status === 403 || /api key/.test(text)) {
      return 'bad_key'
    }
    if (status === 402 || status === 429) return 'quota'
    if (status === 404) return 'bad_endpoint'
    if (status !== null && status >= 500) return 'site_error'
    if (text.includes('nothing found')) return 'no_text'
  }
  if (ARCHIVE_ROUTES.has(route) && /no archived copy|no .*copy|nothing found/.test(text)) {
    return 'no_copy'
  }
  if (status === 401 || status === 403 || status === 451) return 'blocked'
  if (status === 404 || status === 410) return 'not_found'
  if (status === 429) return 'rate_limited'
  if (status !== null && status >= 500) return 'site_error'
  if (text.includes('nothing found')) return 'no_text'
  return 'other'
}

/** `Could not read <url>: a: x · b: y.` as its routes, or null if it is not that. */
function parseAttempts(error: string): Attempt[] | null {
  const head = /^Could not read \S+?: (?=[\w.()-]+: )/.exec(error)
  if (!head) return null
  let body = error.slice(head[0].length)
  // The advice the server appends after the last route
  body = body.replace(/\.(\s+This page needs a real browser[\s\S]*)?$/, '')
  const attempts: Attempt[] = []
  for (const piece of body.split(' · ')) {
    const at = piece.indexOf(': ')
    if (at <= 0) continue
    const route = piece.slice(0, at).trim()
    const raw = piece.slice(at + 2).trim()
    const kind = classify(route, raw)
    attempts.push({ route, label: routeLabel(route), kind, summary: SUMMARIES[kind], raw })
  }
  return attempts.length > 0 ? attempts : null
}

function names(attempts: Attempt[]) {
  const list = attempts.map(a => a.label)
  if (list.length <= 1) return list.join('')
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`
}

function fixesFor(attempts: Attempt[]): string[] {
  const fixes: string[] = []
  const down = attempts.some(a => a.kind === 'service_down')
  const badKey = attempts.filter(a => a.kind === 'bad_key')
  const badEndpoint = attempts.filter(a => a.kind === 'bad_endpoint')
  const quota = attempts.filter(a => a.kind === 'quota')
  if (down) {
    fixes.push(
      'The browser service is not running, so pages that need JavaScript or pass a bot check cannot be read. Start it, or check that it is reachable.'
    )
  }
  if (badKey.length > 0) {
    fixes.push(`${names(badKey)} rejected the API key. Check or replace it in the AI assistant settings.`)
  }
  if (badEndpoint.length > 0) {
    fixes.push(`${names(badEndpoint)} answered "not found". Check its URL in the AI assistant settings.`)
  }
  if (quota.length > 0) {
    fixes.push(`${names(quota)} is out of requests or credit.`)
  }
  return fixes
}

function pageVerdict(attempts: Attempt[]): { title: string; explanation: string } | null {
  // Only the routes that talk to the page speak for the page itself; a reader
  // with a bad key or a browser that is off says nothing about it
  const page = attempts.filter(a => PAGE_ROUTES.has(a.route) && a.kind !== 'service_down')
  const has = (kind: AttemptKind) => page.some(a => a.kind === kind)
  if (has('not_found')) {
    return {
      title: 'This page doesn’t exist',
      explanation: 'The site answered that there is nothing at this address. The link may be old or mistyped.',
    }
  }
  if (has('blocked') || has('rate_limited')) {
    return {
      title: 'The site blocks automated readers',
      explanation: 'It refused the request, or asked for a bot check that could not be passed.',
    }
  }
  if (has('timeout')) {
    return {
      title: 'The site took too long to answer',
      explanation: 'It did not respond in time. It may be slow or down right now.',
    }
  }
  if (has('site_error')) {
    return {
      title: 'The site had a server error',
      explanation: 'It answered with an error of its own. Trying again later may work.',
    }
  }
  if (has('no_text')) {
    return {
      title: 'The page has no readable text',
      explanation: 'It loaded, but there was almost nothing to read, often because it is built with JavaScript.',
    }
  }
  return null
}

function fetchFailure(error: string, attempts: Attempt[]): WebFailure {
  const fixes = fixesFor(attempts)
  const verdict = pageVerdict(attempts)
  const broken = attempts.filter(a =>
    ['service_down', 'bad_key', 'bad_endpoint', 'quota'].includes(a.kind)
  )
  if (verdict) {
    return { ...verdict, fixes, attempts, raw: error }
  }
  // Nothing says what is wrong with the page: the tools around it failed
  const explanation =
    broken.length === attempts.length
      ? 'The page was never loaded: every way of reaching it was offline or misconfigured.'
      : 'Every way of reading it failed.'
  return {
    title: 'Couldn’t read this page',
    explanation,
    fixes,
    attempts,
    raw: error,
  }
}

function searchFailure(error: string): WebFailure {
  const text = error.toLowerCase()
  const base = { fixes: [] as string[], attempts: [] as Attempt[], raw: error }
  if (text.startsWith('web search is not set up')) {
    return {
      ...base,
      title: 'Web search isn’t set up',
      explanation: 'No search provider is configured. Pages can still be opened by link.',
    }
  }
  if (text.startsWith('no web search endpoints')) {
    return {
      ...base,
      title: 'No search provider available',
      explanation: 'Every configured provider is paused or missing.',
    }
  }
  // `All web search endpoints failed: [id]: message; [id]: message`
  const m = /^all web search endpoints failed: ([\s\S]*)$/i.exec(error)
  if (m) {
    const attempts: Attempt[] = []
    for (const part of m[1].split(/;\s+(?=\[)/)) {
      const hit = /^\[([^\]]+)\]:\s*([\s\S]*)$/.exec(part.trim())
      if (!hit) continue
      const route = hit[1]
      const raw = hit[2].trim()
      const kind = classify(route, raw)
      attempts.push({ route, label: route, kind, summary: SUMMARIES[kind], raw })
    }
    return {
      title: 'Web search failed',
      explanation:
        attempts.length > 1
          ? 'Every search provider returned an error.'
          : 'The search provider returned an error.',
      fixes: fixesFor(attempts.map(a => ({ ...a, label: a.label }))),
      attempts,
      raw: error,
    }
  }
  return { ...base, title: 'Web search failed', explanation: error }
}

/** Not a `Could not read` list: one reason for the whole read. */
function singleFailure(error: string): WebFailure {
  const text = error.toLowerCase()
  const base = { fixes: [] as string[], attempts: [] as Attempt[], raw: error }
  if (/not a valid url|only http and https/.test(text)) {
    return { ...base, title: 'That isn’t a URL that can be read', explanation: error }
  }
  if (/private|local|internal/.test(text) && /address|network|host/.test(text)) {
    return {
      ...base,
      title: 'That address is private',
      explanation: 'Pages on private or local networks are never fetched.',
    }
  }
  if (text.includes('request was cancelled')) {
    return { ...base, title: 'Cancelled', explanation: 'The read was stopped before it finished.' }
  }
  return { ...base, title: 'Couldn’t read this page', explanation: error }
}

/** What to show for a failed web_search or web_fetch. `url` is the page's, if known. */
export function describeWebFailure(
  tool: 'web_search' | 'web_fetch',
  error: string,
  url?: string
): WebFailure {
  // The server's advice to the model: not for the person reading the card
  const clean = error
    .replace(/\s+(Its search snippet|Read another result)[\s\S]*$/, '')
    .trim()
  if (tool === 'web_search') return searchFailure(clean)
  const attempts = parseAttempts(clean)
  return attempts
    ? fetchFailure(url ? clean.split(url).join('the page') : clean, attempts)
    : singleFailure(clean)
}
