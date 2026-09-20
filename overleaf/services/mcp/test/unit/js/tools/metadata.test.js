import { expect } from 'chai'
import sinon from 'sinon'
import { registerAllTools } from '../../../../src/server.js'

const TOKEN = 'olp_0123456789abcdef'
const CTX = { http: { authInfo: { token: TOKEN } } }

/**
 * Tools that only read Overleaf data. Listing them here rather than deriving
 * the set from the annotations is the point: a mutation that is mislabelled
 * read-only would let a client run it without confirmation, so the label has
 * to be asserted against an explicit list a reviewer approves.
 */
const READ_ONLY_TOOLS = [
  'list_projects',
  'get_project',
  'get_project_settings',
  'list_available_settings',
  'get_editor_settings',
  'export_project_zip',
  'list_files',
  'search_files',
  'read_file',
  'download_file',
  'get_compile_log',
  'get_compile_pdf',
  'get_word_count',
  'get_doc_outline',
  'scan_latex',
  'search_bib',
  // compile_project builds the project but never changes its content: the
  // only thing it writes is Overleaf's own output directory, which clearCache
  // discards. Annotating it read-only is what stops clients that gate on
  // readOnlyHint (Gemini, Gemini Enterprise) from asking the user to confirm
  // every compile in an edit-compile-read-log loop.
  'compile_project',
]

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

describe('tool metadata', function () {
  let server, client

  beforeEach(function () {
    client = {
      get: sinon.stub(),
      post: sinon.stub(),
      patch: sinon.stub(),
      requestBinary: sinon.stub(),
    }
    server = fakeServer()
    registerAllTools(server, {
      client,
      staticToken: TOKEN,
      maxUploadBytes: 1024 * 1024,
    })
  })

  it('gives every tool a title, a description and both schemas', function () {
    for (const [name, { config }] of server.tools) {
      expect(config.title, `${name} title`).to.be.a('string').and.not.be.empty
      expect(config.inputSchema, `${name} inputSchema`).to.exist
      // Clients such as ChatGPT use the output schema to understand results.
      expect(config.outputSchema, `${name} outputSchema`).to.exist
      expect(config.outputSchema['~standard'], `${name} outputSchema`).to.exist
      expect(config.description, `${name} description`).to.be.a('string')
      expect(
        config.description.length,
        `${name} description is too terse to pick the tool from`
      ).to.be.greaterThan(60)
    }
  })

  it('annotates exactly the read-only tools as read-only', function () {
    const readOnly = [...server.tools]
      .filter(([, { config }]) => config.annotations?.readOnlyHint)
      .map(([name]) => name)
    expect(readOnly).to.have.members(READ_ONLY_TOOLS)
  })

  it('states all four hints explicitly on every tool', function () {
    for (const [name, { config }] of server.tools) {
      const annotations = config.annotations
      expect(annotations, `${name} annotations`).to.exist
      // Every hint left unset resolves to its pessimistic protocol default --
      // destructiveHint to true, idempotentHint to false -- so a client that
      // gates confirmation on the hints treats a harmless read as a possible
      // mutation and prompts for it. Spelling all four out is what keeps the
      // read-only tools running without a confirmation click.
      for (const hint of [
        'readOnlyHint',
        'destructiveHint',
        'idempotentHint',
        'openWorldHint',
      ]) {
        expect(annotations[hint], `${name} ${hint}`).to.be.a('boolean')
      }
    }
  })

  it('never marks a read-only tool as destructive', function () {
    for (const [name, { config }] of server.tools) {
      if (!config.annotations.readOnlyHint) continue
      expect(config.annotations.destructiveHint, `${name} destructiveHint`).to.be
        .false
    }
  })

  it('marks only the tool that reaches outside Overleaf as open-world', function () {
    const openWorld = [...server.tools]
      .filter(([, { config }]) => config.annotations?.openWorldHint)
      .map(([name]) => name)
    // upload_asset can ask Overleaf to fetch an arbitrary external URL.
    expect(openWorld).to.deep.equal(['upload_asset'])
  })

  it('returns structuredContent matching the advertised output schema', async function () {
    client.get.resolves({ path: '/main.tex', content: 'hello' })
    const result = await server.call('read_file', {
      projectId: 'p1',
      path: '/main.tex',
    })
    expect(result.structuredContent).to.deep.equal({
      path: '/main.tex',
      content: 'hello',
    })
    const { config } = server.tools.get('read_file')
    const validated = await config.outputSchema['~standard'].validate(
      result.structuredContent
    )
    expect(validated.issues).to.be.undefined
  })

  it('returns structuredContent alongside a binary resource', async function () {
    client.requestBinary.resolves({
      contentType: 'application/pdf',
      base64: Buffer.from('pdf bytes').toString('base64'),
    })
    const result = await server.call('get_compile_pdf', {
      projectId: 'p1',
      buildId: 'b1',
    })
    expect(result.content[0].type).to.equal('resource')
    expect(result.structuredContent).to.include({
      projectId: 'p1',
      buildId: 'b1',
      mimeType: 'application/pdf',
      sizeBytes: 9,
    })
  })

  it('omits structuredContent from an error result', async function () {
    client.get.rejects(new Error('upstream is down'))
    const result = await server.call('read_file', {
      projectId: 'p1',
      path: '/main.tex',
    })
    // MCP skips output validation for errors, so an error must not carry a
    // half-built structured payload the schema would reject.
    expect(result.isError).to.be.true
    expect(result.structuredContent).to.be.undefined
  })
})
