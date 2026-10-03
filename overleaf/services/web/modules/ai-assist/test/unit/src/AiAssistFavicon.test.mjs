import { describe, it } from 'vitest'
import { expect } from 'chai'
import sinon from 'sinon'
import Settings from '@overleaf/settings'
import {
  FaviconResolver,
  iconLinksIn,
  normalizeOrigin,
  sniffImageType,
} from '../../../app/src/AiAssistFavicon.mjs'

const ICO = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16])
const PNG = Buffer.from('\x89PNG\r\n\x1a\n0000', 'latin1')

function fakeFetch(pages) {
  return sinon.stub().callsFake(async url => {
    if (!(url in pages)) throw new Error(`${url} returned HTTP 404`)
    return { url, body: Buffer.from(pages[url]), truncated: false }
  })
}

describe('AiAssistFavicon', function () {
  it('reads declared icons, rel="icon" first and nearest 32px', function () {
    const html = `
      <link rel="apple-touch-icon" href="/touch.png">
      <link rel="icon" sizes="192x192" href="/big.png">
      <link rel="shortcut icon" href="https://cdn.example.com/fav.ico?v=1&amp;x=2" type="image/x-icon" />
      <link rel="stylesheet" href="/site.css">`
    expect(iconLinksIn(html, 'https://example.com/')).to.deep.equal([
      'https://cdn.example.com/fav.ico?v=1&x=2',
      'https://example.com/big.png',
      'https://example.com/touch.png',
    ])
  })

  it('knows images by their bytes, not their label', function () {
    expect(sniffImageType(ICO)).to.equal('image/x-icon')
    expect(sniffImageType(PNG)).to.equal('image/png')
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).to.equal('image/svg+xml')
    expect(sniffImageType(Buffer.from('<!doctype html><html>Not found</html>'))).to.equal(null)
  })

  it('accepts only http(s) origins', function () {
    expect(normalizeOrigin('https://en.nhandan.vn/some/page')).to.equal('https://en.nhandan.vn')
    expect(normalizeOrigin('javascript:alert(1)')).to.equal(null)
    expect(normalizeOrigin('not a url')).to.equal(null)
  })

  it('follows the icon the home page declares', async function () {
    const fetch = fakeFetch({
      'https://news.example/': '<link rel="shortcut icon" href="https://cdn.example/f.ico">',
      'https://cdn.example/f.ico': ICO,
    })
    const icon = await new FaviconResolver({ fetch }).get('https://news.example')
    expect(icon.type).to.equal('image/x-icon')
  })

  it('falls back to /favicon.ico and skips an HTML page served as an icon', async function () {
    const fetch = fakeFetch({
      'https://site.example/': '<link rel="icon" href="/missing.png">',
      'https://site.example/missing.png': '<html>soft 404</html>',
      'https://site.example/favicon.ico': PNG,
    })
    const icon = await new FaviconResolver({ fetch }).get('https://site.example')
    expect(icon.type).to.equal('image/png')
  })

  it('looks each site up once, including sites with no icon', async function () {
    const fetch = fakeFetch({ 'https://bare.example/': '<p>hi</p>' })
    const resolver = new FaviconResolver({ fetch })
    const results = await Promise.all([
      resolver.get('https://bare.example'),
      resolver.get('https://bare.example'),
    ])
    await resolver.get('https://bare.example')
    expect(results).to.deep.equal([null, null])
    // The home page, /favicon.ico and the three common paths, once
    expect(fetch.callCount).to.equal(5)
  })

  it('asks for /favicon.ico and the home page at once, and stops at the first icon', async function () {
    let pageSignal = null
    const fetch = sinon.stub().callsFake(async (url, options) => {
      if (url === 'https://slow.example/') {
        pageSignal = options.signal
        // A heavy home page: still loading when the icon has arrived
        await new Promise(resolve => setTimeout(resolve, 2000))
        return { url, body: Buffer.from('<p>late</p>'), truncated: false }
      }
      return { url, body: ICO, truncated: false }
    })
    const started = Date.now()
    const icon = await new FaviconResolver({ fetch }).get('https://slow.example')
    expect(icon.type).to.equal('image/x-icon')
    expect(Date.now() - started).to.be.below(500)
    expect(fetch.callCount).to.equal(2)
    expect(pageSignal.aborted).to.equal(true)
  })

  it('tries the declared icons together', async function () {
    const calls = []
    const fetch = sinon.stub().callsFake(async url => {
      calls.push(url)
      if (url === 'https://two.example/') {
        return {
          url,
          body: Buffer.from(
            '<link rel="icon" href="/a.png"><link rel="apple-touch-icon" href="/b.png">'
          ),
          truncated: false,
        }
      }
      if (url === 'https://two.example/b.png') {
        return { url, body: PNG, truncated: false }
      }
      throw Object.assign(new Error(`${url} returned HTTP 404`), {
        kind: 'http',
      })
    })
    const icon = await new FaviconResolver({ fetch }).get('https://two.example')
    expect(icon.type).to.equal('image/png')
    expect(calls).to.include.members([
      'https://two.example/a.png',
      'https://two.example/b.png',
    ])
  })

  it('remembers a site without an icon, but not one it could not check', async function () {
    let now = 0
    let busy = true
    const fetch = sinon.stub().callsFake(async url => {
      if (busy) {
        throw Object.assign(new Error('the browser sidecar is busy'), {
          kind: 'network',
        })
      }
      if (url === 'https://busy.example/favicon.ico') {
        return { url, body: ICO, truncated: false }
      }
      throw Object.assign(new Error(`${url} returned HTTP 404`), {
        kind: 'http',
      })
    })
    const resolver = new FaviconResolver({ fetch, now: () => now })

    const unsure = await resolver.find('https://busy.example')
    expect(unsure).to.deep.equal({ icon: null, sure: false })
    // A minute later the site is looked up again, and its icon found
    busy = false
    now += 61 * 1000
    const found = await resolver.find('https://busy.example')
    expect(found.icon.type).to.equal('image/x-icon')
    expect(found.sure).to.equal(true)

    // A site that answered 404 has no icon: that is kept for the hour
    const missing = await resolver.find('https://none.example')
    expect(missing).to.deep.equal({ icon: null, sure: true })
    const calls = fetch.callCount
    now += 30 * 60 * 1000
    await resolver.find('https://none.example')
    expect(fetch.callCount).to.equal(calls)
  })

  it('fetches icons through the browser sidecar\'s small-file route when it is configured', async function () {
    const original = Settings.aiAssist
    // A sidecar URL no other test uses, so the shared route is built afresh
    // with the stubbed global fetch
    const sidecar = 'http://favicon-test-browser:3000'
    const fetchStub = sinon.stub(globalThis, 'fetch').callsFake(async () =>
      new Response(ICO, {
        status: 200,
        headers: { 'Content-Type': 'image/x-icon', 'X-Page-Status': '200' },
      })
    )
    try {
      Settings.aiAssist = {
        ...original,
        browser: { url: sidecar, token: 't'.repeat(32), concurrency: 2 },
      }
      const icon = await new FaviconResolver().get('https://news.example')
      expect(icon.type).to.equal('image/x-icon')
      const asked = fetchStub.getCalls().map(call => {
        expect(call.args[0]).to.equal(`${sidecar}/v1/fetch`)
        return JSON.parse(call.args[1].body).url
      })
      expect(asked).to.include('https://news.example/favicon.ico')
    } finally {
      fetchStub.restore()
      Settings.aiAssist = original
    }
  })
  it('asks the sidecar for the home page head only, and leaves bot checks to it', async function () {
    const original = Settings.aiAssist
    const sidecar = 'http://favicon-head-browser:3000'
    const asked = []
    const fetchStub = sinon.stub(globalThis, 'fetch').callsFake(async (url, init) => {
      asked.push(`${url.split('/').pop()} ${init.body}`)
      return new Response('<title>Just a moment...</title>', {
        status: 200,
        headers: { 'Content-Type': 'text/html', 'X-Page-Status': '403' },
      })
    })
    try {
      Settings.aiAssist = {
        ...original,
        browser: { url: sidecar, token: 't'.repeat(32), concurrency: 2 },
      }
      const icon = await new FaviconResolver().get('https://guarded.example')
      expect(icon).to.equal(null)
      expect(asked).to.include(
        'fetch {"url":"https://guarded.example/","head":true}'
      )
      expect(asked).to.include(
        'fetch {"url":"https://guarded.example/favicon.ico"}'
      )
      expect(asked.filter(line => line.startsWith('raw'))).to.deep.equal([])
    } finally {
      fetchStub.restore()
      Settings.aiAssist = original
    }
  })

  it('guesses the common icon paths once /favicon.ico is missing', async function () {
    const calls = []
    const fetch = sinon.stub().callsFake(async url => {
      calls.push(url)
      if (url === 'https://guess.example/') {
        // A slow home page that names no icon
        await new Promise(resolve => setTimeout(resolve, 1000))
        return { url, body: Buffer.from('<p>hi</p>'), truncated: false }
      }
      if (url === 'https://guess.example/apple-touch-icon.png') {
        return { url, body: PNG, truncated: false }
      }
      throw Object.assign(new Error(`${url} returned HTTP 404`), {
        kind: 'http',
      })
    })
    const started = Date.now()
    const icon = await new FaviconResolver({ fetch }).get('https://guess.example')
    expect(icon.type).to.equal('image/png')
    expect(Date.now() - started).to.be.below(500)
    expect(calls).to.include.members([
      'https://guess.example/favicon.svg',
      'https://guess.example/apple-touch-icon.png',
      'https://guess.example/favicon.png',
    ])
  })

  it('does not guess when /favicon.ico is there', async function () {
    const fetch = fakeFetch({
      'https://plain.example/': '<p>hi</p>',
      'https://plain.example/favicon.ico': ICO,
    })
    await new FaviconResolver({ fetch }).get('https://plain.example')
    expect(fetch.args.map(args => args[0]).sort()).to.deep.equal([
      'https://plain.example/',
      'https://plain.example/favicon.ico',
    ])
  })
})
