/**
 * Normalizes an instance base URL: guarantees an http(s) scheme, strips
 * queries, hashes, trailing slashes, and an optional path suffix such as a
 * version or endpoint path. Returns '' when invalid or unparseable.
 */
export function normalizeInstanceBaseUrl(raw, versionPattern) {
  if (typeof raw !== 'string' || !raw.trim()) return ''
  let value = raw.trim()
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `http://${value}`
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return ''
  }
  parsed.search = ''
  parsed.hash = ''
  if (versionPattern) {
    parsed.pathname = parsed.pathname.replace(versionPattern, '')
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '')
  return parsed.toString().replace(/\/+$/, '')
}
