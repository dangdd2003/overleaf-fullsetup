import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import zlib from 'node:zlib'
import { pipeline, Readable } from 'node:stream'
import { DEFAULTS } from '../TemplateGalleryDefaults.mjs'
import { openTunnel, HANDSHAKE_TIMEOUT_MS } from './EgressTunnel.mjs'

/**
 * Socket-level SSRF-guarded outbound HTTP/HTTPS transport.
 * Enforces connect-time DNS firewall checks and strict allow-list validation.
 */

export const DEFAULT_ALLOWED_HOSTS = Object.freeze([
  'www.overleaf.com',
  'sk53gl4jly-dsn.algolia.net',
  'sk53gl4jly.algolia.net',
  'sk53gl4jly-1.algolianet.com',
  'sk53gl4jly-2.algolianet.com',
  'sk53gl4jly-3.algolianet.com',
  'writelatex.s3.amazonaws.com',
])

export const DEFAULT_TIMEOUT_MS = 20_000
export const DEFAULT_MAX_REDIRECTS = 5
export const DEFAULT_MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024 // 64 MiB
// A response body that delivers no bytes for this long is abandoned.
export const DEFAULT_BODY_IDLE_MS = 15_000
export const USER_AGENT =
  'Mozilla/5.0 (compatible; OverleafCETemplateGallery/1.0)'
// overleaf.com and its S3 bucket serve the gallery to browsers; present as one.
export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
const BROWSER_UA_HOSTS = new Set([
  'www.overleaf.com',
  'writelatex.s3.amazonaws.com',
])

// Credentials that must never follow a redirect to another origin.
const CREDENTIAL_HEADERS = new Set([
  'cookie',
  'authorization',
  'proxy-authorization',
])
const MAX_RETRY_AFTER_MS = 24 * 3600_000

const BLOCKED_ADDRESSES = new net.BlockList()
for (const [prefix, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) {
  BLOCKED_ADDRESSES.addSubnet(prefix, bits, 'ipv4')
}
for (const [prefix, bits] of [
  ['::', 96],
  ['::1', 128],
  ['::ffff:0:0:0', 96],
  ['3fff::', 20],
  ['5f00::', 16],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
]) {
  BLOCKED_ADDRESSES.addSubnet(prefix, bits, 'ipv6')
}

/**
 * True only for a globally routable unicast public IP address.
 */
export function isPublicAddress(address) {
  const raw = String(address ?? '')
    .replace(/^\[|\]$/g, '')
    .trim()
  if (!raw) return false

  // Handle IPv4-mapped IPv6: ::ffff:192.0.2.1
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(raw)
  if (mapped) return isPublicAddress(mapped[1])

  // Handle hex IPv4-mapped IPv6: ::ffff:c000:0201
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(raw)
  if (mappedHex) {
    const high = parseInt(mappedHex[1], 16)
    const low = parseInt(mappedHex[2], 16)
    return isPublicAddress(
      `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
    )
  }

  try {
    const family = net.isIP(raw)
    if (family === 4) return !BLOCKED_ADDRESSES.check(raw, 'ipv4')
    if (family === 6) {
      if (raw === '::' || raw === '::1') return false
      return !BLOCKED_ADDRESSES.check(raw, 'ipv6')
    }
  } catch {
    return false
  }
  return false
}

/**
 * Custom DNS lookup preventing DNS rebinding and private network traversal.
 */
export function guardedLookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options
    options = {}
  } else if (typeof options === 'number') {
    options = { family: options }
  }

  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err)
    const list = Array.isArray(addresses) ? addresses : []
    const blocked = list.find(entry => !isPublicAddress(entry.address))
    if (list.length === 0 || blocked) {
      const error = new Error(
        `SSRF blocked: ${hostname} resolves to restricted address${blocked ? ` (${blocked.address})` : ''}`
      )
      error.code = 'EADDRBLOCKED'
      return callback(error)
    }
    if (options?.all) return callback(null, list)
    callback(null, list[0].address, list[0].family)
  })
}

// Refusals made before any request is sent (allow-list, port, scheme, address).
// They say nothing about the host's health, so callers must not count them as
// host failures or escalate per-item backoff.
export const OUTBOUND_BLOCKED = 'EOUTBOUND_BLOCKED'

function outboundBlocked(message) {
  const err = new Error(message)
  err.code = OUTBOUND_BLOCKED
  return err
}

/**
 * Validate that URL uses allowed protocol, port, has no credentials, and hostname is in allowedHosts.
 */
export function validateAllowedHost(urlOrString, allowedHosts = null) {
  let url
  try {
    url =
      urlOrString instanceof URL
        ? urlOrString
        : new URL(String(urlOrString).trim())
  } catch {
    throw outboundBlocked(`Invalid URL: ${urlOrString}`)
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw outboundBlocked(
      `Outbound protocol blocked: only http and https are allowed, got ${url.protocol}`
    )
  }

  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
  if (port !== 80 && port !== 443) {
    throw outboundBlocked(
      `Outbound port blocked: only ports 80 and 443 are allowed, got ${port}`
    )
  }

  if (url.username || url.password) {
    throw outboundBlocked('Credentials in URLs are strictly rejected')
  }

  const configuredHosts =
    allowedHosts ||
    DEFAULTS.outbound?.allowedHosts ||
    DEFAULT_ALLOWED_HOSTS

  const hostSet = new Set(
    Array.from(configuredHosts, h => String(h).toLowerCase())
  )
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()

  if (
    (net.isIP(host) && !isPublicAddress(host)) ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host.endsWith('.local')
  ) {
    throw outboundBlocked(
      `Outbound host blocked: ${host} is a local or reserved address`
    )
  }

  if (!hostSet.has(host)) {
    throw outboundBlocked(
      `Outbound target blocked: ${host} is not in template gallery allow-list`
    )
  }

  return url
}

/**
 * Default request headers for a URL, overridable by the caller.
 */
export function buildRequestHeaders(url, headers = {}) {
  const host = String(url?.hostname || '').toLowerCase()
  return {
    'User-Agent': BROWSER_UA_HOSTS.has(host) ? BROWSER_USER_AGENT : USER_AGENT,
    'Accept-Encoding': 'gzip, deflate, br',
    ...headers,
  }
}

/**
 * Headers for the next redirect hop: credentials are dropped as soon as the
 * redirect leaves the origin they were issued for.
 */
export function redirectHeaders(headers, fromUrl, toUrl) {
  if (new URL(fromUrl).origin === new URL(toUrl).origin) return headers
  const next = {}
  for (const [name, value] of Object.entries(headers || {})) {
    if (!CREDENTIAL_HEADERS.has(name.toLowerCase())) next[name] = value
  }
  return next
}

/**
 * Retry-After header (delta seconds or HTTP date) in milliseconds, or null.
 */
export function parseRetryAfter(value, now = Date.now()) {
  if (value == null) return null
  const raw = String(Array.isArray(value) ? value[0] : value).trim()
  if (!raw) return null
  let ms = null
  if (/^\d+$/.test(raw)) {
    ms = Number(raw) * 1000
  } else {
    const at = Date.parse(raw)
    if (!Number.isNaN(at)) ms = Math.max(0, at - now)
  }
  if (ms == null || !Number.isFinite(ms)) return null
  return Math.min(ms, MAX_RETRY_AFTER_MS)
}

function getHeader(headers, name) {
  if (!headers) return undefined
  const target = name.toLowerCase()
  for (const [key, val] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return val
  }
  return undefined
}

export function httpError(status, url, headers, detail = '') {
  const err = new Error(
    `HTTP ${status} response from ${url}${detail ? `: ${detail}` : ''}`
  )
  err.status = status
  err.statusCode = status
  err.code = `EHTTP_${status}`
  err.url = String(url)
  err.headers = headers || {}
  const retryAfterMs = parseRetryAfter(getHeader(headers, 'retry-after'))
  err.retryAfterMs = retryAfterMs != null ? retryAfterMs : null
  return err
}

function transportError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

function decoderFor(encoding) {
  if (encoding === 'gzip' || encoding === 'x-gzip') return zlib.createGunzip()
  if (encoding === 'deflate') return zlib.createInflate()
  if (encoding === 'br') return zlib.createBrotliDecompress()
  return null
}

/**
 * Body of a response, decoded when Content-Encoding asks for it. Failures on
 * the socket are pushed into the decoder, so the returned stream always ends
 * or errors and a caller can never wait on a body that is gone.
 */
function responseBody(res) {
  const encoding = String(res.headers['content-encoding'] || '')
    .trim()
    .toLowerCase()
  const decoder = decoderFor(encoding)
  if (!decoder) return res
  pipeline(res, decoder, () => {})
  return decoder
}

/**
 * One-shot idle timer for a response body, re-armed on every chunk.
 */
function idleWatch(ms, onIdle) {
  let timer = null
  return {
    arm() {
      if (!(ms > 0)) return
      clearTimeout(timer)
      timer = setTimeout(onIdle, ms)
      timer.unref?.()
    },
    clear() {
      clearTimeout(timer)
      timer = null
    },
  }
}

/**
 * Same allow-list checks as validateAllowedHost. Through an egress proxy only
 * https targets are allowed, so the proxy never sees plaintext.
 */
function validateHop(urlOrString, allowedHosts, egress) {
  const url = validateAllowedHost(urlOrString, allowedHosts)
  if (egress && url.protocol !== 'https:') {
    throw outboundBlocked('Egress proxies only carry https targets')
  }
  return url
}

/**
 * Connects to the target through an egress proxy. The target is resolved with
 * the guarded lookup, the first address is checked again and then pinned, and
 * the tunnel is wrapped in TLS with certificate checks against the hostname.
 */
async function openEgressSocket(url, egress, lookupFn) {
  const entries = await new Promise((resolve, reject) => {
    lookupFn(url.hostname, { all: true }, (err, list) =>
      err ? reject(err) : resolve(list)
    )
  })
  const target = Array.isArray(entries) ? entries[0] : null
  if (!target || !isPublicAddress(target.address)) {
    const err = new Error(
      `SSRF blocked: ${url.hostname} resolves to restricted address`
    )
    err.code = 'EADDRBLOCKED'
    throw err
  }
  const tunnel = await openTunnel(egress, target.address, Number(url.port || 443))
  const secure = tls.connect({
    socket: tunnel,
    servername: net.isIP(url.hostname) ? undefined : url.hostname,
  })
  const timer = setTimeout(() => {
    secure.destroy(new Error(`TLS handshake with ${url.hostname} timed out`))
  }, HANDSHAKE_TIMEOUT_MS)
  try {
    await new Promise((resolve, reject) => {
      secure.once('secureConnect', resolve)
      secure.once('error', reject)
      secure.once('close', () =>
        reject(new Error(`connection to ${url.hostname} closed during TLS handshake`))
      )
    })
  } catch (err) {
    secure.destroy()
    tunnel.destroy()
    throw err
  } finally {
    clearTimeout(timer)
  }
  return secure
}

// Request options for a hop: the direct path dials through the guarded lookup;
// an egress hop reuses the tunnel that was opened for it.
function connectOptions(tunnel, lookupFn) {
  return tunnel ? { createConnection: () => tunnel } : { lookup: lookupFn }
}

/**
 * Execute raw HTTP/HTTPS request with security constraints, redirect following, decompression and byte caps.
 * A body that stalls for `idleTimeoutMs` (default DEFAULT_BODY_IDLE_MS) or closes before it completes
 * rejects instead of hanging the caller.
 */
export async function requestRaw(urlString, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body = null,
    timeoutMs = DEFAULTS.outbound?.timeoutMs ||
      DEFAULT_TIMEOUT_MS,
    maxRedirects = DEFAULTS.outbound?.maxRedirects ||
      DEFAULT_MAX_REDIRECTS,
    followRedirects = true,
    maxBytes = DEFAULTS.outbound?.maxDownloadBytes ||
      DEFAULT_MAX_DOWNLOAD_BYTES,
    allowedHosts = null,
    lookupFn = guardedLookup,
    signal = null,
    idleTimeoutMs = DEFAULT_BODY_IDLE_MS,
    egress = null,
  } = options

  let currentUrl = validateHop(urlString, allowedHosts, egress)
  let currentMethod = method
  let currentBody = body
  let currentHeaders = headers

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const tunnel = egress
      ? await openEgressSocket(currentUrl, egress, lookupFn)
      : null
    const response = await new Promise((resolve, reject) => {
      const isHttps = currentUrl.protocol === 'https:'
      const transport = isHttps ? https : http

      const timeoutSignal = AbortSignal.timeout(timeoutMs)
      const combinedSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal

      const reqHeaders = buildRequestHeaders(currentUrl, currentHeaders)

      const req = transport.request(
        currentUrl,
        {
          method: currentMethod,
          headers: reqHeaders,
          ...connectOptions(tunnel, lookupFn),
          signal: combinedSignal,
          agent: false,
        },
        res => {
          const status = res.statusCode ?? 0

          // Check redirect
          if (
            followRedirects &&
            status >= 300 &&
            status < 400 &&
            res.headers.location
          ) {
            res.resume()
            resolve({ redirect: res.headers.location, status })
            return
          }

          if (status >= 400) {
            // Buffer error response if small, but cap at 64 KiB
            const errChunks = []
            let errSize = 0
            let errDone = false
            const failedStatus = () => {
              if (errDone) return
              errDone = true
              reject(
                httpError(
                  status,
                  currentUrl,
                  res.headers,
                  Buffer.concat(errChunks).toString('utf8').slice(0, 500)
                )
              )
            }
            res.on('data', chunk => {
              if (errSize < 64 * 1024) {
                errChunks.push(chunk)
                errSize += chunk.length
              }
            })
            res.on('end', failedStatus)
            // A connection that drops mid-error still reports the HTTP status.
            res.on('close', failedStatus)
            res.on('error', reject)
            return
          }

          const stream = responseBody(res)
          const chunks = []
          let totalBytes = 0
          let truncated = false
          let settled = false

          const idle = idleWatch(idleTimeoutMs, () =>
            fail(
              transportError(
                'ETIMEDOUT',
                `response body from ${currentUrl} stalled for ${idleTimeoutMs}ms`
              )
            )
          )
          const finish = () => {
            if (settled) return
            settled = true
            idle.clear()
            resolve({
              status,
              statusCode: status,
              headers: res.headers,
              contentType: String(res.headers['content-type'] || ''),
              body: Buffer.concat(chunks),
              truncated,
              url: currentUrl.toString(),
            })
          }
          const fail = err => {
            if (settled) return
            settled = true
            idle.clear()
            res.destroy()
            reject(err)
          }

          idle.arm()
          stream.on('data', chunk => {
            if (settled) return
            idle.arm()
            totalBytes += chunk.length
            if (Number.isFinite(maxBytes) && totalBytes > maxBytes) {
              const overflow = totalBytes - maxBytes
              chunks.push(chunk.subarray(0, chunk.length - overflow))
              truncated = true
              finish()
              res.destroy()
              return
            }
            chunks.push(chunk)
          })

          stream.on('end', finish)
          stream.on('error', fail)
          res.on('error', fail)
          res.on('close', () => {
            if (!res.complete) {
              fail(
                transportError(
                  'ECONNRESET',
                  `connection closed before the body from ${currentUrl} completed`
                )
              )
            }
          })
        }
      )

      req.on('error', err => {
        if (combinedSignal.aborted) {
          const abortErr = new Error(
            `Request to ${currentUrl} timed out after ${timeoutMs}ms`
          )
          abortErr.code = 'ETIMEDOUT'
          return reject(abortErr)
        }
        reject(err)
      })

      if (currentBody) {
        if (Buffer.isBuffer(currentBody) || typeof currentBody === 'string') {
          req.end(currentBody)
        } else if (typeof currentBody.pipe === 'function') {
          currentBody.pipe(req)
        } else {
          req.end(JSON.stringify(currentBody))
        }
      } else {
        req.end()
      }
    })

    if (response.redirect) {
      const nextUrl = validateHop(
        new URL(response.redirect, currentUrl),
        allowedHosts,
        egress
      )
      currentHeaders = redirectHeaders(currentHeaders, currentUrl, nextUrl)
      currentUrl = nextUrl
      currentMethod = 'GET'
      currentBody = null
      continue
    }

    return response
  }

  throw new Error(`Too many redirects fetching ${urlString}`)
}

/**
 * Fetch and return complete Buffer.
 */
export async function fetchBuffer(url, opts = {}) {
  const res = await requestRaw(url, { ...opts, method: 'GET' })
  return res.body
}

/**
 * Fetch and return decoded UTF-8 string.
 */
export async function fetchText(url, opts = {}) {
  const buf = await fetchBuffer(url, opts)
  return buf.toString('utf8')
}

/**
 * Fetch and return parsed JSON object.
 */
export async function fetchJson(url, opts = {}) {
  const text = await fetchText(url, {
    ...opts,
    headers: {
      Accept: 'application/json, text/plain, */*',
      ...(opts.headers || {}),
    },
  })
  return JSON.parse(text)
}

/**
 * Fetch returning a byte-capped Readable stream and response headers/status.
 */
export async function fetchStream(url, opts = {}) {
  const {
    timeoutMs = DEFAULTS.outbound?.timeoutMs ||
      DEFAULT_TIMEOUT_MS,
    maxRedirects = DEFAULTS.outbound?.maxRedirects ||
      DEFAULT_MAX_REDIRECTS,
    maxBytes = DEFAULTS.outbound?.maxDownloadBytes ||
      DEFAULT_MAX_DOWNLOAD_BYTES,
    allowedHosts = null,
    lookupFn = guardedLookup,
    headers = {},
    signal = null,
    idleTimeoutMs = DEFAULT_BODY_IDLE_MS,
    egress = null,
  } = opts

  let currentUrl = validateHop(url, allowedHosts, egress)
  let currentHeaders = headers

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const isHttps = currentUrl.protocol === 'https:'
    const transport = isHttps ? https : http

    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal

    const reqHeaders = buildRequestHeaders(currentUrl, currentHeaders)

    const tunnel = egress
      ? await openEgressSocket(currentUrl, egress, lookupFn)
      : null
    const { redirect, result } = await new Promise((resolve, reject) => {
      const req = transport.request(
        currentUrl,
        {
          method: 'GET',
          headers: reqHeaders,
          ...connectOptions(tunnel, lookupFn),
          signal: combinedSignal,
          agent: false,
        },
        res => {
          const status = res.statusCode ?? 0
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume()
            resolve({ redirect: res.headers.location })
            return
          }

          if (status >= 400) {
            res.resume()
            reject(httpError(status, currentUrl, res.headers))
            return
          }

          const stream = responseBody(res)
          let byteCount = 0
          let done = false
          const passThrough = new Readable({
            read() {},
          })

          const idle = idleWatch(idleTimeoutMs, () =>
            fail(
              transportError(
                'ETIMEDOUT',
                `response body from ${currentUrl} stalled for ${idleTimeoutMs}ms`
              )
            )
          )
          const fail = err => {
            if (done) return
            done = true
            idle.clear()
            res.destroy()
            passThrough.destroy(err)
          }

          idle.arm()
          stream.on('data', chunk => {
            if (done) return
            idle.arm()
            byteCount += chunk.length
            if (Number.isFinite(maxBytes) && byteCount > maxBytes) {
              const overflow = byteCount - maxBytes
              if (chunk.length > overflow) {
                passThrough.push(chunk.subarray(0, chunk.length - overflow))
              }
              const capErr = new Error(
                `Byte limit exceeded: stream capped at ${maxBytes} bytes`
              )
              capErr.code = 'EBYTECAP'
              fail(capErr)
              return
            }
            passThrough.push(chunk)
          })

          stream.on('end', () => {
            if (done) return
            done = true
            idle.clear()
            passThrough.push(null)
          })

          stream.on('error', fail)
          res.on('error', fail)
          res.on('close', () => {
            if (!res.complete) {
              fail(
                transportError(
                  'ECONNRESET',
                  `connection closed before the body from ${currentUrl} completed`
                )
              )
            }
          })
          // A consumer that gives up on the stream releases the connection.
          passThrough.on('close', () => {
            if (done) return
            done = true
            idle.clear()
            res.destroy()
          })

          resolve({
            result: {
              status,
              statusCode: status,
              headers: res.headers,
              contentType: String(res.headers['content-type'] || ''),
              stream: passThrough,
              url: currentUrl.toString(),
            },
          })
        }
      )

      req.on('error', err => {
        if (combinedSignal.aborted) {
          const abortErr = new Error(
            `Request to ${currentUrl} timed out after ${timeoutMs}ms`
          )
          abortErr.code = 'ETIMEDOUT'
          return reject(abortErr)
        }
        reject(err)
      })

      req.end()
    })

    if (redirect) {
      const nextUrl = validateHop(
        new URL(redirect, currentUrl),
        allowedHosts,
        egress
      )
      currentHeaders = redirectHeaders(currentHeaders, currentUrl, nextUrl)
      currentUrl = nextUrl
      continue
    }

    return result
  }

  throw new Error(`Too many redirects fetching ${url}`)
}

export default {
  isPublicAddress,
  guardedLookup,
  validateAllowedHost,
  buildRequestHeaders,
  redirectHeaders,
  parseRetryAfter,
  httpError,
  requestRaw,
  fetchBuffer,
  fetchText,
  fetchJson,
  fetchStream,
  DEFAULT_ALLOWED_HOSTS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_MAX_DOWNLOAD_BYTES,
  USER_AGENT,
  BROWSER_USER_AGENT,
}
