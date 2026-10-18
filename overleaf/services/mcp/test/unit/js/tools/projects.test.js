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

function envelopeOf(result) {
  return JSON.parse(result.content[0].text)
}

describe('project tools', function () {
  let server, client

  beforeEach(function () {
    client = {
      get: sinon.stub(),
      post: sinon.stub(),
      patch: sinon.stub(),
      request: sinon.stub(),
      requestBinary: sinon.stub(),
    }
    server = fakeServer()
    registerProjectTools(server, { client, staticToken: '' })
  })

  it('registers the eight project tools', function () {
    expect([...server.tools.keys()]).to.have.members([
      'list_projects',
      'create_project',
      'get_project',
      'update_project',
      'set_project_status',
      'copy_project',
      'delete_project',
      'export_project_zip',
    ])
  })

  it('advertises an output envelope and annotations on every tool', function () {
    for (const [name, { config }] of server.tools) {
      expect(config.outputSchema, `${name} outputSchema`).to.exist
      expect(config.annotations, `${name} annotations`).to.be.an('object')
    }
  })

  it('marks only delete_project as destructive', function () {
    for (const [name, { config }] of server.tools) {
      const destructive = config.annotations.destructiveHint === true
      expect(destructive, `${name} destructiveHint`).to.equal(name === 'delete_project')
    }
  })

  it('returns the shared ok envelope with a summary', async function () {
    client.get.resolves({
      projects: [{ id: 'p1', name: 'Paper' }],
      total: 1,
      returned: 1,
      truncated: false,
    })
    const value = envelopeOf(await server.call('list_projects', {}))
    expect(value.ok).to.be.true
    expect(value.summary).to.be.a('string').and.include('1 of 1')
    expect(value.data.projects[0].id).to.equal('p1')
  })

  it('list_projects forwards the token and only the filters the caller set', async function () {
    client.get.resolves({ projects: [], total: 0, returned: 0, truncated: false })
    await server.call('list_projects', { query: 'draft', status: 'trashed' })
    expect(client.get.firstCall.args[0]).to.equal(TOKEN)
    expect(client.get.firstCall.args[1]).to.equal('/projects')
    expect(client.get.firstCall.args[2]).to.deep.equal({
      query: 'draft',
      status: 'trashed',
    })
  })

  it('list_projects warns and suggests narrowing when more projects match', async function () {
    client.get.resolves({
      projects: [{ id: 'p1', name: 'A' }],
      total: 3,
      returned: 1,
      truncated: true,
    })
    const value = envelopeOf(await server.call('list_projects', { limit: 1 }))
    expect(value.warnings).to.have.length(1)
    expect(value.warnings[0]).to.include('2 more project(s)')
    expect(value.nextSteps[0]).to.include('get_project')
  })

  it('create_project posts the name, template and files as initialFiles', async function () {
    client.post.resolves({
      project: { id: 'p2', name: 'New' },
      rootDocPath: '/main.tex',
      filesCreated: ['/main.tex'],
    })
    const value = envelopeOf(
      await server.call('create_project', {
        name: 'New',
        template: 'example',
        files: [
          { path: '/main.tex', content: '\\documentclass{article}' },
          { path: 'refs.bib', content: '' },
        ],
      })
    )
    expect(client.post.firstCall.args[1]).to.equal('/projects')
    expect(client.post.firstCall.args[2]).to.deep.equal({
      name: 'New',
      template: 'example',
      initialFiles: [
        { path: '/main.tex', content: '\\documentclass{article}' },
        { path: 'refs.bib', content: '' },
      ],
    })
    expect(value.data.rootDocPath).to.equal('/main.tex')
    expect(value.nextSteps[0]).to.include('get_project')
    expect(value.warnings).to.be.undefined
  })

  it('create_project warns when the new project has no root document', async function () {
    client.post.resolves({
      project: { id: 'p3', name: 'Empty' },
      rootDocPath: null,
      filesCreated: [],
    })
    const value = envelopeOf(
      await server.call('create_project', { name: 'Empty', template: 'empty' })
    )
    expect(value.warnings[0]).to.include('No root document')
  })

  it('get_project reads one project and returns settings, allowed values and counts', async function () {
    client.get.resolves({
      project: {
        id: 'p1',
        name: 'Thesis',
        accessLevel: 'owner',
        canWrite: true,
        canAdmin: true,
      },
      settings: {
        name: 'Thesis',
        compiler: 'pdflatex',
        imageName: null,
        spellCheckLanguage: 'en',
        rootDocPath: '/main.tex',
        rootDocId: 'd1',
      },
      allowedValues: {
        compiler: ['pdflatex', 'xelatex'],
        imageName: [{ value: 'texlive/x:2024', description: 'TeX Live 2024' }],
        spellCheckLanguage: [{ value: '', name: 'Spell check off' }],
      },
      files: { documents: 3, files: 1, rootDocCandidates: ['/main.tex'] },
    })
    const result = await server.call('get_project', { projectId: 'p1' })
    expect(client.get.firstCall.args[1]).to.equal('/projects/p1')
    const value = envelopeOf(result)
    expect(value.data.allowedValues.compiler).to.include('xelatex')
    expect(value.summary).to.include('3 document(s)')
    expect(value.warnings).to.be.undefined
    expect(value.nextSteps).to.include.members([
      'list_files with projectId "p1" to see the document tree',
      'compile_project with projectId "p1" to build the project',
    ])
  })

  it('get_project suggests the first root document candidate when none is set', async function () {
    client.get.resolves({
      project: {
        id: 'p1',
        name: 'Thesis',
        accessLevel: 'owner',
        canWrite: true,
        canAdmin: true,
      },
      settings: { name: 'Thesis', compiler: 'pdflatex', rootDocPath: null },
      allowedValues: { compiler: [], imageName: [], spellCheckLanguage: [] },
      files: { documents: 2, files: 0, rootDocCandidates: ['/paper.tex'] },
    })
    const value = envelopeOf(await server.call('get_project', { projectId: 'p1' }))
    expect(value.nextSteps[0]).to.equal(
      'update_project with projectId "p1" and rootDocPath "/paper.tex"'
    )
    expect(value.warnings).to.include(
      'No root document is set, so compiles may pick the wrong file.'
    )
    expect(value.warnings).to.include(
      'This server offers no selectable TeX Live images, so imageName cannot be changed.'
    )
  })

  it('get_project warns read-only callers that edits will be refused', async function () {
    client.get.resolves({
      project: {
        id: 'p1',
        name: 'Shared',
        accessLevel: 'readOnly',
        canWrite: false,
        canAdmin: false,
      },
      settings: { name: 'Shared', compiler: 'pdflatex', rootDocPath: '/main.tex' },
      allowedValues: {
        compiler: ['pdflatex'],
        imageName: [{ value: 'x', description: 'x' }],
        spellCheckLanguage: [],
      },
      files: { documents: 1, files: 0, rootDocCandidates: ['/main.tex'] },
    })
    const value = envelopeOf(await server.call('get_project', { projectId: 'p1' }))
    expect(value.warnings[0]).to.include('read-only')
    expect(
      value.nextSteps.some(step => step.startsWith('update_project'))
    ).to.be.false
  })

  it('update_project patches only the settings supplied', async function () {
    client.patch.resolves({
      changes: [
        { field: 'compiler', before: 'pdflatex', after: 'xelatex', changed: true },
      ],
      settings: { compiler: 'xelatex' },
    })
    const result = await server.call('update_project', {
      projectId: 'p1',
      compiler: 'xelatex',
      rootDocPath: undefined,
    })
    expect(client.patch.firstCall.args[1]).to.equal('/projects/p1/settings')
    expect(client.patch.firstCall.args[2]).to.deep.equal({ compiler: 'xelatex' })
    const value = envelopeOf(result)
    expect(value.summary).to.equal(
      'Updated project p1: compiler pdflatex -> xelatex.'
    )
    expect(value.data.changes[0].changed).to.be.true
  })

  it('update_project says so when every requested value already matched', async function () {
    client.patch.resolves({
      changes: [
        { field: 'compiler', before: 'xelatex', after: 'xelatex', changed: false },
      ],
      settings: { compiler: 'xelatex' },
    })
    const value = envelopeOf(
      await server.call('update_project', { projectId: 'p1', compiler: 'xelatex' })
    )
    expect(value.summary).to.include('already matched')
    expect(value.nextSteps).to.be.undefined
  })

  it('update_project rootDocPath is sent as a path, not an id', async function () {
    client.patch.resolves({ changes: [], settings: {} })
    await server.call('update_project', { projectId: 'p1', rootDocPath: '/main.tex' })
    expect(client.patch.firstCall.args[2]).to.deep.equal({ rootDocPath: '/main.tex' })
  })

  it('set_project_status posts the status and suggests restoring a trashed project', async function () {
    client.post.resolves({ projectId: 'p1', previousStatus: 'active', status: 'trashed' })
    const result = await server.call('set_project_status', {
      projectId: 'p1',
      status: 'trashed',
    })
    expect(client.post.firstCall.args[1]).to.equal('/projects/p1/status')
    expect(client.post.firstCall.args[2]).to.deep.equal({ status: 'trashed' })
    const value = envelopeOf(result)
    expect(value.summary).to.equal('Project p1 moved from active to trashed.')
    expect(value.nextSteps[0]).to.include('"active"')
  })

  it('set_project_status reports a project that already had the status', async function () {
    client.post.resolves({ projectId: 'p1', previousStatus: 'archived', status: 'archived' })
    const value = envelopeOf(
      await server.call('set_project_status', { projectId: 'p1', status: 'archived' })
    )
    expect(value.summary).to.include('already archived')
  })

  it('copy_project posts the optional name and returns the new project', async function () {
    client.post.resolves({
      project: { id: 'p9', name: 'Thesis (Copy)', accessLevel: 'owner' },
      sourceProjectId: 'p1',
    })
    const value = envelopeOf(await server.call('copy_project', { projectId: 'p1' }))
    expect(client.post.firstCall.args[1]).to.equal('/projects/p1/copy')
    expect(client.post.firstCall.args[2]).to.deep.equal({})
    expect(value.data.project.id).to.equal('p9')
    expect(value.nextSteps[0]).to.include('p9')
  })

  it('delete_project refuses to run without confirm: true', async function () {
    const missing = await server.call('delete_project', { projectId: 'p1' })
    expect(missing.isError).to.be.true
    expect(JSON.parse(missing.content[0].text).error.code).to.equal('validation_error')
    expect(client.request.called).to.be.false
  })

  it('delete_project sends a DELETE for the project once confirmed', async function () {
    client.request.resolves({ projectId: 'p1', deleted: true })
    const value = envelopeOf(
      await server.call('delete_project', { projectId: 'p1', confirm: true })
    )
    expect(client.request.firstCall.args[0]).to.equal(TOKEN)
    expect(client.request.firstCall.args[1]).to.equal('DELETE')
    expect(client.request.firstCall.args[2]).to.equal('/projects/p1')
    expect(value.summary).to.equal('Permanently deleted project p1.')
  })

  it('surfaces the upstream code as a tool error', async function () {
    client.get.rejects(new OverleafApiError('not_found', 'not found', 404))
    const result = await server.call('get_project', { projectId: 'p1' })
    expect(result.isError).to.be.true
    expect(JSON.parse(result.content[0].text).error.code).to.equal('not_found')
  })

  it('fails closed when no token is present in the context', async function () {
    const result = await server.call('list_projects', {}, {})
    expect(result.isError).to.be.true
    expect(JSON.parse(result.content[0].text).error.code).to.equal('unauthorized')
    expect(client.get.called).to.be.false
  })

  it('uses the stdio fallback token when there is no HTTP context', async function () {
    const stdioServer = fakeServer()
    registerProjectTools(stdioServer, { client, staticToken: 'olp_stdio000000' })
    client.get.resolves({ projects: [], total: 0, returned: 0, truncated: false })
    await stdioServer.call('list_projects', {}, {})
    expect(client.get.firstCall.args[0]).to.equal('olp_stdio000000')
  })

  describe('output schemas', function () {
    async function expectMatchesOutput(name, result) {
      expect(result.isError, `${name} result`).to.not.be.true
      const { config } = server.tools.get(name)
      const validated = await config.outputSchema['~standard'].validate(
        result.structuredContent
      )
      expect(validated.issues, `${name} structuredContent`).to.be.undefined
    }

    it('validates each tool result against its advertised output schema', async function () {
      client.get
        .onCall(0)
        .resolves({
          projects: [
            {
              id: 'p1',
              name: 'Paper',
              owner: { id: 'u2', name: 'Ada' },
              accessLevel: 'readAndWrite',
              lastUpdated: '2026-01-01T00:00:00.000Z',
            },
          ],
          total: 1,
          returned: 1,
          truncated: false,
        })
      await expectMatchesOutput(
        'list_projects',
        await server.call('list_projects', {})
      )

      client.get.onCall(1).resolves({
        project: {
          id: 'p1',
          name: 'Thesis',
          accessLevel: 'owner',
          canWrite: true,
          canAdmin: true,
        },
        settings: {
          name: 'Thesis',
          compiler: 'pdflatex',
          imageName: null,
          spellCheckLanguage: '',
          rootDocPath: '/main.tex',
          rootDocId: 'd1',
        },
        allowedValues: {
          compiler: ['pdflatex'],
          imageName: [{ value: 'texlive/x:2024', description: 'TeX Live 2024' }],
          spellCheckLanguage: [{ value: '', name: 'Spell check off' }],
        },
        files: { documents: 1, files: 0, rootDocCandidates: ['/main.tex'] },
      })
      await expectMatchesOutput(
        'get_project',
        await server.call('get_project', { projectId: 'p1' })
      )

      client.patch.resolves({
        changes: [
          { field: 'rootDocPath', before: null, after: '/main.tex', changed: true },
        ],
        settings: { rootDocPath: '/main.tex' },
      })
      await expectMatchesOutput(
        'update_project',
        await server.call('update_project', { projectId: 'p1', rootDocPath: '/main.tex' })
      )

      client.post.onCall(0).resolves({
        project: { id: 'p2', name: 'New', accessLevel: 'owner' },
        rootDocPath: null,
        filesCreated: [],
      })
      await expectMatchesOutput(
        'create_project',
        await server.call('create_project', { name: 'New' })
      )

      client.post.onCall(1).resolves({
        projectId: 'p1',
        previousStatus: 'active',
        status: 'archived',
      })
      await expectMatchesOutput(
        'set_project_status',
        await server.call('set_project_status', { projectId: 'p1', status: 'archived' })
      )

      client.post.onCall(2).resolves({
        project: { id: 'p9', name: 'Copy', accessLevel: 'owner' },
        sourceProjectId: 'p1',
      })
      await expectMatchesOutput(
        'copy_project',
        await server.call('copy_project', { projectId: 'p1' })
      )

      client.request.resolves({ projectId: 'p1', deleted: true })
      await expectMatchesOutput(
        'delete_project',
        await server.call('delete_project', { projectId: 'p1', confirm: true })
      )

      client.requestBinary.resolves({
        contentType: 'application/zip',
        filename: 'p1.zip',
        base64: Buffer.from('PK').toString('base64'),
      })
      await expectMatchesOutput(
        'export_project_zip',
        await server.call('export_project_zip', { projectIds: ['p1'] })
      )
    })
  })

  describe('input schemas', function () {
    it('takes any positive list_projects limit and enumerates status values', function () {
      const { inputSchema } = server.tools.get('list_projects').config
      expect(inputSchema.safeParse({ limit: 500 }).success).to.be.true
      expect(inputSchema.safeParse({ limit: 0 }).success).to.be.false
      expect(inputSchema.safeParse({ status: 'deleted' }).success).to.be.false
    })

    it('rejects an update_project call that changes nothing', function () {
      const { inputSchema } = server.tools.get('update_project').config
      expect(inputSchema.safeParse({ projectId: 'p1' }).success).to.be.false
      expect(
        inputSchema.safeParse({ projectId: 'p1', compiler: 'xelatex' }).success
      ).to.be.true
    })

    it('rejects a compiler outside the supported engines', function () {
      const { inputSchema } = server.tools.get('update_project').config
      expect(
        inputSchema.safeParse({ projectId: 'p1', compiler: 'pdftex' }).success
      ).to.be.false
    })

    it('requires confirm to be exactly true for delete_project', function () {
      const { inputSchema } = server.tools.get('delete_project').config
      expect(inputSchema.safeParse({ projectId: 'p1' }).success).to.be.false
      expect(
        inputSchema.safeParse({ projectId: 'p1', confirm: false }).success
      ).to.be.false
      expect(
        inputSchema.safeParse({ projectId: 'p1', confirm: true }).success
      ).to.be.true
    })

    it('limits create_project template to the three documented values', function () {
      const { inputSchema } = server.tools.get('create_project').config
      expect(
        inputSchema.safeParse({ name: 'P', template: 'blank' }).success
      ).to.be.true
      expect(
        inputSchema.safeParse({ name: 'P', template: 'thesis' }).success
      ).to.be.false
    })
  })

  it('export_project_zip downloads one project as its own zip, named by web', async function () {
    client.requestBinary.resolves({
      contentType: 'application/zip',
      filename: 'My_Thesis.zip',
      base64: Buffer.from('PK-zip-content').toString('base64'),
    })
    const result = await server.call('export_project_zip', {
      projectIds: ['p1'],
    })
    expect(client.requestBinary.callCount).to.equal(1)
    expect(client.requestBinary.firstCall.args[0]).to.equal(TOKEN)
    expect(client.requestBinary.firstCall.args[1]).to.equal('/projects/p1/zip')
    expect(result.content).to.have.lengthOf(2)
    expect(result.content[1].type).to.equal('resource')
    expect(result.content[1].resource.mimeType).to.equal('application/zip')
    expect(result.content[1].resource.uri).to.include('/p1/project.zip')
    const value = envelopeOf(result)
    expect(value.ok).to.be.true
    expect(value.data.count).to.equal(1)
    expect(value.data.bundled).to.be.false
    expect(value.data.projectIds).to.deep.equal(['p1'])
    expect(value.data.filename).to.equal('My_Thesis.zip')
    expect(value.summary).to.include('Exported project "p1"')
    expect(result.structuredContent.data.filename).to.equal('My_Thesis.zip')
  })

  it('export_project_zip falls back to the project id when web sends no filename', async function () {
    client.requestBinary.resolves({
      contentType: 'application/zip',
      base64: Buffer.from('PK-zip-content').toString('base64'),
    })
    const result = await server.call('export_project_zip', {
      projectIds: ['p1'],
    })
    expect(envelopeOf(result).data.filename).to.equal('p1.zip')
  })

  it('export_project_zip bundles several projects into one zip in a single request', async function () {
    client.requestBinary.resolves({
      contentType: 'application/zip',
      filename: 'Overleaf Projects 2026-09-21 14-25-30 UTC (3 projects).zip',
      base64: Buffer.from('PK-bundle-content').toString('base64'),
    })
    const result = await server.call('export_project_zip', {
      projectIds: ['p1', 'p2', 'p3'],
    })
    expect(client.requestBinary.callCount).to.equal(1)
    expect(client.requestBinary.firstCall.args[1]).to.equal('/projects-zip')
    expect(client.requestBinary.firstCall.args[2]).to.deep.equal({
      method: 'POST',
      body: { projectIds: ['p1', 'p2', 'p3'] },
    })
    expect(result.content).to.have.lengthOf(2)
    expect(result.content[1].type).to.equal('resource')
    expect(result.content[1].resource.uri).to.equal(
      'overleaf://exports/Overleaf%20Projects%202026-09-21%2014-25-30%20UTC%20(3%20projects).zip'
    )
    const value = envelopeOf(result)
    expect(value.data.count).to.equal(3)
    expect(value.data.bundled).to.be.true
    expect(value.data.projectIds).to.deep.equal(['p1', 'p2', 'p3'])
    expect(value.summary).to.include('Exported 3 projects')
  })

  it('export_project_zip deduplicates ids, so a repeated id stays a single-project export', async function () {
    client.requestBinary.resolves({
      contentType: 'application/zip',
      filename: 'My_Thesis.zip',
      base64: Buffer.from('PK-zip-content').toString('base64'),
    })
    const result = await server.call('export_project_zip', {
      projectIds: ['p1', 'p1'],
    })
    expect(client.requestBinary.callCount).to.equal(1)
    expect(client.requestBinary.firstCall.args[1]).to.equal('/projects/p1/zip')
    const value = envelopeOf(result)
    expect(value.data.count).to.equal(1)
    expect(value.data.bundled).to.be.false
  })

  it('export_project_zip rejects an empty projectIds list', async function () {
    const empty = await server.call('export_project_zip', { projectIds: [] })
    expect(empty.isError).to.be.true

    const missing = await server.call('export_project_zip', {})
    expect(missing.isError).to.be.true

    expect(client.requestBinary.called).to.be.false
  })

  it('export_project_zip accepts any number of projects', function () {
    const { inputSchema } = server.tools.get('export_project_zip').config
    const projectIds = Array.from({ length: 51 }, (_, i) => `p${i}`)
    expect(inputSchema.safeParse({ projectIds }).success).to.be.true
  })
})
