import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import zlib from 'node:zlib'

/**
 * Small files (a site's icon, a home page that names it) read by plain HTTP
 * through the gateway's egress proxy, without opening a Chrome page: a few
 * hundred milliseconds instead of a browser tab, and never in the queue for
 * the pages web_fetch reads. Every hop, redirects included, goes through the
 * egress proxy, which still decides what may be reached.
 */

export const FETCH_LIMITS = {
  /** The most of one file handed back, after decompression. */
  maxBytes: 1024 * 1024,
  /** The whole fetch, redirects included. */
  timeoutMs: 8_000,
  maxRedirects: 4,
}

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,image/avif,image/webp,image/*;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
}

function fetchError(message, { status = 502, kind = 'network' } = {}) {
  return Object.assign(new Error(message), { status, kind })
}

/** A tunnel to the target's host and port through the egress proxy. */
function tunnel(proxy, target, signal) {
  const port = Number(target.port || 443)
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port || 80),
      method: 'CONNECT',
      path: `${target.hostname}:${port}`,
      headers: { host: `${target.hostname}:${port}` },
      signal,
    })
    req.once('connect', (res, socket) => {
      if (res.statusCode === 200) return resolve(socket)
      socket.destroy()
      reject(
        fetchError(
          `the egress proxy refused ${target.hostname} (HTTP ${res.statusCode})`,
          { status: res.statusCode === 403 ? 403 : 502, kind: 'content' }
        )
      )
    })
    req.once('error', reject)
    req.end()
  })
}

/** One request; answers { response } with the headers in. */
async function requestOnce(target, { proxy, signal }) {
  let req
  if (target.protocol === 'https:') {
    const socket = await tunnel(proxy, target, signal)
    const host = target.hostname.replace(/^\[|\]$/g, '')
    req = https.request({
      host,
      port: Number(target.port || 443),
      path: `${target.pathname}${target.search}`,
      headers: { ...HEADERS, host: target.host },
      // No agent: with one, Node dials (and looks up) the host itself
      createConnection: () =>
        tls.connect({ socket, servername: net.isIP(host) ? undefined : host }),
      signal,
    })
  } else {
    req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port || 80),
      path: target.href,
      headers: { ...HEADERS, host: target.host },
      agent: false,
      signal,
    })
  }
  return new Promise((resolve, reject) => {
    req.once('response', resolve)
    req.once('error', reject)
    req.end()
  })
}

/**
 * The body decoded and cut at maxBytes, and whether it was cut. With `head`,
 * it stops once </head> has arrived: a page's icons are named before it.
 */
function readBody(response, maxBytes, { head = false } = {}) {
  const encoding = String(response.headers['content-encoding'] ?? '')
    .trim()
    .toLowerCase()
  const decoder =
    encoding === 'gzip' || encoding === 'x-gzip'
      ? zlib.createGunzip()
      : encoding === 'deflate'
        ? zlib.createInflate()
        : encoding === 'br'
          ? zlib.createBrotliDecompress()
          : null
  const stream = decoder ? response.pipe(decoder) : response
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let done = false
    // The end of the last chunk, so a </head> split across two is found
    let tail = ''
    const finish = truncated => {
      if (done) return
      done = true
      response.destroy()
      decoder?.destroy()
      resolve({ body: Buffer.concat(chunks), truncated })
    }
    stream.on('data', chunk => {
      if (size + chunk.length > maxBytes) {
        chunks.push(chunk.subarray(0, maxBytes - size))
        size = maxBytes
        finish(true)
        return
      }
      chunks.push(chunk)
      size += chunk.length
      if (head) {
        const text = tail + chunk.toString('latin1')
        if (/<\/head\s*>/i.test(text)) {
          finish(true)
          return
        }
        tail = text.slice(-8)
      }
    })
    stream.once('end', () => finish(false))
    stream.once('error', err => {
      if (!done) reject(err)
    })
    response.once('error', err => {
      if (!done) reject(err)
    })
  })
}

/**
 * GET `url` through the egress proxy at `proxyUrl`, following redirects.
 * Answers { status, finalUrl, contentType, body, truncated }; a page's own
 * HTTP error comes back as its status, not thrown. `head` reads a page only
 * up to its </head>.
 */
export async function fetchSmall(
  url,
  {
    proxyUrl,
    signal,
    maxBytes = FETCH_LIMITS.maxBytes,
    timeoutMs = FETCH_LIMITS.timeoutMs,
    maxRedirects = FETCH_LIMITS.maxRedirects,
    head = false,
  } = {}
) {
  const proxy = new URL(proxyUrl)
  const timeout = AbortSignal.timeout(timeoutMs)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  let target = new URL(url)

  for (let hop = 0; hop <= maxRedirects; hop++) {
    let response
    try {
      response = await requestOnce(target, { proxy, signal: combined })
    } catch (err) {
      if (err?.status) throw err
      if (timeout.aborted) {
        throw fetchError(`${target.host} did not answer within ${timeoutMs} ms`, {
          status: 504,
        })
      }
      if (combined.aborted) throw err
      throw fetchError(
        `could not fetch ${target.host}: ${String(err?.message || err).split('\n')[0]}`
      )
    }

    const status = response.statusCode ?? 502
    const location = response.headers.location
    if (status >= 300 && status < 400 && location) {
      response.destroy()
      let next
      try {
        next = new URL(location, target)
      } catch {
        throw fetchError(`${target.host} redirected to an invalid URL`, {
          kind: 'content',
        })
      }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        throw fetchError(`${target.host} redirected to ${next.protocol}`, {
          kind: 'content',
        })
      }
      target = next
      continue
    }

    try {
      const { body, truncated } = await readBody(response, maxBytes, { head })
      return {
        status,
        finalUrl: target.toString(),
        contentType:
          response.headers['content-type'] || 'application/octet-stream',
        body,
        truncated,
      }
    } catch (err) {
      if (timeout.aborted) {
        throw fetchError(`${target.host} did not answer within ${timeoutMs} ms`, {
          status: 504,
        })
      }
      if (combined.aborted) throw err
      throw fetchError(`could not read ${target.host}: ${err?.message || err}`)
    }
  }
  throw fetchError(`too many redirects from ${url}`, { kind: 'content' })
}
