// Shapes shared with the server (app/src/connectors/ConnectorService.mjs).
// Secrets never come back: a saved value shows up only as `hasValue` /
// `hasClientSecret`.

export type ConnectorStatus =
  | 'connected'
  | 'needs_auth'
  | 'error'
  | 'disconnected'
  | 'pending'

export const CONNECTOR_TRANSPORTS = ['auto', 'streamable-http', 'sse'] as const
export type ConnectorTransport = (typeof CONNECTOR_TRANSPORTS)[number]

/**
 * 'auto' signs in when the server asks (sign in when needed), 'oauth' signs
 * in before connecting (sign in now), 'none' never signs in.
 */
export const CONNECTOR_AUTH_MODES = ['auto', 'oauth', 'none'] as const
export type ConnectorAuthMode = (typeof CONNECTOR_AUTH_MODES)[number]

export const OAUTH_CLIENT_MODES = ['auto', 'cimd', 'dcr', 'custom'] as const
export type OAuthClientMode = (typeof OAUTH_CLIENT_MODES)[number]

export const TOKEN_ENDPOINT_AUTH_METHODS = [
  'auto',
  'client_secret_basic',
  'client_secret_post',
  'none',
] as const
export type TokenEndpointAuthMethod =
  (typeof TOKEN_ENDPOINT_AUTH_METHODS)[number]

export const TOOL_PERMISSIONS = ['allow', 'ask', 'block'] as const
export type ToolPermission = (typeof TOOL_PERMISSIONS)[number]

export function isOneOf<T extends string>(
  values: readonly T[],
  value: unknown
): value is T {
  return (
    typeof value === 'string' && (values as readonly unknown[]).includes(value)
  )
}

/** A known server's sign-in (Google's remote MCP servers). */
export type ConnectorPreset = {
  id: string
  label: string
  /** The server registers no apps itself: the user brings an OAuth client. */
  needsClient: boolean
  clientHelpUrl?: string
}

export type ConnectorTool = {
  name: string
  title?: string
  description?: string
  readOnly: boolean
  destructive: boolean
  openWorld: boolean
  permission: ToolPermission
  inputSchema?: Record<string, unknown>
}

export type ConnectorView = {
  id: string
  name: string
  url: string
  transport: ConnectorTransport
  authMode: ConnectorAuthMode
  enabled: boolean
  status: ConnectorStatus
  lastError: { message: string; code?: string; at: string } | null
  /** Seconds a tool call may run; null waits as long as the server takes. */
  timeoutSeconds: number | null
  headers: { name: string; hasValue: boolean }[]
  oauth: {
    clientMode: OAuthClientMode
    /** The client ID the user entered, for the custom client. */
    clientId: string | null
    hasClientSecret: boolean
    scopes: string
    authorizationUrl: string
    tokenUrl: string
    tokenEndpointAuthMethod: TokenEndpointAuthMethod
    extraParams: { name: string; value: string }[]
    /** Discovered authorization server, once known. */
    issuer: string | null
    /** How Overleaf is currently registered with that server. */
    registration: 'cimd' | 'dcr' | 'custom' | null
    grantedScopes: string | null
    expiresAt: string | null
    hasRefreshToken: boolean
  }
  server: {
    name?: string
    title?: string
    version?: string
    protocolVersion?: string
    transport?: 'streamable-http' | 'sse'
    instructions?: string
  } | null
  preset: ConnectorPreset | null
  /** Permission for tools without their own (`*`). */
  defaultPermission: ToolPermission
  tools: ConnectorTool[]
  toolsUpdatedAt: string | null
  createdAt: string
  updatedAt: string
  lastConnectedAt: string | null
}

export type ConnectorsMeta = {
  /** Register this exact URL with an OAuth app used as a custom client. */
  redirectUri: string
  /** Overleaf's Client ID Metadata Document, when this instance offers one. */
  clientMetadataUrl: string | null
}

export type ConnectorHeaderInput = {
  name: string
  value: string
  /** Keep the saved value; `value` is ignored. */
  keep?: boolean
}

export type ConnectorInput = {
  name: string
  url: string
  transport?: ConnectorTransport
  authMode?: ConnectorAuthMode
  timeoutSeconds?: number | null
  headers?: ConnectorHeaderInput[]
  /** Tool name (or `*` for the rest) to permission. */
  toolPermissions?: Record<string, ToolPermission>
  oauth?: {
    clientMode?: OAuthClientMode
    clientId?: string
    clientSecret?: string
    keepClientSecret?: boolean
    scopes?: string
    authorizationUrl?: string
    tokenUrl?: string
    tokenEndpointAuthMethod?: TokenEndpointAuthMethod
    extraParams?: { name: string; value: string }[]
  }
}

export type ConnectorPatch = Partial<ConnectorInput> & {
  enabled?: boolean
}

export type ConnectNext = 'connected' | 'authorize' | 'error'

export type ProbeResult = {
  ok: boolean
  reachable: boolean
  requiresAuth: boolean
  transport?: 'streamable-http' | 'sse'
  era?: 'modern' | 'legacy' | 'sse'
  server?: {
    name?: string
    title?: string
    version?: string
    protocolVersion?: string
  }
  toolCount?: number
  preset?: ConnectorPreset | null
  auth?: {
    issuer?: string
    supportsDcr: boolean
    supportsCimd: boolean
    scopes?: string[]
    needsClient: boolean
  }
  error?: string
  code?: string
}

export type ImportResult = {
  created: { connector: ConnectorView; next: ConnectNext }[]
  skipped: { name: string; reason: string }[]
}

/** Posted by the OAuth callback page when the sign-in finishes. */
export type ConnectorOAuthMessage = {
  type: 'ai-assist:connector-oauth'
  connectorId: string
  status: 'connected' | 'error'
  error?: string
}
