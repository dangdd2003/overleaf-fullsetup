const DEFAULT_PORT = 3050
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_ENDPOINT_PATH = '/mcp'
const DEFAULT_MAX_UPLOAD_MB = 20
const TRANSPORTS = ['http', 'stdio']
const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1']

function intFromEnv(env, name, defaultValue) {
  const raw = env[name]
  if (raw === undefined || raw === '') return defaultValue
  const parsed = parseInt(raw, 10)
  if (Number.isNaN(parsed) || parsed <= 0) {
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
  const enabled = env.OVERLEAF_MCP_ENABLED?.toLowerCase() === 'true'

  const transport = env.MCP_TRANSPORT || 'http'
  if (enabled && !TRANSPORTS.includes(transport)) {
    throw new Error(
      `MCP_TRANSPORT must be one of ${TRANSPORTS.join(', ')}, got "${transport}"`
    )
  }

  const internalUrl = (env.OVERLEAF_INTERNAL_URL || env.OVERLEAF_URL || '').replace(
    /\/+$/,
    ''
  )
  if (enabled && !internalUrl) {
    throw new Error(
      'OVERLEAF_INTERNAL_URL (or OVERLEAF_URL) is required when OVERLEAF_MCP_ENABLED=true'
    )
  }

  const stdioToken = env.OVERLEAF_MCP_TOKEN || ''
  if (enabled && transport === 'stdio' && !stdioToken) {
    throw new Error(
      'OVERLEAF_MCP_TOKEN is required when MCP_TRANSPORT=stdio'
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
  const authServerUrl = (env.OVERLEAF_URL || internalUrl || '').replace(
    /\/+$/,
    ''
  )
  const resourceUri =
    env.MCP_RESOURCE_URI ||
    (env.OVERLEAF_URL
      ? `${authServerUrl}${endpointPath}`
      : `http://${host}:${port}${endpointPath}`)

  return Object.freeze({
    enabled,
    transport,
    host,
    port,
    endpointPath,
    internalUrl,
    resourceUri,
    authServerUrl,
    maxUploadBytes:
      intFromEnv(env, 'MCP_MAX_UPLOAD_MB', DEFAULT_MAX_UPLOAD_MB) * 1024 * 1024,
    stdioToken,
    allowedHosts: Object.freeze(allowedHosts),
    allowedOrigins: Object.freeze(allowedOrigins),
  })
}
