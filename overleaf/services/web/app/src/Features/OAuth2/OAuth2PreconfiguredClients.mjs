import Settings from '@overleaf/settings'

/**
 * Standard preconfigured OAuth 2.1 public clients.
 *
 * Callback URL formats follow Overleaf's standard integration conventions:
 * - GitHub Sync:        ${siteUrl}/user/github/callback
 * - Google Drive Sync:  ${siteUrl}/user/google-drive/callback
 * - MCP Integration:    ${siteUrl}/user/mcp/callback
 * - Native OAuth:       ${siteUrl}/oauth/callback
 *
 * For native desktop clients (Claude Desktop, Goose), loopback redirect URIs
 * (http://localhost:* and http://127.0.0.1:*) are supported per RFC 8252.
 */
const PRECONFIGURED_CLIENTS = {
  claude: {
    id: 'claude',
    name: 'Claude Desktop / Claude Code',
    redirectUris: [
      'http://localhost:*',
      'http://127.0.0.1:*',
      'https://claude.ai/api/mcp/oauth_callback',
    ],
    grants: ['authorization_code', 'refresh_token'],
    scopes: ['mcp'],
    isPublic: true,
  },
  'claude-desktop': {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    redirectUris: ['http://localhost:*', 'http://127.0.0.1:*'],
    grants: ['authorization_code', 'refresh_token'],
    scopes: ['mcp'],
    isPublic: true,
  },
  chatgpt: {
    id: 'chatgpt',
    name: 'ChatGPT / OpenAI',
    redirectUris: ['https://chatgpt.com/connector/oauth/*'],
    grants: ['authorization_code', 'refresh_token'],
    scopes: ['mcp'],
    isPublic: true,
  },
  gemini: {
    id: 'gemini',
    name: 'Google Gemini (Goose / LibreChat)',
    redirectUris: ['http://localhost:*', 'http://127.0.0.1:*'],
    grants: ['authorization_code', 'refresh_token'],
    scopes: ['mcp'],
    isPublic: true,
  },
  goose: {
    id: 'goose',
    name: 'Block Goose (Gemini)',
    redirectUris: ['http://localhost:*', 'http://127.0.0.1:*'],
    grants: ['authorization_code', 'refresh_token'],
    scopes: ['mcp'],
    isPublic: true,
  },
  web: {
    id: 'web',
    name: 'Web / Custom Client',
    redirectUris: ['http://localhost:*', 'http://127.0.0.1:*'],
    grants: ['authorization_code', 'refresh_token'],
    scopes: ['mcp'],
    isPublic: true,
  },
  overleaf: {
    id: 'overleaf',
    name: 'Overleaf Client',
    redirectUris: ['http://localhost:*', 'http://127.0.0.1:*'],
    grants: ['authorization_code', 'refresh_token'],
    scopes: ['mcp'],
    isPublic: true,
  },
}

function matchPattern(pattern, uri, parsedUri) {
  if (pattern === uri) return true

  // RFC 8252 Loopback redirect URI validation
  if (pattern === 'http://localhost:*') {
    return parsedUri.protocol === 'http:' && parsedUri.hostname === 'localhost'
  }
  if (pattern === 'http://127.0.0.1:*') {
    return parsedUri.protocol === 'http:' && parsedUri.hostname === '127.0.0.1'
  }

  // Wildcard path matching
  if (pattern.endsWith('*')) {
    try {
      const patternUrl = new URL(pattern.slice(0, -1))
      return (
        parsedUri.origin === patternUrl.origin &&
        parsedUri.pathname.startsWith(patternUrl.pathname)
      )
    } catch {
      const prefix = pattern.slice(0, -1)
      return uri.startsWith(prefix)
    }
  }
  return false
}

function getSiteUrls() {
  const urls = new Set()
  const fromSettings = (Settings.siteUrl || '').replace(/\/+$/, '')
  if (fromSettings) urls.add(fromSettings)
  return Array.from(urls)
}

const OAuth2PreconfiguredClients = {
  getClient(clientId) {
    return PRECONFIGURED_CLIENTS[clientId] || null
  },

  isRedirectUriAllowed(client, uri) {
    if (!client || !uri || typeof uri !== 'string') return false

    // Parse and validate WHATWG URL format
    let parsedUri
    try {
      parsedUri = new URL(uri)
    } catch {
      return false
    }

    // Reject userinfo (@) to prevent open-redirect / auth code exfiltration tricks
    if (parsedUri.username || parsedUri.password) {
      return false
    }

    const allowed = [...(client.redirectUris || [])]

    // Standard Overleaf synchronization / integration callback pattern:
    // Matches GitHub (${siteUrl}/user/github/callback) and Google Drive (${siteUrl}/user/google-drive/callback)
    for (const siteUrl of getSiteUrls()) {
      allowed.push(
        `${siteUrl}/user/mcp/callback`,
        `${siteUrl}/oauth/callback`
      )
    }

    // Dynamic environment redirect patterns
    const envRedirects = (process.env.MCP_OAUTH2_ALLOWED_REDIRECT_URIS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
    for (const pattern of envRedirects) {
      allowed.push(pattern)
    }

    for (const pattern of allowed) {
      if (matchPattern(pattern, uri, parsedUri)) return true
    }
    return false
  },
}

export default OAuth2PreconfiguredClients
