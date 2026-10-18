// Known servers and other apps' connector configs.
//
// Google's remote MCP servers (https://<service>.googleapis.com/mcp) sign in
// with Google OAuth, which neither registers apps automatically (DCR) nor
// reads a Client ID Metadata Document, so they need the user's own OAuth
// client from Google Cloud Console. The preset fills in everything else.

const GOOGLE_PRESET = {
  id: 'google',
  label: 'Google Cloud',
  needsClient: true,
  clientHelpUrl: 'https://console.cloud.google.com/auth/clients',
  // Google's token endpoint does not take RFC 8707 resource indicators
  omitResource: true,
  oauth: {
    clientMode: 'custom',
    issuer: 'https://accounts.google.com',
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: 'https://www.googleapis.com/auth/cloud-platform',
    tokenEndpointAuthMethod: 'client_secret_post',
    // A refresh token, issued on every consent rather than only the first
    extraParams: [
      { name: 'access_type', value: 'offline' },
      { name: 'prompt', value: 'consent' },
    ],
  },
}

export function presetFor(url) {
  let host
  try {
    host = new URL(String(url)).hostname.toLowerCase()
  } catch {
    return null
  }
  if (host === 'googleapis.com' || host.endsWith('.googleapis.com')) {
    return GOOGLE_PRESET
  }
  return null
}

/** What the browser shows for a preset: no internal flags. */
export function presetView(preset) {
  if (!preset) return null
  return {
    id: preset.id,
    label: preset.label,
    needsClient: preset.needsClient,
    clientHelpUrl: preset.clientHelpUrl,
    oauth: preset.oauth,
  }
}

function scopesFrom(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join(' ')
  return typeof value === 'string' ? value.trim() : ''
}

function headersFrom(value) {
  if (!value || typeof value !== 'object') return []
  return Object.entries(value)
    .filter(([name, val]) => name && val !== undefined && val !== null)
    .map(([name, val]) => ({ name: String(name), value: String(val) }))
}

const STREAMABLE_TYPES = new Set(['http', 'streamable-http', 'streamablehttp'])

/**
 * One server entry from Gemini CLI's settings.json, Claude Code's .mcp.json,
 * Claude Desktop, VS Code or Cursor, as a connector input. Returns
 * `{ input }` or `{ reason }` when it cannot run here.
 */
function connectorFromEntry(name, entry) {
  if (!entry || typeof entry !== 'object') {
    return { reason: 'Not a server definition' }
  }
  if (entry.command && !entry.url && !entry.httpUrl && !entry.serverUrl) {
    return {
      reason:
        'Runs as a local program (stdio). Overleaf runs on a server and can only reach remote MCP servers by URL.',
    }
  }

  const type = String(entry.type || entry.transport || '').toLowerCase()
  const url = entry.httpUrl || entry.url || entry.serverUrl
  if (!url) return { reason: 'No URL' }
  let transport = 'auto'
  if (entry.httpUrl || STREAMABLE_TYPES.has(type)) transport = 'streamable-http'
  else if (type === 'sse') transport = 'sse'

  const headers = headersFrom(entry.headers)
  // Claude API style
  if (entry.authorization_token) {
    headers.push({
      name: 'Authorization',
      value: `Bearer ${entry.authorization_token}`,
    })
  }

  const input = {
    name: String(entry.name || name),
    url: String(url),
    transport,
    authMode: 'auto',
    headers,
  }

  // Gemini CLI: `timeout` in milliseconds
  if (Number(entry.timeout) > 0) {
    input.timeoutSeconds = Math.ceil(Number(entry.timeout) / 1000)
  }

  // Gemini CLI tool filters and trust; `*` is every tool not named
  const permissions = {}
  if (entry.trust === true) permissions['*'] = 'allow'
  if (Array.isArray(entry.includeTools) && entry.includeTools.length) {
    for (const tool of entry.includeTools) {
      permissions[tool] = entry.trust === true ? 'allow' : 'ask'
    }
    permissions['*'] = 'block'
  }
  if (Array.isArray(entry.excludeTools)) {
    for (const tool of entry.excludeTools) permissions[tool] = 'block'
  }
  if (Object.keys(permissions).length) input.toolPermissions = permissions

  const authProvider = String(entry.authProviderType || '').toLowerCase()
  if (authProvider === 'service_account_impersonation') {
    return {
      reason:
        "Signs in by impersonating a Google service account with the Gemini CLI's local Google credentials, which Overleaf does not have. Add it with your own OAuth client instead.",
    }
  }

  const oauth = entry.oauth && typeof entry.oauth === 'object' ? entry.oauth : null
  const google =
    authProvider === 'google_credentials' ? GOOGLE_PRESET : presetFor(url)
  if (oauth || google) {
    const base = google ? { ...google.oauth } : { clientMode: 'auto' }
    input.oauth = {
      ...base,
      ...(oauth?.clientId ? { clientMode: 'custom', clientId: oauth.clientId } : {}),
      ...(oauth?.clientSecret ? { clientSecret: oauth.clientSecret } : {}),
      ...(oauth?.authorizationUrl
        ? { authorizationUrl: oauth.authorizationUrl }
        : {}),
      ...(oauth?.tokenUrl ? { tokenUrl: oauth.tokenUrl } : {}),
      ...(scopesFrom(oauth?.scopes) ? { scopes: scopesFrom(oauth.scopes) } : {}),
    }
    const extraParams = [...(input.oauth.extraParams || [])]
    const audiences = scopesFrom(oauth?.audiences)
    if (audiences) extraParams.push({ name: 'audience', value: audiences })
    if (extraParams.length) input.oauth.extraParams = extraParams
    if (oauth?.enabled === true || google) input.authMode = 'oauth'
    delete input.oauth.issuer
  }

  return { input }
}

/**
 * Connector inputs from another app's MCP config, pasted as JSON:
 * `{ mcpServers: {...} }` (Gemini CLI, Claude Code/Desktop, Cursor),
 * `{ servers: {...} }` (VS Code), `{ mcp_servers: [...] }` (Claude API),
 * or a bare `{ name: {...} }` map.
 */
export function parseConnectorConfig(raw) {
  let config = raw
  if (typeof raw === 'string') {
    try {
      config = JSON.parse(raw)
    } catch {
      const err = new Error('The configuration is not valid JSON')
      err.status = 400
      throw err
    }
  }
  if (!config || typeof config !== 'object') {
    const err = new Error('The configuration is empty')
    err.status = 400
    throw err
  }

  let entries
  const list = config.mcp_servers || (Array.isArray(config) ? config : null)
  if (Array.isArray(list)) {
    entries = list.map((entry, i) => [entry?.name || `server-${i + 1}`, entry])
  } else {
    const map = config.mcpServers || config.servers || config
    entries = Object.entries(map)
  }

  const connectors = []
  const skipped = []
  for (const [name, entry] of entries) {
    const { input, reason } = connectorFromEntry(name, entry)
    if (input) connectors.push(input)
    else skipped.push({ name, reason })
  }
  return { connectors, skipped }
}

export default { presetFor, presetView, parseConnectorConfig }
