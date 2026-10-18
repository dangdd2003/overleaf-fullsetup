const DEFAULT_PORT = 3050
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_ENDPOINT_PATH = '/mcp'
const DEFAULT_MAX_BODY_MB = 70
const TRANSPORTS = ['http', 'stdio']
const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1']

function intFromEnv(env, name, defaultValue) {
  const raw = env[name]
  if (raw === undefined || raw === '') return defaultValue
  // parseInt would accept "3050abc" or "1e3" as a number; the whole value must be digits.
  const parsed = /^\d+$/.test(raw) ? Number(raw) : 0
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`)
  }
  return parsed
}

function listFromEnv(env, name) {
  const raw = env[name]
  if (!raw) return []
  return raw
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean)
}

/**
 * Parse and validate the service environment into one frozen config object.
 *
 * Every value the service reads from the environment is resolved here, so the
 * rest of the service never touches process.env.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {Readonly<object>}
 */
export function loadConfig(env = process.env) {
  const enabled = env.MCP_ENABLED?.toLowerCase() === 'true'

  const transport = env.MCP_TRANSPORT || 'http'
  if (enabled && !TRANSPORTS.includes(transport)) {
    throw new Error(
      `MCP_TRANSPORT must be one of ${TRANSPORTS.join(', ')}, got "${transport}"`
    )
  }

  const internalUrl = (
    env.MCP_INTERNAL_URL ||
    env.OVERLEAF_SITE_URL ||
    ''
  ).replace(/\/+$/, '')
  if (enabled && !internalUrl) {
    throw new Error(
      'MCP_INTERNAL_URL (or OVERLEAF_SITE_URL) is required when MCP_ENABLED=true'
    )
  }

  // Web signs access tokens with its site URL as the issuer. That URL is not
  // the internal one (web:3000 in compose), so it cannot be guessed from
  // MCP_INTERNAL_URL; without it every JWT would fail the issuer check.
  if (enabled && transport === 'http' && !env.OVERLEAF_SITE_URL) {
    throw new Error(
      'OVERLEAF_SITE_URL is required when MCP_ENABLED=true and MCP_TRANSPORT=http: ' +
        'it must match the site URL Overleaf issues tokens for (the JWT issuer)'
    )
  }

  const stdioToken = env.MCP_TOKEN || ''
  if (enabled && transport === 'stdio' && !stdioToken) {
    throw new Error(
      'MCP_TOKEN is required when MCP_TRANSPORT=stdio'
    )
  }

  const host = env.MCP_HOST || DEFAULT_HOST
  const allowedHosts = listFromEnv(env, 'MCP_ALLOWED_HOSTS')
  if (enabled && transport === 'http' && !LOCAL_HOSTS.includes(host) && !allowedHosts.length) {
    throw new Error(
      `MCP_ALLOWED_HOSTS must list the hostnames served when MCP_HOST is "${host}" ` +
        '(binding beyond loopback drops the default DNS-rebinding protection)'
    )
  }

  const allowedOrigins = listFromEnv(env, 'MCP_ALLOWED_ORIGINS')
  if (allowedOrigins.includes('*')) {
    throw new Error('MCP_ALLOWED_ORIGINS must not contain a wildcard "*"')
  }

  const port = intFromEnv(env, 'MCP_PORT', DEFAULT_PORT)
  const endpointPath = env.MCP_ENDPOINT_PATH || DEFAULT_ENDPOINT_PATH
  const maxBodyMb = intFromEnv(env, 'MCP_MAX_BODY_MB', DEFAULT_MAX_BODY_MB)
  const authServerUrl = (env.OVERLEAF_SITE_URL || internalUrl || '').replace(
    /\/+$/,
    ''
  )
  const resourceUri =
    env.MCP_RESOURCE_URI ||
    (env.OVERLEAF_SITE_URL
      ? `${authServerUrl}${endpointPath}`
      : `http://${host}:${port}${endpointPath}`)

  return Object.freeze({
    enabled,
    transport,
    host,
    port,
    endpointPath,
    maxBodyMb,
    internalUrl,
    resourceUri,
    authServerUrl,
    stdioToken,
    allowedHosts: Object.freeze(allowedHosts),
    allowedOrigins: Object.freeze(allowedOrigins),
  })
}
