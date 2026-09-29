import { describe, it, beforeEach, afterEach } from 'vitest'
import { expect } from 'chai'
import sinon from 'sinon'
import Settings from '@overleaf/settings'
import { AiAssistWebToolsController } from '../../../app/src/AiAssistWebToolsController.mjs'

function res() {
  const r = { statusCode: 200, body: null, writableEnded: false }
  r.status = code => {
    r.statusCode = code
    return r
  }
  r.json = body => {
    r.body = body
    r.writableEnded = true
    return r
  }
  return r
}

describe('AiAssistWebToolsController', function () {
  let tools, factory, controller, savedAiAssist

  // ModuleSettings.mjs derives Settings.aiAssist from the environment on
  // import, so the test sets the instance switches after importing.
  beforeEach(function () {
    savedAiAssist = Settings.aiAssist
    Settings.aiAssist = {
      ...Settings.aiAssist,
      webToolsEnabled: true,
      serverWebSearch: { enabled: true, type: 'searxng', baseUrl: 'http://s' },
    }
    tools = {
      getToolSpecs: () => [{ name: 'web_search' }, { name: 'web_fetch' }],
      rememberSources: sinon.stub(),
      execute: sinon.stub().resolves({ query: 'q', results: [] }),
    }
    factory = sinon.stub().returns(tools)
    controller = new AiAssistWebToolsController({ webToolsFactory: factory })
  })

  afterEach(function () {
    Settings.aiAssist = savedAiAssist
  })

  const req = (params, body) => ({
    params: { Project_id: 'p1', ...params },
    body,
    session: { user: { _id: 'aaaaaaaaaaaaaaaaaaaaaaaa' } },
    on: () => {},
  })

  it('lists the specs the user settings offer', async function () {
    const r = res()
    await controller.specs(
      req({}, { webSearchSettings: { sourceMode: 'server' } }),
      r
    )
    expect(r.body).to.deep.equal({
      specs: [{ name: 'web_search' }, { name: 'web_fetch' }],
    })
  })

  it('runs a web tool and returns the text the model reads', async function () {
    const r = res()
    await controller.execute(
      req(
        { name: 'web_search' },
        {
          args: { query: 'q' },
          webSearchSettings: { sourceMode: 'server' },
          contextWindow: 100000,
          knownCalls: [
            { name: 'web_search', args: { query: 'x' }, result: { results: [] } },
          ],
        }
      ),
      r
    )
    expect(factory.firstCall.args[1]).to.deep.equal({
      userId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      contextWindow: 100000,
    })
    expect(tools.rememberSources.firstCall.args[0][0].toolCalls).to.have.length(
      1
    )
    expect(tools.execute.firstCall.args.slice(0, 2)).to.deep.equal([
      'web_search',
      { query: 'q' },
    ])
    expect(r.body.result).to.deep.equal({ query: 'q', results: [] })
    expect(r.body.text).to.be.a('string').and.not.be.empty
  })

  it('refuses unknown tool names', async function () {
    const r = res()
    await controller.execute(req({ name: 'read_file' }, {}), r)
    expect(r.statusCode).to.equal(404)
    expect(tools.execute.called).to.be.false
  })

  it('refuses a user who disabled web search', async function () {
    const r = res()
    await controller.execute(
      req(
        { name: 'web_search' },
        { webSearchSettings: { sourceMode: 'disabled' } }
      ),
      r
    )
    expect(r.statusCode).to.equal(403)
    expect(tools.execute.called).to.be.false
  })

  it('refuses everything when the instance has no web tools', async function () {
    Settings.aiAssist.webToolsEnabled = false
    const r = res()
    await controller.specs(
      req({}, { webSearchSettings: { sourceMode: 'server' } }),
      r
    )
    expect(r.statusCode).to.equal(403)
  })

  it('keeps at most 50 known calls', async function () {
    const r = res()
    const knownCalls = Array.from({ length: 80 }, (_, i) => ({
      name: 'web_fetch',
      args: { url: `https://e.org/${i}` },
      result: { source: i + 1, url: `https://e.org/${i}` },
    }))
    await controller.execute(
      req(
        { name: 'web_fetch' },
        {
          args: { url: 'https://e.org' },
          webSearchSettings: { sourceMode: 'server' },
          knownCalls,
        }
      ),
      r
    )
    expect(tools.rememberSources.firstCall.args[0][0].toolCalls).to.have.length(
      50
    )
  })
})
