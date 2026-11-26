import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import zlib from 'node:zlib'
import { pipeline } from 'node:stream'
import dns from 'node:dns'
import os from 'node:os'
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import { dockerHostGateway, isRunningInDocker } from '../DockerHost.mjs'

// What a refused destination says to the user and the model. The detail (which
// address, which rule) goes to the server log only, never to a reply.
const DESTINATION_REFUSED = 'destination not allowed'

export class ConnectorHeaders {
  constructor(init) {
    this._map = new Map()
    if (init) {
      if (init instanceof ConnectorHeaders || typeof init?.entries === 'function') {
        for (const [k, v] of init.entries()) {
          this.set(k, v)
        }
      } else if (Array.isArray(init)) {
        for (const [k, v] of init) {
          this.set(k, v)
        }
      } else if (typeof init === 'object') {
        for (const [k, v] of Object.entries(init)) {
          if (Array.isArray(v)) {
            this.set(k, v.join(', '))
          } else if (v !== undefined && v !== null) {
            this.set(k, String(v))
          }
        }
      }
    }
  }

  get(name) {
    return this._map.get(String(name).toLowerCase()) ?? null
  }

  has(name) {
    return this._map.has(String(name).toLowerCase())
  }

  set(name, value) {
    this._map.set(String(name).toLowerCase(), String(value))
  }

  delete(name) {
    this._map.delete(String(name).toLowerCase())
  }

  entries() {
    return this._map.entries()
  }

  keys() {
    return this._map.keys()
  }

  values() {
    return this._map.values()
  }

  forEach(callback, thisArg) {
    for (const [k, v] of this._map.entries()) {
      callback.call(thisArg, v, k, this)
    }
  }

  [Symbol.iterator]() {
    return this._map.entries()
  }

  raw() {
    const obj = {}
    for (const [k, v] of this._map.entries()) {
      obj[k] = v
    }
    return obj
  }
}

// Connectors may live anywhere the user can reach: the public internet, a
// LAN or a sibling container, over http or https. What they may not reach is
// this server itself (loopback, its own interface addresses) or the cloud
// metadata service, where the instance's internal services and credentials
// answer without asking who is calling.
const SELF_ADDRESSES = new net.BlockList()
for (const [prefix, bits] of [
  ['0.0.0.0', 8],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  // Alibaba Cloud's metadata service, in the shared address space
  ['100.100.100.200', 32],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) {
  SELF_ADDRESSES.addSubnet(prefix, bits, 'ipv4')
}
for (const [prefix, bits] of [
  // Unspecified, loopback and the deprecated IPv4-compatible ::a.b.c.d.
  ['::', 96],
  // IPv4-translated (::ffff:0:a.b.c.d) form, which can embed a loopback address
  ['::ffff:0:0:0', 96],
  // AWS's IPv6 metadata service (fd00:ec2::254), inside the ULA range
  ['fd00:ec2::254', 128],
  ['fe80::', 10],
  ['ff00::', 8],
]) {
  SELF_ADDRESSES.addSubnet(prefix, bits, 'ipv6')
}
const SELF_HOSTNAMES = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'instance-data',
])

function normalizeHost(raw) {
  return String(raw ?? '')
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '')
    .toLowerCase()
}

// Overleaf's own backing services (docstore, filestore, clsi, history,
// mongo, redis, ...) answer without authentication, so a connector must not
// reach them even when they run as sibling containers on the LAN.
function internalServiceHosts() {
  const hosts = new Set()
  const addHost = raw => {
    const host = normalizeHost(raw)
    if (!host) return
    hosts.add(host)
    if (net.isIP(host)) hosts.add(normalizeAddress(host))
  }
  const addUrl = url => {
    if (typeof url !== 'string') return
    // mongodb://user:pass@a:1,b:2/db may list several hosts
    const authority = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/?#]*)/i.exec(url)
    for (const entry of authority ? authority[1].split(',') : []) {
      const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(entry)
      const rawHost = bracketed ? bracketed[1] : entry.replace(/:\d+$/, '')
      addHost(rawHost)
    }
  }
  for (const api of Object.values(Settings.apis || {})) addUrl(api?.url)
  addUrl(Settings.mongo?.url)
  // The browser sidecar answers any page request made with its token
  addUrl(Settings.aiAssist?.browser?.url)
  for (const redis of Object.values(Settings.redis || {})) {
    if (typeof redis?.host === 'string') addHost(redis.host)
  }
  return hosts
}

let internalAddressCache = { expiresAt: 0, addresses: null }

/** IPs the internal service hosts resolve to, refreshed every minute. */
async function internalServiceAddresses() {
  if (internalAddressCache.expiresAt > Date.now()) {
    return internalAddressCache.addresses
  }
  const addresses = new Set()
  const recordIp = ip => {
    const lower = String(ip ?? '').toLowerCase()
    if (!lower) return
    addresses.add(lower)
    addresses.add(normalizeAddress(lower))
  }
  await Promise.all(
    [...internalServiceHosts()].map(async host => {
      if (net.isIP(host)) return recordIp(host)
      try {
        for (const { address } of await dns.promises.lookup(host, {
          all: true,
        })) {
          recordIp(address)
        }
      } catch {}
    })
  )
  internalAddressCache = { expiresAt: Date.now() + 60_000, addresses }
  return addresses
}

function interfaceAddresses() {
  const addresses = new Set()
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list || []) {
      addresses.add(entry.address.toLowerCase())
      addresses.add(normalizeAddress(entry.address))
    }
  }
  return addresses
}

/** The eight 16-bit groups of an IPv6 address, or null when it does not parse. */
function ipv6Groups(raw) {
  let text = raw
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text)
  if (dotted) {
    const o = dotted[1].split('.').map(Number)
    text = `${text.slice(0, dotted.index)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  let groups
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length
    if (fill < 1) return null
    groups = [...head, ...Array(fill).fill('0'), ...tail]
  } else {
    groups = head
  }
  if (groups.length !== 8) return null
  const values = groups.map(g => parseInt(g, 16))
  return values.every(v => Number.isInteger(v) && v >= 0 && v <= 0xffff)
    ? values
    : null
}

/**
 * The IPv4 address an IPv6 address carries in its tail: IPv4-mapped
 * (::ffff:a.b.c.d / 0:0:0:0:0:ffff:x:y), 6to4 (2002::/16), Teredo
 * (2001:0::/32, client address inverted), and well-known NAT64 (64:ff9b::/96).
 * The check runs on the address inside, so a wrapper cannot hide a private one.
 */
function embeddedIPv4(groups) {
  const dotted = (hi, lo) =>
    [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.')
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff
  ) {
    return dotted(groups[6], groups[7])
  }
  if (groups[0] === 0x2002) return dotted(groups[1], groups[2])
  if (groups[0] === 0x2001 && groups[1] === 0) {
    return dotted((~groups[6]) & 0xffff, (~groups[7]) & 0xffff)
  }
  if (
    groups[0] === 0x64 &&
    groups[1] === 0xff9b &&
    groups.slice(2, 6).every(g => g === 0)
  ) {
    return dotted(groups[6], groups[7])
  }
  return null
}

/** An IP address as the checks compare it: lower case, unwrapped from IPv4-mapped and tunnel forms. */
function normalizeAddress(address) {
  let raw = normalizeHost(address)
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(raw)
  if (mapped) raw = mapped[1]
  // A URL writes ::ffff:127.0.0.1 as ::ffff:7f00:1: the same address, unwrapped
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(raw)
  if (mappedHex) {
    const high = parseInt(mappedHex[1], 16)
    const low = parseInt(mappedHex[2], 16)
    raw = `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
  }
  if (net.isIPv6(raw)) {
    const groups = ipv6Groups(raw)
    const inner = groups ? embeddedIPv4(groups) : null
    if (inner) raw = inner
  }
  return raw
}

/** True when dialling `address` would land on this server or its metadata. */
export function isSelfAddress(address) {
  const raw = normalizeAddress(address)
  const family = net.isIP(raw)
  if (!family) return true
  if (SELF_ADDRESSES.check(raw, family === 4 ? 'ipv4' : 'ipv6')) return true
  // RFC 8215 local-use NAT64 (64:ff9b:1::/48) can embed a loopback/self IPv4
  if (family === 6) {
    const groups = ipv6Groups(raw)
    if (
      groups &&
      groups[0] === 0x64 &&
      groups[1] === 0xff9b &&
      groups[2] === 0x1
    ) {
      const inner = [
        groups[6] >> 8,
        groups[6] & 255,
        groups[7] >> 8,
        groups[7] & 255,
      ].join('.')
      if (SELF_ADDRESSES.check(inner, 'ipv4')) return true
    }
  }
  return interfaceAddresses().has(raw)
}

// Private and LAN addresses. A user-supplied connector, search endpoint or
// provider may never reach one; admin-configured server endpoints are exempt
// only when the caller explicitly passes allowAdminEndpoint / trustedEndpoint.
const PRIVATE_ADDRESSES = new net.BlockList()
for (const [prefix, bits] of [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  // Carrier-grade NAT, which a cloud provider may place a host behind
  ['100.64.0.0', 10],
  // IETF protocol assignments & benchmarking
  ['192.0.0.0', 24],
  ['198.18.0.0', 15],
]) {
  PRIVATE_ADDRESSES.addSubnet(prefix, bits, 'ipv4')
}
for (const [prefix, bits] of [
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['100::', 64],
  ['64:ff9b:1::', 48],
]) {
  PRIVATE_ADDRESSES.addSubnet(prefix, bits, 'ipv6')
}

/** True for a private or LAN address, including the docker host gateway. */
export function isPrivateAddress(address) {
  const raw = normalizeAddress(address)
  // The gateway resolveDockerHostUrl maps localhost to, only inside Docker
  if (isRunningInDocker() && raw === normalizeAddress(dockerHostGateway())) {
    return true
  }
  const family = net.isIP(raw)
  if (!family) return false
  return PRIVATE_ADDRESSES.check(raw, family === 4 ? 'ipv4' : 'ipv6')
}

// Server-side web-search URLs an admin configures in the environment. A private
// address is trusted only at the exact 'host:port' the admin named, and only
// when the caller explicitly passes allowAdminEndpoint: true.
const ADMIN_URL_ENV_NAMES = [
  'AI_ASSIST_SEARXNG_URLS',
  'AI_ASSIST_FIRECRAWL_SELFHOSTED_URLS',
  'AI_ASSIST_MCP_URLS',
]

/** Exact 'host:port' endpoints of the admin-configured server web-search URLs. */
function adminTrustedEndpoints() {
  const endpoints = new Set()
  for (const name of ADMIN_URL_ENV_NAMES) {
    for (const raw of String(process.env[name] || '').split(',')) {
      try {
        const parsed = new URL(raw.trim())
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue
        endpoints.add(endpointOf(parsed))
      } catch {}
    }
  }
  return endpoints
}

/** The origin of a URL, or null when it does not parse. */
export function originOf(url) {
  try {
    return new URL(String(url)).origin
  } catch {
    return null
  }
}

/** 'host:port' of a URL, lower case, with the scheme's default port when none is written. */
function endpointOf(parsed) {
  const host = normalizeHost(parsed.hostname)
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80')
  return `${host}:${port}`
}

/**
 * The private endpoints an admin trusts for providers, from
 * Settings.aiAssist.trustedProviderHosts ('host:port' each). Only the private
 * check is lifted for them: loopback, this server, and the metadata services
 * stay refused whatever is listed.
 */
export function trustedProviderEndpoints() {
  const endpoints = new Set()
  for (const entry of Settings.aiAssist?.trustedProviderHosts || []) {
    const match = /^(\[[^\]]+\]|[^:\s]+):(\d{1,5})$/.exec(String(entry).trim())
    if (!match) continue
    try {
      const parsed = new URL(`http://${match[1]}:${Number(match[2])}`)
      endpoints.add(endpointOf(parsed))
    } catch {
      const host = normalizeHost(match[1])
      if (host) endpoints.add(`${host}:${Number(match[2])}`)
    }
  }
  return endpoints
}

/**
 * Checks a URL before it is dialled. `trusted` lets a provider reach an
 * admin-trusted private 'host:port' (see trustedProviderEndpoints).
 * `allowAdminEndpoint` lets server-mode web search reach an exact 'host:port'
 * configured in ADMIN_URL_ENV_NAMES.
 */
export function validateConnectorUrl(
  rawUrl,
  { trusted = false, allowAdminEndpoint = false } = {}
) {
  let parsed
  try {
    parsed = new URL(String(rawUrl).trim())
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Invalid protocol ${parsed.protocol}: only http and https are allowed`
    )
  }
  if (parsed.username || parsed.password) {
    throw new Error('URLs with embedded credentials are not allowed')
  }
  const host = normalizeHost(parsed.hostname)
  const endpoint = endpointOf(parsed)
  const internalHosts = internalServiceHosts()
  if (
    SELF_HOSTNAMES.has(host) ||
    internalHosts.has(host) ||
    (net.isIP(host) && internalHosts.has(normalizeAddress(host))) ||
    host.endsWith('.localhost') ||
    (net.isIP(host) && isSelfAddress(host))
  ) {
    logger.warn({ host }, '[AiAssist] connector URL refused: points at this server')
    throw new Error(DESTINATION_REFUSED)
  }
  // A name is checked when it is dialled, at the address it resolves to; an
  // address written out is checked here
  const trustedHere =
    (trusted && trustedProviderEndpoints().has(endpoint)) ||
    (allowAdminEndpoint && adminTrustedEndpoints().has(endpoint))
  if (net.isIP(host) && !trustedHere && isPrivateAddress(host)) {
    logger.warn({ host }, '[AiAssist] connector URL refused: private address')
    throw new Error(DESTINATION_REFUSED)
  }
  return { parsed }
}

/** `dns.lookup` that refuses an answer pointing back at this server, or at an untrusted private address. */
export function connectorLookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options
    options = {}
  } else if (typeof options === 'number') {
    options = { family: options }
  }
  // A provider or server-web-search call names its 'host:port' so an
  // admin-trusted private one passes
  const { trustedEndpoint, adminEndpoint, ...lookupOptions } = options ?? {}
  const trustedHere =
    (typeof trustedEndpoint === 'string' &&
      trustedProviderEndpoints().has(trustedEndpoint)) ||
    (typeof adminEndpoint === 'string' &&
      adminTrustedEndpoints().has(adminEndpoint))
  dns.lookup(hostname, { ...lookupOptions, all: true }, (err, addresses) => {
    if (err) return callback(err)
    const list = Array.isArray(addresses) ? addresses : []
    internalServiceAddresses().then(internal => {
      const blocked = list.find(
        entry =>
          isSelfAddress(entry.address) ||
          internal.has(entry.address.toLowerCase()) ||
          internal.has(normalizeAddress(entry.address)) ||
          (!trustedHere && isPrivateAddress(entry.address))
      )
      if (list.length === 0 || blocked) {
        logger.warn(
          {
            hostname,
            address: blocked?.address ?? null,
            private: blocked ? isPrivateAddress(blocked.address) : false,
          },
          '[AiAssist] connector destination refused'
        )
        const error = new Error(DESTINATION_REFUSED)
        error.code = 'EADDRBLOCKED'
        return callback(error)
      }
      if (lookupOptions?.all) return callback(null, list)
      callback(null, list[0].address, list[0].family)
    }, callback)
  })
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

const CROSS_ORIGIN_SAFE_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'content-type',
  'mcp-protocol-version',
  'user-agent',
])

// A response body larger than this (after decompression) is refused.
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024

/**
 * Makes a request to a connector, search or provider endpoint. The address is
 * vetted by `lookup` (connectorLookup by default) and dialled as that same
 * answer, so a DNS change between check and connect cannot redirect the socket.
 *
 * Options: method, headers, body, signal, redirect ('manual' returns a redirect
 * unfollowed), timeoutMs (socket idle), deadlineMs (wall clock for the whole
 * call, redirects and body reads included), maxResponseBytes, lookup,
 * trustedEndpoint (a provider call: admin-trusted private endpoints allowed).
 */
export async function connectorFetch(url, options = {}) {
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  const lookup = options.lookup ?? connectorLookup
  let currentUrlStr = String(url)
  let currentMethod = (options.method || 'GET').toUpperCase()
  let currentHeaders = new ConnectorHeaders(options.headers)
  let currentBody = options.body

  if (!currentHeaders.has('accept-encoding')) {
    currentHeaders.set('accept-encoding', 'gzip, deflate, br')
  }

  // One deadline for the whole call. It stays armed while the body is read, so
  // a server that drips bytes slowly is cut off even though each byte resets
  // the socket's idle timer.
  const deadline = new AbortController()
  const deadlineTimer =
    options.deadlineMs > 0
      ? setTimeout(() => {
          deadline.abort(
            Object.assign(
              new Error(`Request exceeded its ${options.deadlineMs}ms deadline`),
              { code: 'ETIMEDOUT' }
            )
          )
        }, options.deadlineMs)
      : null
  deadlineTimer?.unref?.()
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline.signal])
    : deadline.signal
  // Whichever way the call ends, the deadline stops once the body is gone
  const stopDeadline = () => clearTimeout(deadlineTimer)

  const visited = new Set()
  let redirectCount = 0
  const trusted = options.trustedEndpoint === true
  const allowAdminEndpoint = options.allowAdminEndpoint === true

  try {
    while (true) {
      const { parsed: currentUrl } = validateConnectorUrl(currentUrlStr, {
        trusted,
        allowAdminEndpoint,
      })

      if (visited.has(currentUrl.href)) {
        throw new Error(`Redirect loop detected: ${currentUrl.href}`)
      }
      visited.add(currentUrl.href)

      // Node skips custom `lookup` for IP literals, so check internal service IPs
      // explicitly before opening the socket.
      const host = normalizeHost(currentUrl.hostname)
      if (net.isIP(host)) {
        const internal = await internalServiceAddresses()
        if (internal.has(host) || internal.has(normalizeAddress(host))) {
          logger.warn({ host }, '[AiAssist] connector URL refused: internal service IP')
          throw new Error(DESTINATION_REFUSED)
        }
      }

      const response = await new Promise((resolve, reject) => {
        const transport = currentUrl.protocol === 'https:' ? https : http
        const reqHeaders = currentHeaders.raw()

        // The lookup learns which 'host:port' it serves, for the trust check
        const endpoint =
          trusted || allowAdminEndpoint ? endpointOf(currentUrl) : null
        const lookupForCall = endpoint
          ? (hostname, lookupOptions, cb) =>
              lookup(
                hostname,
                {
                  ...(lookupOptions && typeof lookupOptions === 'object'
                    ? lookupOptions
                    : {}),
                  ...(trusted ? { trustedEndpoint: endpoint } : {}),
                  ...(allowAdminEndpoint ? { adminEndpoint: endpoint } : {}),
                },
                cb
              )
          : lookup

        const reqOptions = {
          method: currentMethod,
          headers: reqHeaders,
          agent: false,
          signal,
          lookup: lookupForCall,
        }

        const req = transport.request(currentUrl, reqOptions, res => {
          const status = res.statusCode ?? 0
          const isRedirect =
            REDIRECT_STATUSES.has(status) &&
            res.headers.location &&
            options.redirect !== 'manual'

          if (isRedirect) {
            res.resume()
            redirectCount++
            if (redirectCount > 20) {
              return reject(new Error('Too many redirects'))
            }

            let nextUrl
            try {
              nextUrl = new URL(res.headers.location, currentUrl)
            } catch {
              return reject(new Error('Invalid redirect location'))
            }

            // Never forward credentials (Authorization, cookies, the
            // connector's custom API-key headers) or a POST/PUT body to a
            // different origin
            if (nextUrl.origin !== currentUrl.origin) {
              for (const name of [...currentHeaders.keys()]) {
                if (!CROSS_ORIGIN_SAFE_HEADERS.has(name)) {
                  currentHeaders.delete(name)
                }
              }
              if (
                (status === 307 || status === 308) &&
                currentBody !== undefined
              ) {
                return reject(
                  new Error('Cross-origin redirect with request body refused')
                )
              }
            }

            if (status === 303) {
              currentMethod = 'GET'
              currentBody = undefined
              currentHeaders.delete('content-length')
              currentHeaders.delete('content-type')
            } else if (
              (status === 301 || status === 302) &&
              currentMethod === 'POST'
            ) {
              currentMethod = 'GET'
              currentBody = undefined
              currentHeaders.delete('content-length')
              currentHeaders.delete('content-type')
            }

            currentUrlStr = nextUrl.href
            return resolve({ redirect: true })
          }

          let bodyStream = res
          const encoding = String(res.headers['content-encoding'] || '')
            .trim()
            .toLowerCase()
          let decoder = null
          if (encoding === 'gzip' || encoding === 'x-gzip') {
            decoder = zlib.createGunzip()
          } else if (encoding === 'deflate') {
            decoder = zlib.createInflate()
          } else if (encoding === 'br') {
            decoder = zlib.createBrotliDecompress()
          }
          if (decoder) {
            // pipeline, unlike pipe, carries a socket error on to the decoder
            // so a reader of the body fails instead of waiting forever.
            bodyStream = pipeline(res, decoder, () => {})
          }

          let cachedText
          const responseHeaders = new ConnectorHeaders(res.headers)
          const responseObj = {
            status,
            statusText: res.statusMessage || '',
            ok: status >= 200 && status < 300,
            headers: responseHeaders,
            url: currentUrl.href,
            body: bodyStream,
            async text() {
              if (cachedText !== undefined) return cachedText
              const chunks = []
              let size = 0
              for await (const chunk of bodyStream) {
                const buf =
                  typeof chunk === 'string' ? Buffer.from(chunk) : chunk
                size += buf.length
                if (maxResponseBytes > 0 && size > maxResponseBytes) {
                  bodyStream.destroy()
                  throw new Error(
                    `Response body exceeds ${maxResponseBytes} bytes`
                  )
                }
                chunks.push(buf)
              }
              cachedText = Buffer.concat(chunks).toString('utf8')
              return cachedText
            },
            async json() {
              const txt = await this.text()
              return JSON.parse(txt)
            },
          }

          // The deadline reaches the body too: a stream past it fails with the
          // deadline error rather than hanging
          const onDeadline = () => res.destroy(deadline.signal.reason)
          deadline.signal.addEventListener('abort', onDeadline, { once: true })
          res.once('close', () => {
            deadline.signal.removeEventListener('abort', onDeadline)
            stopDeadline()
          })

          resolve(responseObj)
        })

        if (options.timeoutMs) {
          req.setTimeout(options.timeoutMs, () => {
            // ETIMEDOUT: the retry layer treats it as a timed-out connection
            const error = new Error(
              `Request timed out after ${options.timeoutMs}ms`
            )
            error.code = 'ETIMEDOUT'
            req.destroy(error)
          })
        }

        req.on('error', err =>
          reject(
            deadline.signal.aborted && !options.signal?.aborted
              ? deadline.signal.reason
              : err
          )
        )

        if (currentBody) {
          if (typeof currentBody === 'string' || Buffer.isBuffer(currentBody)) {
            req.write(currentBody)
            req.end()
          } else if (typeof currentBody.pipe === 'function') {
            currentBody.pipe(req)
          } else {
            req.write(String(currentBody))
            req.end()
          }
        } else {
          req.end()
        }
      })

      if (!response.redirect) {
        return response
      }
    }
  } catch (err) {
    stopDeadline()
    throw err
  }
}

/**
 * The socket's idle limit for a provider call. It is a backstop behind the
 * stream idle timer and the connect timer (both in AiAssistProviders), so it
 * never fires first: at least the stream idle limit, and at least the connect
 * limit, which a slow header wait (Ollama loading a model) can need.
 */
export function providerSocketTimeoutMs() {
  const idleMs = (Settings.aiAssist?.streamIdleSeconds ?? 300) * 1000
  const connectMs = (Settings.aiAssist?.requestTimeoutSeconds ?? 180) * 1000
  return Math.max(idleMs, connectMs)
}

/**
 * The fetch-shaped call the AI providers make. It goes through connectorFetch,
 * so the address checked is the address dialled (the lookup is pinned), and the
 * body streams. A provider's reply has no reason to move, so a redirect is
 * refused unless the caller asks to follow it.
 */
export async function providerFetch(url, init = {}) {
  const { redirect = 'error', timeoutMs = providerSocketTimeoutMs(), ...rest } = init
  const response = await connectorFetch(url, {
    ...rest,
    timeoutMs,
    trustedEndpoint: true,
    redirect: redirect === 'follow' ? undefined : 'manual',
  })
  if (
    redirect === 'error' &&
    REDIRECT_STATUSES.has(response.status) &&
    response.headers.has('location')
  ) {
    response.body?.destroy?.()
    const error = new Error('The provider redirected a request, which is refused')
    error.code = 'EREDIRECTREFUSED'
    throw error
  }
  return response
}

export default connectorFetch
