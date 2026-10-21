import { describe, it, beforeEach } from 'vitest'
import { expect } from 'chai'
import {
  buildToolArguments,
  clearMcpToolCache,
  isNotMcpError,
  mcpSearchEntries,
  mcpHeaders,
  parseResultBlocks,
  pickReadTool,
  pickSearchTool,
  probeMcpSearch,
  readViaMcp,
  searchViaMcp,
} from '../../../../app/src/web-fetch/mcp.mjs'
import { ConnectorAuthError } from '../../../../app/src/connectors/McpClient.mjs'
import { READERS } from '../../../../app/src/web-fetch/routes/readers.mjs'

const EXA_TOOLS = [
  {
    name: 'web_search_exa',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        numResults: { type: 'number' },
        objective: { type: 'string' },
      },
      required: ['query', 'objective'],
    },
  },
  {
    name: 'web_fetch_exa',
    inputSchema: {
      type: 'object',
      properties: { urls: { type: 'array', items: { type: 'string' } } },
      required: ['urls'],
    },
  },
]

const SEARXNG_TOOLS = [
  {
    name: 'searxng_web_search',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'web_url_read',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
]

/**
 * A fake MCP server answering Streamable HTTP. It has no `server/discover`
 * (a legacy server, 404), and it answers the rest as JSON or as SSE-framed
 * messages, as real servers do.
 */
function fakeMcpServer({ tools, callTool, sse = false, status = 200 } = {}) {
  const requests = []
  const fetchFn = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : {}
    requests.push({ url, method: body.method, headers: init.headers })
    if (status !== 200) {
      return new Response('nope', { status, headers: { 'Content-Type': 'text/plain' } })
    }
    if (body.method === 'server/discover') {
      return new Response('{"error":"not found"}', {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (body.method === 'notifications/initialized') {
      return new Response(null, { status: 202 })
    }
    let result
    if (body.method === 'initialize') {
      result = {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake' },
      }
    } else if (body.method === 'tools/list') {
      result = { tools }
    } else if (body.method === 'tools/call') {
      result = callTool(body.params)
    } else {
      return new Response('{}', { status: 400, headers: { 'Content-Type': 'application/json' } })
    }
    const message = JSON.stringify({ jsonrpc: '2.0', id: body.id, result })
    const headers = { 'Content-Type': sse ? 'text/event-stream' : 'application/json' }
    if (body.method === 'initialize') headers['Mcp-Session-Id'] = 'session-1'
    return new Response(sse ? `event: message\ndata: ${message}\n\n` : message, {
      status: 200,
      headers,
    })
  }
  return { fetchFn, requests }
}

const target = (fetchFn, extra = {}) => ({
  url: 'https://mcp.example.test/mcp',
  headers: { Authorization: 'Bearer t0k' },
  fetchFn,
  timeoutMs: 5000,
  ...extra,
})

describe('web-fetch MCP helpers', function () {
  beforeEach(function () {
    clearMcpToolCache()
  })

  describe('tool selection', function () {
    it('picks a search tool and maps its query argument', function () {
      const tool = pickSearchTool(EXA_TOOLS)
      expect(tool.name).to.equal('web_search_exa')
      expect(tool.arg.name).to.equal('query')
    })

    it('does not pick a fetch tool as the search tool, or a search tool as the reader', function () {
      expect(pickSearchTool([EXA_TOOLS[1]])).to.be.null
      expect(pickReadTool([EXA_TOOLS[0]])).to.be.null
      expect(pickReadTool(EXA_TOOLS).name).to.equal('web_fetch_exa')
      expect(pickReadTool(SEARXNG_TOOLS).name).to.equal('web_url_read')
    })

    it('does not read a tool that takes a repo name as its page reader', function () {
      const deepwiki = [
        {
          name: 'read_wiki_contents',
          inputSchema: { type: 'object', properties: { repoName: { type: 'string' } }, required: ['repoName'] },
        },
      ]
      expect(pickReadTool(deepwiki)).to.be.null
      expect(pickSearchTool(deepwiki)).to.be.null
    })

    it('skips destructive tools', function () {
      const tools = [
        { ...SEARXNG_TOOLS[0], name: 'search_delete', annotations: { destructiveHint: true } },
        SEARXNG_TOOLS[0],
      ]
      expect(pickSearchTool(tools).name).to.equal('searxng_web_search')
    })

    it('fills a required string the caller does not know with the query', function () {
      const args = buildToolArguments(pickSearchTool(EXA_TOOLS), 'latex')
      expect(args).to.deep.equal({ query: 'latex', objective: 'latex' })
    })

    it('sends a reader its URL as an array when the schema asks for one', function () {
      const args = buildToolArguments(pickReadTool(EXA_TOOLS), 'https://a.test/', {
        fillText: false,
      })
      expect(args).to.deep.equal({ urls: ['https://a.test/'] })
    })
  })

  describe('result parsing', function () {
    it('reads Title / URL / Published blocks separated by ---', function () {
      const text = [
        'Title: Overleaf, Online LaTeX Editor',
        'URL: https://www.overleaf.com/',
        'Published: N/A',
        'Author: N/A',
        'Highlights:',
        'Collaborative online LaTeX editor.',
        '',
        '---',
        '',
        'Title: N/A',
        'URL: https://docs.overleaf.com/getting-started',
        'Published: 2024-03-01',
        'Highlights:',
        'Start here.',
      ].join('\n')
      const entries = parseResultBlocks(text)
      expect(entries).to.have.lengthOf(2)
      expect(entries[0]).to.include({
        title: 'Overleaf, Online LaTeX Editor',
        url: 'https://www.overleaf.com/',
      })
      expect(entries[0].snippet).to.include('Collaborative online LaTeX editor.')
      expect(entries[1]).to.include({
        title: '',
        url: 'https://docs.overleaf.com/getting-started',
        publishedDate: '2024-03-01',
      })
    })

    it('reads a bare URL line and keeps the snippet short', function () {
      const entries = parseResultBlocks(
        `https://a.test/x\nDescription: ${'word '.repeat(2000)}`
      )
      expect(entries[0].url).to.equal('https://a.test/x')
      expect(entries[0].snippet.length).to.be.at.most(2100)
    })

    it('prefers structuredContent, then JSON text, then blocks', function () {
      expect(
        mcpSearchEntries({
          structuredContent: { results: [{ url: 'https://s.test' }] },
          content: [{ type: 'text', text: 'Title: ignored\nURL: https://t.test' }],
        })
      ).to.deep.equal([{ url: 'https://s.test' }])
      expect(
        mcpSearchEntries({
          content: [{ type: 'text', text: '{"results":[{"title":"J","url":"https://j.test"}]}' }],
        })
      ).to.deep.equal([{ title: 'J', url: 'https://j.test' }])
      expect(mcpSearchEntries({ content: [{ type: 'text', text: 'No results found.' }] })).to.deep.equal([])
    })
  })

  describe('over the wire', function () {
    it('initializes, lists tools and calls the search tool with the bearer token', async function () {
      const { fetchFn, requests } = fakeMcpServer({
        tools: SEARXNG_TOOLS,
        callTool: () => ({
          content: [
            {
              type: 'text',
              text: 'Title: LaTeX Project\nURL: https://www.latex-project.org/\nDescription: TeX home page.',
            },
          ],
        }),
      })
      const entries = await searchViaMcp(target(fetchFn), 'latex')
      expect(entries).to.deep.equal([
        {
          title: 'LaTeX Project',
          url: 'https://www.latex-project.org/',
          snippet: 'TeX home page.',
        },
      ])
      const methods = requests.map(r => r.method)
      expect(methods).to.include('tools/list')
      expect(methods).to.include('tools/call')
      expect(requests.every(r => r.headers.Authorization === 'Bearer t0k')).to.be.true
    })

    it('reads SSE-framed responses', async function () {
      const { fetchFn } = fakeMcpServer({
        tools: EXA_TOOLS,
        sse: true,
        callTool: params => ({
          content: [{ type: 'text', text: `Title: Got ${params.arguments.query}\nURL: https://got.test/` }],
        }),
      })
      const entries = await searchViaMcp(target(fetchFn), 'sse')
      expect(entries[0]).to.include({ title: 'Got sse', url: 'https://got.test/' })
    })

    it('reports a tool that answers isError as a failure with its text', async function () {
      const { fetchFn } = fakeMcpServer({
        tools: SEARXNG_TOOLS,
        callTool: () => ({ isError: true, content: [{ type: 'text', text: 'engine offline' }] }),
      })
      try {
        await searchViaMcp(target(fetchFn), 'x')
        expect.fail('expected a failure')
      } catch (err) {
        expect(err.message).to.include('engine offline')
        expect(err.kind).to.not.equal('network')
      }
    })

    it('says so when the server has no search tool', async function () {
      const { fetchFn } = fakeMcpServer({ tools: [SEARXNG_TOOLS[1]], callTool: () => ({}) })
      try {
        await searchViaMcp(target(fetchFn), 'x')
        expect.fail('expected a failure')
      } catch (err) {
        expect(err.message).to.include('no search tool')
        expect(err.message).to.include('web_url_read')
      }
    })

    it('treats an endpoint that is not MCP as not supported, so the contract can be tried', async function () {
      const fetchFn = async () =>
        new Response('<html>Not found</html>', { status: 404, headers: { 'Content-Type': 'text/html' } })
      try {
        await searchViaMcp(target(fetchFn), 'x')
        expect.fail('expected a failure')
      } catch (err) {
        expect(isNotMcpError(err)).to.be.true
      }
    })

    it('treats an auth refusal as a reason to try the contract too', async function () {
      const { fetchFn } = fakeMcpServer({ status: 401, tools: [], callTool: () => ({}) })
      try {
        await searchViaMcp(target(fetchFn), 'x')
        expect.fail('expected a failure')
      } catch (err) {
        expect(err).to.be.instanceOf(ConnectorAuthError)
        expect(isNotMcpError(err)).to.be.true
      }
    })

    it('reads a page through the reader tool', async function () {
      const { fetchFn } = fakeMcpServer({
        tools: SEARXNG_TOOLS,
        callTool: params => ({
          content: [{ type: 'text', text: `# Page for ${params.arguments.url}\n\nBody text.` }],
        }),
      })
      const page = await readViaMcp(target(fetchFn), 'https://page.test/a')
      expect(page.text).to.include('Body text.')
    })

    it('fails a read when the reader returns no text', async function () {
      const { fetchFn } = fakeMcpServer({
        tools: SEARXNG_TOOLS,
        callTool: () => ({ content: [] }),
      })
      try {
        await readViaMcp(target(fetchFn), 'https://page.test/a')
        expect.fail('expected a failure')
      } catch (err) {
        expect(err.message).to.include('returned no text')
      }
    })

    it('health check lists tools and reports whether one can search', async function () {
      const withSearch = fakeMcpServer({ tools: SEARXNG_TOOLS, callTool: () => ({}) })
      expect(await probeMcpSearch(target(withSearch.fetchFn))).to.deep.equal({
        toolCount: 2,
        hasSearch: true,
      })
      const readOnly = fakeMcpServer({ tools: [SEARXNG_TOOLS[1]], callTool: () => ({}) })
      expect(await probeMcpSearch(target(readOnly.fetchFn))).to.deep.equal({
        toolCount: 1,
        hasSearch: false,
      })
    })

    it('caches the chosen tool so a second search skips tools/list', async function () {
      const { fetchFn, requests } = fakeMcpServer({
        tools: SEARXNG_TOOLS,
        callTool: () => ({ content: [{ type: 'text', text: 'Title: A\nURL: https://a.test/' }] }),
      })
      await searchViaMcp(target(fetchFn), 'one')
      const before = requests.filter(r => r.method === 'tools/list').length
      await searchViaMcp(target(fetchFn), 'two')
      const after = requests.filter(r => r.method === 'tools/list').length
      expect(before).to.equal(1)
      expect(after).to.equal(1)
    })
  })

  describe('headers and wiring', function () {
    it('sends only the endpoint headers and its own token, not the contract defaults', function () {
      expect(mcpHeaders({ bearerToken: 'abc', headers: [{ key: 'X-Team', value: 'a' }] })).to.deep.equal({
        'X-Team': 'a',
        Authorization: 'Bearer abc',
      })
      expect(mcpHeaders({ headers: [{ key: 'authorization', value: 'Bearer own' }], bearerToken: 'x' })).to.deep.equal({
        authorization: 'Bearer own',
      })
    })

    it('is a page reader in the reader table', function () {
      expect(READERS).to.have.property('mcp')
    })
  })
})
