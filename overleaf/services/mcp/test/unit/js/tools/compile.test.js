import { expect } from 'chai'
import sinon from 'sinon'
import { registerCompileTools } from '../../../../src/tools/compile.js'
import { OverleafApiError } from '../../../../src/errors.js'

const TOKEN = 'olp_0123456789abcdef'
const CTX = { http: { authInfo: { token: TOKEN } } }

function fakeServer() {
  const tools = new Map()
  return {
    tools,
    registerTool(name, config, handler) {
      tools.set(name, { config, handler })
    },
    call(name, args, ctx = CTX) {
      return tools.get(name).handler(args, ctx)
    },
  }
}

describe('compile tools', function () {
  let server, client

  beforeEach(function () {
    client = { get: sinon.stub(), post: sinon.stub(), requestBinary: sinon.stub() }
    server = fakeServer()
    registerCompileTools(server, { client, staticToken: '' })
  })

  it('registers the four compile tools', function () {
    expect([...server.tools.keys()]).to.have.members([
      'compile_project',
      'get_compile_log',
      'get_compile_pdf',
      'get_word_count',
    ])
  })

  it('compile_project posts only the options supplied', async function () {
    client.post.resolves({ status: 'success', outputFiles: [] })
    await server.call('compile_project', { projectId: 'p1', draft: true })
    expect(client.post.firstCall.args[1]).to.equal('/projects/p1/compile')
    expect(client.post.firstCall.args[2]).to.deep.equal({ draft: true })
  })

  it('compile_project clears cache first when clearCache is true', async function () {
    client.post.resolves({ status: 'success', outputFiles: [] })
    await server.call('compile_project', { projectId: 'p1', clearCache: true })
    expect(client.post.firstCall.args[1]).to.equal('/projects/p1/compile/clear-cache')
    expect(client.post.secondCall.args[1]).to.equal('/projects/p1/compile')
  })

  it('get_compile_log requires a buildId and passes maxLines', async function () {
    client.get.resolves({ log: 'output', truncated: false })
    await server.call('get_compile_log', {
      projectId: 'p1',
      buildId: 'b1',
      maxLines: 500,
    })
    expect(client.get.firstCall.args[1]).to.equal('/projects/p1/compile/log')
    expect(client.get.firstCall.args[2]).to.deep.equal({ buildId: 'b1', maxLines: 500 })
  })

  it('get_compile_pdf returns the bytes as a resource block', async function () {
    client.requestBinary.resolves({ contentType: 'application/pdf', base64: 'JVBERi0=' })
    const result = await server.call('get_compile_pdf', { projectId: 'p1', buildId: 'b1' })
    const block = result.content[0]
    expect(block.type).to.equal('resource')
    expect(block.resource.mimeType).to.equal('application/pdf')
    expect(block.resource.blob).to.equal('JVBERi0=')
  })

  it('get_word_count reads the wordcount route for the whole project', async function () {
    client.get.resolves({ wordCount: { textWords: 1200 } })
    await server.call('get_word_count', { projectId: 'p1' })
    expect(client.get.firstCall.args[1]).to.equal('/projects/p1/wordcount')
    expect(client.get.firstCall.args[2]).to.deep.equal({ file: undefined })
  })

  it('get_word_count can be limited to one file', async function () {
    client.get.resolves({ wordCount: { textWords: 300 } })
    await server.call('get_word_count', { projectId: 'p1', file: '/chapters/intro.tex' })
    expect(client.get.firstCall.args[2]).to.deep.equal({ file: '/chapters/intro.tex' })
  })

  it('preserves upstream_error from a failed compile_project', async function () {
    client.post.rejects(new OverleafApiError('upstream_error', 'clsi unavailable', 502))
    const result = await server.call('compile_project', { projectId: 'p1' })
    expect(JSON.parse(result.content[0].text).code).to.equal('upstream_error')
  })
})
