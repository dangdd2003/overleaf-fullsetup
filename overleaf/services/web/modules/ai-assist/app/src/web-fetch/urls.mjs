/**
 * URL helpers shared by the Markdown clean-up and the page cache. Tracking
 * parameters say who sent a reader, not which page it is.
 */

const TRACKING_PARAM =
  /^(?:utm_[\w-]*|fbclid|gclid|dclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|igshid|yclid|_hsenc|_hsmi|ref_src|spm)$/i

/** `url` without tracking parameters; unchanged when it has none or does not parse. */
export function stripTrackingParams(url) {
  const raw = String(url ?? '')
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    return raw
  }
  const tracking = [...new Set(parsed.searchParams.keys())].filter(name =>
    TRACKING_PARAM.test(name)
  )
  if (tracking.length === 0) return raw
  for (const name of tracking) parsed.searchParams.delete(name)
  if ([...parsed.searchParams.keys()].length === 0) parsed.search = ''
  return parsed.toString()
}

/**
 * Canonical cache key for a URL: lowercase protocol and hostname, no www,
 * default ports, trailing slash, fragment or tracking parameters. Search
 * engines and links spell one page all these ways.
 */
export function cacheKeyFor(rawUrl) {
  const raw = String(rawUrl ?? '').trim()
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    return raw
  }
  parsed.hash = ''
  parsed.protocol = parsed.protocol.toLowerCase()
  parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, '')
  parsed.pathname = parsed.pathname.replace(/\/+$/, '')
  if (
    (parsed.protocol === 'http:' && parsed.port === '80') ||
    (parsed.protocol === 'https:' && parsed.port === '443')
  ) {
    parsed.port = ''
  }
  return stripTrackingParams(parsed.toString())
}
