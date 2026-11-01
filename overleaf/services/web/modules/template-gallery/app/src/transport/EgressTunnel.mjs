import dns from 'node:dns'
import net from 'node:net'
import tls from 'node:tls'
import { isPublicAddress } from './GuardedHttps.mjs'

// Opens a raw TCP tunnel to a target IP through one outbound proxy: an HTTP
// CONNECT proxy (optionally over TLS) or a SOCKS5 proxy. The caller does TLS
// to the target itself, so the certificate check stays with the target host.
// The target is always an IP the caller has already checked and pinned.

export const HANDSHAKE_TIMEOUT_MS = 10_000
const MAX_HEADER_BYTES = 8 * 1024

const METADATA_BLOCK = new net.BlockList()
METADATA_BLOCK.addSubnet('169.254.0.0', 16, 'ipv4')
// Node matches ::ffff:a.b.c.d against the ipv4 rule, but not the RFC 2765
// translated form ::ffff:0:a.b.c.d
METADATA_BLOCK.addSubnet('::ffff:0:169.254.0.0', 112, 'ipv6')
METADATA_BLOCK.addSubnet('fe80::', 10, 'ipv6')
METADATA_BLOCK.addSubnet('fd00:ec2::', 32, 'ipv6')

/**
 * Cloud metadata and link-local addresses. Refused for proxies even when the
 * operator allows private proxy hosts.
 */
export function isMetadataAddress(address) {
  const raw = String(address ?? '').replace(/^\[|\]$/g, '')
  const family = net.isIP(raw)
  if (family === 0) return false
  return METADATA_BLOCK.check(raw, family === 4 ? 'ipv4' : 'ipv6')
}

function tunnelError(code, message, extra = {}) {
  const err = new Error(message)
  err.code = code
  Object.assign(err, extra)
  return err
}

function unreachable(err) {
  return tunnelError(
    'EPROXY_UNREACHABLE',
    `proxy unreachable: ${err?.code || err?.message || 'unknown error'}`
  )
}

// The proxy host is resolved here and the first address is dialled, so the
// check and the connection use the same address.
async function resolveProxyAddress(proxy) {
  let entries
  try {
    entries = await dns.promises.lookup(proxy.host, { all: true })
  } catch (err) {
    throw unreachable(err)
  }
  const restricted = entries.some(
    entry =>
      isMetadataAddress(entry.address) ||
      (!proxy.allowPrivate && !isPublicAddress(entry.address))
  )
  if (entries.length === 0 || restricted) {
    throw tunnelError(
      'EPROXY_UNREACHABLE',
      'proxy host resolves to a restricted address'
    )
  }
  return entries[0].address
}

// Waits for the next chunk from the socket. Unlike a 'data' listener, bytes
// that are not consumed stay buffered for the next reader.
function nextChunk(socket) {
  const ready = socket.read()
  if (ready) return Promise.resolve(ready)
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off('readable', onReadable)
      socket.off('error', onFail)
      socket.off('end', onClosed)
      socket.off('close', onClosed)
    }
    const onReadable = () => {
      const chunk = socket.read()
      if (chunk) {
        cleanup()
        resolve(chunk)
      }
    }
    const onFail = err => {
      cleanup()
      reject(err)
    }
    const onClosed = () => {
      cleanup()
      reject(tunnelError('EPROXY_UNREACHABLE', 'proxy closed the connection'))
    }
    socket.on('readable', onReadable)
    socket.on('error', onFail)
    socket.on('end', onClosed)
    socket.on('close', onClosed)
  })
}

async function readExact(socket, length) {
  let acc = Buffer.alloc(0)
  while (acc.length < length) {
    acc = Buffer.concat([acc, await nextChunk(socket)])
  }
  if (acc.length > length) socket.unshift(acc.subarray(length))
  return acc.subarray(0, length)
}

async function readHeaderBlock(socket) {
  const end = Buffer.from('\r\n\r\n')
  let acc = Buffer.alloc(0)
  for (;;) {
    acc = Buffer.concat([acc, await nextChunk(socket)])
    const at = acc.indexOf(end)
    if (at !== -1) {
      if (at + end.length < acc.length) {
        socket.unshift(acc.subarray(at + end.length))
      }
      return acc.subarray(0, at).toString('latin1')
    }
    if (acc.length > MAX_HEADER_BYTES) {
      throw tunnelError('EPROXY_PROTOCOL', 'proxy response headers too large')
    }
  }
}

function hostPort(ip, port) {
  return net.isIP(ip) === 6 ? `[${ip}]:${port}` : `${ip}:${port}`
}

async function httpConnect(socket, proxy, targetIp, targetPort) {
  const headers = [`CONNECT ${hostPort(targetIp, targetPort)} HTTP/1.1`]
  headers.push(`Host: ${hostPort(targetIp, targetPort)}`)
  if (proxy.username || proxy.password) {
    const token = Buffer.from(
      `${proxy.username || ''}:${proxy.password || ''}`,
      'utf8'
    ).toString('base64')
    headers.push(`Proxy-Authorization: Basic ${token}`)
  }
  socket.write(`${headers.join('\r\n')}\r\n\r\n`)

  const head = await readHeaderBlock(socket)
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1])
  if (!status) {
    throw tunnelError('EPROXY_PROTOCOL', 'proxy sent an invalid CONNECT reply')
  }
  if (status === 407) {
    throw tunnelError('EPROXY_AUTH', 'proxy rejected the login', { status })
  }
  if (status !== 200) {
    throw tunnelError('EPROXY_CONNECT', `proxy refused CONNECT (HTTP ${status})`, {
      status,
    })
  }
}

const SOCKS_AUTH_NONE = 0x00
const SOCKS_AUTH_PASSWORD = 0x02
const SOCKS_AUTH_REJECTED = 0xff
const SOCKS_ATYP_IPV4 = 0x01
const SOCKS_ATYP_IPV6 = 0x04
const SOCKS_ATYP_DOMAIN = 0x03

// RFC 1928 greeting, then RFC 1929 username/password when the proxy asks for it
async function socksAuthenticate(socket, proxy) {
  const hasLogin = Boolean(proxy.username || proxy.password)
  const methods = hasLogin
    ? [SOCKS_AUTH_NONE, SOCKS_AUTH_PASSWORD]
    : [SOCKS_AUTH_NONE]
  socket.write(Buffer.from([0x05, methods.length, ...methods]))

  const [version, method] = await readExact(socket, 2)
  if (version !== 0x05) {
    throw tunnelError('EPROXY_PROTOCOL', 'proxy is not a SOCKS5 server')
  }
  if (method === SOCKS_AUTH_REJECTED) {
    throw tunnelError('EPROXY_AUTH', 'SOCKS5 proxy offered no usable login method')
  }
  if (method === SOCKS_AUTH_NONE) return
  if (method !== SOCKS_AUTH_PASSWORD || !hasLogin) {
    throw tunnelError('EPROXY_PROTOCOL', `unexpected SOCKS5 method ${method}`)
  }

  const user = Buffer.from(proxy.username || '', 'utf8')
  const pass = Buffer.from(proxy.password || '', 'utf8')
  if (user.length > 255 || pass.length > 255) {
    throw tunnelError('EPROXY_AUTH', 'SOCKS5 login is longer than 255 bytes')
  }
  socket.write(
    Buffer.concat([
      Buffer.from([0x01, user.length]),
      user,
      Buffer.from([pass.length]),
      pass,
    ])
  )
  const [authVersion, status] = await readExact(socket, 2)
  if (authVersion !== 0x01 || status !== 0x00) {
    throw tunnelError('EPROXY_AUTH', 'SOCKS5 proxy rejected the login', {
      status: null,
    })
  }
}

// Reply: VER REP RSV ATYP BND.ADDR BND.PORT. BND is read and discarded.
const SOCKS_REPLY_MESSAGES = Object.freeze({
  1: 'general failure',
  2: 'connection not allowed by ruleset',
  3: 'network unreachable',
  4: 'host unreachable',
  5: 'connection refused',
  6: 'TTL expired',
  7: 'command not supported',
  8: 'address type not supported',
})

async function socksConnect(socket, targetIp, targetPort) {
  const family = net.isIP(targetIp)
  const address =
    family === 6 ? expandIPv6(targetIp) : Buffer.from(targetIp.split('.').map(Number))
  const atyp = family === 6 ? SOCKS_ATYP_IPV6 : SOCKS_ATYP_IPV4
  const port = Buffer.alloc(2)
  port.writeUInt16BE(targetPort)
  socket.write(
    Buffer.concat([Buffer.from([0x05, 0x01, 0x00, atyp]), address, port])
  )

  const [version, reply, , boundType] = await readExact(socket, 4)
  if (version !== 0x05) {
    throw tunnelError('EPROXY_PROTOCOL', 'proxy sent an invalid SOCKS5 reply')
  }
  if (reply !== 0x00) {
    const reason = SOCKS_REPLY_MESSAGES[reply] || `reply code ${reply}`
    throw tunnelError('EPROXY_CONNECT', `SOCKS5 CONNECT failed: ${reason}`, {
      socksReply: reply,
    })
  }
  // Discard the bound address: 4 or 16 bytes, or a length-prefixed name.
  if (boundType === SOCKS_ATYP_IPV4) await readExact(socket, 4 + 2)
  else if (boundType === SOCKS_ATYP_IPV6) await readExact(socket, 16 + 2)
  else if (boundType === SOCKS_ATYP_DOMAIN) {
    const [length] = await readExact(socket, 1)
    await readExact(socket, length + 2)
  } else {
    throw tunnelError('EPROXY_PROTOCOL', 'proxy sent an unknown SOCKS5 address type')
  }
}

// Full 8-group form of an IPv6 literal, as eight big-endian 16-bit words
function expandIPv6(ip) {
  // Mixed notation (::ffff:93.184.216.34): the dotted quad becomes two groups
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip)
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number)
    ip = `${ip.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const [head, tail = null] = ip.split('::')
  const headParts = head ? head.split(':') : []
  const tailParts = tail ? tail.split(':') : []
  const missing = 8 - headParts.length - tailParts.length
  const groups = [
    ...headParts,
    ...Array(Math.max(0, missing)).fill('0'),
    ...tailParts,
  ]
  const bytes = Buffer.alloc(16)
  groups.forEach((group, index) => bytes.writeUInt16BE(parseInt(group, 16), index * 2))
  return bytes
}

async function connectProxy(proxy, state) {
  const address = await resolveProxyAddress(proxy)
  const tcp = net.connect({ host: address, port: proxy.port })
  state.socket = tcp
  state.tcp = tcp
  await new Promise((resolve, reject) => {
    tcp.once('connect', resolve)
    tcp.once('error', err => reject(unreachable(err)))
  })
  if (proxy.scheme !== 'https') return tcp

  // SNI carries names only, never IP literals
  const secure = tls.connect({
    socket: tcp,
    servername: net.isIP(proxy.host) ? undefined : proxy.host,
  })
  state.socket = secure
  await new Promise((resolve, reject) => {
    secure.once('secureConnect', resolve)
    secure.once('error', err => reject(unreachable(err)))
    secure.once('close', () =>
      reject(tunnelError('EPROXY_UNREACHABLE', 'proxy closed the connection'))
    )
  })
  return secure
}

/**
 * Opens a tunnel to targetIp:targetPort through the proxy. Resolves to a
 * connected socket, ready for the caller's TLS handshake with the target.
 *
 * @param {{ scheme: string, host: string, port: number, username?: string|null, password?: string|null, allowPrivate?: boolean }} proxy
 * @param {string} targetIp - literal IP the caller has already checked
 * @param {number} targetPort
 * @param {{ timeoutMs?: number }} [opts]
 */
export async function openTunnel(proxy, targetIp, targetPort, opts = {}) {
  if (net.isIP(targetIp) === 0) {
    throw tunnelError('EPROXY_CONNECT', 'tunnel target must be an IP address')
  }
  const timeoutMs = opts.timeoutMs > 0 ? opts.timeoutMs : HANDSHAKE_TIMEOUT_MS
  const state = { socket: null, tcp: null }
  const timer = setTimeout(() => {
    state.socket?.destroy(
      tunnelError('EPROXY_UNREACHABLE', 'proxy handshake timed out')
    )
  }, timeoutMs)
  timer.unref?.()

  // Errors on the socket while no reader is waiting must not crash the process
  const swallow = () => {}
  try {
    const socket = await connectProxy(proxy, state)
    socket.on('error', swallow)
    if (proxy.scheme === 'socks5' || proxy.scheme === 'socks5h') {
      await socksAuthenticate(socket, proxy)
      await socksConnect(socket, targetIp, targetPort)
    } else {
      await httpConnect(socket, proxy, targetIp, targetPort)
    }
    socket.off('error', swallow)
    return socket
  } catch (err) {
    state.socket?.destroy()
    state.tcp?.destroy()
    throw err
  } finally {
    clearTimeout(timer)
  }
}

export default {
  openTunnel,
  isMetadataAddress,
  HANDSHAKE_TIMEOUT_MS,
}
