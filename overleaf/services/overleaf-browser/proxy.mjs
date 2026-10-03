import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import { resolvePublic } from './address.mjs'

/**
 * An internal guarded HTTP proxy that connects only to public addresses on web
 * ports, optionally chaining through an upstream HTTP or SOCKS5 proxy.
 *
 * Both Google Chrome and fetchSmall route their outbound traffic through it.
 * Even if an attacker compromises the browser, they cannot reach Overleaf,
 * MongoDB, Redis, the host network, or cloud metadata endpoints.
 */

export const EGRESS_PORTS = new Set([80, 443])

export const EGRESS_LIMITS = {
  maxConnections: 256,
  idleMs: 15_000,
  lifetimeMs: 10 * 60_000,
  maxUploadBytes: 16 * 1024 * 1024,
  connectTimeoutMs: 15_000,
}

/**
 * Parses a proxy URL string into structured proxy options.
 * Supports:
 *   - http://[user:pass@]host:port
 *   - https://[user:pass@]host:port
 *   - socks5://[user:pass@]host:port
 *   - socks5h://[user:pass@]host:port
 */
export function parseProxyUrl(raw) {
  if (!raw || typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  try {
    const parsed = new URL(trimmed)
    const proto = parsed.protocol.toLowerCase()
    if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(proto)) {
      throw new Error(`Unsupported proxy protocol: ${parsed.protocol}`)
    }
    const isSocks = proto === 'socks5:' || proto === 'socks5h:'
    return {
      type: isSocks ? 'socks5' : 'http',
      protocol: proto,
      host: parsed.hostname.replace(/^\[|\]$/g, ''),
      port: Number(parsed.port || (isSocks ? 1080 : 8080)),
      username: parsed.username ? decodeURIComponent(parsed.username) : null,
      password: parsed.password ? decodeURIComponent(parsed.password) : null,
    }
  } catch (err) {
    throw new Error(`Invalid proxy URL "${raw}": ${err.message}`)
  }
}

function authorityOf(value) {
  const match = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(String(value ?? ''))
  return match ? { host: match[1], port: Number(match[2]) } : null
}

/** Connects to destination through an upstream SOCKS5 proxy (RFC 1928 / 1929). */
function connectSocks5Tunnel({ proxy, targetHost, targetPort, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port })
    let cleaned = false

    const cleanup = err => {
      if (cleaned) return
      cleaned = true
      clearTimeout(timer)
      socket.destroy()
      reject(err || new Error('SOCKS5 connection failed'))
    }

    const timer = setTimeout(() => cleanup(new Error('SOCKS5 timeout')), timeoutMs)
    timer.unref?.()
    socket.once('error', cleanup)

    socket.once('connect', () => {
      // Step 1: Handshake. Support No Auth (0x00) and User/Pass (0x02)
      const hasAuth = Boolean(proxy.username || proxy.password)
      const handshake = hasAuth
        ? Buffer.from([0x05, 0x02, 0x00, 0x02])
        : Buffer.from([0x05, 0x01, 0x00])

      socket.write(handshake)
      socket.once('data', methodChunk => {
        if (methodChunk[0] !== 0x05) {
          return cleanup(new Error(`Invalid SOCKS version: ${methodChunk[0]}`))
        }
        const method = methodChunk[1]

        if (method === 0x02 && hasAuth) {
          // Username/Password authentication (RFC 1929)
          const uBuf = Buffer.from(proxy.username || '')
          const pBuf = Buffer.from(proxy.password || '')
          const authMsg = Buffer.concat([
            Buffer.from([0x01, uBuf.length]),
            uBuf,
            Buffer.from([pBuf.length]),
            pBuf,
          ])
          socket.write(authMsg)
          socket.once('data', authResp => {
            if (authResp[1] !== 0x00) {
              return cleanup(new Error('SOCKS5 authentication failed'))
            }
            sendConnectCommand()
          })
        } else if (method === 0x00) {
          sendConnectCommand()
        } else {
          return cleanup(new Error(`SOCKS5 rejected auth method: ${method}`))
        }
      })
    })

    function sendConnectCommand() {
      // Command 1 = CONNECT. Address type 3 = Domain Name, 1 = IPv4
      const isIpv4 = net.isIP(targetHost) === 4
      let addrBuf
      if (isIpv4) {
        const parts = targetHost.split('.').map(Number)
        addrBuf = Buffer.concat([Buffer.from([0x01]), Buffer.from(parts)])
      } else {
        const hostBuf = Buffer.from(targetHost)
        addrBuf = Buffer.concat([Buffer.from([0x03, hostBuf.length]), hostBuf])
      }
      const portBuf = Buffer.alloc(2)
      portBuf.writeUInt16BE(targetPort, 0)
      const req = Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addrBuf, portBuf])

      socket.write(req)
      socket.once('data', resp => {
        if (resp[0] !== 0x05 || resp[1] !== 0x00) {
          return cleanup(new Error(`SOCKS5 CONNECT failed with code ${resp[1]}`))
        }
        // SOCKS5 tunnel established
        clearTimeout(timer)
        socket.removeListener('error', cleanup)
        cleaned = true
        resolve(socket)
      })
    }
  })
}

/** Connects to destination through an upstream HTTP proxy via CONNECT. */
function connectHttpTunnel({ proxy, targetHost, targetPort, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const isTls = proxy.protocol === 'https:'
    const connectFn = isTls ? tls.connect : net.connect
    const socket = connectFn({ host: proxy.host, port: proxy.port })
    let cleaned = false

    const cleanup = err => {
      if (cleaned) return
      cleaned = true
      clearTimeout(timer)
      socket.destroy()
      reject(err || new Error('HTTP proxy connection failed'))
    }

    const timer = setTimeout(
      () => cleanup(new Error('HTTP proxy timeout')),
      timeoutMs
    )
    timer.unref?.()
    socket.once('error', cleanup)

    socket.once('connect', () => {
      const authority = `${targetHost}:${targetPort}`
      let headers = `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n`
      if (proxy.username || proxy.password) {
        const creds = Buffer.from(
          `${proxy.username || ''}:${proxy.password || ''}`
        ).toString('base64')
        headers += `Proxy-Authorization: Basic ${creds}\r\n`
      }
      headers += '\r\n'

      socket.write(headers)
      socket.once('data', chunk => {
        const line = chunk.toString().split('\r\n')[0]
        if (/^HTTP\/1\.[01]\s+200\b/i.test(line)) {
          clearTimeout(timer)
          socket.removeListener('error', cleanup)
          cleaned = true
          resolve(socket)
        } else {
          cleanup(new Error(`HTTP proxy refused CONNECT: ${line}`))
        }
      })
    })
  })
}

export function createEgressProxy({
  upstreamProxy = null,
  lookup,
  isPublic,
  ports = EGRESS_PORTS,
  limits = EGRESS_LIMITS,
  log = line => console.log(line),
} = {}) {
  const upstream =
    typeof upstreamProxy === 'string'
      ? parseProxyUrl(upstreamProxy)
      : upstreamProxy
  const resolve = host => resolvePublic(host, { lookup, isPublic })
  let open = 0

  function track(sockets) {
    if (open >= limits.maxConnections) return false
    open++
    let done = false
    const close = () => {
      if (done) return
      done = true
      open--
      clearTimeout(lifetime)
      for (const socket of sockets) socket?.destroy()
    }
    const lifetime = setTimeout(close, limits.lifetimeMs)
    lifetime.unref?.()
    for (const socket of sockets) {
      if (!socket) continue
      socket.setTimeout(limits.idleMs, close)
      socket.once('close', close)
      socket.on('error', close)
    }
    return true
  }

  function capUpload(source, sink, alreadySent = 0) {
    let sent = alreadySent
    source.on('data', chunk => {
      sent += chunk.length
      if (sent > limits.maxUploadBytes) {
        source.destroy()
        sink.destroy()
        return
      }
      if (!sink.write(chunk)) source.pause()
    })
    sink.on('drain', () => source.resume())
    source.on('end', () => sink.end())
  }

  // Dial destination: directly or through configured upstream proxy
  async function openUpstreamSocket(targetHost, targetPort, resolvedAddress) {
    if (!upstream) {
      return net.connect({
        host: resolvedAddress.address,
        port: targetPort,
        family: resolvedAddress.family,
      })
    }
    if (upstream.type === 'socks5') {
      return connectSocks5Tunnel({
        proxy: upstream,
        targetHost,
        targetPort,
        timeoutMs: limits.connectTimeoutMs,
      })
    }
    return connectHttpTunnel({
      proxy: upstream,
      targetHost,
      targetPort,
      timeoutMs: limits.connectTimeoutMs,
    })
  }

  // Plain HTTP
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
    const port = Number(target.port || 80)
    if (!ports.has(port)) {
      log(`egress refused ${target.hostname}:${port} (port)`)
      res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Port refused')
      return
    }
    let address
    try {
      address = await resolve(target.hostname)
    } catch (err) {
      log(`egress refused ${target.hostname}:${port} (address)`)
      res.writeHead(403, { 'Content-Type': 'text/plain' }).end(err.message)
      return
    }

    // Forward through upstream HTTP proxy or tunnel through SOCKS5/direct
    const headers = { ...req.headers, host: target.host }
    delete headers['proxy-connection']
    delete headers['proxy-authorization']

    if (upstream && upstream.type === 'http') {
      if (upstream.username || upstream.password) {
        const creds = Buffer.from(
          `${upstream.username || ''}:${upstream.password || ''}`
        ).toString('base64')
        headers['Proxy-Authorization'] = `Basic ${creds}`
      }
      const upstreamReq = http.request(
        {
          host: upstream.host,
          port: upstream.port,
          method: req.method,
          path: target.href,
          headers,
        },
        upstreamRes => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
          upstreamRes.pipe(res)
        }
      )
      upstreamReq.on('socket', socket => {
        if (!track([req.socket, socket])) {
          upstreamReq.destroy()
          if (!res.headersSent) res.writeHead(429).end('Too many connections')
          return
        }
        log(`egress http (proxy) ${target.hostname}:${port} via ${upstream.host}`)
      })
      upstreamReq.on('error', () => {
        if (!res.headersSent) res.writeHead(502)
        res.end()
      })
      capUpload(req, upstreamReq)
      return
    }

    let upstreamSocket
    try {
      upstreamSocket = await openUpstreamSocket(target.hostname, port, address)
    } catch (err) {
      log(`egress failed ${target.hostname}:${port} (${err.message})`)
      if (!res.headersSent) res.writeHead(502).end('Gateway error')
      return
    }

    const upstreamReq = http.request({
      createConnection: () => upstreamSocket,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers,
    })
    upstreamReq.on('socket', socket => {
      if (!track([req.socket, socket])) {
        upstreamReq.destroy()
        if (!res.headersSent) res.writeHead(429).end('Too many connections')
        return
      }
      log(`egress http ${target.hostname}:${port} ${address.address}${upstream ? ` (via ${upstream.type})` : ''}`)
    })
    upstreamReq.on('response', upstreamRes => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
      upstreamRes.pipe(res)
    })
    upstreamReq.on('error', () => {
      if (!res.headersSent) res.writeHead(502)
      res.end()
    })
    capUpload(req, upstreamReq)
  })

  // HTTPS and WebSockets: CONNECT tunnel
  server.on('connect', async (req, client, head) => {
    client.on('error', () => {})
    const authority = authorityOf(req.url)
    if (!authority) {
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return
    }
    if (!ports.has(authority.port)) {
      log(`egress refused ${authority.host}:${authority.port} (port)`)
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    let address
    try {
      address = await resolve(authority.host)
    } catch {
      log(`egress refused ${authority.host}:${authority.port} (address)`)
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }

    let upstreamSocket
    try {
      upstreamSocket = await openUpstreamSocket(authority.host, authority.port, address)
    } catch (err) {
      log(`egress failed ${authority.host}:${authority.port} (${err.message})`)
      client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      return
    }

    if (!track([client, upstreamSocket])) {
      upstreamSocket.destroy()
      client.end('HTTP/1.1 429 Too Many Requests\r\n\r\n')
      return
    }

    log(`egress connect ${authority.host}:${authority.port} ${address.address}${upstream ? ` (via ${upstream.type})` : ''}`)
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head?.length) upstreamSocket.write(head)
    upstreamSocket.pipe(client)
    capUpload(client, upstreamSocket, head?.length ?? 0)
  })

  server.openConnections = () => open
  return server
}
