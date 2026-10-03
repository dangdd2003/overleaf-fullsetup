import { expect } from 'chai'
import { describeWebFailure } from '../../../../frontend/js/features/ai-assist/agent/web-errors'

const URL = 'https://www.britannica.com/money/Elon-Musk'

describe('describeWebFailure', function () {
  it('explains a fetch where the tools failed, not the page', function () {
    const failure = describeWebFailure(
      'web_fetch',
      `Could not read ${URL}: websearchapi: HTTP 401 · ollama: HTTP 404 · browser-raw: the browser sidecar is unavailable · browser-render: the browser sidecar is unavailable · wayback: the browser sidecar is unavailable · archive.today: the browser sidecar is unavailable.`,
      URL
    )
    expect(failure.title).to.equal('Couldn’t read this page')
    expect(failure.attempts.map(a => a.summary)).to.deep.equal([
      'API key rejected',
      'Endpoint not found',
      'Browser service offline',
      'Browser service offline',
      'Browser service offline',
      'Browser service offline',
    ])
    expect(failure.attempts[0].label).to.equal('WebSearchAPI.ai')
    expect(failure.fixes).to.have.length(3)
    expect(failure.fixes[0]).to.match(/browser service is not running/)
    expect(failure.fixes[1]).to.match(/WebSearchAPI\.ai rejected the API key/)
  })

  it('blames the site when its own routes were refused', function () {
    const failure = describeWebFailure(
      'web_fetch',
      `Could not read ${URL}: direct: HTTP 403 · wayback: no archived copy · archive.today: no archive.today copy.`,
      URL
    )
    expect(failure.title).to.equal('The site blocks automated readers')
    expect(failure.fixes).to.deep.equal([])
    expect(failure.attempts.map(a => a.kind)).to.deep.equal([
      'blocked',
      'no_copy',
      'no_copy',
    ])
  })

  it('says a missing page is missing', function () {
    const failure = describeWebFailure(
      'web_fetch',
      `Could not read ${URL}: direct: HTTP 404.`,
      URL
    )
    expect(failure.title).to.equal('This page doesn’t exist')
  })

  it('drops the advice written for the model', function () {
    const failure = describeWebFailure(
      'web_fetch',
      `Could not read ${URL}: direct: HTTP 403. Its search snippet is included; rely on it only for what it states, or read another result.`,
      URL
    )
    expect(failure.raw).to.not.match(/search snippet/)
    expect(failure.attempts).to.have.length(1)
  })

  it('keeps an unrecognised error readable', function () {
    const failure = describeWebFailure('web_fetch', 'Not a valid URL: foo', 'foo')
    expect(failure.title).to.equal('That isn’t a URL that can be read')
  })

  it('explains a failed search', function () {
    const failure = describeWebFailure(
      'web_search',
      'All web search endpoints failed: [tavily-1]: HTTP 401; [exa-1]: HTTP 429'
    )
    expect(failure.title).to.equal('Web search failed')
    expect(failure.attempts.map(a => a.summary)).to.deep.equal([
      'API key rejected',
      'Limit or credit used up',
    ])
    expect(
      describeWebFailure('web_search', 'Web search is not set up. Read pages with web_fetch instead.').title
    ).to.equal('Web search isn’t set up')
  })
})
