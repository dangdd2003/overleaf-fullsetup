import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import zlib from 'node:zlib'
import { Readable } from 'node:stream'
import Settings from '@overleaf/settings'

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
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'gitlab.com',
])

export const DEFAULT_TIMEOUT_MS = 20_000
export const DEFAULT_MAX_REDIRECTS = 5
export const DEFAULT_MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024 // 64 MiB
export const USER_AGENT = 'Mozilla/5.0 (compatible; OverleafCETemplateGallery/1.0)'
// overleaf.com and its S3 bucket serve the gallery to browsers; present as one.
export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
const BROWSER_UA_HOSTS = new Set(['www.overleaf.com', 'writelatex.s3.amazonaws.com'])

// Credentials that must never follow a redirect to another origin.
const CREDENTIAL_HEADERS = new Set(['cookie', 'authorization', 'proxy-authorization'])
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
  const raw = String(address ?? '').replace(/^\[|\]$/g, '').trim()
  if (!raw) return false

  // Handle IPv4-mapped IPv6: ::ffff:192.0.2.1
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(raw)
  if (mapped) return isPublicAddress(mapped[1])

  // Handle hex IPv4-mapped IPv6: ::ffff:c000:0201
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(raw)
  if (mappedHex) {
    const high = parseInt(mappedHex[1], 16)
    const low = parseInt(mappedHex[2], 16)
    return isPublicAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
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

/**
 * Validate that URL uses allowed protocol, port, has no credentials, and hostname is in allowedHosts.
 */
export function validateAllowedHost(urlOrString, allowedHosts = null) {
  let url
  try {
    url = urlOrString instanceof URL ? urlOrString : new URL(String(urlOrString).trim())
  } catch {
    throw new Error(`Invalid URL: ${urlOrString}`)
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Outbound protocol blocked: only http and https are allowed, got ${url.protocol}`)
  }

  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
  if (port !== 80 && port !== 443) {
    throw new Error(`Outbound port blocked: only ports 80 and 443 are allowed, got ${port}`)
  }

  if (url.username || url.password) {
    throw new Error('Credentials in URLs are strictly rejected')
  }

  const configuredHosts =
    allowedHosts ||
    Settings?.templateGallery?.outbound?.allowedHosts ||
    DEFAULT_ALLOWED_HOSTS

  const hostSet = new Set(Array.from(configuredHosts, h => String(h).toLowerCase()))
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()

  if (
    (net.isIP(host) && !isPublicAddress(host)) ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host.endsWith('.local')
  ) {
    throw new Error(`Outbound host blocked: ${host} is a local or reserved address`)
  }

  if (!hostSet.has(host)) {
    throw new Error(`Outbound target blocked: ${host} is not in template gallery allow-list`)
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

/**
 * Execute raw HTTP/HTTPS request with security constraints, redirect following, decompression and byte caps.
 */
export async function requestRaw(urlString, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body = null,
    timeoutMs = Settings?.templateGallery?.outbound?.timeoutMs || DEFAULT_TIMEOUT_MS,
    maxRedirects = Settings?.templateGallery?.outbound?.maxRedirects || DEFAULT_MAX_REDIRECTS,
    followRedirects = true,
    maxBytes = Settings?.templateGallery?.outbound?.maxDownloadBytes || DEFAULT_MAX_DOWNLOAD_BYTES,
    allowedHosts = null,
    lookupFn = guardedLookup,
    signal = null,
  } = options

  let currentUrl = validateAllowedHost(urlString, allowedHosts)
  let currentMethod = method
  let currentBody = body
  let currentHeaders = headers

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const response = await new Promise((resolve, reject) => {
      const isHttps = currentUrl.protocol === 'https:'
      const transport = isHttps ? https : http

      const timeoutSignal = AbortSignal.timeout(timeoutMs)
      const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal

      const reqHeaders = buildRequestHeaders(currentUrl, currentHeaders)

      const req = transport.request(
        currentUrl,
        {
          method: currentMethod,
          headers: reqHeaders,
          lookup: lookupFn,
          signal: combinedSignal,
          agent: false,
        },
        res => {
          const status = res.statusCode ?? 0

          // Check redirect
          if (followRedirects && status >= 300 && status < 400 && res.headers.location) {
            res.resume()
            resolve({ redirect: res.headers.location, status })
            return
          }

          if (status >= 400) {
            // Buffer error response if small, but cap at 64 KiB
            const errChunks = []
            let errSize = 0
            res.on('data', chunk => {
              if (errSize < 64 * 1024) {
                errChunks.push(chunk)
                errSize += chunk.length
              }
            })
            res.on('end', () => {
              reject(
                httpError(
                  status,
                  currentUrl,
                  res.headers,
                  Buffer.concat(errChunks).toString('utf8').slice(0, 500)
                )
              )
            })
            res.on('error', reject)
            return
          }

          let stream = res
          const encoding = String(res.headers['content-encoding'] || '').trim().toLowerCase()
          if (encoding === 'gzip' || encoding === 'x-gzip') {
            stream = res.pipe(zlib.createGunzip())
          } else if (encoding === 'deflate') {
            stream = res.pipe(zlib.createInflate())
          } else if (encoding === 'br') {
            stream = res.pipe(zlib.createBrotliDecompress())
          }

          const chunks = []
          let totalBytes = 0
          let truncated = false
          let settled = false

          const finish = () => {
            if (settled) return
            settled = true
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

          stream.on('data', chunk => {
            if (truncated) return
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
          stream.on('error', err => {
            if (truncated || settled) return
            settled = true
            reject(err)
          })
        }
      )

      req.on('error', err => {
        if (combinedSignal.aborted) {
          const abortErr = new Error(`Request to ${currentUrl} timed out after ${timeoutMs}ms`)
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
      const nextUrl = validateAllowedHost(new URL(response.redirect, currentUrl), allowedHosts)
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
    timeoutMs = Settings?.templateGallery?.outbound?.timeoutMs || DEFAULT_TIMEOUT_MS,
    maxRedirects = Settings?.templateGallery?.outbound?.maxRedirects || DEFAULT_MAX_REDIRECTS,
    maxBytes = Settings?.templateGallery?.outbound?.maxDownloadBytes || DEFAULT_MAX_DOWNLOAD_BYTES,
    allowedHosts = null,
    lookupFn = guardedLookup,
    headers = {},
    signal = null,
  } = opts

  let currentUrl = validateAllowedHost(url, allowedHosts)
  let currentHeaders = headers

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const isHttps = currentUrl.protocol === 'https:'
    const transport = isHttps ? https : http

    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal

    const reqHeaders = buildRequestHeaders(currentUrl, currentHeaders)

    const { redirect, result } = await new Promise((resolve, reject) => {
      const req = transport.request(
        currentUrl,
        {
          method: 'GET',
          headers: reqHeaders,
          lookup: lookupFn,
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

          let stream = res
          const encoding = String(res.headers['content-encoding'] || '').trim().toLowerCase()
          if (encoding === 'gzip' || encoding === 'x-gzip') {
            stream = res.pipe(zlib.createGunzip())
          } else if (encoding === 'deflate') {
            stream = res.pipe(zlib.createInflate())
          } else if (encoding === 'br') {
            stream = res.pipe(zlib.createBrotliDecompress())
          }

          let byteCount = 0
          const passThrough = new Readable({
            read() {},
          })

          stream.on('data', chunk => {
            byteCount += chunk.length
            if (Number.isFinite(maxBytes) && byteCount > maxBytes) {
              const overflow = byteCount - maxBytes
              if (chunk.length > overflow) {
                passThrough.push(chunk.subarray(0, chunk.length - overflow))
              }
              const capErr = new Error(`Byte limit exceeded: stream capped at ${maxBytes} bytes`)
              capErr.code = 'EBYTECAP'
              passThrough.destroy(capErr)
              res.destroy()
              return
            }
            passThrough.push(chunk)
          })

          stream.on('end', () => {
            passThrough.push(null)
          })

          stream.on('error', err => {
            passThrough.destroy(err)
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
          const abortErr = new Error(`Request to ${currentUrl} timed out after ${timeoutMs}ms`)
          abortErr.code = 'ETIMEDOUT'
          return reject(abortErr)
        }
        reject(err)
      })

      req.end()
    })

    if (redirect) {
      const nextUrl = validateAllowedHost(new URL(redirect, currentUrl), allowedHosts)
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
