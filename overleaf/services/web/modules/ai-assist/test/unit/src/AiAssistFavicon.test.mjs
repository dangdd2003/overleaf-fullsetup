import { describe, it } from 'vitest'
import { expect } from 'chai'
import sinon from 'sinon'
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
    expect(fetch.callCount).to.equal(2)
  })
})
