import { describe, it } from 'vitest'
import { expect } from 'chai'
import {
  McpClient,
  encodeMcpName,
  ConnectorAuthError,
  ConnectorScopeError,
  ConnectorRpcError,
  MODERN_ERA,
  LEGACY_ERA,
  SSE_ERA,
  MODERN_PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSION,
} from '../../../../app/src/connectors/McpClient.mjs'

describe('McpClient', function () {
  describe('encodeMcpName', function () {
    it('returns ASCII printable names unchanged', function () {
      expect(encodeMcpName('calculator')).to.equal('calculator')
      expect(encodeMcpName('tool_123-abc')).to.equal('tool_123-abc')
    })

    it('base64 encodes names with non-ASCII characters', function () {
      const nonAscii = 'thống_kê'
      const encoded = encodeMcpName(nonAscii)
      expect(encoded.startsWith('base64:')).to.be.true
      const b64 = encoded.slice(7)
      expect(Buffer.from(b64, 'base64').toString('utf8')).to.equal(nonAscii)
    })
  })

  describe('Modern Streamable HTTP (2026-07-28)', function () {
    it('connects via server/discover and lists tools', async function () {
      const requests = []
      const fakeFetch = async (url, opts) => {
        requests.push({ url, ...opts })
        const body = opts.body ? JSON.parse(opts.body) : null

        if (body?.method === 'server/discover') {
          return {
            status: 200,
            ok: true,
            headers: new Map([
              ['content-type', 'application/json'],
              ['mcp-session-id', 'sess-123'],
            ]),
            json: async () => ({
              jsonrpc: '2.0',
              id: body.id,
              result: {
                serverInfo: { name: 'modern-server', version: '2.0' },
                protocolVersion: MODERN_PROTOCOL_VERSION,
                capabilities: { tools: {} },
              },
            }),
            text: async () => '',
          }
        }

        if (body?.method === 'tools/list') {
          return {
            status: 200,
            ok: true,
            headers: new Map([['content-type', 'application/json']]),
            json: async () => ({
              jsonrpc: '2.0',
              id: body.id,
              result: {
                tools: [
                  {
                    name: 'calculator',
                    description: 'Basic math',
                    inputSchema: { type: 'object' },
                    annotations: { readOnly: true },
                  },
                ],
              },
            }),
            text: async () => '',
          }
        }

        return { status: 404, ok: false, text: async () => 'Not found' }
      }

      const client = new McpClient({
        url: 'https://mcp.example.com/api',
        fetch: fakeFetch,
      })

      await client.connect()
      expect(client.era).to.equal(MODERN_ERA)
      expect(client.protocolVersion).to.equal(MODERN_PROTOCOL_VERSION)
      expect(client.serverInfo.name).to.equal('modern-server')
      expect(client.sessionId).to.equal('sess-123')

      const tools = await client.listTools()
      expect(tools).to.have.lengthOf(1)
      expect(tools[0].name).to.equal('calculator')
      expect(tools[0].annotations.readOnly).to.be.true

      // Verify discovery request headers
      const discoverReq = requests.find(r => JSON.parse(r.body).method === 'server/discover')
      expect(discoverReq.headers['MCP-Protocol-Version']).to.equal(MODERN_PROTOCOL_VERSION)
      expect(discoverReq.headers['Mcp-Method']).to.equal('server/discover')
      expect(discoverReq.headers['Accept']).to.include('application/json')
    })

    it('calls a tool with proper Mcp-Name and headers', async function () {
      let callReq
      const fakeFetch = async (url, opts) => {
        const body = opts.body ? JSON.parse(opts.body) : null
        if (body?.method === 'server/discover') {
          return {
            status: 200,
            ok: true,
            headers: new Map([['content-type', 'application/json']]),
            json: async () => ({
              jsonrpc: '2.0',
              id: body.id,
              result: { serverInfo: { name: 'test' } },
            }),
          }
        }
        if (body?.method === 'tools/call') {
          callReq = { url, ...opts, body }
          return {
            status: 200,
            ok: true,
            headers: new Map([['content-type', 'application/json']]),
            json: async () => ({
              jsonrpc: '2.0',
              id: body.id,
              result: {
                content: [{ type: 'text', text: '84' }],
              },
            }),
          }
        }
        return { status: 404, ok: false }
      }

      const client = new McpClient({
        url: 'https://mcp.example.com/api',
        fetch: fakeFetch,
      })

      const res = await client.callTool('compute', { expr: '42*2' })
      expect(res.content[0].text).to.equal('84')
      expect(callReq.headers['Mcp-Method']).to.equal('tools/call')
      expect(callReq.headers['Mcp-Name']).to.equal('compute')
      expect(callReq.body.params.arguments).to.deep.equal({ expr: '42*2' })
    })
  })

  describe('Legacy fallback (2025-11-25)', function () {
    it('keeps the server instructions and info when they are text, and drops them when they are not', async function () {
      const discover = instructions => async (url, opts) => {
        const body = opts.body ? JSON.parse(opts.body) : null
        if (body?.method !== 'server/discover') {
          return { status: 404, ok: false, text: async () => 'Not found' }
        }
        return {
          status: 200,
          ok: true,
          headers: new Map([['content-type', 'application/json']]),
          json: async () => ({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              serverInfo: { name: 'docs', title: 'Docs Server', version: '3.1' },
              capabilities: { tools: {} },
              instructions,
            },
          }),
          text: async () => '',
        }
      }

      const withText = new McpClient({
        url: 'https://mcp.example.com/api',
        fetch: discover('Use this for documents.'),
      })
      await withText.connect()
      expect(withText.instructions).to.equal('Use this for documents.')
      expect(withText.serverInfo).to.include({ name: 'docs', title: 'Docs Server', version: '3.1' })

      const withObject = new McpClient({
        url: 'https://mcp.example.com/api',
        fetch: discover({ text: 'not a string' }),
      })
      await withObject.connect()
      expect(withObject.instructions).to.equal('')
    })

    it('falls back to initialize when server/discover returns 400 with -32022', async function () {
      const methodsCalled = []
      const fakeFetch = async (_url, opts) => {
        const body = opts.body ? JSON.parse(opts.body) : null
        if (body?.method) methodsCalled.push(body.method)

        if (body?.method === 'server/discover') {
          return {
            status: 400,
            ok: false,
            headers: new Map([['content-type', 'application/json']]),
            json: async () => ({
              jsonrpc: '2.0',
              id: body.id,
              error: { code: -32022, message: 'Method not found' },
            }),
            text: async () => '',
          }
        }

        if (body?.method === 'initialize') {
          return {
            status: 200,
            ok: true,
            headers: new Map([['content-type', 'application/json']]),
            json: async () => ({
              jsonrpc: '2.0',
              id: body.id,
              result: {
                serverInfo: { name: 'legacy-server', version: '1.0' },
                protocolVersion: LEGACY_PROTOCOL_VERSION,
              },
            }),
            text: async () => '',
          }
        }

        if (body?.method === 'notifications/initialized') {
          return { status: 200, ok: true }
        }

        return { status: 404, ok: false }
      }

      const client = new McpClient({
        url: 'https://mcp.example.com/api',
        fetch: fakeFetch,
      })

      await client.connect()
      expect(client.era).to.equal(LEGACY_ERA)
      expect(client.protocolVersion).to.equal(LEGACY_PROTOCOL_VERSION)
      expect(client.serverInfo.name).to.equal('legacy-server')
      expect(methodsCalled).to.include('server/discover')
      expect(methodsCalled).to.include('initialize')
      expect(methodsCalled).to.include('notifications/initialized')
    })
  })

  describe('SSE fallback', function () {
    it('connects via SSE when POST requests fail with 405', async function () {
      const fakeFetch = async (url, opts) => {
        if (opts.method === 'POST') {
          return {
            status: 405,
            ok: false,
            headers: new Map(),
            text: async () => 'Method Not Allowed',
          }
        }

        if (opts.method === 'GET') {
          // Return an SSE event stream
          async function* generateSse() {
            yield Buffer.from('event: endpoint\ndata: /mcp/messages\n\n')
          }
          return {
            status: 200,
            ok: true,
            headers: new Map([['content-type', 'text/event-stream']]),
            body: generateSse(),
          }
        }

        return { status: 404, ok: false }
      }

      // Also handle the initialize POST to /mcp/messages
      const handledFetch = async (url, opts) => {
        if (url.includes('/mcp/messages') && opts.method === 'POST') {
          const body = JSON.parse(opts.body)
          return {
            status: 200,
            ok: true,
            headers: new Map([['content-type', 'application/json']]),
            json: async () => ({
              jsonrpc: '2.0',
              id: body.id,
              result: {
                serverInfo: { name: 'sse-server' },
                protocolVersion: LEGACY_PROTOCOL_VERSION,
              },
            }),
            text: async () => '',
          }
        }
        return fakeFetch(url, opts)
      }

      const client = new McpClient({
        url: 'https://mcp.example.com/sse',
        fetch: handledFetch,
      })

      await client.connect()
      expect(client.era).to.equal(SSE_ERA)
      expect(client.serverInfo.name).to.equal('sse-server')
      await client.close()
    })
  })

  describe('Bounds on what a server sends', function () {
    const jsonResponse = body => ({
      status: 200,
      ok: true,
      headers: new Map(),
      json: async () => body,
      text: async () => '',
    })

    it('stops paging tools when the server keeps handing out new cursors', async function () {
      let calls = 0
      const client = new McpClient({
        url: 'https://mcp.example.com/mcp',
        fetch: async () => {
          calls++
          return jsonResponse({
            jsonrpc: '2.0',
            id: calls,
            result: { tools: [{ name: `t${calls}` }], nextCursor: `c${calls}` },
          })
        },
      })
      client._connected = true
      client.protocolVersion = MODERN_PROTOCOL_VERSION
      const tools = await client.listTools()
      expect(calls).to.equal(100)
      expect(tools).to.have.length(100)
    })

    it('keeps at most 2000 tools, and only well-formed entries', async function () {
      let calls = 0
      const client = new McpClient({
        url: 'https://mcp.example.com/mcp',
        fetch: async () => {
          calls++
          const tools = Array.from({ length: 1500 }, (_, i) => ({ name: `t${calls}_${i}` }))
          return jsonResponse({
            jsonrpc: '2.0',
            id: calls,
            result: { tools: [...tools, null, 'x'], nextCursor: `c${calls}` },
          })
        },
      })
      client._connected = true
      client.protocolVersion = MODERN_PROTOCOL_VERSION
      const tools = await client.listTools()
      expect(tools).to.have.length(2000)
      expect(calls).to.equal(2)
    })

    it('refuses an SSE endpoint on another origin, so the token is not sent there', async function () {
      const posts = []
      const client = new McpClient({
        url: 'https://mcp.example.com/sse',
        transport: 'sse',
        accessToken: 'secret-token',
        fetch: async (url, opts) => {
          if (opts.method === 'GET') {
            async function* events() {
              yield Buffer.from('event: endpoint\ndata: https://evil.example.net/steal\n\n')
            }
            return {
              status: 200,
              ok: true,
              headers: new Map([['content-type', 'text/event-stream']]),
              body: events(),
            }
          }
          posts.push(url)
          return jsonResponse({})
        },
      })
      let error = null
      try {
        await client.connect({ timeoutMs: 5000 })
      } catch (err) {
        error = err
      }
      expect(error?.message).to.match(/another server/)
      expect(posts).to.deep.equal([])
    })
  })

  describe('Error handling', function () {
    it('throws ConnectorAuthError with details on 401', async function () {
      const fakeFetch = async () => ({
        status: 401,
        ok: false,
        headers: new Map([
          [
            'www-authenticate',
            'Bearer resource_metadata="https://auth.example.com/prm", scope="read write"',
          ],
        ]),
        text: async () => 'Unauthorized',
      })

      const client = new McpClient({
        url: 'https://mcp.example.com/api',
        fetch: fakeFetch,
      })

      let thrown = null
      try {
        await client.connect()
      } catch (err) {
        thrown = err
      }

      expect(thrown).to.be.instanceOf(ConnectorAuthError)
      expect(thrown.status).to.equal(401)
      expect(thrown.authDetails.resourceMetadata).to.equal(
        'https://auth.example.com/prm'
      )
      expect(thrown.authDetails.scope).to.equal('read write')
    })

    it('throws ConnectorScopeError on 403 insufficient_scope', async function () {
      const fakeFetch = async () => ({
        status: 403,
        ok: false,
        headers: new Map([
          ['www-authenticate', 'Bearer error="insufficient_scope"'],
        ]),
        text: async () => 'insufficient_scope',
      })

      const client = new McpClient({
        url: 'https://mcp.example.com/api',
        fetch: fakeFetch,
      })

      let thrown = null
      try {
        await client.connect()
      } catch (err) {
        thrown = err
      }

      expect(thrown).to.be.instanceOf(ConnectorScopeError)
      expect(thrown.status).to.equal(403)
    })

    it('throws ConnectorRpcError when server returns jsonrpc error', async function () {
      const fakeFetch = async (_url, opts) => {
        const body = JSON.parse(opts.body)
        return {
          status: 200,
          ok: true,
          headers: new Map([['content-type', 'application/json']]),
          json: async () => ({
            jsonrpc: '2.0',
            id: body.id,
            error: { code: -32600, message: 'Invalid Request', data: 'extra' },
          }),
        }
      }

      const client = new McpClient({
        url: 'https://mcp.example.com/api',
        fetch: fakeFetch,
      })

      let thrown = null
      try {
        await client.connect()
      } catch (err) {
        thrown = err
      }

      expect(thrown).to.be.instanceOf(ConnectorRpcError)
      expect(thrown.code).to.equal(-32600)
      expect(thrown.message).to.equal('Invalid Request')
    })
  })

  describe('Protocol details', function () {
    const jsonRes = (id, result, headers = []) => ({
      status: 200,
      ok: true,
      headers: new Map([['content-type', 'application/json'], ...headers]),
      json: async () => ({ jsonrpc: '2.0', id, result }),
      text: async () => '',
    })
    const notFound = () => ({
      status: 404,
      ok: false,
      headers: new Map(),
      text: async () => 'Not Found',
    })
    const rejectionOf = async promise => {
      try {
        await promise
      } catch (err) {
        return err
      }
      return null
    }

    it('sends the per-request _meta on modern requests and reads serverInfo from _meta', async function () {
      const sent = []
      const fakeFetch = async (url, opts) => {
        const body = JSON.parse(opts.body)
        sent.push(body)
        if (body.method === 'server/discover') {
          return jsonRes(body.id, {
            supportedVersions: [MODERN_PROTOCOL_VERSION],
            capabilities: { tools: {} },
            _meta: {
              'io.modelcontextprotocol/serverInfo': {
                name: 'cloud',
                version: '0.4',
              },
            },
          })
        }
        return jsonRes(body.id, { tools: [] })
      }

      const client = new McpClient({
        url: 'https://mcp.example.com/mcp',
        fetch: fakeFetch,
      })
      await client.listTools()

      expect(client.era).to.equal(MODERN_ERA)
      expect(client.serverInfo).to.deep.equal({ name: 'cloud', version: '0.4' })
      const list = sent.find(m => m.method === 'tools/list')
      expect(
        list.params._meta['io.modelcontextprotocol/protocolVersion']
      ).to.equal(MODERN_PROTOCOL_VERSION)
      expect(
        list.params._meta['io.modelcontextprotocol/clientInfo'].name
      ).to.equal('overleaf-ai-assist')
    })

    it('refuses a legacy server that speaks a protocol version the client does not', async function () {
      const fakeFetch = async (url, opts) => {
        const body = JSON.parse(opts.body)
        if (body.method === 'initialize') {
          return jsonRes(body.id, { protocolVersion: '2019-01-01' })
        }
        return notFound()
      }
      const client = new McpClient({
        url: 'https://mcp.example.com/mcp',
        fetch: fakeFetch,
      })
      const err = await rejectionOf(client.connect())
      expect(err.message).to.match(/does not support/)
    })

    it('starts a new session when the server drops the old one, and ends the session on close', async function () {
      const initCount = { n: 0 }
      const listSessions = []
      let deleted = null
      const fakeFetch = async (url, opts) => {
        if (opts.method === 'DELETE') {
          deleted = opts.headers['Mcp-Session-Id']
          return { status: 200, ok: true, headers: new Map() }
        }
        const body = JSON.parse(opts.body)
        if (body.method === 'notifications/initialized') {
          return { status: 202, ok: true, headers: new Map() }
        }
        if (body.method === 'server/discover') return notFound()
        if (body.method === 'initialize') {
          initCount.n++
          return jsonRes(
            body.id,
            {
              protocolVersion: LEGACY_PROTOCOL_VERSION,
              serverInfo: { name: 'legacy' },
            },
            [['mcp-session-id', `s${initCount.n}`]]
          )
        }
        if (body.method === 'tools/list') {
          listSessions.push(opts.headers['Mcp-Session-Id'])
          if (listSessions.length === 1) return notFound()
          return jsonRes(body.id, { tools: [] })
        }
        return notFound()
      }

      const client = new McpClient({
        url: 'https://mcp.example.com/mcp',
        fetch: fakeFetch,
      })
      await client.listTools()
      expect(initCount.n).to.equal(2)
      expect(listSessions).to.deep.equal(['s1', 's2'])

      await client.close()
      await new Promise(resolve => setImmediate(resolve))
      expect(deleted).to.equal('s2')
    })

    it('mirrors x-mcp-header parameters, and leaves out tools whose annotations break the spec', async function () {
      let callHeaders = null
      const schema = {
        type: 'object',
        properties: {
          region: { type: 'string', 'x-mcp-header': 'Region' },
          count: { type: 'integer', 'x-mcp-header': 'Count' },
          query: { type: 'string' },
        },
      }
      const badSchema = {
        type: 'object',
        properties: { a: { type: 'number', 'x-mcp-header': 'A' } },
      }
      const fakeFetch = async (url, opts) => {
        const body = JSON.parse(opts.body)
        if (body.method === 'server/discover') {
          return jsonRes(body.id, { capabilities: {} })
        }
        if (body.method === 'tools/list') {
          return jsonRes(body.id, {
            tools: [
              { name: 'run', inputSchema: schema },
              { name: 'bad', inputSchema: badSchema },
            ],
          })
        }
        callHeaders = opts.headers
        return jsonRes(body.id, { content: [{ type: 'text', text: 'ok' }] })
      }

      const client = new McpClient({
        url: 'https://mcp.example.com/mcp',
        fetch: fakeFetch,
      })
      const tools = await client.listTools()
      expect(tools.map(t => t.name)).to.deep.equal(['run'])

      await client.callTool('run', { region: 'us-west1', count: 3, query: 'q' })
      expect(callHeaders['Mcp-Param-Region']).to.equal('us-west1')
      expect(callHeaders['Mcp-Param-Count']).to.equal('3')
      expect(callHeaders['Mcp-Param-Query']).to.be.undefined

      // Without a listing, the schema the caller passes is used
      const fresh = new McpClient({
        url: 'https://mcp.example.com/mcp',
        fetch: fakeFetch,
      })
      await fresh.callTool(
        'run',
        { region: 'Hà Nội' },
        { inputSchema: schema }
      )
      expect(callHeaders['Mcp-Param-Region']).to.equal(
        `=?base64?${Buffer.from('Hà Nội', 'utf8').toString('base64')}?=`
      )
    })

    it('does not put an idle timeout on the legacy SSE stream', async function () {
      let streamOpts = null
      const fakeFetch = async (url, opts) => {
        if (opts.method === 'GET') {
          streamOpts = opts
          async function* generateSse() {
            yield Buffer.from('event: endpoint\ndata: /mcp/messages\n\n')
          }
          return {
            status: 200,
            ok: true,
            headers: new Map([['content-type', 'text/event-stream']]),
            body: generateSse(),
          }
        }
        const body = JSON.parse(opts.body)
        if (body.method === 'initialize') {
          return jsonRes(body.id, { protocolVersion: LEGACY_PROTOCOL_VERSION })
        }
        return { status: 202, ok: true, headers: new Map() }
      }
      const client = new McpClient({
        url: 'https://mcp.example.com/sse',
        transport: 'sse',
        fetch: fakeFetch,
      })
      await client.connect({ timeoutMs: 30_000 })
      expect(streamOpts.timeoutMs).to.be.undefined
      await client.close()
    })

    it('fails a call whose answer can only come on an SSE stream that has closed', async function () {
      const fakeFetch = async (url, opts) => {
        if (opts.method === 'GET') {
          async function* generateSse() {
            yield Buffer.from('event: endpoint\ndata: /mcp/messages\n\n')
          }
          return {
            status: 200,
            ok: true,
            headers: new Map([['content-type', 'text/event-stream']]),
            body: generateSse(),
          }
        }
        const body = JSON.parse(opts.body)
        if (body.method === 'initialize') {
          return jsonRes(body.id, { protocolVersion: LEGACY_PROTOCOL_VERSION })
        }
        return { status: 202, ok: true, headers: new Map() }
      }
      const client = new McpClient({
        url: 'https://mcp.example.com/sse',
        transport: 'sse',
        fetch: fakeFetch,
      })
      await client.connect()
      await new Promise(resolve => setImmediate(resolve))
      const err = await rejectionOf(client.callTool('run', {}))
      expect(err.message).to.match(/SSE connection failed/)
    })
  })
})
