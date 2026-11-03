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

function egressFor(port, scheme = 'http') {
  return {
    id: 'px_test00000001',
    label: 'test',
    scheme,
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

  it.each(['http', 'https', 'socks5', 'socks5h'])(
    'refuses a private target before a %s proxy is contacted',
    async scheme => {
      const proxy = await countingProxy()
      const err = await requestRaw(`https://${HOST}/x`, {
        egress: egressFor(proxy.port, scheme),
        allowedHosts: [HOST],
        lookupFn: lookupTo('10.0.0.5'),
      }).catch(e => e)
      expect(err.code).toBe('EADDRBLOCKED')
      expect(proxy.connections).toBe(0)
    }
  )

  it.each(['http', 'socks5h'])(
    'refuses a loopback or link-local target through a %s proxy',
    async scheme => {
      for (const address of ['127.0.0.1', '169.254.169.254']) {
        const proxy = await countingProxy()
        const err = await requestRaw(`https://${HOST}/x`, {
          egress: egressFor(proxy.port, scheme),
          allowedHosts: [HOST],
          lookupFn: lookupTo(address),
        }).catch(e => e)
        expect(err.code).toBe('EADDRBLOCKED')
        expect(proxy.connections).toBe(0)
      }
    }
  )

  it('refuses a literal private IP target through an HTTP proxy', async () => {
    const proxy = await countingProxy()
    const err = await requestRaw('https://10.0.0.5/x', {
      egress: egressFor(proxy.port),
      allowedHosts: ['10.0.0.5'],
      lookupFn: lookupTo('93.184.216.34'),
    }).catch(e => e)
    expect(err.code).toBe(OUTBOUND_BLOCKED)
    expect(proxy.connections).toBe(0)
  })

  it('still lets a public target through a SOCKS5 proxy', async () => {
    const proxy = await countingProxy(socket => {
      socket.end('HTTP/1.1 500 no\r\n\r\n')
    })
    const err = await requestRaw(`https://${HOST}/x`, {
      egress: egressFor(proxy.port, 'socks5'),
      allowedHosts: [HOST],
      lookupFn: lookupTo('93.184.216.34'),
      timeoutMs: 3000,
    }).catch(e => e)
    expect(err.code).not.toBe('EADDRBLOCKED')
    expect(err.code).not.toBe(OUTBOUND_BLOCKED)
    expect(proxy.connections).toBe(1)
  })

  it('sends the host name to an HTTP CONNECT proxy, which resolves it', async () => {
    // The fake proxy answers 200 and closes, so TLS fails, but the CONNECT
    // line shows what was sent.
    const proxy = await countingProxy(socket => {
      socket.end('HTTP/1.1 200 Connection established\r\n\r\n')
    })
    const lookups = []
    const err = await requestRaw(`https://${HOST}/x`, {
      egress: egressFor(proxy.port),
      allowedHosts: [HOST],
      lookupFn: (...args) => {
        lookups.push(args[0])
        return lookupTo('93.184.216.34')(...args)
      },
      timeoutMs: 3000,
    }).catch(e => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.code).not.toBe(OUTBOUND_BLOCKED)
    expect(proxy.connections).toBe(1)
    expect(proxy.lines[0]).toBe(`CONNECT ${HOST}:443 HTTP/1.1`)
    // The name is vetted locally before it is handed to the proxy
    expect(lookups).toEqual([HOST])
  })

  it('does not need local DNS when the proxy resolves the name', async () => {
    // A broken local resolver (EAI_AGAIN, or a fake-IP answer) must not stop
    // a request that the proxy can serve.
    const proxy = await countingProxy(socket => {
      socket.end('HTTP/1.1 200 Connection established\r\n\r\n')
    })
    const failingDns = (hostname, options, callback) => {
      const err = Object.assign(new Error('getaddrinfo EAI_AGAIN'), {
        code: 'EAI_AGAIN',
      })
      callback(err)
    }
    const err = await requestRaw(`https://${HOST}/x`, {
      egress: egressFor(proxy.port, 'socks5h'),
      allowedHosts: [HOST],
      lookupFn: failingDns,
      timeoutMs: 3000,
    }).catch(e => e)
    expect(err.code).not.toBe('EAI_AGAIN')
    expect(err.code).not.toBe('EADDRBLOCKED')
    expect(proxy.connections).toBe(1)
  })
})
