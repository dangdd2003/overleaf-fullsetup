import {
  ConnectorModel,
  OAuthStateModel,
} from './ConnectorModel.mjs'
import {
  loadCredentials,
  saveCredentials,
  deleteCredentials,
} from './ConnectorCredentials.mjs'
import { McpClient, ConnectorAuthError } from './McpClient.mjs'
import {
  discover,
  startAuthorization,
  handleCallback,
  refreshTokens,
  currentAccessToken,
  redirectUri,
  clientMetadataUrl,
  canUseCimd,
  signInOffered,
  pendingConnectorId,
} from './McpOAuth.mjs'
import {
  presetFor,
  presetView,
  parseConnectorConfig,
} from './ConnectorPresets.mjs'
import { sanitizeServerIcons } from './ConnectorIcons.mjs'
import { originOf } from './ConnectorFetch.mjs'

/**
 * MCP tool annotations are `…Hint`; older servers sent the bare names, and
 * some saved tools carry the hints at the top level. All three are read.
 */
export function toolHint(tool, name) {
  const annotations = tool?.annotations || {}
  const value =
    annotations[`${name}Hint`] ??
    annotations[name] ??
    tool?.[`${name}Hint`] ??
    tool?.[name]
  return Boolean(value)
}

const PERMISSION_LEVELS = new Set(['allow', 'ask', 'block'])

/**
 * The key a tool's permission is stored under. Mongo reads a dot as a path
 * and a leading `$` as an operator, so those (and `%`, which keeps the encoding
 * one-to-one) are written as percent escapes. The key stays one plain name and
 * no two tools share one. The connector default stays `*`.
 */
export function permissionKeyFor(toolName) {
  const name = String(toolName)
  if (name === '*') return '%2A'
  return name.replace(
    /[%.$]/g,
    c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

/** A permission map as it is stored: keys from permissionKeyFor, levels checked. */
function storedPermissions(map) {
  if (!map || typeof map !== 'object') return {}
  return Object.fromEntries(
    Object.entries(map)
      .filter(([, level]) => PERMISSION_LEVELS.has(level))
      .map(([name, level]) => [
        name === '*' ? '*' : permissionKeyFor(name),
        level,
      ])
  )
}

/**
 * A tool's permission: its own, else the connector's `*` default, else ask.
 * Only the connector's own keys count and only the three levels: an inherited
 * property (`constructor`, `toString`) is not a permission, and approval must
 * not be skipped because of one.
 */
export function toolPermission(connector, toolName) {
  const permissions = connector?.toolPermissions || {}
  const own = key => {
    if (!Object.prototype.hasOwnProperty.call(permissions, key)) return null
    return PERMISSION_LEVELS.has(permissions[key]) ? permissions[key] : null
  }
  return own(permissionKeyFor(toolName)) || own('*') || 'ask'
}

function notFound() {
  const err = new Error('Connector not found')
  err.status = 404
  return err
}

function iso(date) {
  return date ? new Date(date).toISOString() : null
}

/** The last error a connector keeps: the error's own, else the fallbacks. */
function lastErrorFrom(err, fallbackMessage, fallbackCode) {
  return {
    message: err.message || fallbackMessage,
    code: err.code || fallbackCode,
    at: new Date(),
  }
}

export function toView(doc) {
  if (!doc) return null
  const oauth = doc.oauth || {}
  return {
    id: doc._id.toString(),
    name: doc.name,
    url: doc.url,
    transport: doc.transport || 'auto',
    authMode: doc.authMode || 'auto',
    enabled: Boolean(doc.enabled),
    status: doc.status || 'pending',
    lastError: doc.lastError?.message
      ? {
          message: doc.lastError.message,
          code: doc.lastError.code,
          at: iso(doc.lastError.at) || new Date().toISOString(),
        }
      : null,
    timeoutSeconds: doc.timeoutSeconds || null,
    headers: (doc.headerNames || []).map(name => ({ name, hasValue: true })),
    oauth: {
      clientMode: oauth.clientMode || 'auto',
      clientId: oauth.customClientId || oauth.clientId || null,
      hasClientSecret: Boolean(doc.hasClientSecret),
      scopes: oauth.scopes || '',
      authorizationUrl: oauth.authorizationUrl || '',
      tokenUrl: oauth.tokenUrl || '',
      tokenEndpointAuthMethod: oauth.tokenEndpointAuthMethod || 'auto',
      extraParams: (oauth.extraParams || []).map(p => ({
        name: p.name,
        value: p.value,
      })),
      issuer: oauth.issuer || null,
      registration: oauth.registration || null,
      grantedScopes: oauth.grantedScopes || null,
      expiresAt: iso(oauth.expiresAt),
      hasRefreshToken: Boolean(oauth.hasRefreshToken),
    },
    preset: presetView(presetFor(doc.url)),
    iconUrl: `/ai-assist/connectors/${doc._id.toString()}/icon`,
    server:
      doc.server && (doc.server.name || doc.server.protocolVersion)
        ? {
            name: doc.server.name,
            title: doc.server.title,
            version: doc.server.version,
            protocolVersion: doc.server.protocolVersion,
            transport: doc.server.transport,
            instructions: doc.server.instructions,
          }
        : null,
    defaultPermission: doc.toolPermissions?.['*'] || 'ask',
    tools: (doc.tools || []).map(t => ({
      name: t.name,
      title: t.title,
      description: t.description,
      readOnly: toolHint(t, 'readOnly'),
      destructive: toolHint(t, 'destructive'),
      openWorld: toolHint(t, 'openWorld'),
      permission: toolPermission(doc, t.name),
      inputSchema: t.inputSchema,
    })),
    toolsUpdatedAt: iso(doc.toolsUpdatedAt),
    createdAt: iso(doc.createdAt) || new Date().toISOString(),
    updatedAt: iso(doc.updatedAt) || new Date().toISOString(),
    lastConnectedAt: iso(doc.lastConnectedAt),
  }
}

export function getMeta() {
  return {
    redirectUri: redirectUri(),
    // Offered to servers only when they can fetch it (a public https site)
    clientMetadataUrl: canUseCimd() ? clientMetadataUrl() : null,
  }
}

function headerMap(headers) {
  const map = {}
  for (const h of Array.isArray(headers) ? headers : []) {
    if (h?.name && h.value) map[String(h.name).trim()] = String(h.value)
  }
  return map
}

function timeoutFrom(value) {
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null
}

/** Applies the non-secret OAuth settings a form or an import sent. */
function applyOAuthInput(connector, input = {}) {
  const oauth = connector.oauth
  if (input.clientMode) oauth.clientMode = input.clientMode
  if (input.clientId !== undefined) {
    oauth.customClientId = input.clientId || undefined
  }
  for (const field of ['scopes', 'authorizationUrl', 'tokenUrl']) {
    if (input[field] !== undefined) oauth[field] = input[field] || ''
  }
  if (input.tokenEndpointAuthMethod) {
    oauth.tokenEndpointAuthMethod = input.tokenEndpointAuthMethod
  }
  if (Array.isArray(input.extraParams)) {
    oauth.extraParams = input.extraParams.filter(p => p?.name)
  }
}

async function withSecretFlags(doc) {
  const credentials = await loadCredentials(doc._id)
  doc.hasClientSecret = Boolean(credentials.clientSecret)
  return doc
}

export class ConnectorService {
  static async list(userId) {
    const docs = await ConnectorModel.find({ user_id: userId })
      .sort({ createdAt: 1 })
      .exec()
    await Promise.all(docs.map(withSecretFlags))
    return { connectors: docs.map(toView), meta: getMeta() }
  }

  /** What the icon route needs: the URL and the icons the server declared. */
  static async iconSource(id, userId) {
    const doc = await this._find(id, userId)
    return { url: doc.url, serverIcons: doc.serverIcons }
  }

  static async _find(id, userId) {
    const doc = await ConnectorModel.findOne({ _id: id, user_id: userId }).exec()
    if (!doc) throw notFound()
    return doc
  }

  static async create(userId, input) {
    const headers = headerMap(input.headers)
    const connector = new ConnectorModel({
      user_id: userId,
      name: input.name,
      url: input.url,
      transport: input.transport || 'auto',
      authMode: input.authMode || 'auto',
      enabled: true,
      status: 'pending',
      timeoutSeconds: timeoutFrom(input.timeoutSeconds),
      headerNames: Object.keys(headers),
      oauth: {},
      toolPermissions: storedPermissions(input.toolPermissions),
    })
    applyOAuthInput(connector, input.oauth)
    await connector.save()
    await saveCredentials(connector._id, userId, {
      headers,
      clientSecret: input.oauth?.clientSecret || null,
    })

    // Verified straight away: the server connects, or says it needs sign-in.
    // It is saved already, so a check that breaks leaves it as an error to
    // fix, never stuck pending.
    let next
    try {
      next = await this.connect(connector)
    } catch (err) {
      connector.status = 'error'
      connector.lastError = lastErrorFrom(
        err,
        'Connection failed',
        'CONNECT_ERROR'
      )
      await connector.save()
      next = 'error'
    }
    await withSecretFlags(connector)
    return { connector: toView(connector), next }
  }

  /** Pastes another app's MCP config (Gemini CLI, Claude, VS Code, Cursor). */
  static async import(userId, config) {
    const { connectors, skipped } = parseConnectorConfig(config)
    const created = []
    for (const input of connectors) {
      try {
        created.push(await this.create(userId, input))
      } catch (err) {
        skipped.push({ name: input.name, reason: err.message })
      }
    }
    return { created, skipped }
  }

  static async _needsSignIn(connector) {
    connector.status = 'needs_auth'
    await connector.save()
    return 'authorize'
  }

  static async update(id, userId, patch) {
    const connector = await this._find(id, userId)
    let reconnect = false
    let originChanged = false

    if (patch.name !== undefined) connector.name = patch.name
    if (patch.url !== undefined && patch.url !== connector.url) {
      originChanged = originOf(patch.url) !== originOf(connector.url)
      connector.url = patch.url
      reconnect = true
    }
    if (patch.transport !== undefined) {
      connector.transport = patch.transport
      reconnect = true
    }
    if (patch.authMode !== undefined) connector.authMode = patch.authMode
    if (patch.enabled !== undefined) connector.enabled = Boolean(patch.enabled)
    if (patch.timeoutSeconds !== undefined) {
      connector.timeoutSeconds = timeoutFrom(patch.timeoutSeconds)
    }
    if (patch.toolPermissions) {
      connector.toolPermissions = {
        ...(connector.toolPermissions || {}),
        ...storedPermissions(patch.toolPermissions),
      }
      connector.markModified('toolPermissions')
    }

    const secrets = {}
    if (Array.isArray(patch.headers)) {
      const saved = (await loadCredentials(connector._id)).headers || {}
      const headers = {}
      for (const h of patch.headers) {
        if (h.keep && !originChanged && saved[h.name]) {
          headers[h.name] = saved[h.name]
        }
        else if (h.name && h.value) headers[h.name] = h.value
      }
      connector.headerNames = Object.keys(headers)
      secrets.headers = headers
      reconnect = true
    }
    if (originChanged) {
      // Secrets were issued for, or typed in for, the old server: never send
      // them to a new host. The user signs in or enters them again.
      secrets.tokens = null
      if (!Array.isArray(patch.headers)) {
        secrets.headers = null
        connector.headerNames = []
      }
      connector.oauth.expiresAt = null
      connector.oauth.hasRefreshToken = false
      connector.oauth.grantedScopes = undefined
      connector.oauth.issuer = undefined
      connector.oauth.clientId = undefined
      // Endpoints of the old server, discovered or typed in: the next sign-in
      // rediscovers them for the new one
      connector.oauth.authorizationUrl = undefined
      connector.oauth.tokenUrl = undefined
      connector.oauth.resourceMetadataUrl = undefined
      connector.oauth.resource = undefined
      // Scopes discovered from the old server; scopes typed in this PATCH are
      // applied below and win
      connector.oauth.scopes = undefined
      // The client secret was issued for the old server's authorization server.
      // A secret typed in this PATCH is saved below and wins.
      if (!patch.oauth?.clientSecret) secrets.clientSecret = null
    }
    if (patch.oauth) {
      applyOAuthInput(connector, patch.oauth)
      if (patch.oauth.clientSecret) {
        secrets.clientSecret = patch.oauth.clientSecret
      } else if (patch.oauth.keepClientSecret === false) {
        secrets.clientSecret = null
      }
      reconnect = true
    }

    await connector.save()
    if (Object.keys(secrets).length) {
      await saveCredentials(connector._id, userId, secrets)
    }
    const next =
      reconnect && connector.enabled ? await this.connect(connector) : null
    await withSecretFlags(connector)
    return { connector: toView(connector), next }
  }

  static async remove(id, userId) {
    const result = await ConnectorModel.deleteOne({
      _id: id,
      user_id: userId,
    }).exec()
    if (result.deletedCount === 0) throw notFound()
    await deleteCredentials(id)
    await OAuthStateModel.deleteMany({ connector_id: id }).exec()
    return { ok: true }
  }

  /** Whether the server offers sign-in; a failed check counts as not offered. */
  static async _signInOffered(connector) {
    try {
      return await signInOffered({ connector })
    } catch {
      return false
    }
  }

  /** Connects with what is saved, refreshing the tool list on success. */
  static async connect(connector, credentials = null) {
    let client = null
    try {
      credentials = credentials || (await loadCredentials(connector._id))
      if (credentials.lost.length) {
        // loadCredentials recorded why; pick that up rather than overwrite it
        const fresh = await ConnectorModel.findById(connector._id).lean().exec()
        if (fresh) connector.init(fresh)
        return await this._needsSignIn(connector)
      }

      client = new McpClient({
        url: connector.url,
        transport: connector.transport,
        headers: credentials.headers || {},
        accessToken: await currentAccessToken({ connector, credentials }),
      })

      await client.connect({ timeoutMs: 30_000 })
      const tools = await client.listTools({ timeoutMs: 60_000 })
      connector.status = 'connected'
      connector.server = {
        name: client.serverInfo?.name,
        title: client.serverInfo?.title,
        version: client.serverInfo?.version,
        protocolVersion: client.protocolVersion,
        transport: client.era === 'sse' ? 'sse' : 'streamable-http',
        instructions: client.instructions,
        capabilities: client.capabilities,
      }
      connector.serverIcons = sanitizeServerIcons(client.serverInfo?.icons)
      connector.tools = tools
      connector.toolsUpdatedAt = new Date()
      connector.lastConnectedAt = new Date()
      connector.lastError = undefined
      await connector.save()
      return 'connected'
    } catch (err) {
      if (err instanceof ConnectorAuthError && connector.authMode !== 'none') {
        if (err.authDetails?.resourceMetadata) {
          connector.oauth.resourceMetadataUrl = err.authDetails.resourceMetadata
        }
        if (err.authDetails?.scope && !connector.oauth.scopes) {
          connector.oauth.scopes = err.authDetails.scope
        }
        // A 401 only means sign-in when the server offers one. Otherwise a
        // Sign in button could never work, so say what to do instead.
        if (await this._signInOffered(connector)) {
          connector.lastError = undefined
          return await this._needsSignIn(connector)
        }
        connector.status = 'error'
        connector.lastError = {
          message: `The server rejected the request (${err.status || 401}) and offers no sign-in. If it needs an API key, add it as a header in the connector's settings.`,
          code: 'SIGN_IN_NOT_OFFERED',
          at: new Date(),
        }
        await connector.save()
        return 'error'
      }
      connector.status = 'error'
      connector.lastError = lastErrorFrom(
        err,
        'Connection failed',
        'CONNECT_ERROR'
      )
      await connector.save()
      return 'error'
    } finally {
      await client?.close().catch(() => {})
    }
  }

  static async probe(input) {
    const client = new McpClient({
      url: input.url,
      transport: input.transport || 'auto',
      headers: headerMap(input.headers),
    })
    const preset = presetView(presetFor(input.url))
    try {
      await client.connect({ timeoutMs: 30_000 })
      const tools = await client.listTools({ timeoutMs: 60_000 })
      return {
        ok: true,
        reachable: true,
        requiresAuth: false,
        transport: client.era === 'sse' ? 'sse' : 'streamable-http',
        era: client.era,
        // Icons are fetched through the icon route once the connector is saved
        server: withoutIcons(client.serverInfo),
        toolCount: tools.length,
        preset,
      }
    } catch (err) {
      if (err instanceof ConnectorAuthError) {
        const { prm, as } = await discover({
          url: input.url,
          resourceMetadataUrl: err.authDetails?.resourceMetadata,
        })
        const supportsCimd = Boolean(
          as?.client_id_metadata_document_supported &&
            as.token_endpoint_auth_methods_supported.includes('none') &&
            canUseCimd()
        )
        const supportsDcr = Boolean(as?.registration_endpoint)
        return {
          ok: true,
          reachable: true,
          requiresAuth: true,
          transport: client.era === 'sse' ? 'sse' : 'streamable-http',
          era: client.era,
          preset,
          auth: {
            issuer: as?.issuer || prm?.authorization_servers?.[0],
            supportsDcr,
            supportsCimd,
            scopes: prm?.scopes_supported?.length
              ? prm.scopes_supported
              : as?.scopes_supported || [],
            needsClient: Boolean(preset?.needsClient) || (!supportsCimd && !supportsDcr),
          },
        }
      }
      return {
        ok: false,
        reachable: false,
        requiresAuth: false,
        preset,
        error: err.message || 'Probe failed',
        code: err.code || 'PROBE_ERROR',
      }
    } finally {
      await client.close().catch(() => {})
    }
  }

  static async _startSignIn(connector, scope) {
    return startAuthorization({ connector, stepUpScope: scope || null })
  }

  static async authorize(id, userId, { scope } = {}) {
    const connector = await this._find(id, userId)
    if (connector.authMode === 'none') {
      const err = new Error(
        'Sign-in is turned off for this connector (authentication mode: none).'
      )
      err.status = 400
      throw err
    }
    try {
      return await this._startSignIn(connector, scope)
    } catch (err) {
      // A connected connector keeps its status: only the step-up failed
      if (connector.status !== 'connected') {
        connector.status = 'error'
        connector.lastError = lastErrorFrom(
          err,
          'Sign-in could not start',
          'SIGN_IN_ERROR'
        )
        await connector.save()
      }
      throw err
    }
  }

  static async refresh(id, userId) {
    const connector = await this._find(id, userId)
    const credentials = await loadCredentials(connector._id)
    if (credentials.lost.length) {
      const next = await this.connect(connector, credentials)
      return { connector: toView(connector), next }
    }
    if (connector.oauth?.hasRefreshToken) {
      await refreshTokens({ connector }).catch(() => {})
    }
    const next = await this.connect(connector)
    await withSecretFlags(connector)
    return { connector: toView(connector), next }
  }

  static async disconnect(id, userId) {
    const connector = await this._find(id, userId)
    await saveCredentials(connector._id, userId, { tokens: null })
    connector.oauth.expiresAt = null
    connector.oauth.hasRefreshToken = false
    connector.oauth.grantedScopes = undefined
    connector.status = 'disconnected'
    await connector.save()
    await withSecretFlags(connector)
    return { connector: toView(connector) }
  }

  static async handleCallback(params) {
    const { connector } = await handleCallback(params)
    const next = await this.connect(connector)
    return { connector: toView(connector), next }
  }

  static async pendingConnectorId({ state, userId }) {
    return pendingConnectorId({ state, userId })
  }
}

/** A server's initialize info without its icons, for a response to the page. */
function withoutIcons(serverInfo) {
  if (!serverInfo) return serverInfo
  const info = { ...serverInfo }
  delete info.icons
  return info
}

export default ConnectorService
