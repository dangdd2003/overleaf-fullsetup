import { describe, it } from 'vitest'
import { expect } from 'chai'
import sinon from 'sinon'
import {
  BROWSER_HEADERS,
  fetchPublicUrl,
} from '../../../../app/src/web-fetch/transport.mjs'

describe('transport', function () {
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
