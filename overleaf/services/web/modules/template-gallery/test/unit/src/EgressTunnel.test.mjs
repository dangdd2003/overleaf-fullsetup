import net from 'node:net'
import { describe, it, expect, afterEach } from 'vitest'
import { openTunnel } from '../../../app/src/transport/EgressTunnel.mjs'

// Fake proxies on loopback. Each test passes allowPrivate: true for them.

const servers = []

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop()
    server.close()
  }
})

function listen(server) {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      servers.push(server)
      resolve(server.address().port)
    })
  })
}

function firstData(socket) {
  return new Promise(resolve => socket.once('data', resolve))
}

// Fake HTTP CONNECT proxy: answers `status` and echoes after a 200
function connectProxy({ status = 200, requireAuth = null, seen = [] } = {}) {
  const server = net.createServer(socket => {
    let buf = Buffer.alloc(0)
    const onData = chunk => {
      buf = Buffer.concat([buf, chunk])
      const end = buf.indexOf('\r\n\r\n')
      if (end === -1) return
      socket.off('data', onData)
      const head = buf.subarray(0, end).toString('latin1')
      seen.push(head)
      if (requireAuth) {
        const token = Buffer.from(requireAuth).toString('base64')
        if (!head.includes(`Proxy-Authorization: Basic ${token}`)) {
          return socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
        }
      }
      if (status !== 200) return socket.end(`HTTP/1.1 ${status} Refused\r\n\r\n`)
      socket.write('HTTP/1.1 200 Connection established\r\n\r\n')
      socket.on('data', data => socket.write(data))
    }
    socket.on('data', onData)
    socket.on('error', () => {})
  })
  return listen(server)
}

// Fake SOCKS5 server: no-auth or username/password, reply code configurable
function socksProxy({ login = null, replyCode = 0, seen = {} } = {}) {
  const server = net.createServer(socket => {
    socket.on('error', () => {})
    socket.once('data', greeting => {
      const methods = [...greeting.subarray(2, 2 + greeting[1])]
      seen.methods = methods
      if (!login) {
        socket.write(Buffer.from([0x05, 0x00]))
      } else {
        if (!methods.includes(0x02)) return socket.end(Buffer.from([0x05, 0xff]))
        socket.write(Buffer.from([0x05, 0x02]))
        socket.once('data', auth => {
          const ulen = auth[1]
          const user = auth.subarray(2, 2 + ulen).toString()
          const pass = auth.subarray(3 + ulen + 0, 3 + ulen + auth[2 + ulen]).toString()
          seen.login = `${user}:${pass}`
          const ok = `${user}:${pass}` === login
          socket.write(Buffer.from([0x01, ok ? 0x00 : 0x01]))
          if (!ok) return socket.end()
          awaitRequest(socket)
        })
        return
      }
      awaitRequest(socket)
    })
  })

  function awaitRequest(socket) {
    socket.once('data', request => {
      seen.request = request
      const reply = Buffer.from([0x05, replyCode, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
      socket.write(reply)
      if (replyCode === 0) socket.on('data', data => socket.write(data))
    })
  }
  return listen(server)
}

function closedPort() {
  return new Promise(resolve => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

async function echoesThroughTunnel(socket) {
  socket.write('ping')
  expect((await firstData(socket)).toString()).toBe('ping')
  socket.destroy()
}

describe('EgressTunnel: HTTP CONNECT', () => {
  it('opens a tunnel through an HTTP proxy', async () => {
    const seen = []
    const port = await connectProxy({ seen })
    const socket = await openTunnel(
      { scheme: 'http', host: '127.0.0.1', port, allowPrivate: true },
      '93.184.216.34',
      443
    )
    expect(seen[0].split('\r\n')[0]).toBe('CONNECT 93.184.216.34:443 HTTP/1.1')
    await echoesThroughTunnel(socket)
  })

  it('sends Basic Proxy-Authorization when a login is set', async () => {
    const seen = []
    const port = await connectProxy({ seen, requireAuth: 'alice:s3cret' })
    const socket = await openTunnel(
      {
        scheme: 'http',
        host: '127.0.0.1',
        port,
        allowPrivate: true,
        username: 'alice',
        password: 's3cret',
      },
      '93.184.216.34',
      443
    )
    expect(seen[0]).toContain('Proxy-Authorization: Basic ')
    socket.destroy()
  })

  it('maps 407 to EPROXY_AUTH', async () => {
    const port = await connectProxy({ requireAuth: 'alice:s3cret' })
    const err = await openTunnel(
      { scheme: 'http', host: '127.0.0.1', port, allowPrivate: true },
      '93.184.216.34',
      443
    ).catch(e => e)
    expect(err.code).toBe('EPROXY_AUTH')
    expect(err.message).not.toContain('s3cret')
  })

  it('maps a non-200 reply to EPROXY_CONNECT', async () => {
    const port = await connectProxy({ status: 502 })
    const err = await openTunnel(
      { scheme: 'http', host: '127.0.0.1', port, allowPrivate: true },
      '93.184.216.34',
      443
    ).catch(e => e)
    expect(err.code).toBe('EPROXY_CONNECT')
    expect(err.status).toBe(502)
  })
})

describe('EgressTunnel: SOCKS5', () => {
  it('connects with no authentication (IPv4 target)', async () => {
    const seen = {}
    const port = await socksProxy({ seen })
    const socket = await openTunnel(
      { scheme: 'socks5', host: '127.0.0.1', port, allowPrivate: true },
      '93.184.216.34',
      443
    )
    expect(seen.methods).toEqual([0x00])
    expect([...seen.request.subarray(0, 4)]).toEqual([0x05, 0x01, 0x00, 0x01])
    expect(seen.request.readUInt16BE(8)).toBe(443)
    await echoesThroughTunnel(socket)
  })

  it('offers and performs username/password authentication', async () => {
    const seen = {}
    const port = await socksProxy({ seen, login: 'bob:pw' })
    const socket = await openTunnel(
      {
        scheme: 'socks5h',
        host: '127.0.0.1',
        port,
        allowPrivate: true,
        username: 'bob',
        password: 'pw',
      },
      '93.184.216.34',
      443
    )
    expect(seen.methods).toEqual([0x00, 0x02])
    expect(seen.login).toBe('bob:pw')
    socket.destroy()
  })

  it('rejects a wrong login with EPROXY_AUTH', async () => {
    const port = await socksProxy({ login: 'bob:pw' })
    const err = await openTunnel(
      {
        scheme: 'socks5',
        host: '127.0.0.1',
        port,
        allowPrivate: true,
        username: 'bob',
        password: 'wrong',
      },
      '93.184.216.34',
      443
    ).catch(e => e)
    expect(err.code).toBe('EPROXY_AUTH')
  })

  it('uses ATYP 04 and 16 address bytes for an IPv6 target', async () => {
    const seen = {}
    const port = await socksProxy({ seen })
    const socket = await openTunnel(
      { scheme: 'socks5', host: '127.0.0.1', port, allowPrivate: true },
      '2606:4700::1111',
      443
    )
    expect(seen.request[3]).toBe(0x04)
    expect(seen.request.length).toBe(4 + 16 + 2)
    expect(seen.request.readUInt16BE(20)).toBe(443)
    socket.destroy()
  })

  it('maps a SOCKS5 refusal to EPROXY_CONNECT', async () => {
    const port = await socksProxy({ replyCode: 5 })
    const err = await openTunnel(
      { scheme: 'socks5', host: '127.0.0.1', port, allowPrivate: true },
      '93.184.216.34',
      443
    ).catch(e => e)
    expect(err.code).toBe('EPROXY_CONNECT')
  })
})

describe('EgressTunnel: failures', () => {
  it('times out a proxy that never answers with EPROXY_UNREACHABLE', async () => {
    const server = net.createServer(() => {})
    const port = await listen(server)
    const started = Date.now()
    const err = await openTunnel(
      { scheme: 'http', host: '127.0.0.1', port, allowPrivate: true },
      '93.184.216.34',
      443,
      { timeoutMs: 200 }
    ).catch(e => e)
    expect(err.code).toBe('EPROXY_UNREACHABLE')
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('reports a closed port as EPROXY_UNREACHABLE', async () => {
    const port = await closedPort()
    const err = await openTunnel(
      { scheme: 'socks5', host: '127.0.0.1', port, allowPrivate: true },
      '93.184.216.34',
      443
    ).catch(e => e)
    expect(err.code).toBe('EPROXY_UNREACHABLE')
  })

  it('refuses a private proxy host unless allowPrivate is set', async () => {
    const port = await connectProxy()
    const err = await openTunnel(
      { scheme: 'http', host: '127.0.0.1', port },
      '93.184.216.34',
      443
    ).catch(e => e)
    expect(err.code).toBe('EPROXY_UNREACHABLE')
  })

  it('refuses a metadata proxy address even with allowPrivate', async () => {
    const err = await openTunnel(
      { scheme: 'http', host: '169.254.169.254', port: 80, allowPrivate: true },
      '93.184.216.34',
      443
    ).catch(e => e)
    expect(err.code).toBe('EPROXY_UNREACHABLE')
  })
})
