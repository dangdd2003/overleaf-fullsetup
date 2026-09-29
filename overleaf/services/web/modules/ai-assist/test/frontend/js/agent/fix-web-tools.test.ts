import { expect } from 'chai'
import { createFixWebTools } from '../../../../frontend/js/features/ai-assist/agent/tools/fix-web-tools'

const SPECS = [
  {
    name: 'web_search',
    description: 's',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'web_fetch',
    description: 'f',
    parameters: { type: 'object', properties: {} },
  },
] as any[]

function fakeFetch() {
  const calls: any[] = []
  const impl = async (url: string, init: any) => {
    const body = JSON.parse(init.body)
    calls.push({ url, body })
    const result = { query: body.args.query, results: [], call: calls.length }
    return new Response(
      JSON.stringify({ result, text: `TEXT ${calls.length}` }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  }
  return { impl: impl as unknown as typeof fetch, calls }
}

describe('fix web tools', function () {
  it('calls the project endpoint and renders the server text', async function () {
    const { impl, calls } = fakeFetch()
    const tools = createFixWebTools({
      projectId: 'p1',
      specs: SPECS,
      webSearchSettings: { sourceMode: 'server', providers: {} } as any,
      contextWindow: 100000,
      fetchImpl: impl,
    })
    const result = await tools.web_search.execute(
      { query: 'siunitx' },
      null as any
    )
    expect(calls[0].url).to.equal('/ai-assist/projects/p1/web-tools/web_search')
    expect(calls[0].body.contextWindow).to.equal(100000)
    expect(tools.web_search.render!(result)).to.equal('TEXT 1')
    expect(tools.web_search.mutates).to.equal(false)
    expect(tools.web_search.suspends).to.equal(false)
  })

  it('sends earlier calls of this fix run with each request', async function () {
    const { impl, calls } = fakeFetch()
    const tools = createFixWebTools({
      projectId: 'p1',
      specs: SPECS,
      webSearchSettings: null,
      contextWindow: 100000,
      fetchImpl: impl,
    })
    await tools.web_search.execute({ query: 'a' }, null as any)
    await tools.web_fetch.execute({ url: 'https://e.org' }, null as any)
    expect(calls[1].body.knownCalls).to.have.length(1)
    expect(calls[1].body.knownCalls[0].name).to.equal('web_search')
  })

  it('executes web tools dynamically without artificial quota limits', async function () {
    const { impl, calls } = fakeFetch()
    const tools = createFixWebTools({
      projectId: 'p1',
      specs: SPECS,
      webSearchSettings: null,
      contextWindow: 100000,
      fetchImpl: impl,
    })
    for (let i = 0; i < 5; i++) {
      const res = await tools.web_search.execute({ query: `query-${i}` }, null as any)
      expect(res).not.to.have.property('error')
    }
    expect(calls).to.have.length(5)
  })

  it('offers only the tools the server listed', function () {
    const tools = createFixWebTools({
      projectId: 'p1',
      specs: [SPECS[1]],
      webSearchSettings: null,
      contextWindow: 100000,
    })
    expect(Object.keys(tools)).to.deep.equal(['web_fetch'])
  })
})
