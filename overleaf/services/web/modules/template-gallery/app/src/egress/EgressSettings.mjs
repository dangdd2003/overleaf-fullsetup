import crypto from 'node:crypto'
import net from 'node:net'
import { configCol } from '../persistence/Collections.mjs'
import {
  decryptSecret,
  encryptSecret,
  hasConfiguredSecret,
} from '../crypto/SecretBox.mjs'
import { isMetadataAddress } from '../transport/EgressTunnel.mjs'
import { logWarn } from '../observability/Log.mjs'

// Outbound proxies for the gallery's requests to overleaf.com, algolia and S3.
// Config lives in the templateGalleryConfig collection, document 'egressProxies'.
// A missing document means direct only. Proxy logins are sealed with the same
// key as the session cookie; nothing returned to the admin contains them.

export const EGRESS_DOC_ID = 'egressProxies'
export const MAX_PROXIES = 20
export const SNAPSHOT_REFRESH_MS = 30_000
export const SCHEMES = Object.freeze(['http', 'https', 'socks5', 'socks5h'])

const MAX_LABEL_LENGTH = 60
const MAX_HOST_LENGTH = 253
const MAX_LOGIN_BYTES = 255
const MAX_BULK_TEXT_BYTES = 20 * 1024
const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/
// URL schemes accepted in a bulk list, mapped to the stored scheme
const BULK_SCHEMES = Object.freeze({
  http: 'http',
  https: 'https',
  socks: 'socks5',
  socks5: 'socks5',
  socks5h: 'socks5h',
})
// socks has no default port: a bulk line must name one
const BULK_DEFAULT_PORTS = Object.freeze({ http: 80, https: 443 })
// Matches the login of a token, so it can be hidden in error output
const LOGIN_IN_TOKEN = /^((?:[a-z][a-z0-9+.-]*:\/\/)?[^:/?#@]*:)[^/?#]*@/i

// In-memory copy read by the host limiter, which needs it synchronously.
const state = {
  useDirect: true,
  egresses: [],
  checkedAt: 0,
  refreshing: null,
}

function codedError(code, message = code) {
  const err = new Error(message)
  err.code = code
  return err
}

function newProxyId() {
  return `px_${crypto.randomBytes(6).toString('hex')}`
}

// Two proxies with the same key are the same endpoint
function endpointKey({ scheme, host, port }) {
  return `${scheme}://${host.toLowerCase()}:${port}`
}

// A public proxy needs an IP address or a dotted domain name; a single-label
// name (localhost, a container name) can only be a private-network proxy.
function normalizeHost(value, { allowPrivate = false } = {}) {
  if (typeof value !== 'string') throw codedError('invalid_host')
  const host = value.trim().replace(/^\[|\]$/g, '')
  if (!host || host.length > MAX_HOST_LENGTH) throw codedError('invalid_host')
  if (net.isIP(host) === 0) {
    if (!HOST_PATTERN.test(host)) throw codedError('invalid_host')
    if (!host.includes('.') && !allowPrivate) throw codedError('invalid_host')
  }
  if (isMetadataAddress(host)) throw codedError('invalid_host')
  return host
}

// Label, scheme, host, port and flags. Missing keys keep the current value.
function normalizeFields(input, current) {
  const pick = key => (input[key] !== undefined ? input[key] : current?.[key])

  const scheme = pick('scheme')
  if (!SCHEMES.includes(scheme)) throw codedError('invalid_scheme')

  const port = pick('port')
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw codedError('invalid_port')
  }

  const label = pick('label') ?? ''
  if (typeof label !== 'string' || label.trim().length > MAX_LABEL_LENGTH) {
    throw codedError('invalid_label')
  }

  const enabled = pick('enabled') ?? true
  const allowPrivate = pick('allowPrivate') ?? false
  if (typeof enabled !== 'boolean' || typeof allowPrivate !== 'boolean') {
    throw codedError('invalid_flag')
  }

  return {
    label: label.trim(),
    scheme,
    host: normalizeHost(pick('host'), { allowPrivate }),
    port,
    enabled,
    allowPrivate,
  }
}

function validateLogin(username, password) {
  for (const value of [username, password]) {
    if (
      typeof value !== 'string' ||
      CONTROL_CHARS.test(value) ||
      Buffer.byteLength(value, 'utf8') > MAX_LOGIN_BYTES
    ) {
      throw codedError('invalid_login')
    }
  }
}

function sealLogin(username, password) {
  if (!hasConfiguredSecret()) throw codedError('secret_not_configured')
  validateLogin(username, password)
  return encryptSecret(JSON.stringify({ username, password }))
}

function openLogin(payload) {
  return JSON.parse(decryptSecret(payload))
}

// Login for a new proxy: none when neither field is given.
function loginForCreate(input) {
  const username = typeof input.username === 'string' ? input.username.trim() : ''
  const password = typeof input.password === 'string' ? input.password : ''
  if (!username && !password) return null
  return sealLogin(username, password)
}

// Login after an update. Omitted fields keep the stored value; an empty
// password clears the login entirely.
function loginForUpdate(input, current) {
  if (input.username === undefined && input.password === undefined) {
    return current.authEnc ?? null
  }
  if (input.password === '') return null
  const stored = current.authEnc ? openLogin(current.authEnc) : {}
  const username =
    input.username !== undefined
      ? String(input.username ?? '').trim()
      : stored.username || ''
  const password =
    input.password !== undefined ? input.password : stored.password || ''
  if (!username && !password) return null
  return sealLogin(username, password)
}

function toView(proxy) {
  return {
    id: proxy.id,
    label: proxy.label || proxy.host,
    scheme: proxy.scheme,
    host: proxy.host,
    port: proxy.port,
    enabled: proxy.enabled,
    allowPrivate: proxy.allowPrivate,
    hasAuth: Boolean(proxy.authEnc),
  }
}

// The decrypted form used for connections. Never sent to the admin UI.
function toEgress(proxy) {
  const login = proxy.authEnc ? openLogin(proxy.authEnc) : {}
  return {
    id: proxy.id,
    label: proxy.label || proxy.host,
    scheme: proxy.scheme,
    host: proxy.host,
    port: proxy.port,
    allowPrivate: proxy.allowPrivate,
    username: login.username || null,
    password: login.password || null,
  }
}

function applyDoc(doc) {
  state.useDirect = doc?.useDirect !== false
  state.egresses = (doc?.proxies || [])
    .filter(proxy => proxy.enabled)
    .flatMap(proxy => {
      try {
        return [toEgress(proxy)]
      } catch (err) {
        logWarn('tg_egress_unreadable', { id: proxy.id, err: err.message })
        return []
      }
    })
  state.checkedAt = Date.now()
}

// Something usable must remain, or the mirror would have no route at all.
function ensureUsable({ useDirect, proxies }) {
  if (!useDirect && !proxies.some(proxy => proxy.enabled)) {
    throw codedError('no_egress')
  }
}

async function readDoc() {
  const col = await configCol()
  return col.findOne({ _id: EGRESS_DOC_ID })
}

/**
 * Reads the stored config and replaces the in-memory copy.
 */
export function refresh() {
  if (!state.refreshing) {
    state.checkedAt = Date.now()
    state.refreshing = readDoc()
      .then(applyDoc)
      .catch(err => {
        logWarn('tg_egress_refresh_failed', { err: err.message })
      })
      .finally(() => {
        state.refreshing = null
      })
  }
  return state.refreshing
}

/**
 * Synchronous view for the host limiter: whether direct is on and the enabled
 * proxies, decrypted. Starts a background refresh once the copy is 30 s old.
 *
 * @returns {{ useDirect: boolean, egresses: Array<object> }}
 */
export function snapshot() {
  if (Date.now() - state.checkedAt >= SNAPSHOT_REFRESH_MS) {
    void refresh()
  }
  return { useDirect: state.useDirect, egresses: state.egresses }
}

/**
 * Stored config without secrets: hasAuth says whether a login is set.
 */
export async function view() {
  const doc = await readDoc()
  applyDoc(doc)
  return {
    useDirect: state.useDirect,
    proxies: (doc?.proxies || []).map(toView),
  }
}

// Read-modify-write with a version compare-and-set. Two admins saving at once
// cannot overwrite each other: the loser gets version_conflict.
async function commit(mutate) {
  const col = await configCol()
  const current = await col.findOne({ _id: EGRESS_DOC_ID })
  const base = {
    useDirect: current?.useDirect !== false,
    proxies: current?.proxies || [],
  }
  const next = mutate(base)
  // Nothing to change: no write, no version bump
  if (next === base) return view()
  ensureUsable(next)

  const version = (current?.version || 0) + 1
  const fields = {
    useDirect: next.useDirect,
    proxies: next.proxies,
    version,
    updatedAt: new Date(),
  }
  if (current) {
    const result = await col.updateOne(
      { _id: EGRESS_DOC_ID, version: current.version },
      { $set: fields }
    )
    if (result.matchedCount === 0) throw codedError('version_conflict')
  } else {
    const result = await col.updateOne(
      { _id: EGRESS_DOC_ID },
      { $setOnInsert: fields },
      { upsert: true }
    )
    if (result.upsertedCount !== 1) throw codedError('version_conflict')
  }
  applyDoc({ ...fields })
  return view()
}

/**
 * Turns direct connections on or off. Refused when that would leave no route.
 */
export function setUseDirect(useDirect) {
  if (typeof useDirect !== 'boolean') throw codedError('invalid_direct')
  return commit(base => ({ ...base, useDirect }))
}

/**
 * Adds a proxy. Input: { label?, scheme, host, port, username?, password?,
 * enabled?, allowPrivate? }.
 */
export function createProxy(input) {
  return commit(base => {
    if (base.proxies.length >= MAX_PROXIES) throw codedError('proxy_limit')
    const now = new Date()
    const fields = normalizeFields(input, null)
    if (base.proxies.some(proxy => endpointKey(proxy) === endpointKey(fields))) {
      throw codedError('duplicate')
    }
    const proxy = {
      id: newProxyId(),
      ...fields,
      authEnc: loginForCreate(input),
      createdAt: now,
      updatedAt: now,
    }
    return { ...base, proxies: [...base.proxies, proxy] }
  }).then(async view => ({
    view,
    proxy: view.proxies.at(-1),
  }))
}

/**
 * Changes a proxy. Omitted fields keep their value; password '' clears login.
 */
export function updateProxy(id, input) {
  return commit(base => {
    const index = base.proxies.findIndex(proxy => proxy.id === id)
    if (index === -1) throw codedError('not_found')
    const current = base.proxies[index]
    const updated = {
      ...current,
      ...normalizeFields(input, current),
      authEnc: loginForUpdate(input, current),
      updatedAt: new Date(),
    }
    const key = endpointKey(updated)
    if (base.proxies.some((proxy, i) => i !== index && endpointKey(proxy) === key)) {
      throw codedError('duplicate')
    }
    const proxies = base.proxies.map((proxy, i) => (i === index ? updated : proxy))
    return { ...base, proxies }
  }).then(view => ({
    view,
    proxy: view.proxies.find(proxy => proxy.id === id),
  }))
}

// Splits a pasted list into [{ line, position, token }]. Blank lines and lines
// starting with '#' are skipped; a line may hold several addresses separated by
// commas. position is the 0-based index of the token among all tokens, so the
// admin form can tell which addresses were rejected. An address containing
// spaces is kept whole, so it is reported as invalid instead of being split
// into words that could parse as addresses.
function bulkTokens(text) {
  const tokens = []
  text.split(/\r\n|\r|\n/).forEach((raw, index) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    for (const part of line.split(',')) {
      const token = part.trim()
      if (token) tokens.push({ line: index + 1, position: tokens.length, token })
    }
  })
  return tokens
}

function decodeUrlPart(value, code) {
  try {
    return decodeURIComponent(value)
  } catch {
    throw codedError(code)
  }
}

// The fields of one proxy URL, as createProxy takes them. Throws invalid_url,
// invalid_scheme or invalid_login.
function parseProxyUrl(token) {
  if (/\s/.test(token)) throw codedError('invalid_url')
  let url
  try {
    url = new URL(token)
  } catch {
    throw codedError('invalid_url')
  }
  const key = url.protocol.slice(0, -1)
  const scheme = Object.hasOwn(BULK_SCHEMES, key) ? BULK_SCHEMES[key] : null
  if (!scheme) throw codedError('invalid_scheme')
  return {
    label: decodeUrlPart(url.hash.slice(1), 'invalid_url'),
    scheme,
    host: url.hostname,
    port: url.port ? Number(url.port) : BULK_DEFAULT_PORTS[scheme],
    username: decodeUrlPart(url.username, 'invalid_login'),
    password: decodeUrlPart(url.password, 'invalid_login'),
  }
}

// The token as it may be shown back to the admin, with any password hidden
function redactLogin(token) {
  return token.replace(LOGIN_IN_TOKEN, '$1***@')
}

/**
 * Adds every proxy in a pasted list, one URL per token, e.g.
 * socks5://user:pass@host:1080#office. Valid lines are saved in one write;
 * the others are reported with their line number and an error code.
 *
 * @param {string} text
 * @param {{ allowPrivate?: boolean }} [options]
 * @returns {Promise<{ added: Array<object>, errors: Array<{ line: number, position: number, input: string, error: string }> }>}
 */
export async function createProxiesFromText(text, { allowPrivate = false } = {}) {
  if (
    typeof text !== 'string' ||
    Buffer.byteLength(text, 'utf8') > MAX_BULK_TEXT_BYTES
  ) {
    throw codedError('invalid_text')
  }
  if (typeof allowPrivate !== 'boolean') throw codedError('invalid_flag')

  const errors = []
  let addedIds = []
  const current = await commit(base => {
    const keys = new Set(base.proxies.map(endpointKey))
    const added = []
    for (const { line, position, token } of bulkTokens(text)) {
      try {
        const input = { ...parseProxyUrl(token), allowPrivate }
        const fields = normalizeFields(input, null)
        const key = endpointKey(fields)
        if (keys.has(key)) throw codedError('duplicate')
        if (base.proxies.length + added.length >= MAX_PROXIES) {
          throw codedError('proxy_limit')
        }
        const now = new Date()
        added.push({
          id: newProxyId(),
          ...fields,
          authEnc: loginForCreate(input),
          createdAt: now,
          updatedAt: now,
        })
        keys.add(key)
      } catch (err) {
        if (!err.code) throw err
        errors.push({
          line,
          position,
          input: redactLogin(token),
          error: err.code,
        })
      }
    }
    addedIds = added.map(proxy => proxy.id)
    if (added.length === 0) return base
    return { ...base, proxies: [...base.proxies, ...added] }
  })
  return {
    added: current.proxies.filter(proxy => addedIds.includes(proxy.id)),
    errors,
  }
}

export function deleteProxy(id) {
  return commit(base => {
    if (!base.proxies.some(proxy => proxy.id === id)) {
      throw codedError('not_found')
    }
    return {
      ...base,
      proxies: base.proxies.filter(proxy => proxy.id !== id),
    }
  })
}

/**
 * Decrypted form of one stored proxy, enabled or not. Used only for the admin
 * connection test; resolves to null when the id is unknown.
 */
export async function findProxyEgress(id) {
  const doc = await readDoc()
  const proxy = (doc?.proxies || []).find(item => item.id === id)
  return proxy ? toEgress(proxy) : null
}

/**
 * Drops the in-memory copy. Tests only.
 */
export function resetEgressSettingsForTests() {
  state.useDirect = true
  state.egresses = []
  state.checkedAt = 0
  state.refreshing = null
}

export default {
  EGRESS_DOC_ID,
  MAX_PROXIES,
  SNAPSHOT_REFRESH_MS,
  refresh,
  snapshot,
  view,
  setUseDirect,
  createProxy,
  updateProxy,
  createProxiesFromText,
  deleteProxy,
  findProxyEgress,
  resetEgressSettingsForTests,
}
