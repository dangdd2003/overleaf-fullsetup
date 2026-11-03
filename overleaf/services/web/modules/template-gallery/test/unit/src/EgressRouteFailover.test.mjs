import net from 'node:net'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The proxy list is replaced by a plain array so no database is needed.
const egressState = vi.hoisted(() => ({ egresses: [] }))

vi.mock('../../../app/src/egress/EgressSettings.mjs', () => ({
  snapshot: () => ({ egresses: egressState.egresses }),
  ensureLoaded: async () => ({ egresses: egressState.egresses }),
}))

import {
  withHostSlot,
  isRouteFailure,
  isTransientError,
  resetRateGateForTests,
  getHostStatus,
} from '../../../app/src/transport/RateGate.mjs'
import {
  openTunnel,
  isTunnelTarget,
} from '../../../app/src/transport/EgressTunnel.mjs'

// S3 is not paced, so these tests do not wait for pacing slots.
const HOST = 's3'

function egress(id, extra = {}) {
  return {
    id,
    label: id,
    scheme: 'http',
    host: '127.0.0.1',
    port: 3128,
    allowPrivate: true,
    username: null,
    password: null,
    ...extra,
  }
}

function coded(code, extra = {}) {
  return Object.assign(new Error(`${code} happened`), { code }, extra)
}

beforeEach(() => {
  resetRateGateForTests()
  egressState.egresses = []
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

// Runs a withHostSlot call and advances fake time until it settles
async function settle(promise, ms = 120_000) {
  let result
  const tracked = promise.then(
    value => (result = { value }),
    error => (result = { error })
  )
  await vi.advanceTimersByTimeAsync(ms)
  await tracked
  return result
}

describe('RateGate: route failures', () => {
  it('classifies connection, DNS, TLS and gateway failures as route failures', () => {
    for (const code of [
      'ECONNRESET',
      'ETIMEDOUT',
      'EAI_AGAIN',
      'EADDRBLOCKED',
      'EPROXY_CONNECT',
      'EPROXY_UNREACHABLE',
      'ERR_TLS_CERT_ALTNAME_INVALID',
      'EPROTO',
    ]) {
      expect(isRouteFailure(coded(code))).toBe(true)
    }
    expect(isRouteFailure(new Error('socket hang up'))).toBe(true)
    expect(isRouteFailure(coded('EHTTP_502', { status: 502 }))).toBe(true)
    expect(isRouteFailure(coded('EHTTP_504', { status: 504 }))).toBe(true)
  })

  it('does not classify item-level answers as route failures', () => {
    expect(isRouteFailure(coded('EHTTP_404', { status: 404 }))).toBe(false)
    expect(isRouteFailure(coded('EHTTP_500', { status: 500 }))).toBe(false)
    expect(isRouteFailure(coded('EBYTECAP'))).toBe(false)
    expect(isRouteFailure(coded('detail_unparseable'))).toBe(false)
  })

  it('treats a flagged error as transient', () => {
    expect(isTransientError(coded('ECONNRESET'))).toBe(true)
    expect(isTransientError(Object.assign(new Error('x'), { routeFailure: true }))).toBe(true)
    expect(isTransientError(coded('EBYTECAP'))).toBe(false)
  })

  it('moves a failed request to the next route at once', async () => {
    egressState.egresses = [egress('px_a'), egress('px_b')]
    const used = []
    const result = await settle(
      withHostSlot(HOST, { priority: 'interactive' }, async ({ egress }) => {
        used.push(egress.id)
        if (egress.id === 'px_a') throw coded('ECONNRESET')
        return { status: 200 }
      })
    )
    expect(result.value).toEqual({ status: 200 })
    expect(used).toEqual(['px_a', 'px_b'])
  })

  it('rests a failing route briefly after one failure, longer after two in a row', async () => {
    egressState.egresses = [egress('px_a')]
    const attempt = withHostSlot(HOST, { priority: 'background' }, async () => {
      throw coded('ECONNRESET')
    }).catch(err => err)
    await vi.advanceTimersByTimeAsync(0)
    const afterFirst = getHostStatus().s3.routes[0].restUntil
    expect(afterFirst.getTime() - Date.now()).toBe(5_000)
    // The retry starts after the short rest, fails again: now the long rest
    await vi.advanceTimersByTimeAsync(6_000)
    const afterSecond = getHostStatus().s3.routes[0].restUntil
    expect(afterSecond.getTime() - Date.now()).toBeGreaterThan(50_000)
    await vi.advanceTimersByTimeAsync(120_000)
    expect((await attempt).routeFailure).toBe(true)
  })

  it('gives a background call up after a persistently failing single route, flagged as a route failure', async () => {
    egressState.egresses = [egress('px_a')]
    const result = await settle(
      withHostSlot(HOST, { priority: 'background' }, async () => {
        throw coded('ETIMEDOUT')
      })
    )
    expect(result.error.code).toBe('ETIMEDOUT')
    expect(result.error.routeFailure).toBe(true)
    expect(isTransientError(result.error)).toBe(true)
  })

  it('lets an admin call wait for a single route to come back', async () => {
    egressState.egresses = [egress('px_a')]
    let calls = 0
    const result = await settle(
      withHostSlot(HOST, { priority: 'admin' }, async () => {
        calls++
        if (calls === 1) throw coded('ECONNRESET')
        return { status: 200 }
      })
    )
    expect(result.value).toEqual({ status: 200 })
    expect(calls).toBe(2)
  })

  it('pins a call to its route: a failure is returned without another route', async () => {
    egressState.egresses = [egress('px_a'), egress('px_b')]
    const used = []
    const result = await settle(
      withHostSlot(HOST, { priority: 'admin', egress: 'px_a' }, async ({ egress }) => {
        used.push(egress.id)
        throw coded('ECONNRESET')
      })
    )
    expect(result.error.routeFailure).toBe(true)
    expect(used).toEqual(['px_a'])
  })

  it('a 503 from upstream blocks that route and is not a route failure', async () => {
    egressState.egresses = [egress('px_a'), egress('px_b')]
    const used = []
    const result = await settle(
      withHostSlot(HOST, { priority: 'interactive' }, async ({ egress }) => {
        used.push(egress.id)
        if (egress.id === 'px_a') {
          throw Object.assign(new Error('HTTP 503'), {
            status: 503,
            code: 'EHTTP_503',
          })
        }
        return { status: 200 }
      })
    )
    expect(result.value).toEqual({ status: 200 })
    expect(used).toEqual(['px_a', 'px_b'])
    expect(getHostStatus().s3.routes.find(r => r.id === 'px_a').lastStatus).toBe(503)
  })

  it('an item-level error is thrown at once, without trying another route', async () => {
    egressState.egresses = [egress('px_a'), egress('px_b')]
    const used = []
    const result = await settle(
      withHostSlot(HOST, { priority: 'interactive' }, async ({ egress }) => {
        used.push(egress.id)
        throw coded('EBYTECAP')
      })
    )
    expect(result.error.code).toBe('EBYTECAP')
    expect(result.error.routeFailure).toBeUndefined()
    expect(used).toEqual(['px_a'])
  })
})

describe('tunnel target names', () => {
  const servers = []
  afterEach(() => {
    while (servers.length) servers.pop().close()
  })

  function recordingProxy(seen) {
    const server = net.createServer(socket => {
      socket.on('error', () => {})
      socket.once('data', chunk => {
        seen.push(chunk)
        socket.write('HTTP/1.1 200 Connection established\r\n\r\n')
        socket.on('data', d => socket.write(d))
      })
    })
    return new Promise(resolve => {
      server.listen(0, '127.0.0.1', () => {
        servers.push(server)
        resolve(server.address().port)
      })
    })
  }

  it('accepts IP literals and host names, and refuses anything else', () => {
    expect(isTunnelTarget('93.184.216.34')).toBe(true)
    expect(isTunnelTarget('www.overleaf.com')).toBe(true)
    expect(isTunnelTarget('bad host')).toBe(false)
    expect(isTunnelTarget('evil.com\r\nHost: x')).toBe(false)
    expect(isTunnelTarget('')).toBe(false)
  })

  it('sends a host name in the HTTP CONNECT line', async () => {
    vi.useRealTimers()
    const seen = []
    const port = await recordingProxy(seen)
    const socket = await openTunnel(
      { scheme: 'http', host: '127.0.0.1', port, allowPrivate: true },
      'www.overleaf.com',
      443
    )
    expect(seen[0].toString('latin1').split('\r\n')[0]).toBe(
      'CONNECT www.overleaf.com:443 HTTP/1.1'
    )
    socket.destroy()
  })

  it('sends a host name as ATYP 0x03 for socks5h', async () => {
    vi.useRealTimers()
    const seen = []
    const server = net.createServer(socket => {
      socket.on('error', () => {})
      socket.once('data', greeting => {
        seen.push(greeting)
        socket.write(Buffer.from([0x05, 0x00]))
        socket.once('data', request => {
          seen.push(request)
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
          socket.on('data', d => socket.write(d))
        })
      })
    })
    const port = await new Promise(resolve =>
      server.listen(0, '127.0.0.1', () => {
        servers.push(server)
        resolve(server.address().port)
      })
    )
    const socket = await openTunnel(
      { scheme: 'socks5h', host: '127.0.0.1', port, allowPrivate: true },
      'www.overleaf.com',
      443
    )
    const request = seen[1]
    expect(request[3]).toBe(0x03)
    expect(request[4]).toBe('www.overleaf.com'.length)
    expect(request.subarray(5, 5 + 16).toString('ascii')).toBe('www.overleaf.com')
    expect(request.readUInt16BE(request.length - 2)).toBe(443)
    socket.destroy()
  })
})
