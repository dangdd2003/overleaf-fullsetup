import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import zlib from 'node:zlib'
import { pipeline } from 'node:stream'
import dns from 'node:dns'
import os from 'node:os'
import Settings from '@overleaf/settings'

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

// Overleaf's own backing services (docstore, filestore, clsi, history,
// mongo, redis, ...) answer without authentication, so a connector must not
// reach them even when they run as sibling containers on the LAN.
function internalServiceHosts() {
  const hosts = new Set()
  const addUrl = url => {
    if (typeof url !== 'string') return
    // mongodb://user:pass@a:1,b:2/db may list several hosts
    const authority = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/?#]*)/i.exec(url)
    for (const entry of authority ? authority[1].split(',') : []) {
      const host = entry.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
      if (host) hosts.add(host.toLowerCase())
    }
  }
  for (const api of Object.values(Settings.apis || {})) addUrl(api?.url)
  addUrl(Settings.mongo?.url)
  // The browser sidecar answers any page request made with its token
  addUrl(Settings.aiAssist?.browser?.url)
  for (const redis of Object.values(Settings.redis || {})) {
    if (typeof redis?.host === 'string') hosts.add(redis.host.toLowerCase())
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
  await Promise.all(
    [...internalServiceHosts()].map(async host => {
      if (net.isIP(host)) return addresses.add(host)
      try {
        for (const { address } of await dns.promises.lookup(host, {
          all: true,
        })) {
          addresses.add(address.toLowerCase())
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
    for (const entry of list || []) addresses.add(entry.address.toLowerCase())
  }
  return addresses
}

/** An IP address as the checks compare it: lower case, unwrapped from IPv4-mapped forms. */
function normalizeAddress(address) {
  let raw = String(address ?? '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(raw)
  if (mapped) raw = mapped[1]
  // A URL writes ::ffff:127.0.0.1 as ::ffff:7f00:1: the same address, unwrapped
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(raw)
  if (mappedHex) {
    const high = parseInt(mappedHex[1], 16)
    const low = parseInt(mappedHex[2], 16)
    raw = `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
  }
  return raw
}

/** True when dialling `address` would land on this server or its metadata. */
export function isSelfAddress(address) {
  const raw = normalizeAddress(address)
  const family = net.isIP(raw)
  if (!family) return true
  if (SELF_ADDRESSES.check(raw, family === 4 ? 'ipv4' : 'ipv6')) return true
  return interfaceAddresses().has(raw)
}

// Private and LAN addresses. A user-supplied connector, search endpoint or
// provider may never reach one; admin-configured server URLs are exempt.
const PRIVATE_ADDRESSES = new net.BlockList()
for (const [prefix, bits] of [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  // Carrier-grade NAT, which a cloud provider may place a host behind
  ['100.64.0.0', 10],
]) {
  PRIVATE_ADDRESSES.addSubnet(prefix, bits, 'ipv4')
}
PRIVATE_ADDRESSES.addSubnet('fc00::', 7, 'ipv6')
PRIVATE_ADDRESSES.addSubnet('fe80::', 10, 'ipv6')

/** The docker host gateway that resolveDockerHostUrl maps localhost to. */
function dockerGatewayAddress() {
  return normalizeAddress(process.env.DOCKER_HOST_GATEWAY || '172.20.0.1')
}

/** True for a private or LAN address, including the docker host gateway. */
export function isPrivateAddress(address) {
  const raw = normalizeAddress(address)
  if (raw === dockerGatewayAddress()) return true
  const family = net.isIP(raw)
  if (!family) return false
  return PRIVATE_ADDRESSES.check(raw, family === 4 ? 'ipv4' : 'ipv6')
}

// Server-side URLs an admin configures in the environment. A private address
// is trusted only when the admin named it there; a user-typed URL never is.
const ADMIN_URL_ENV_NAMES = [
  'AI_ASSIST_SEARXNG_URLS',
  'AI_ASSIST_FIRECRAWL_SELFHOSTED_URLS',
  'AI_ASSIST_MCP_URLS',
  'AI_ASSIST_BROWSER_URL',
]

/** The hosts (names or IP literals) of the admin-configured server URLs. */
function adminTrustedHosts() {
  const hosts = new Set()
  for (const name of ADMIN_URL_ENV_NAMES) {
    for (const raw of String(process.env[name] || '').split(',')) {
      try {
        const host = new URL(raw.trim()).hostname
          .replace(/^\[|\]$/g, '')
          .toLowerCase()
        if (host) hosts.add(host)
      } catch {}
    }
  }
  return hosts
}

/** True when the admin named the hostname, or the address it resolved to. */
export function isAdminTrustedPrivateDestination(hostname, address) {
  const trusted = adminTrustedHosts()
  const host = String(hostname ?? '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
  return trusted.has(host) || trusted.has(normalizeAddress(address))
}

/** True when dialling `address` for `hostname` is a private destination the admin did not name. */
export function privateDestinationRefused(hostname, address) {
  return (
    isPrivateAddress(address) &&
    !isAdminTrustedPrivateDestination(hostname, address)
  )
}

export function validateConnectorUrl(rawUrl) {
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
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (
    SELF_HOSTNAMES.has(host) ||
    internalServiceHosts().has(host) ||
    host.endsWith('.localhost') ||
    (net.isIP(host) && isSelfAddress(host))
  ) {
    throw new Error(`${host} points at this Overleaf server`)
  }
  // A name is checked when it is dialled, at the address it resolves to; an
  // address written out is checked here
  if (net.isIP(host) && privateDestinationRefused(host, host)) {
    throw new Error(`${host} is a private network address. Only user-supplied URLs are restricted, so a private address is refused.`)
  }
  return { parsed }
}

/** `dns.lookup` that refuses an answer pointing back at this server, or at a private address the admin did not name. */
export function connectorLookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options
    options = {}
  } else if (typeof options === 'number') {
    options = { family: options }
  }
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err)
    const list = Array.isArray(addresses) ? addresses : []
    internalServiceAddresses().then(internal => {
      const blocked = list.find(
        entry =>
          isSelfAddress(entry.address) ||
          internal.has(entry.address.toLowerCase()) ||
          privateDestinationRefused(hostname, entry.address)
      )
      if (list.length === 0 || blocked) {
        const where = blocked ? ` (${blocked.address})` : ''
        const message =
          blocked && isPrivateAddress(blocked.address)
            ? `${hostname} resolves to a private network address${where}. Private addresses are refused.`
            : `${hostname} resolves to this Overleaf server${where}`
        const error = new Error(message)
        error.code = 'EADDRBLOCKED'
        return callback(error)
      }
      if (options?.all) return callback(null, list)
      callback(null, list[0].address, list[0].family)
    }, callback)
  })
}

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
 * call, redirects and body reads included), maxResponseBytes, lookup.
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

  while (true) {
    const { parsed: currentUrl } = validateConnectorUrl(currentUrlStr)

    if (visited.has(currentUrl.href)) {
      stopDeadline()
      throw new Error(`Redirect loop detected: ${currentUrl.href}`)
    }
    visited.add(currentUrl.href)

    const response = await new Promise((resolve, reject) => {
      const transport = currentUrl.protocol === 'https:' ? https : http
      const reqHeaders = currentHeaders.raw()

      const reqOptions = {
        method: currentMethod,
        headers: reqHeaders,
        agent: false,
        signal,
        lookup,
      }

      const req = transport.request(currentUrl, reqOptions, res => {
        const status = res.statusCode ?? 0
        const isRedirect =
          [301, 302, 303, 307, 308].includes(status) &&
          res.headers.location &&
          options.redirect !== 'manual'

        if (isRedirect) {
          res.resume()
          redirectCount++
          if (redirectCount > 20) {
            stopDeadline()
            return reject(new Error('Too many redirects'))
          }

          const nextUrl = new URL(res.headers.location, currentUrl)

          // Never forward credentials (Authorization, cookies, the
          // connector's custom API-key headers) to a different origin
          if (nextUrl.origin !== currentUrl.origin) {
            for (const name of [...currentHeaders.keys()]) {
              if (!CROSS_ORIGIN_SAFE_HEADERS.has(name)) {
                currentHeaders.delete(name)
              }
            }
          }

          if (status === 303) {
            currentMethod = 'GET'
            currentBody = undefined
          } else if (
            (status === 301 || status === 302) &&
            currentMethod === 'POST'
          ) {
            currentMethod = 'GET'
            currentBody = undefined
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
          req.destroy(new Error(`Request timed out after ${options.timeoutMs}ms`))
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
}

/**
 * The fetch-shaped call the AI providers make. It goes through connectorFetch,
 * so the address checked is the address dialled (the lookup is pinned), and the
 * body streams. A provider's reply has no reason to move, so a redirect is
 * refused unless the caller asks to follow it.
 */
export async function providerFetch(url, init = {}) {
  const { redirect = 'error', ...rest } = init
  const response = await connectorFetch(url, {
    ...rest,
    redirect: redirect === 'follow' ? undefined : 'manual',
  })
  if (
    redirect === 'error' &&
    [301, 302, 303, 307, 308].includes(response.status) &&
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
