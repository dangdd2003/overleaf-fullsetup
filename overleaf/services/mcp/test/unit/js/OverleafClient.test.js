import { expect } from 'chai'
import sinon from 'sinon'
import { OverleafClient } from '../../../src/OverleafClient.js'
import { OverleafApiError } from '../../../src/errors.js'

const BASE_URL = 'http://web:3000'
const TOKEN = 'olp_0123456789abcdef0123456789abcdef'

function jsonResponse(status, body, contentType = 'application/json') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => (name.toLowerCase() === 'content-type' ? contentType : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer,
  }
}

describe('OverleafClient', function () {
  let fetchImpl, client

  beforeEach(function () {
    fetchImpl = sinon.stub()
    client = new OverleafClient({ baseUrl: BASE_URL, fetchImpl })
  })

  it('forwards the caller token as a bearer header', async function () {
    fetchImpl.resolves(jsonResponse(200, { projects: [] }))
    await client.get(TOKEN, '/projects')
    const [url, init] = fetchImpl.firstCall.args
    expect(url).to.equal('http://web:3000/api/v0/mcp/projects')
    expect(init.headers.Authorization).to.equal(`Bearer ${TOKEN}`)
  })

  it('never sends the token anywhere but the Authorization header', async function () {
    fetchImpl.resolves(jsonResponse(200, {}))
    await client.get(TOKEN, '/projects', { query: 'draft' })
    const [url, init] = fetchImpl.firstCall.args
    expect(url).to.not.include(TOKEN)
    expect(JSON.stringify(init.body ?? '')).to.not.include(TOKEN)
  })

  it('serialises query parameters and drops undefined ones', async function () {
    fetchImpl.resolves(jsonResponse(200, {}))
    await client.get(TOKEN, '/projects/p1/doc', {
      path: '/main.tex',
      startLine: 1,
      endLine: undefined,
    })
    const [url] = fetchImpl.firstCall.args
    expect(url).to.include('path=%2Fmain.tex')
    expect(url).to.include('startLine=1')
    expect(url).to.not.include('endLine')
  })

  it('sends a JSON body on POST', async function () {
    fetchImpl.resolves(jsonResponse(200, { status: 'ok' }))
    await client.post(TOKEN, '/projects', { name: 'Paper' })
    const [, init] = fetchImpl.firstCall.args
    expect(init.method).to.equal('POST')
    expect(init.headers['Content-Type']).to.equal('application/json')
    expect(JSON.parse(init.body)).to.deep.equal({ name: 'Paper' })
  })

  it('preserves the upstream code from the error envelope', async function () {
    fetchImpl.resolves(jsonResponse(403, { code: 'insufficient_scope', message: 'no mcp scope' }))
    try {
      await client.get(TOKEN, '/projects')
      expect.fail('expected a throw')
    } catch (err) {
      expect(err).to.be.instanceOf(OverleafApiError)
      expect(err.code).to.equal('insufficient_scope')
      expect(err.message).to.equal('no mcp scope')
      expect(err.status).to.equal(403)
    }
  })

  it('falls back to the status map when the body carries no envelope', async function () {
    fetchImpl.resolves(jsonResponse(404, 'nope', 'text/html'))
    try {
      await client.get(TOKEN, '/projects/p1')
      expect.fail('expected a throw')
    } catch (err) {
      expect(err.code).to.equal('not_found')
    }
  })

  it('sanitises the internal URL out of an upstream message', async function () {
    fetchImpl.resolves(
      jsonResponse(502, { code: 'upstream_error', message: 'clsi at http://web:3000 died' })
    )
    try {
      await client.get(TOKEN, '/projects/p1/compile')
      expect.fail('expected a throw')
    } catch (err) {
      expect(err.message).to.not.include('web:3000')
    }
  })

  it('maps a transport failure to upstream_error without leaking the URL', async function () {
    fetchImpl.rejects(new TypeError('connect ECONNREFUSED http://web:3000'))
    try {
      await client.get(TOKEN, '/projects')
      expect.fail('expected a throw')
    } catch (err) {
      expect(err).to.be.instanceOf(OverleafApiError)
      expect(err.code).to.equal('upstream_error')
      expect(err.message).to.not.include('web:3000')
    }
  })

  it('returns binary content base64-encoded', async function () {
    const pdf = new TextEncoder().encode('%PDF-1.7')
    fetchImpl.resolves({
      ok: true,
      status: 200,
      headers: { get: () => 'application/pdf' },
      arrayBuffer: async () => pdf.buffer,
    })
    const result = await client.requestBinary(TOKEN, '/projects/p1/compile/pdf', {
      buildId: 'b1',
    })
    expect(result.contentType).to.equal('application/pdf')
    expect(Buffer.from(result.base64, 'base64').toString()).to.equal('%PDF-1.7')
  })

  it('rejects a missing token before making a request', async function () {
    try {
      await client.get('', '/projects')
      expect.fail('expected a throw')
    } catch (err) {
      expect(err.code).to.equal('unauthorized')
    }
    expect(fetchImpl.called).to.be.false
  })

  it('requestBinary: rejects a missing token before making a request', async function () {
    try {
      await client.requestBinary('', '/projects/p1/compile/pdf')
      expect.fail('expected a throw')
    } catch (err) {
      expect(err.code).to.equal('unauthorized')
    }
    expect(fetchImpl.called).to.be.false
  })

  it('requestBinary: accepts a plain query object', async function () {
    const pdf = new TextEncoder().encode('%PDF-1.7')
    fetchImpl.resolves({
      ok: true,
      status: 200,
      headers: { get: () => 'application/pdf' },
      arrayBuffer: async () => pdf.buffer,
    })
    const result = await client.requestBinary(TOKEN, '/projects/p1/compile/pdf', {
      buildId: 'b1',
    })
    const [url] = fetchImpl.firstCall.args
    expect(url).to.include('buildId=b1')
    expect(result.contentType).to.equal('application/pdf')
    expect(Buffer.from(result.base64, 'base64').toString()).to.equal('%PDF-1.7')
  })

  it('requestBinary: accepts an options object with a query key', async function () {
    const pdf = new TextEncoder().encode('%PDF-1.7')
    fetchImpl.resolves({
      ok: true,
      status: 200,
      headers: { get: () => 'application/pdf' },
      arrayBuffer: async () => pdf.buffer,
    })
    const result = await client.requestBinary(TOKEN, '/projects/p1/compile/pdf', {
      query: { buildId: 'b1' },
    })
    const [url] = fetchImpl.firstCall.args
    expect(url).to.include('buildId=b1')
    expect(result.contentType).to.equal('application/pdf')
    expect(Buffer.from(result.base64, 'base64').toString()).to.equal('%PDF-1.7')
  })

  it('requestBinary: accepts method and body for POST binary requests', async function () {
    const zip = new TextEncoder().encode('PK-zip')
    fetchImpl.resolves({
      ok: true,
      status: 200,
      headers: { get: () => 'application/zip' },
      arrayBuffer: async () => zip.buffer,
    })
    const result = await client.requestBinary(TOKEN, '/projects-zip', {
      method: 'POST',
      body: { projectIds: ['p1', 'p2'] },
    })
    const [url, init] = fetchImpl.firstCall.args
    expect(url).to.equal('http://web:3000/api/v0/mcp/projects-zip')
    expect(init.method).to.equal('POST')
    expect(init.headers['Content-Type']).to.equal('application/json')
    expect(JSON.parse(init.body)).to.deep.equal({ projectIds: ['p1', 'p2'] })
    expect(result.contentType).to.equal('application/zip')
  })
})
