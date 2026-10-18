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
})
