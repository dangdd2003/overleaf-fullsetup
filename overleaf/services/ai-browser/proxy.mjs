import dns from 'node:dns'
import http from 'node:http'
import net from 'node:net'

/**
 * An HTTP proxy that only connects to public addresses. Chromium sends every
 * request through it, so a page's JavaScript cannot reach the Overleaf
 * containers, the Docker host or a cloud metadata service. The proxy dials
 * the exact address it checked, so a DNS answer that changes between check
 * and connect cannot slip through.
 *
 * Keep BLOCKED_ADDRESSES in step with
 * services/web/modules/ai-assist/app/src/web-fetch/transport.mjs.
 */

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
  ['::', 128],
  ['::1', 128],
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
    // an address BlockList cannot parse is not public
  }
  return false
}

/** One address for `host`, provided every address it resolves to is public. */
export async function resolvePublic(
  host,
  { lookup = dns.promises.lookup, isPublic = isPublicAddress } = {}
) {
  const bare = String(host ?? '').replace(/^\[|\]$/g, '')
  const family = net.isIP(bare)
  const addresses = family
    ? [{ address: bare, family }]
    : await lookup(bare, { all: true })
  if (
    addresses.length === 0 ||
    addresses.some(entry => !isPublic(entry.address))
  ) {
    const error = new Error(`${host} is not a public address`)
    error.code = 'EADDRBLOCKED'
    throw error
  }
  return addresses[0]
}

function authorityOf(value) {
  const match = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(String(value ?? ''))
  return match ? { host: match[1], port: Number(match[2]) } : null
}

export function createGuardedProxy({ lookup, isPublic } = {}) {
  const resolve = host => resolvePublic(host, { lookup, isPublic })

  // Plain HTTP: the request line carries the absolute URL
  const server = http.createServer(async (req, res) => {
    let target
    try {
      target = new URL(req.url)
    } catch {
      res.writeHead(400).end('Bad request')
      return
    }
    if (target.protocol !== 'http:') {
      res.writeHead(400).end('Only http:// is proxied this way')
      return
    }
    let address
    try {
      address = await resolve(target.hostname)
    } catch (err) {
      res.writeHead(403, { 'Content-Type': 'text/plain' }).end(err.message)
      return
    }
    const headers = { ...req.headers, host: target.host }
    delete headers['proxy-connection']
    delete headers['proxy-authorization']
    const upstream = http.request(
      {
        host: address.address,
        family: address.family,
        port: target.port || 80,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers,
      },
      upstreamRes => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
        upstreamRes.pipe(res)
      }
    )
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502)
      res.end()
    })
    req.pipe(upstream)
  })

  // HTTPS and WebSockets: a tunnel to host:port
  server.on('connect', async (req, client, head) => {
    client.on('error', () => {})
    const authority = authorityOf(req.url)
    if (!authority) {
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return
    }
    let address
    try {
      address = await resolve(authority.host)
    } catch {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    const upstream = net.connect(
      { host: address.address, port: authority.port, family: address.family },
      () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head?.length) upstream.write(head)
        upstream.pipe(client)
        client.pipe(upstream)
      }
    )
    upstream.on('error', () => client.destroy())
    client.on('close', () => upstream.destroy())
  })

  return server
}
