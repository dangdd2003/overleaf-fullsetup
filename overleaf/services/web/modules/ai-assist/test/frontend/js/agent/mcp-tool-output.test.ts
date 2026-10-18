import { expect } from 'chai'
import {
  connectorOutcome,
  humanizeServer,
  mcpArgSummary,
  outputSegments,
  parseJsonOutput,
  splitConnectorText,
} from '../../../../frontend/js/features/ai-assist/agent/mcp-tool-output'
import { connectorNameFor } from '../../../../frontend/js/features/ai-assist/agent/mcp-connector-names'

const PAGE_1 =
  '[Result r1: 12,345 characters]\n\nfirst page text\n\n[Page 1 of 3 of result r1. Call read_connector_result with id "r1" and page 2 to continue.]'

describe('connector result text', function () {
  it('takes the paging header and trailer off a first page', function () {
    expect(splitConnectorText(PAGE_1)).to.deep.equal({
      body: 'first page text',
      resultId: 'r1',
      chars: 12345,
      page: { page: 1, pages: 3, more: true },
    })
  })

  it('reads the last page as the end', function () {
    const split = splitConnectorText(
      'last words\n\n[Page 3 of 3 of result r1: the end.]'
    )
    expect(split.body).to.equal('last words')
    expect(split.page).to.deep.equal({ page: 3, pages: 3, more: false })
    expect(split.resultId).to.equal('r1')
  })

  it('leaves an unpaged text as it is', function () {
    expect(splitConnectorText('plain [Page] text')).to.deep.equal({
      body: 'plain [Page] text',
      resultId: undefined,
      chars: undefined,
      page: undefined,
    })
  })

  it('reads the runtime result shape', function () {
    const outcome = connectorOutcome({ result: PAGE_1, isError: false })
    expect(outcome.body).to.equal('first page text')
    expect(outcome.raw).to.equal(PAGE_1)
    expect(outcome.isError).to.equal(false)
    expect(outcome.error).to.be.undefined
  })

  it('reads an error as its message', function () {
    expect(connectorOutcome({ error: 'Boom' })).to.include({
      error: 'Boom',
      isError: true,
    })
    const failed = connectorOutcome({ result: 'Rate limited', isError: true })
    expect(failed.isError).to.equal(true)
    expect(failed.error).to.equal('Rate limited')
  })

  it('takes a bare string as the text', function () {
    expect(connectorOutcome('just text').body).to.equal('just text')
  })

  it('unwraps a trimmed history preview and flags it', function () {
    const outcome = connectorOutcome({
      truncated: true,
      preview: JSON.stringify({ result: 'kept' }),
    })
    expect(outcome.body).to.equal('kept')
    expect(outcome.truncated).to.equal(true)
  })

  it('carries the harness notice without showing it as output', function () {
    const outcome = connectorOutcome({
      result: 'ok',
      notice: 'That is 5 web calls for this request.',
    })
    expect(outcome.body).to.equal('ok')
    expect(outcome.notice).to.equal('That is 5 web calls for this request.')
  })

  it('splits images out as their own segments', function () {
    expect(outputSegments('before\n[Image: image/png]\nafter')).to.deep.equal([
      { kind: 'text', text: 'before' },
      { kind: 'image', mime: 'image/png' },
      { kind: 'text', text: 'after' },
    ])
  })

  it('parses JSON objects and arrays only', function () {
    expect(parseJsonOutput('{"a":1}')).to.deep.equal({ a: 1 })
    expect(parseJsonOutput('[1,2]')).to.deep.equal([1, 2])
    expect(parseJsonOutput('42')).to.be.undefined
    expect(parseJsonOutput('{broken')).to.be.undefined
  })
})

describe('connector names', function () {
  it('humanises a server segment', function () {
    expect(humanizeServer('github')).to.equal('Github')
    expect(humanizeServer('my_server-x')).to.equal('My Server X')
    expect(humanizeServer('')).to.equal('')
  })

  it('summarises the first string argument, a URL as its host', function () {
    expect(mcpArgSummary({ limit: 3, query: '  overleaf  latex ' })).to.equal(
      'overleaf latex'
    )
    expect(mcpArgSummary({ url: 'https://www.ctan.org/pkg/x' })).to.equal(
      'ctan.org'
    )
    expect(mcpArgSummary({ query: 'a'.repeat(60) })).to.equal(
      `${'a'.repeat(39)}…`
    )
    expect(mcpArgSummary({ limit: 3 })).to.be.undefined
  })

  it('matches a sanitised name to the connector it belongs to', function () {
    const connectors = [
      { id: 'abcd1234', name: 'GitHub Tools' },
      { id: 'efgh5678', name: 'Notes' },
    ] as any[]
    expect(connectorNameFor(connectors, 'GitHub_Tools')).to.equal(
      'GitHub Tools'
    )
    expect(connectorNameFor(connectors, 'Notes_gh5678')).to.equal('Notes')
    expect(connectorNameFor(connectors, 'unknown')).to.be.undefined
  })
})
