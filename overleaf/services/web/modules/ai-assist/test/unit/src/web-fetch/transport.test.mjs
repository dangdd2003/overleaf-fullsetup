import { describe, it } from 'vitest'
import { expect } from 'chai'
import sinon from 'sinon'
import {
  BROWSER_HEADERS,
  fetchPublicUrl,
  isPublicAddress,
  parseFetchUrl,
} from '../../../../app/src/web-fetch/transport.mjs'

describe('transport', function () {
  it('refuses IPv6 forms that embed an IPv4 address, and reserved IPv6 ranges', function () {
    for (const address of [
      '::',
      '::1',
      '::7f00:1', // ::127.0.0.1, IPv4-compatible
      '::a00:1', // ::10.0.0.1
      '::ffff:0:7f00:1', // ::ffff:0:127.0.0.1, IPv4-translated
      '3fff::1',
      '5f00::1',
    ]) {
      expect(isPublicAddress(address), address).to.equal(false)
    }
    expect(isPublicAddress('8.8.8.8')).to.equal(true)
    expect(isPublicAddress('2606:4700:4700::1111')).to.equal(true)
  })

  it('parseFetchUrl refuses those addresses written into a URL', function () {
    for (const url of [
      'http://[::127.0.0.1]/',
      'http://[::ffff:0:127.0.0.1]/',
      'http://[3fff::1]/',
    ]) {
      expect(() => parseFetchUrl(url), url).to.throw(/not a public address/)
    }
  })

  it('parseFetchUrl refuses the ports browsers refuse, and keeps web ports', function () {
    for (const url of [
      'http://example.com:25/',
      'https://example.com:22/',
      'http://example.com:6667/',
      'http://example.com:0/',
    ]) {
      expect(() => parseFetchUrl(url), url).to.throw(/is not a web port/)
    }
    for (const url of [
      'http://example.com/',
      'https://example.com/',
      'https://example.com:8443/',
      'http://example.com:8080/',
    ]) {
      expect(parseFetchUrl(url).hostname).to.equal('example.com')
    }
  })

  it('BROWSER_HEADERS claims Chrome 150 with complete sec-ch-ua headers', function () {
    expect(BROWSER_HEADERS['User-Agent']).to.include('Chrome/150.0.0.0')
    expect(BROWSER_HEADERS['sec-ch-ua']).to.include('"Chromium";v="150"')
    expect(BROWSER_HEADERS['sec-ch-ua-mobile']).to.equal('?0')
    expect(BROWSER_HEADERS['sec-ch-ua-platform']).to.equal('"Linux"')
  })

  it('fetchPublicUrl routes to curlFetch when impersonate is true and binary is available', async function () {
    const fakeCurl = sinon.stub().resolves({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: Buffer.from('curl content'),
      truncated: false,
    })

    const res = await fetchPublicUrl('https://example.com/impersonated', {
      impersonate: true,
      curlFn: fakeCurl,
      isCurlAvailable: () => true,
    })

    expect(fakeCurl.calledOnce).to.be.true
    expect(res.body.toString('utf8')).to.equal('curl content')
  })

  it('fetchPublicUrl falls back to Node transport when impersonate is true but binary is missing', async function () {
    const fakeLookup = sinon
      .stub()
      .yields(null, [{ address: '93.184.216.34', family: 4 }])
    const fakeRequestOnce = sinon.stub().resolves({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: Buffer.from('node fallback content'),
      truncated: false,
    })

    const res = await fetchPublicUrl('https://example.com/fallback', {
      impersonate: true,
      lookup: fakeLookup,
      isCurlAvailable: () => false,
      requestOnceFn: fakeRequestOnce,
    })

    expect(fakeRequestOnce.calledOnce).to.be.true
    expect(res.body.toString('utf8')).to.equal('node fallback content')
  })
})
