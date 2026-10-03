import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import {
  EGRESS_LIMITS,
  EGRESS_PORTS,
  createEgressProxy,
  parseProxyUrl,
} from '../proxy.mjs'

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return server.address().port
}

function connectThrough(port, authority) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`
      )
    })
    socket.once('data', chunk => {
      socket.destroy()
      resolve(chunk.toString().split('\r\n')[0])
    })
    socket.on('error', reject)
  })
}

function openTunnel(port, authority) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`
      )
    })
    socket.once('data', chunk => {
      const line = chunk.toString().split('\r\n')[0]
      if (/ 200 /.test(line)) resolve(socket)
      else reject(new Error(line))
    })
    socket.on('error', reject)
  })
}

async function echoTarget() {
  const target = net.createServer(socket => socket.pipe(socket))
  const port = await listen(target)
  return { target, port }
}

function proxyFor(targetPort, options = {}) {
  const lines = []
  const proxy = createEgressProxy({
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    isPublic: () => true,
    ports: new Set([targetPort]),
    log: line => lines.push(line),
    ...options,
  })
  return { proxy, lines }
}

test('parseProxyUrl parses HTTP and SOCKS5 URLs with credentials', () => {
  assert.equal(parseProxyUrl(null), null)
  assert.equal(parseProxyUrl(''), null)

  const httpProxy = parseProxyUrl('http://user:pass123@proxy.example.com:8080')
  assert.deepEqual(httpProxy, {
    type: 'http',
    protocol: 'http:',
    host: 'proxy.example.com',
    port: 8080,
    username: 'user',
    password: 'pass123',
  })

  const socksProxy = parseProxyUrl('socks5://admin:secret@10.0.0.5:1080')
  assert.deepEqual(socksProxy, {
    type: 'socks5',
    protocol: 'socks5:',
    host: '10.0.0.5',
    port: 1080,
    username: 'admin',
    password: 'secret',
  })

  const defaultSocksPort = parseProxyUrl('socks5h://proxy.example.com')
  assert.equal(defaultSocksPort.port, 1080)
  assert.equal(defaultSocksPort.type, 'socks5')
})

test('allows only ports 80 and 443 by default', () => {
  assert.deepEqual([...EGRESS_PORTS], [80, 443])
})

test('tunnels to a public address on an allowed port and logs it', async () => {
  const { target, port: targetPort } = await echoTarget()
  const { proxy, lines } = proxyFor(targetPort)
  const port = await listen(proxy)
  try {
    const socket = await openTunnel(port, `example.test:${targetPort}`)
    const echoed = await new Promise(resolve => {
      socket.once('data', chunk => resolve(chunk.toString()))
      socket.write('hello')
    })
    assert.equal(echoed, 'hello')
    assert.match(lines.join('\n'), /egress connect example\.test:\d+ 127\.0\.0\.1/)
    socket.destroy()
  } finally {
    proxy.close()
    target.close()
  }
})

test('refuses a port that is not a web port', async () => {
  const { proxy, lines } = proxyFor(443)
  const port = await listen(proxy)
  try {
    assert.match(await connectThrough(port, 'example.test:25'), /^HTTP\/1\.1 403/)
    assert.match(lines.join('\n'), /egress refused example\.test:25 \(port\)/)
  } finally {
    proxy.close()
  }
})

test('refuses a private address', async () => {
  const lines = []
  const proxy = createEgressProxy({
    lookup: async () => [{ address: '172.18.0.3', family: 4 }],
    ports: new Set([27017]),
    log: line => lines.push(line),
  })
  const port = await listen(proxy)
  try {
    assert.match(
      await connectThrough(port, 'mongo:27017'),
      /^HTTP\/1\.1 403/
    )
    assert.match(lines.join('\n'), /egress refused mongo:27017 \(address\)/)
  } finally {
    proxy.close()
  }
})

test('chains outbound HTTPS through an upstream SOCKS5 proxy with auth', async () => {
  const { target, port: targetPort } = await echoTarget()
  // Mock SOCKS5 server with auth
  let socksAuthUsed = false
  const socksServer = net.createServer(socket => {
    socket.once('data', chunk => {
      if (chunk[0] === 5 && chunk.includes(2)) {
        socket.write(Buffer.from([5, 2])) // username/password
        socket.once('data', auth => {
          socksAuthUsed = true
          socket.write(Buffer.from([1, 0])) // auth ok
          socket.once('data', req => {
            if (req[0] === 5 && req[1] === 1) { // CONNECT
              // Connect to local target
              const upstream = net.connect({ host: '127.0.0.1', port: targetPort }, () => {
                socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]))
                socket.pipe(upstream).pipe(socket)
              })
            }
          })
        })
      }
    })
  })
  const socksPort = await listen(socksServer)

  const { proxy, lines } = proxyFor(targetPort, {
    upstreamProxy: `socks5://user:pass@127.0.0.1:${socksPort}`,
  })
  const proxyPort = await listen(proxy)
  try {
    const socket = await openTunnel(proxyPort, `example.test:${targetPort}`)
    const echoed = await new Promise(resolve => {
      socket.once('data', chunk => resolve(chunk.toString()))
      socket.write('socks5-data')
    })
    assert.equal(echoed, 'socks5-data')
    assert.equal(socksAuthUsed, true)
    assert.match(lines.join('\n'), /egress connect example\.test:\d+ 127\.0\.0\.1 \(via socks5\)/)
    socket.destroy()
  } finally {
    proxy.close()
    socksServer.close()
    target.close()
  }
})

test('chains outbound HTTP through an upstream HTTP proxy', async () => {
  let proxyAuthHeader = null
  const upstreamHttp = http.createServer((req, res) => {
    proxyAuthHeader = req.headers['proxy-authorization']
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('from-upstream-http')
  })
  const upstreamPort = await listen(upstreamHttp)

  const { proxy } = proxyFor(80, {
    upstreamProxy: `http://myuser:mypass@127.0.0.1:${upstreamPort}`,
  })
  const proxyPort = await listen(proxy)
  try {
    const res = await new Promise((resolve, reject) => {
      http.get(
        {
          host: '127.0.0.1',
          port: proxyPort,
          path: 'http://example.test/test-page',
          headers: { host: 'example.test' },
        },
        resolve
      ).on('error', reject)
    })
    assert.equal(res.statusCode, 200)
    const body = await new Promise(resolve => {
      let b = ''
      res.on('data', c => { b += c })
      res.on('end', () => resolve(b))
    })
    assert.equal(body, 'from-upstream-http')
    assert.equal(
      proxyAuthHeader,
      `Basic ${Buffer.from('myuser:mypass').toString('base64')}`
    )
  } finally {
    proxy.close()
    upstreamHttp.close()
  }
})
