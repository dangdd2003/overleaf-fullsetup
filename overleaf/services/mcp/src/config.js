// Fixed in the container. nginx proxies /mcp and the OAuth metadata to this
// loopback port (server-ce/nginx/mcp.conf.template), and web listens on 4000
// (server-ce/runit/web-overleaf/run).
const LISTEN_HOST = '127.0.0.1'
const LISTEN_PORT = 3050
const ENDPOINT_PATH = '/mcp'
const MAX_BODY_MB = 70
/** Where the HTTP transport reaches web, inside the container. */
export const WEB_INTERNAL_URL = 'http://127.0.0.1:4000'
// The loopback names the SDK itself trusts. The service also serves the site
// hostname nginx forwards, and web calls it on loopback.
const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '[::1]']

/** Unique, non-empty entries; the site entries are empty while disabled. */
function freezeList(entries) {
  return Object.freeze([...new Set(entries)].filter(Boolean))
}

/** Comma-separated entries an operator adds to a derived list. */
function listFromEnv(env, name) {
  return (env[name] || '')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean)
}

function hostnameOf(siteUrl) {
  try {
    return new URL(siteUrl).hostname
  } catch {
    throw new Error(
      `OVERLEAF_SITE_URL must be an absolute URL, got "${siteUrl}"`
    )
  }
}

/**
 * Parse and validate the service environment into one frozen config object.
 *
 * Every value the service reads from the environment is resolved here, so the
 * rest of the service never touches process.env.
 *
 * @param {Record<string, string|undefined>} [env]
 * @param {{ stdio?: boolean }} [options] stdio selects the local stdio transport
 * @returns {Readonly<object>}
 */
export function loadConfig(env = process.env, { stdio = false } = {}) {
  const enabled = env.MCP_ENABLED?.toLowerCase() === 'true'

  // The site URL is the token issuer over HTTP, and the Overleaf instance a
  // local stdio server acts for.
  const siteUrl = (env.OVERLEAF_SITE_URL || '').replace(/\/+$/, '')
  if (enabled && !siteUrl) {
    throw new Error('OVERLEAF_SITE_URL is required when MCP_ENABLED=true')
  }
  const siteHostname = enabled ? hostnameOf(siteUrl) : ''

  const stdioToken = env.MCP_TOKEN || ''
  if (enabled && stdio && !stdioToken) {
    throw new Error('MCP_TOKEN is required with --stdio')
  }

  // Extra names for deployments reached under more than the site URL (another
  // domain, an IP) and browser apps on other origins that call /mcp
  const extraHosts = listFromEnv(env, 'MCP_ALLOWED_HOSTS')
  const extraOrigins = listFromEnv(env, 'MCP_ALLOWED_ORIGINS')
  if (extraOrigins.includes('*')) {
    throw new Error('MCP_ALLOWED_ORIGINS must not contain a wildcard "*"')
  }

  return Object.freeze({
    enabled,
    transport: stdio ? 'stdio' : 'http',
    host: LISTEN_HOST,
    port: LISTEN_PORT,
    endpointPath: ENDPOINT_PATH,
    maxBodyMb: MAX_BODY_MB,
    internalUrl: stdio ? siteUrl : WEB_INTERNAL_URL,
    resourceUri: `${siteUrl}${ENDPOINT_PATH}`,
    authServerUrl: siteUrl,
    stdioToken,
    allowedHosts: freezeList([...LOCAL_HOSTS, siteHostname, ...extraHosts]),
    allowedOrigins: freezeList([...LOCAL_HOSTS, siteUrl, ...extraOrigins]),
  })
}
