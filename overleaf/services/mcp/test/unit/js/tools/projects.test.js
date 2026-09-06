import { expect } from 'chai'
import sinon from 'sinon'
import { registerProjectTools } from '../../../../src/tools/projects.js'
import { OverleafApiError } from '../../../../src/errors.js'

const TOKEN = 'olp_0123456789abcdef'
const CTX = { http: { authInfo: { token: TOKEN } } }

/** Minimal stand-in for McpServer that captures registered handlers. */
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

describe('project tools', function () {
  let server, client

  beforeEach(function () {
    client = {
      get: sinon.stub(),
      post: sinon.stub(),
      patch: sinon.stub(),
      requestBinary: sinon.stub(),
    }
    server = fakeServer()
    registerProjectTools(server, { client, staticToken: '' })
  })

  it('registers the five project tools', function () {
    expect([...server.tools.keys()]).to.have.members([
      'list_projects',
      'create_project',
      'get_project',
      'update_project',
      'export_project_zip',
    ])
  })

  it('list_projects forwards the token and the query and status filters', async function () {
    client.get.resolves({ projects: [{ id: 'p1', name: 'Paper' }] })
    const result = await server.call('list_projects', { query: 'draft', status: 'trashed' })
    expect(client.get.firstCall.args[0]).to.equal(TOKEN)
    expect(client.get.firstCall.args[1]).to.equal('/projects')
    expect(client.get.firstCall.args[2]).to.deep.equal({ query: 'draft', status: 'trashed' })
    expect(JSON.parse(result.content[0].text).projects[0].id).to.equal('p1')
  })

  it('create_project posts the name and optional initial files', async function () {
    client.post.resolves({ project: { id: 'p2' } })
    await server.call('create_project', {
      name: 'New',
      initialFiles: [{ path: 'main.tex', content: '\\documentclass{article}' }],
    })
    expect(client.post.firstCall.args[1]).to.equal('/projects')
    expect(client.post.firstCall.args[2].name).to.equal('New')
    expect(client.post.firstCall.args[2].initialFiles).to.have.length(1)
  })

  it('get_project reads one project by id', async function () {
    client.get.resolves({ project: { id: 'p1' } })
    await server.call('get_project', { projectId: 'p1' })
    expect(client.get.firstCall.args[1]).to.equal('/projects/p1')
  })

  it('update_project patches only the fields supplied', async function () {
    client.patch.resolves({ status: 'ok' })
    await server.call('update_project', { projectId: 'p1', compiler: 'xelatex' })
    expect(client.patch.firstCall.args[1]).to.equal('/projects/p1/settings')
    expect(client.patch.firstCall.args[2]).to.deep.equal({ compiler: 'xelatex' })
  })

  it('surfaces the upstream code as a tool error', async function () {
    client.get.rejects(new OverleafApiError('not_found', 'not found', 404))
    const result = await server.call('get_project', { projectId: 'p1' })
    expect(result.isError).to.be.true
    expect(JSON.parse(result.content[0].text).code).to.equal('not_found')
  })

  it('fails closed when no token is present in the context', async function () {
    const result = await server.call('list_projects', {}, {})
    expect(result.isError).to.be.true
    expect(JSON.parse(result.content[0].text).code).to.equal('unauthorized')
    expect(client.get.called).to.be.false
  })

  it('uses the stdio fallback token when there is no HTTP context', async function () {
    const stdioServer = fakeServer()
    registerProjectTools(stdioServer, { client, staticToken: 'olp_stdio000000' })
    client.get.resolves({ projects: [] })
    await stdioServer.call('list_projects', {}, {})
    expect(client.get.firstCall.args[0]).to.equal('olp_stdio000000')
  })

  it('export_project_zip requests single project zip and returns resource and text', async function () {
    client.requestBinary.resolves({
      contentType: 'application/zip',
      base64: Buffer.from('PK-zip-content').toString('base64'),
    })
    const result = await server.call('export_project_zip', { projectId: 'p1' })
    expect(client.requestBinary.firstCall.args[0]).to.equal(TOKEN)
    expect(client.requestBinary.firstCall.args[1]).to.equal('/projects/p1/zip')
    expect(result.content[0].type).to.equal('resource')
    expect(result.content[0].resource.mimeType).to.equal('application/zip')
    expect(result.content[0].resource.uri).to.include('/p1/project.zip')
    expect(result.content[1].type).to.equal('text')
    expect(JSON.parse(result.content[1].text).message).to.include('Exported project "p1"')
  })

  it('export_project_zip bundles multiple projects via POST /projects-zip', async function () {
    client.requestBinary.resolves({
      contentType: 'application/zip',
      base64: Buffer.from('PK-multi-zip-content').toString('base64'),
    })
    const result = await server.call('export_project_zip', {
      projectIds: ['p1', 'p2', 'p3'],
    })
    expect(client.requestBinary.firstCall.args[0]).to.equal(TOKEN)
    expect(client.requestBinary.firstCall.args[1]).to.equal('/projects-zip')
    expect(client.requestBinary.firstCall.args[2]).to.deep.equal({
      method: 'POST',
      body: { projectIds: ['p1', 'p2', 'p3'] },
    })
    expect(result.content[0].type).to.equal('resource')
    expect(result.content[0].resource.uri).to.include('bundle-3-projects.zip')
    expect(JSON.parse(result.content[1].text).message).to.include('Exported 3 projects')
  })

  it('export_project_zip rejects when neither or both projectId and projectIds are passed', async function () {
    const neither = await server.call('export_project_zip', {})
    expect(neither.isError).to.be.true

    const both = await server.call('export_project_zip', {
      projectId: 'p1',
      projectIds: ['p2'],
    })
    expect(both.isError).to.be.true
    expect(client.requestBinary.called).to.be.false
  })
})
