import { expect } from 'chai'
import sinon from 'sinon'
import { registerFileTools } from '../../../../src/tools/files.js'

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

describe('file tools', function () {
  let server, client

  beforeEach(function () {
    client = {
      get: sinon.stub(),
      post: sinon.stub(),
      requestBinary: sinon.stub(),
    }
    server = fakeServer()
    registerFileTools(server, {
      client,
      staticToken: '',
      maxUploadBytes: 20 * 1024 * 1024,
    })
  })

  it('registers the eight file tools', function () {
    expect([...server.tools.keys()]).to.have.members([
      'list_files',
      'search_files',
      'read_file',
      'write_file',
      'edit_file',
      'move_file',
      'upload_asset',
      'download_file',
    ])
  })

  it('list_files reads the project tree', async function () {
    client.get.resolves({ docs: [], files: [] })
    await server.call('list_files', { projectId: 'p1' })
    expect(client.get.firstCall.args[1]).to.equal('/projects/p1/tree')
  })

  it('read_file passes the path and line range through', async function () {
    client.get.resolves({ path: '/main.tex', content: 'hello' })
    await server.call('read_file', {
      projectId: 'p1',
      path: '/main.tex',
      startLine: 5,
      endLine: 10,
    })
    expect(client.get.firstCall.args[1]).to.equal('/projects/p1/doc')
    expect(client.get.firstCall.args[2]).to.deep.equal({
      path: '/main.tex',
      startLine: 5,
      endLine: 10,
    })
  })

  it('write_file posts the full content', async function () {
    client.post.resolves({ status: 'ok', docId: 'd1' })
    await server.call('write_file', {
      projectId: 'p1',
      path: '/main.tex',
      content: 'new body',
    })
    expect(client.post.firstCall.args[1]).to.equal('/projects/p1/doc')
    expect(client.post.firstCall.args[2]).to.deep.equal({
      path: '/main.tex',
      content: 'new body',
    })
  })

  it('edit_file reads, replaces once, and writes back', async function () {
    client.get.resolves({ path: '/main.tex', content: 'alpha beta gamma' })
    client.post.resolves({ status: 'ok', docId: 'd1' })
    const result = await server.call('edit_file', {
      projectId: 'p1',
      path: '/main.tex',
      oldString: 'beta',
      newString: 'delta',
    })
    expect(client.post.firstCall.args[2].content).to.equal('alpha delta gamma')
    expect(JSON.parse(result.content[0].text).replacements).to.equal(1)
  })

  it('edit_file preserves replacement string literally when replaceAll is false', async function () {
    client.get.resolves({ path: '/main.tex', content: 'placeholder' })
    client.post.resolves({ status: 'ok', docId: 'd1' })
    await server.call('edit_file', {
      projectId: 'p1',
      path: '/main.tex',
      oldString: 'placeholder',
      newString: '$$x = y$$',
    })
    expect(client.post.firstCall.args[2].content).to.equal('$$x = y$$')
  })

  it('edit_file refuses when the old string is absent', async function () {
    client.get.resolves({ path: '/main.tex', content: 'alpha beta' })
    const result = await server.call('edit_file', {
      projectId: 'p1',
      path: '/main.tex',
      oldString: 'missing',
      newString: 'x',
    })
    expect(result.isError).to.be.true
    expect(JSON.parse(result.content[0].text).code).to.equal('validation_error')
    expect(client.post.called).to.be.false
  })

  it('edit_file refuses an ambiguous match unless replaceAll is set', async function () {
    client.get.resolves({ path: '/main.tex', content: 'x x' })
    const result = await server.call('edit_file', {
      projectId: 'p1',
      path: '/main.tex',
      oldString: 'x',
      newString: 'y',
    })
    expect(result.isError).to.be.true
    expect(JSON.parse(result.content[0].text).message).to.match(/2 times/)
    expect(client.post.called).to.be.false
  })

  it('edit_file replaces every occurrence when replaceAll is set', async function () {
    client.get.resolves({ path: '/main.tex', content: 'x x' })
    client.post.resolves({ status: 'ok', docId: 'd1' })
    const result = await server.call('edit_file', {
      projectId: 'p1',
      path: '/main.tex',
      oldString: 'x',
      newString: 'y',
      replaceAll: true,
    })
    expect(client.post.firstCall.args[2].content).to.equal('y y')
    expect(JSON.parse(result.content[0].text).replacements).to.equal(2)
  })

  it('edit_file never reads a line-sliced document', async function () {
    client.get.resolves({ path: '/main.tex', content: 'alpha' })
    client.post.resolves({ status: 'ok' })
    await server.call('edit_file', {
      projectId: 'p1',
      path: '/main.tex',
      oldString: 'alpha',
      newString: 'beta',
    })
    // A sliced read would truncate the write and destroy the rest of the file.
    expect(client.get.firstCall.args[2]).to.deep.equal({ path: '/main.tex' })
  })

  it('move_file posts both paths', async function () {
    client.post.resolves({ status: 'ok' })
    await server.call('move_file', {
      projectId: 'p1',
      oldPath: '/a.tex',
      newPath: '/b.tex',
    })
    expect(client.post.firstCall.args[2]).to.deep.equal({
      oldPath: '/a.tex',
      newPath: '/b.tex',
    })
  })

  it('upload_asset forwards base64 content', async function () {
    client.post.resolves({ status: 'ok', fileId: 'f1' })
    await server.call('upload_asset', {
      projectId: 'p1',
      path: '/figures/a.png',
      contentBase64: 'AAAA',
    })
    expect(client.post.firstCall.args[1]).to.equal('/projects/p1/file')
    expect(client.post.firstCall.args[2].contentBase64).to.equal('AAAA')
  })

  it('upload_asset forwards a url instead', async function () {
    client.post.resolves({ status: 'ok', fileId: 'f1' })
    await server.call('upload_asset', {
      projectId: 'p1',
      path: '/figures/a.pdf',
      url: 'https://example.com/a.pdf',
    })
    expect(client.post.firstCall.args[2].url).to.equal('https://example.com/a.pdf')
  })

  it('upload_asset rejects oversize base64 locally before calling web', async function () {
    const huge = 'A'.repeat(30 * 1024 * 1024)
    const result = await server.call('upload_asset', {
      projectId: 'p1',
      path: '/figures/a.png',
      contentBase64: huge,
    })
    expect(result.isError).to.be.true
    expect(JSON.parse(result.content[0].text).code).to.equal('validation_error')
    expect(client.post.called).to.be.false
  })

  it('upload_asset requires exactly one of contentBase64 or url', async function () {
    const neither = await server.call('upload_asset', { projectId: 'p1', path: '/a.png' })
    expect(neither.isError).to.be.true
    const both = await server.call('upload_asset', {
      projectId: 'p1',
      path: '/a.png',
      contentBase64: 'AAAA',
      url: 'https://example.com/a.png',
    })
    expect(both.isError).to.be.true
    expect(client.post.called).to.be.false
  })

  it('download_file requests binary file and returns resource block', async function () {
    client.requestBinary.resolves({
      contentType: 'image/png',
      base64: Buffer.from('png-bytes').toString('base64'),
    })
    const result = await server.call('download_file', {
      projectId: 'p1',
      path: '/figures/plot.png',
    })
    expect(client.requestBinary.firstCall.args[0]).to.equal(TOKEN)
    expect(client.requestBinary.firstCall.args[1]).to.equal('/projects/p1/file')
    expect(client.requestBinary.firstCall.args[2]).to.deep.equal({
      path: '/figures/plot.png',
    })
    expect(result.content[0].type).to.equal('resource')
    expect(result.content[0].resource.mimeType).to.equal('image/png')
    expect(result.content[0].resource.uri).to.include('/figures/plot.png')
    expect(result.content[1].type).to.equal('text')
    expect(JSON.parse(result.content[1].text).status).to.equal('ok')
  })

  it('search_files passes search query, filters and options to web API', async function () {
    client.get.resolves({
      query: 'theorem',
      totalMatches: 1,
      matches: [{ path: '/intro.tex', line: 5, preview: '\\begin{theorem}' }],
    })
    const result = await server.call('search_files', {
      projectId: 'p1',
      query: 'theorem',
      path: '/chapters',
      fileTypes: ['.tex', '.bib'],
      caseSensitive: true,
      maxMatches: 15,
    })
    expect(client.get.firstCall.args[1]).to.equal('/projects/p1/search')
    expect(client.get.firstCall.args[2]).to.deep.equal({
      query: 'theorem',
      path: '/chapters',
      fileTypes: ['.tex', '.bib'],
      caseSensitive: true,
      maxMatches: 15,
    })
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.totalMatches).to.equal(1)
    expect(parsed.matches[0].path).to.equal('/intro.tex')
  })
})
