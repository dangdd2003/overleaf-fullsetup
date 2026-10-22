import { describe, it } from 'vitest'
import { expect } from 'chai'
import * as transport from '../../../../app/src/web-fetch/transport.mjs'
import * as documents from '../../../../app/src/web-fetch/document.mjs'
import * as util from '../../../../app/src/web-fetch/util.mjs'
import * as api from '../../../../app/src/web-fetch/api.mjs'

describe('web-fetch modules', function () {
  it('export the helpers later modules build on', function () {
    for (const name of [
      'webError',
      'describeStatus',
      'collapse',
      'clip',
      'clampInt',
      'isoDay',
    ]) {
      expect(util[name], name).to.be.a('function')
    }
    expect(util.HOUR_MS).to.equal(3_600_000)
    for (const name of ['parseFetchUrl', 'fetchPublicUrl']) {
      expect(transport[name], name).to.be.a('function')
    }
    expect(transport.BROWSER_HEADERS['User-Agent']).to.match(/Chrome/)
    for (const name of ['makeDocument', 'pageText']) {
      expect(documents[name], name).to.be.a('function')
    }
    for (const name of ['apiRequest', 'apiJson', 'upstreamError']) {
      expect(api[name], name).to.be.a('function')
    }
    expect(util.webError('x', { kind: 'http', status: 403 })).to.include({
      kind: 'http',
      status: 403,
      code: 'webToolError',
    })
  })
})
