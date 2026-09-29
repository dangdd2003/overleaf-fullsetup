import http from 'node:http'
import { expect } from 'chai'
import { createHttpApp } from '../../../src/http.js'
import { OverleafClient } from '../../../src/OverleafClient.js'

const CONFIG = {
  host: '127.0.0.1',
  port: 0,
  endpointPath: '/mcp',
  allowedHosts: [],
  allowedOrigins: [],
}

function startServer(app) {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}/mcp` })
    })
  })
}

async function rpc(url, body, { token } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  }
  if (token) headers.Authorization = `Bearer ${token}`
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  const text = await response.text()
  // The endpoint answers with a single SSE `message` event or a JSON body.
  const line = text.split('\n').find(l => l.startsWith('data: '))
  return { status: response.status, body: line ? JSON.parse(line.slice(6)) : text }
}

describe('MCP HTTP transport', function () {
  let running

  beforeEach(async function () {
    const client = new OverleafClient({
      baseUrl: 'http://web:3000',
      fetchImpl: async (_url, init) => {
        const auth = init?.headers?.Authorization || ''
        if (auth === 'Bearer olp_0123456789abcdef') {
          return {
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            json: async () => ({ projects: [] }),
            text: async () => JSON.stringify({ projects: [] }),
          }
        }
        return {
          ok: false,
          status: 401,
          headers: { get: () => 'application/json' },
          json: async () => ({ code: 'unauthorized', message: 'invalid token' }),
          text: async () => JSON.stringify({ code: 'unauthorized', message: 'invalid token' }),
        }
      },
    })
    const { app } = createHttpApp({ config: CONFIG, client })
    running = await startServer(app)
  })

  afterEach(function (done) {
    running.server.close(done)
  })

  it('refuses a request with no bearer token before doing anything else', async function () {
    const { status, body } = await rpc(running.url, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    })
    expect(status).to.equal(401)
    expect(JSON.parse(body).code).to.equal('unauthorized')
  })

  it('rejects a fake or unauthorized token on tools/list with 401', async function () {
    const { status, body } = await rpc(
      running.url,
      { jsonrpc: '2.0', id: 99, method: 'tools/list' },
      { token: 'olp_invalid_dummy_token' }
    )
    expect(status).to.equal(401)
    expect(JSON.parse(body).code).to.equal('unauthorized')
  })

  it('completes the initialize handshake with a valid token', async function () {
    const { body } = await rpc(
      running.url,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2026-07-28',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      },
      { token: 'olp_0123456789abcdef' }
    )
    expect(body.result.serverInfo.name).to.equal('overleaf')
    expect(body.result).to.have.property('protocolVersion')
    expect(body.result.instructions).to.include('get_doc_outline')
    expect(body.result.instructions).to.include('edit_file')
  })

  it('lists registered prompts with a valid token', async function () {
    const { body } = await rpc(
      running.url,
      { jsonrpc: '2.0', id: 22, method: 'prompts/list' },
      { token: 'olp_0123456789abcdef' }
    )
    const names = body.result.prompts.map(p => p.name)
    expect(names).to.have.members([
      'review_project',
      'fix_compile_errors',
      'edit_section',
    ])
  })

  it('lists the whole authoring-core tool surface with a valid token', async function () {
    const { body } = await rpc(
      running.url,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { token: 'olp_0123456789abcdef' }
    )
    const names = body.result.tools.map(tool => tool.name)
    expect(names).to.include.members([
      'list_projects',
      'create_project',
      'get_project',
      'update_project',
      'export_project_zip',
      'list_files',
      'search_files',
      'read_file',
      'write_file',
      'edit_file',
      'move_file',
      'upload_asset',
      'download_file',
      'compile_project',
      'get_compile_log',
      'get_compile_pdf',
      'get_word_count',
      'get_doc_outline',
      'scan_latex',
      'search_bib',
    ])
    expect(names).to.have.length(20)
  })

  it('calls a tool with a valid token', async function () {
    const { body } = await rpc(
      running.url,
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_projects', arguments: {} } },
      { token: 'olp_0123456789abcdef' }
    )
    expect(JSON.parse(body.result.content[0].text).projects).to.deep.equal([])
  })

  it('rejects a non-localhost Host header (DNS rebinding guard)', async function () {
    // Node.js Fetch API treats Host as a forbidden header and silently overwrites
    // it with the real server address, so we use http.request directly here.
    const port = running.server.address().port
    const body = JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' })
    const status = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/mcp',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            Authorization: 'Bearer olp_0123456789abcdef',
            Host: 'evil.example.com',
          },
        },
        res => resolve(res.statusCode)
      )
      req.on('error', reject)
      req.write(body)
      req.end()
    })
    expect(status).to.equal(403)
  })
})
