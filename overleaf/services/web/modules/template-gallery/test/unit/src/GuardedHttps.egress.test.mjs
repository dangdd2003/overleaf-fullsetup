import net from 'node:net'
import { describe, it, expect, afterEach } from 'vitest'
import { requestRaw, OUTBOUND_BLOCKED } from '../../../app/src/transport/GuardedHttps.mjs'

// Egress checks run before any proxy socket is opened. The fake proxy counts
// connections so a refusal can be shown to happen before the proxy is touched.

const HOST = 'gallery.test.example'
const servers = []

afterEach(() => {
  while (servers.length) servers.pop().close()
})

function countingProxy(answer = null) {
  const seen = { connections: 0, lines: [] }
  const server = net.createServer(socket => {
    seen.connections++
    socket.on('error', () => {})
    socket.once('data', chunk => {
      seen.lines.push(chunk.toString('latin1').split('\r\n')[0])
      if (answer) answer(socket)
      else socket.end('HTTP/1.1 500 no\r\n\r\n')
    })
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      servers.push(server)
      seen.port = server.address().port
      resolve(seen)
    })
  })
}

function egressFor(port) {
  return {
    id: 'px_test00000001',
    label: 'test',
    scheme: 'http',
    host: '127.0.0.1',
    port,
    allowPrivate: true,
    username: null,
    password: null,
  }
}

function lookupTo(address) {
  return (hostname, options, callback) => {
    if (options?.all) return callback(null, [{ address, family: 4 }])
    callback(null, address, 4)
  }
}

describe('GuardedHttps egress option', () => {
  it('refuses an off-list host before any proxy socket is opened', async () => {
    const proxy = await countingProxy()
    const err = await requestRaw('https://evil.example.com/x', {
      egress: egressFor(proxy.port),
      allowedHosts: [HOST],
      lookupFn: lookupTo('93.184.216.34'),
    }).catch(e => e)
    expect(err.code).toBe(OUTBOUND_BLOCKED)
    expect(proxy.connections).toBe(0)
  })

  it('refuses plain http targets through an egress proxy', async () => {
    const proxy = await countingProxy()
    const err = await requestRaw(`http://${HOST}/x`, {
      egress: egressFor(proxy.port),
      allowedHosts: [HOST],
      lookupFn: lookupTo('93.184.216.34'),
    }).catch(e => e)
    expect(err.code).toBe(OUTBOUND_BLOCKED)
    expect(proxy.connections).toBe(0)
  })

  it('refuses a private target before the proxy is contacted', async () => {
    const proxy = await countingProxy()
    const err = await requestRaw(`https://${HOST}/x`, {
      egress: egressFor(proxy.port),
      allowedHosts: [HOST],
      lookupFn: lookupTo('10.0.0.5'),
    }).catch(e => e)
    expect(err.code).toBe('EADDRBLOCKED')
    expect(proxy.connections).toBe(0)
  })

  it('pins the first public address and tunnels to it', async () => {
    // The fake proxy answers 200 and closes, so TLS fails, but the CONNECT
    // line proves which address was pinned.
    const proxy = await countingProxy(socket => {
      socket.end('HTTP/1.1 200 Connection established\r\n\r\n')
    })
    const err = await requestRaw(`https://${HOST}/x`, {
      egress: egressFor(proxy.port),
      allowedHosts: [HOST],
      lookupFn: lookupTo('93.184.216.34'),
      timeoutMs: 3000,
    }).catch(e => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.code).not.toBe(OUTBOUND_BLOCKED)
    expect(proxy.connections).toBe(1)
    expect(proxy.lines[0]).toBe('CONNECT 93.184.216.34:443 HTTP/1.1')
  })
})
