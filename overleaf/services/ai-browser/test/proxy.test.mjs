import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import {
  createGuardedProxy,
  isPublicAddress,
  resolvePublic,
} from '../proxy.mjs'

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return server.address().port
}

/** Sends a raw CONNECT and returns the proxy's first reply line. */
function connectThrough(port, authority, after) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`
      )
    })
    let reply = ''
    socket.on('data', chunk => {
      reply += chunk.toString()
      if (!after) {
        socket.destroy()
        resolve(reply.split('\r\n')[0])
      } else if (reply.includes('\r\n\r\n') && !socket.sentAfter) {
        socket.sentAfter = true
        socket.write(after)
      } else if (socket.sentAfter && reply.includes('tunnelled')) {
        socket.destroy()
        resolve(reply)
      }
    })
    socket.on('error', reject)
  })
}

test('only globally routable addresses are public', () => {
  assert.equal(isPublicAddress('8.8.8.8'), true)
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true)
  for (const address of [
    '127.0.0.1',
    '10.0.0.5',
    '172.18.0.3',
    '192.168.1.1',
    '169.254.169.254',
    '::1',
    'fd00::1',
    '::ffff:127.0.0.1',
    'nonsense',
  ]) {
    assert.equal(isPublicAddress(address), false, address)
  }
})

test('refuses a name that resolves to a private address', async () => {
  await assert.rejects(
    resolvePublic('mongo', {
      lookup: async () => [{ address: '172.18.0.3', family: 4 }],
    }),
    /not a public address/
  )
  await assert.rejects(resolvePublic('127.0.0.1'), /not a public address/)
})

test('refuses to tunnel to a private address', async function () {
  const proxy = createGuardedProxy({
    lookup: async () => [{ address: '172.18.0.3', family: 4 }],
  })
  const port = await listen(proxy)
  try {
    assert.match(await connectThrough(port, 'mongo:27017'), /^HTTP\/1\.1 403/)
  } finally {
    proxy.close()
  }
})

test('refuses a plain HTTP request for loopback', async () => {
  const proxy = createGuardedProxy()
  const port = await listen(proxy)
  try {
    const status = await new Promise((resolve, reject) => {
      http
        .get(
          {
            host: '127.0.0.1',
            port,
            path: 'http://localhost:3000/secret',
            headers: { Host: 'localhost:3000' },
          },
          res => {
            res.resume()
            resolve(res.statusCode)
          }
        )
        .on('error', reject)
    })
    assert.equal(status, 403)
  } finally {
    proxy.close()
  }
})

test('tunnels to an allowed address', async () => {
  const target = net.createServer(socket =>
    socket.on('data', () => socket.end('tunnelled'))
  )
  const targetPort = await listen(target)
  // Stand-ins: DNS says "the test server", and the test server counts as public
  const proxy = createGuardedProxy({
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    isPublic: () => true,
  })
  const port = await listen(proxy)
  try {
    const reply = await connectThrough(
      port,
      `example.test:${targetPort}`,
      'hello'
    )
    assert.match(reply, /^HTTP\/1\.1 200/)
    assert.match(reply, /tunnelled/)
  } finally {
    proxy.close()
    target.close()
  }
})
