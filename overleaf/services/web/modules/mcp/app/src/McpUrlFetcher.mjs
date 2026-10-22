import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import OError from '@overleaf/o-error'
import Settings from '@overleaf/settings'

const TIMEOUT_MS = 10000

/**
 * Try to interpret a URL hostname as an IP address literal, handling bracketed
 * IPv6 (`[::1]`) forms. WHATWG URL already canonicalises IPv4 representations.
 * Returns a canonical dotted-quad / IPv6 string, or null when the host is a real name.
 */
function parseIpLiteral(host) {
  if (!host) return null
  const h = String(host).replace(/^\[/, '').replace(/\]$/, '')
  if (net.isIP(h)) return h
  return null
}

/**
 * True when `ip` points at loopback, link-local, private, CGNAT or unspecified
 * space. Handles IPv4-mapped IPv6 (`::ffff:10.0.0.1` and the `::ffff:a00:1` hex
 * form) by extracting the embedded v4 address and re-checking it.
 */
function isBlockedIp(ip) {
  if (!ip) return false
  let addr = String(ip).toLowerCase().replace(/^\[/, '').replace(/\]$/, '')

  // IPv4-mapped (::ffff:) and NAT64 (64:ff9b::/96) addresses embed an IPv4
  // address that a gateway can route, so they are checked as that IPv4 address.
  const mappedDotted = addr.match(
    /^(?:::ffff:|64:ff9b::)(\d{1,3}(?:\.\d{1,3}){3})$/
  )
  if (mappedDotted) addr = mappedDotted[1]

  const mappedHex = addr.match(
    /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/
  )
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16)
    const lo = parseInt(mappedHex[2], 16)
    addr = [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join('.')
  }

  if (net.isIPv4(addr)) {
    const [a, b] = addr.split('.').map(Number)
    if (a === 0) return true // 0.0.0.0/8 incl. unspecified
    if (a === 10) return true
    if (a === 127) return true
    if (a === 169 && b === 254) return true // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
    if (a === 198 && (b === 18 || b === 19)) return true // benchmarking 198.18/15
    if (a >= 224) return true // multicast, reserved and broadcast 224/4 and up
    return false
  }

  if (net.isIPv6(addr)) {
    if (addr === '::' || addr === '::1') return true
    if (addr.startsWith('fc') || addr.startsWith('fd')) return true // ULA fc00::/7
    if (addr.startsWith('ff')) return true // multicast ff00::/8
    if (/^fe[89a-f]/.test(addr)) return true // fe80::/10 and deprecated fec0::/10
    if (addr.startsWith('::ffff:0:')) return true // IPv4-translated ::ffff:0:0:0/96
    if (addr.startsWith('2002:')) return true // 6to4 embeds an IPv4 address
    if (/^2001:(0{1,4})?:/.test(addr) || addr.startsWith('2001:db8:')) return true // Teredo, documentation
    if (addr.startsWith('3fff:') || addr.startsWith('100:')) return true // documentation and discard-only 100::/64
    // IPv4-compatible ::/96 (deprecated, never routable). WHATWG URL writes
    // `[::127.0.0.1]` as `::7f00:1`, so both forms are caught here.
    if (/^::(\d{1,3}(\.\d{1,3}){3}|([0-9a-f]{1,4}:)?[0-9a-f]{1,4})$/.test(addr))
      return true
    return false
  }

  return false
}

async function resolveAndValidate(hostname) {
  let addresses
  try {
    addresses = await dns.lookup(hostname, { all: true })
  } catch (err) {
    throw new OError('dns lookup failed', { code: 'fetch_failed' })
  }
  if (!addresses || addresses.length === 0) {
    throw new OError('dns lookup returned no records', { code: 'fetch_failed' })
  }
  for (const { address } of addresses) {
    if (isBlockedIp(address)) {
      throw new OError('resolved to a blocked address', {
        code: 'ssrf_blocked',
        address,
      })
    }
  }
  return addresses[0]
}

/**
 * Fetch a URL into a Buffer with SSRF protection:
 *  - only http(s)
 *  - reject blocked IP literals in the hostname (decimal / hex / IPv6 forms)
 *  - resolve via dns.lookup({ all: true }) and reject if ANY address is internal
 *  - pin the socket to a validated address via the `lookup` option AND
 *    re-validate on every lookup callback, closing the DNS-rebinding TOCTOU hole
 *  - do NOT follow redirects (3xx -> fetch_failed): each hop would need its
 *    own validation, so a redirect is reported instead
 *  - 10s timeout for the whole fetch
 *  - the body is streamed and aborted once it exceeds maxBytes (default
 *    Settings.maxUploadSize, the Overleaf upload limit); it then fails as too_large
 *
 * @param {string} url
 * @param {{ maxBytes?: number }} [options]
 * @returns {Promise<{ buffer: Buffer, contentType: string }>}
 */
async function fetchToBuffer(url, { maxBytes = Settings.maxUploadSize } = {}) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new OError('invalid url', { code: 'ssrf_blocked' })
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new OError('url scheme not allowed', { code: 'ssrf_blocked' })
  }

  const literal = parseIpLiteral(parsed.hostname)
  if (literal && isBlockedIp(literal)) {
    throw new OError('hostname is a blocked ip literal', {
      code: 'ssrf_blocked',
    })
  }

  const hostname = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '')
  await resolveAndValidate(hostname)

  const transport = parsed.protocol === 'https:' ? https : http

  // Pin: every connect lookup re-resolves AND re-validates. An unvalidated
  // address can never be handed to the socket.
  // Node's autoSelectFamily asks for every address (`all: true`) and expects an
  // array back; the single-address form is for older callers.
  const lookup = (lookupHost, options, cb) => {
    resolveAndValidate(lookupHost).then(
      addr =>
        options?.all
          ? cb(null, [{ address: addr.address, family: addr.family }])
          : cb(null, addr.address, addr.family),
      err => cb(err)
    )
  }

  return await new Promise((resolve, reject) => {
    let settled = false
    const fail = err => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      reject(
        err instanceof OError
          ? err
          : new OError('url fetch failed', { code: 'fetch_failed', cause: err })
      )
    }

    // `timeout` above is an idle-socket timeout; a slow-drip body would keep
    // it alive indefinitely. This is the total deadline for the whole fetch.
    const deadline = setTimeout(() => {
      req.destroy()
      fail(new OError('url fetch timed out', { code: 'fetch_failed' }))
    }, TIMEOUT_MS)

    const req = transport.request(
      url,
      {
        method: 'GET',
        lookup,
        servername: hostname,
        headers: { host: parsed.host, accept: '*/*' },
        timeout: TIMEOUT_MS,
      },
      res => {
        const status = res.statusCode || 0
        if (status >= 300 && status < 400) {
          res.destroy()
          return fail(
            new OError('redirect not followed', {
              code: 'fetch_failed',
              status,
            })
          )
        }
        if (status < 200 || status >= 300) {
          res.destroy()
          return fail(
            new OError('upstream returned an error status', {
              code: 'fetch_failed',
              status,
            })
          )
        }

        const chunks = []
        let total = 0
        res.on('data', chunk => {
          total += chunk.length
          if (total > maxBytes) {
            res.destroy()
            return fail(
              new OError('response body exceeded maxBytes', {
                code: 'too_large',
              })
            )
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          if (settled) return
          settled = true
          clearTimeout(deadline)
          resolve({
            buffer: Buffer.concat(chunks),
            contentType: res.headers['content-type'] || '',
          })
        })
        res.on('error', err => fail(err))
      }
    )

    req.on('timeout', () => {
      req.destroy()
      fail(new OError('url fetch timed out', { code: 'fetch_failed' }))
    })
    req.on('error', err => fail(err))
    req.end()
  })
}

export default { fetchToBuffer, isBlockedIp, parseIpLiteral }
export { fetchToBuffer, isBlockedIp, parseIpLiteral }
