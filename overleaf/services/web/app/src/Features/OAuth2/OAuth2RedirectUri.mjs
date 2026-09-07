/**
 * Redirect URI validation for the OAuth 2.1 authorization server.
 *
 * Clients reach this server through dynamic client registration, so the only
 * legitimate redirect URIs are the ones that client registered for itself.
 * There is no shared allow-list and no wildcard matching — a permissive
 * redirect URI is an open-redirect and authorization-code exfiltration vector.
 *
 * The single exception is the loopback port. RFC 8252 §7.3 native clients bind
 * an ephemeral port at request time and cannot know it at registration, so the
 * port (and only the port) is ignored when comparing loopback URIs.
 */
const LOOPBACK_HOSTS = ['127.0.0.1', '[::1]', 'localhost']

function parse(uri) {
  if (!uri || typeof uri !== 'string') return null
  let parsed
  try {
    parsed = new URL(uri)
  } catch {
    return null
  }
  // Reject userinfo to prevent open-redirect / code exfiltration tricks.
  if (parsed.username || parsed.password) return null
  return parsed
}

function isLoopback(url) {
  return url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname)
}

function matches(registeredUri, requested) {
  const registered = parse(registeredUri)
  if (!registered) return false

  if (registered.href === requested.href) return true

  // Same origin except the port, for loopback only.
  if (isLoopback(registered) && isLoopback(requested)) {
    return (
      registered.hostname === requested.hostname &&
      registered.pathname === requested.pathname &&
      registered.search === requested.search
    )
  }
  return false
}

const OAuth2RedirectUri = {
  isRedirectUriAllowed(client, uri) {
    const requested = parse(uri)
    if (!client || !requested) return false

    const registered = client.redirectUris
    if (!Array.isArray(registered) || registered.length === 0) return false

    return registered.some(candidate => matches(candidate, requested))
  },
}

export default OAuth2RedirectUri
