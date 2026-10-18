// Shapes shared with the server (app/src/connectors/ConnectorService.mjs).
// Secrets never come back: a saved value shows up only as `hasValue` /
// `hasClientSecret`.

export type ConnectorStatus =
  | 'connected'
  | 'needs_auth'
  | 'error'
  | 'disconnected'
  | 'pending'

export type ConnectorTransport = 'auto' | 'streamable-http' | 'sse'

/**
 * 'auto' signs in when the server asks (sign in when needed), 'oauth' signs
 * in before connecting (sign in now), 'none' never signs in.
 */
export type ConnectorAuthMode = 'auto' | 'oauth' | 'none'

export type OAuthClientMode = 'auto' | 'cimd' | 'dcr' | 'custom'

export type TokenEndpointAuthMethod =
  | 'auto'
  | 'client_secret_basic'
  | 'client_secret_post'
  | 'none'

export type ToolPermission = 'allow' | 'ask' | 'block'

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

/** The connector details the run attaches to a connector tool call. */
export type ConnectorCallInfo = {
  id: string
  name: string
  tool: string
  title?: string
}
