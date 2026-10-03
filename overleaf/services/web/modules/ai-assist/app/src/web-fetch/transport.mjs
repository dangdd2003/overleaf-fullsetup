import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import zlib from 'node:zlib'
import { ProviderError } from '../AiAssistProviders.mjs'
import { describeStatus, webError } from './util.mjs'
import { curlFetch, isCurlImpersonateAvailable } from './curl.mjs'

/**
 * The HTTP client for pages the model chooses. It may only connect to public
 * addresses: the model picks the URL, and a page it read earlier can steer
 * that pick. The check runs at connect time on the address actually dialled,
 * so a DNS answer that changes between check and connect cannot slip through.
 */

/**
 * The most of one page held in memory, after decompression. Any book or
 * manual fits; past this a download is cut and the document marked
 * truncated, so a huge file cannot exhaust the web process's memory.
 */
export const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024
/** PDFs carry fonts and images besides their text, so they get more room */
export const MAX_PDF_BYTES = 128 * 1024 * 1024
const MAX_REDIRECTS = 5
export const REQUEST_TIMEOUT_MS = 20_000
export const USER_AGENT = 'Mozilla/5.0 (compatible; OverleafAIAssist/1.0)'

/**
 * Many news and documentation sites answer an unfamiliar user agent with 401
 * or 403 but serve an ordinary browser. A refused page is asked for once more
 * the way a browser would ask.
 */
export const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Accept-Language': 'en-US,en;q=0.9',
  'Upgrade-Insecure-Requests': '1',
  'sec-ch-ua':
    '"Chromium";v="150", "Not?A_Brand";v="24", "Google Chrome";v="150"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Linux"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
}

// ---------------------------------------------------------------------------
// Public-address guard
// ---------------------------------------------------------------------------

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
  // Unspecified, loopback and the old IPv4-compatible form (::a.b.c.d), then
  // the IPv4-translated form (::ffff:0:a.b.c.d): both embed an IPv4 address
  ['::', 96],
  ['::ffff:0:0:0', 96],
  // Documentation (RFC 9637) and SRv6 segment IDs (RFC 9602)
  ['3fff::', 20],
  ['5f00::', 16],
  // NAT64, Teredo and 6to4 all embed an IPv4 address that may be private;
  // none of them is how a public documentation site is reached. IPv4-mapped
  // addresses are unwrapped in isPublicAddress instead: BlockList matches every
  // plain IPv4 address against a ::ffff:0:0/96 rule.
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

/** True only for a globally routable unicast IP address. */
export function isPublicAddress(address) {
  const raw = String(address ?? '').replace(/^\[|\]$/g, '')
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(raw)
  if (mapped) return isPublicAddress(mapped[1])
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
    if (family === 6) return !BLOCKED_ADDRESSES.check(raw, 'ipv6')
  } catch {
    // an address BlockList cannot parse (a zone id, say) is not public
  }
  return false
}

/**
 * A `dns.lookup` replacement that refuses to hand back a private address.
 * Used as the socket's own lookup, so the address it vets is the one dialled.
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
        `${hostname} resolves to a private or reserved address${blocked ? ` (${blocked.address})` : ''}`
      )
      error.code = 'EADDRBLOCKED'
      return callback(error)
    }
    if (options?.all) return callback(null, list)
    callback(null, list[0].address, list[0].family)
  })
}

/**
 * Ports a browser refuses to fetch: the Fetch standard's "bad port" list
 * (https://fetch.spec.whatwg.org/#port-blocking). They belong to mail, shell,
 * IRC and other services that are not web pages but could be sent an HTTP
 * request. Chrome refuses the same ports, so both transports behave alike.
 */
const BAD_PORTS = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77,
  79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135,
  137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531,
  532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720,
  1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
])

export function parseFetchUrl(raw) {
  let parsed
  try {
    parsed = new URL(String(raw).trim())
  } catch {
    throw webError(`Not a valid URL: ${raw}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw webError(
      `Only http and https URLs can be fetched, not ${parsed.protocol}`
    )
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (
    (net.isIP(host) && !isPublicAddress(host)) ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host.endsWith('.local')
  ) {
    throw webError(
      `${host} is not a public address. Only public web pages can be fetched.`
    )
  }
  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80))
  if (BAD_PORTS.has(port)) {
    throw webError(
      `Port ${port} is not a web port. Only public web pages can be fetched.`
    )
  }
  parsed.hash = ''
  return parsed
}

const DEFAULT_HEADERS = {
  'User-Agent': USER_AGENT,
  Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
  'Accept-Language': 'en;q=1.0, *;q=0.5',
}

function requestOnce(
  url,
  {
    signal,
    maxBytes,
    pdfMaxBytes = maxBytes,
    lookup,
    headers = DEFAULT_HEADERS,
  }
) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http
    const req = transport.request(
      url,
      {
        method: 'GET',
        headers: { ...headers, 'Accept-Encoding': 'gzip, deflate, br' },
        lookup,
        signal,
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
          const reason = describeStatus(status)
          reject(
            webError(
              `${url} returned HTTP ${status}${reason ? `: ${reason}` : ''}.`,
              {
                status,
                kind: 'http',
              }
            )
          )
          return
        }

        let stream = res
        const limit = /application\/(?:x-)?pdf/i.test(
          String(res.headers['content-type'] || '')
        )
          ? Math.max(maxBytes, pdfMaxBytes)
          : maxBytes
        const encoding = String(res.headers['content-encoding'] || '')
          .trim()
          .toLowerCase()
        if (encoding === 'gzip' || encoding === 'x-gzip')
          stream = res.pipe(zlib.createGunzip())
        else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate())
        else if (encoding === 'br')
          stream = res.pipe(zlib.createBrotliDecompress())

        const chunks = []
        let size = 0
        let truncated = false
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          resolve({
            status,
            contentType: String(res.headers['content-type'] || ''),
            body: Buffer.concat(chunks),
            truncated,
          })
        }
        // The cap applies after decompression, so a small compressed bomb
        // cannot expand past it.
        stream.on('data', chunk => {
          if (truncated) return
          size += chunk.length
          if (Number.isFinite(limit) && size > limit) {
            chunks.push(chunk.subarray(0, chunk.length - (size - limit)))
            truncated = true
            finish()
            res.destroy()
            return
          }
          chunks.push(chunk)
        })
        stream.on('end', finish)
        stream.on('error', err => {
          if (truncated) return
          if (settled) return
          settled = true
          reject(err)
        })
      }
    )
    req.on('error', reject)
    req.end()
  })
}

/**
 * GETs a public web page: http(s) only, public addresses only (checked on
 * every redirect hop and at connect time), bounded in size and time.
 */
export async function fetchPublicUrl(
  rawUrl,
  {
    signal,
    maxBytes = MAX_DOWNLOAD_BYTES,
    // Only the default page cap is raised for PDFs; a caller asking for a
    // small cap (the favicon route, the archive lookup) keeps it.
    pdfMaxBytes = maxBytes === MAX_DOWNLOAD_BYTES ? MAX_PDF_BYTES : maxBytes,
    timeoutMs = REQUEST_TIMEOUT_MS,
    lookup = guardedLookup,
    headers,
    impersonate = false,
    curlFn = curlFetch,
    isCurlAvailable = isCurlImpersonateAvailable,
    requestOnceFn = requestOnce,
  } = {}
) {
  const timeout = AbortSignal.timeout(timeoutMs)
  const combined = AbortSignal.any([signal, timeout].filter(Boolean))
  let current = parseFetchUrl(rawUrl)

  const useCurl = impersonate && isCurlAvailable()

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let response
    try {
      if (useCurl) {
        response = await curlFn(current, {
          signal: combined,
          maxBytes,
          pdfMaxBytes,
          timeoutMs,
          lookup,
        })
      } else {
        response = await requestOnceFn(current, {
          signal: combined,
          maxBytes,
          pdfMaxBytes,
          lookup,
          headers: impersonate ? BROWSER_HEADERS : headers,
        })
      }
    } catch (err) {
      if (signal?.aborted)
        throw new ProviderError('Request was cancelled', { code: 'aborted' })
      if (timeout.aborted) {
        throw webError(
          `${current} did not answer within ${Math.round(timeoutMs / 1000)}s.`,
          {
            kind: 'network',
          }
        )
      }
      if (err instanceof ProviderError) throw err
      if (err?.code === 'EADDRBLOCKED') {
        throw webError(`${err.message}. Only public web pages can be fetched.`)
      }
      if (err?.code === 'ENOTFOUND' || err?.code === 'EAI_AGAIN') {
        throw webError(`Could not resolve ${current.hostname}. Check the URL.`)
      }
      throw webError(
        `Could not fetch ${current}: ${err?.message || 'network error'}`,
        {
          kind: 'network',
        }
      )
    }
    if (response.redirect) {
      current = parseFetchUrl(new URL(response.redirect, current).toString())
      continue
    }
    return { ...response, url: current.toString() }
  }
  throw webError(`Too many redirects fetching ${rawUrl}.`)
}
