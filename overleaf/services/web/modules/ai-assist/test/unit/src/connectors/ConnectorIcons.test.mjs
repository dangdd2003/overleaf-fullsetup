import { describe, it, afterEach, vi } from 'vitest'
import { expect } from 'chai'
import sinon from 'sinon'
import {
  IconCache,
  bestIconSources,
  cacheTtl,
  createConnectorIconHandler,
  iconCacheKey,
  sanitizeServerIcons,
} from '../../../../app/src/connectors/ConnectorIcons.mjs'

const CONNECTOR_ID = '507f1f77bcf86cd799439011'
const USER_ID = '607f1f77bcf86cd799439099'
const PNG_DATA = 'data:image/png;base64,iVBORw0KGgo='
const ICON = { type: 'image/png', body: Buffer.from('png') }

function fakeResponse() {
  return {
    headers: {},
    statusCode: 200,
    setHeader(name, value) {
      this.headers[name] = value
    },
    status(code) {
      this.statusCode = code
      return this
    },
    end() {
      this.ended = true
      return this
    },
  }
}

function handlerWith({ connector, loadError, fetchIconBytes, resolveOriginIcon, cache }) {
  const loadConnector = sinon.stub()
  if (loadError) loadConnector.rejects(loadError)
  else loadConnector.resolves(connector)
  const sendIcon = sinon.spy((res, found) => {
    if (!found.icon) res.status(404).end()
    else res.status(200).end()
  })
  const handler = createConnectorIconHandler({
    loadConnector,
    fetchIconBytes: fetchIconBytes || sinon.stub().resolves(null),
    resolveOriginIcon:
      resolveOriginIcon || sinon.stub().resolves({ icon: null, sure: true }),
    sendIcon,
    cache: cache || new IconCache(),
  })
  return { handler, loadConnector, sendIcon, fetchIconBytes, resolveOriginIcon }
}

function run(handler, connectorId = CONNECTOR_ID) {
  const res = fakeResponse()
  const next = sinon.spy()
  return handler({ params: { connectorId }, user: { _id: USER_ID } }, res, next).then(
    () => ({ res, next })
  )
}

describe('sanitizeServerIcons', function () {
  it('keeps https and image data URIs and drops everything else', function () {
    const kept = sanitizeServerIcons([
      { src: 'https://example.com/icon.png' },
      { src: PNG_DATA },
      { src: 'http://example.com/plain.png' },
      { src: 'javascript:alert(1)' },
      { src: 'data:text/html;base64,PGgxPg==' },
      { src: '' },
      { src: 42 },
      null,
    ])
    expect(kept.map(i => i.src)).to.deep.equal([
      'https://example.com/icon.png',
      PNG_DATA,
    ])
  })

  it('drops data URIs over the size cap and sources over the length cap', function () {
    const big = `data:image/png;base64,${'A'.repeat(256 * 1024)}`
    const long = `https://example.com/${'a'.repeat(2048)}`
    expect(sanitizeServerIcons([{ src: big }, { src: long }])).to.deep.equal([])
  })

  it('keeps at most eight icons', function () {
    const icons = Array.from({ length: 12 }, (_, i) => ({
      src: `https://example.com/${i}.png`,
    }))
    expect(sanitizeServerIcons(icons)).to.have.length(8)
  })

  it('keeps only well-formed mime types, sizes and themes', function () {
    const [icon] = sanitizeServerIcons([
      {
        src: 'https://example.com/a',
        mimeType: 'IMAGE/PNG',
        sizes: ['32x32', 'any', 'big', '1x1x1', 'x', '48X48'],
        theme: 'dark',
      },
      {
        src: 'https://example.com/b',
        mimeType: 'text/html',
        sizes: 'nope',
        theme: 'neon',
      },
    ])
    expect(icon).to.deep.equal({
      src: 'https://example.com/a',
      mimeType: 'image/png',
      sizes: ['32x32', 'any', '48x48'],
      theme: 'dark',
    })
  })

  it('returns an empty list when the server declares no icons', function () {
    expect(sanitizeServerIcons(undefined)).to.deep.equal([])
    expect(sanitizeServerIcons('https://example.com/x.png')).to.deep.equal([])
  })
})

describe('bestIconSources', function () {
  it('prefers light or unmarked icons over dark ones', function () {
    const sources = bestIconSources([
      { src: 'https://example.com/dark.svg', theme: 'dark', sizes: ['any'] },
      { src: 'https://example.com/light.png', theme: 'light', sizes: ['32x32'] },
      { src: 'https://example.com/plain.png', sizes: ['32x32'] },
    ])
    expect(sources).to.deep.equal([
      'https://example.com/light.png',
      'https://example.com/plain.png',
      'https://example.com/dark.svg',
    ])
  })

  it('takes the size nearest 32px first, and treats `any` as ideal', function () {
    const sources = bestIconSources([
      { src: 'https://example.com/256.png', sizes: ['256x256'] },
      { src: 'https://example.com/24.png', sizes: ['24x24'] },
      { src: 'https://example.com/vector.svg', sizes: ['any'] },
    ])
    expect(sources[0]).to.equal('https://example.com/vector.svg')
    expect(sources[1]).to.equal('https://example.com/24.png')
  })

  it('puts SVG before PNG when the sizes tie', function () {
    const sources = bestIconSources([
      { src: 'https://example.com/a.png', sizes: ['32x32'] },
      { src: 'https://example.com/a.svg', sizes: ['32x32'] },
    ])
    expect(sources).to.deep.equal([
      'https://example.com/a.svg',
      'https://example.com/a.png',
    ])
  })

  it('tries at most three icons', function () {
    const icons = Array.from({ length: 6 }, (_, i) => ({
      src: `https://example.com/${i}.png`,
    }))
    expect(bestIconSources(icons)).to.have.length(3)
  })
})

describe('iconCacheKey and cacheTtl', function () {
  it('changes when the URL or the declared icons change', function () {
    const icons = [{ src: 'https://example.com/a.png' }]
    const key = iconCacheKey('c1', 'https://example.com/mcp', icons)
    expect(iconCacheKey('c1', 'https://example.com/mcp', icons)).to.equal(key)
    expect(iconCacheKey('c1', 'https://other.example/mcp', icons)).to.not.equal(key)
    expect(
      iconCacheKey('c1', 'https://example.com/mcp', [{ src: 'https://example.com/b.png' }])
    ).to.not.equal(key)
  })

  it('keeps found icons longest, then known misses, then unsure ones shortest', function () {
    expect(cacheTtl({ icon: ICON, sure: true })).to.be.above(
      cacheTtl({ icon: null, sure: true })
    )
    expect(cacheTtl({ icon: null, sure: true })).to.be.above(
      cacheTtl({ icon: null, sure: false })
    )
  })
})

describe('IconCache', function () {
  afterEach(function () {
    vi.useRealTimers()
  })

  it('evicts the least recently used entry once full', function () {
    const cache = new IconCache(2)
    cache.set('a', 1, 60_000)
    cache.set('b', 2, 60_000)
    cache.get('a')
    cache.set('c', 3, 60_000)
    expect(cache.get('a')).to.equal(1)
    expect(cache.get('b')).to.be.undefined
    expect(cache.get('c')).to.equal(3)
  })

  it('forgets an entry after its ttl', function () {
    vi.useFakeTimers()
    const cache = new IconCache()
    cache.set('a', 1, 1000)
    vi.advanceTimersByTime(1001)
    expect(cache.get('a')).to.be.undefined
  })
})

describe('connector icon handler', function () {
  const connector = {
    url: 'https://mcp.example.com/mcp',
    serverIcons: [
      { src: 'https://cdn.example.com/icon.svg', sizes: ['any'] },
    ],
  }

  it('serves the declared icon when it loads', async function () {
    const fetchIconBytes = sinon.stub().resolves(ICON)
    const { handler, resolveOriginIcon, sendIcon } = handlerWith({
      connector,
      fetchIconBytes,
    })

    await run(handler)

    expect(fetchIconBytes.calledOnceWith('https://cdn.example.com/icon.svg', {
      allowPrivate: true,
    })).to.be.true
    expect(resolveOriginIcon.called).to.be.false
    expect(sendIcon.firstCall.args[1]).to.deep.equal({ icon: ICON, sure: true })
  })

  it('falls back to the origin icon when every declared icon fails', async function () {
    const fetchIconBytes = sinon.stub().resolves(null)
    const resolveOriginIcon = sinon
      .stub()
      .resolves({ icon: ICON, sure: true })
    const { handler, sendIcon } = handlerWith({
      connector: { ...connector, serverIcons: [{ src: PNG_DATA }] },
      fetchIconBytes,
      resolveOriginIcon,
    })

    const { res } = await run(handler)

    expect(resolveOriginIcon.calledOnceWith('https://mcp.example.com', {
      allowPrivate: true,
      parentFallback: true,
    })).to.be.true
    expect(sendIcon.firstCall.args[1]).to.deep.equal({ icon: ICON, sure: true })
    expect(res.statusCode).to.equal(200)
  })

  it('falls back to the origin icon when the connector declared none', async function () {
    const resolveOriginIcon = sinon.stub().resolves({ icon: ICON, sure: true })
    const { handler, fetchIconBytes } = handlerWith({
      connector: { url: connector.url, serverIcons: [] },
      resolveOriginIcon,
    })

    await run(handler)

    expect(fetchIconBytes.called).to.be.false
    expect(resolveOriginIcon.calledOnce).to.be.true
  })

  it('answers 404 when nothing is found, with the found result passed to sendIcon', async function () {
    const { handler, sendIcon } = handlerWith({ connector })

    const { res } = await run(handler)

    expect(sendIcon.firstCall.args[1]).to.deep.equal({ icon: null, sure: true })
    expect(res.statusCode).to.equal(404)
  })

  it('treats a failed origin lookup as not checked, not as a miss', async function () {
    const resolveOriginIcon = sinon.stub().rejects(new Error('timeout'))
    const { handler, sendIcon } = handlerWith({
      connector: { url: connector.url, serverIcons: [] },
      resolveOriginIcon,
    })

    await run(handler)

    expect(sendIcon.firstCall.args[1]).to.deep.equal({ icon: null, sure: false })
  })

  it('answers 404 for a connector the user cannot see, without fetching', async function () {
    const { handler, fetchIconBytes, resolveOriginIcon, sendIcon } = handlerWith({
      loadError: Object.assign(new Error('Connector not found'), { status: 404 }),
      fetchIconBytes: sinon.stub().resolves(ICON),
    })

    const { res, next } = await run(handler)

    expect(res.statusCode).to.equal(404)
    expect(res.headers['Cache-Control']).to.equal('no-store')
    expect(fetchIconBytes.called).to.be.false
    expect(resolveOriginIcon.called).to.be.false
    expect(sendIcon.called).to.be.false
    expect(next.called).to.be.false
  })

  it('answers 404 for an id that is not an ObjectId', async function () {
    const { handler } = handlerWith({
      loadError: Object.assign(new Error('Cast to ObjectId failed'), {
        name: 'CastError',
      }),
    })

    const { res, next } = await run(handler, 'not-an-id')

    expect(res.statusCode).to.equal(404)
    expect(next.called).to.be.false
  })

  it('passes other load errors to next', async function () {
    const boom = new Error('database down')
    const { handler } = handlerWith({ loadError: boom })

    const { next } = await run(handler)

    expect(next.calledOnceWith(boom)).to.be.true
  })

  it('reuses a found icon from the cache without refetching', async function () {
    const cache = new IconCache()
    const fetchIconBytes = sinon.stub().resolves(ICON)
    const { handler } = handlerWith({ connector, fetchIconBytes, cache })

    await run(handler)
    await run(handler)

    expect(fetchIconBytes.calledOnce).to.be.true
  })

  it('checks the connector owner on every request, even with a cached icon', async function () {
    const cache = new IconCache()
    const fetchIconBytes = sinon.stub().resolves(ICON)
    const first = handlerWith({ connector, fetchIconBytes, cache })
    await run(first.handler)

    const second = handlerWith({
      loadError: Object.assign(new Error('Connector not found'), { status: 404 }),
      cache,
    })
    const { res } = await run(second.handler)

    expect(res.statusCode).to.equal(404)
    expect(second.loadConnector.calledOnce).to.be.true
  })
})
