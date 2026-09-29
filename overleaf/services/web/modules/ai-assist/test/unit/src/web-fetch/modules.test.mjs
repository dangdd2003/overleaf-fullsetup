import { describe, it } from 'vitest'
import { expect } from 'chai'
import * as tools from '../../../../app/src/AiAssistWebTools.mjs'
import * as transport from '../../../../app/src/web-fetch/transport.mjs'
import * as documents from '../../../../app/src/web-fetch/document.mjs'
import * as find from '../../../../app/src/web-fetch/find.mjs'
import * as html from '../../../../app/src/web-fetch/extract/html.mjs'
import * as util from '../../../../app/src/web-fetch/util.mjs'
import * as api from '../../../../app/src/web-fetch/api.mjs'

describe('web-fetch modules', function () {
  it('are what AiAssistWebTools re-exports, so old imports keep working', function () {
    expect(tools.fetchPublicUrl).to.equal(transport.fetchPublicUrl)
    expect(tools.guardedLookup).to.equal(transport.guardedLookup)
    expect(tools.isPublicAddress).to.equal(transport.isPublicAddress)
    expect(tools.documentFromResponse).to.equal(documents.documentFromResponse)
    expect(tools.findPassages).to.equal(find.findPassages)
    expect(tools.splitPages).to.equal(documents.splitPages)
    expect(tools.PAGE_CHARS).to.equal(documents.PAGE_CHARS)
    expect(tools.htmlToMarkdown).to.equal(html.htmlToMarkdown)
    expect(tools.extractPageDates).to.equal(html.extractPageDates)
    expect(tools.isoDay).to.equal(util.isoDay)
  })

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
