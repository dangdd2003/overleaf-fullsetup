import { expect } from 'chai'
import sinon from 'sinon'
import {
  compileStatus,
  registerCompileTools,
} from '../../../../src/tools/compile.js'
import { OverleafApiError } from '../../../../src/errors.js'

const TOKEN = 'olp_0123456789abcdef'
const CTX = { http: { authInfo: { token: TOKEN } } }

const NO_PROBLEMS = {
  errors: 0,
  warnings: 0,
  badBoxes: 0,
  undefinedReferences: 0,
  undefinedCitations: 0,
}

// The shape web returns from GET /compile/diagnostics.
function diagnostics(overrides = {}) {
  return {
    buildId: 'b1',
    logAvailable: true,
    rootDocPath: 'main.tex',
    logTruncated: false,
    fatal: false,
    rerunNeeded: false,
    counts: NO_PROBLEMS,
    errors: [],
    errorsTruncated: false,
    warnings: [],
    warningsTruncated: false,
    badBoxes: [],
    advice: [],
    ...overrides,
  }
}

const PDF_BUILD = {
  status: 'success',
  buildId: 'b1',
  clsiServerId: 's1',
  rootDocPath: 'main.tex',
  pdf: { path: 'output.pdf', build: 'b1' },
  outputFiles: [
    { path: 'output.pdf', build: 'b1' },
    { path: 'output.log', build: 'b1' },
  ],
}

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
  let server, client, sleep

  beforeEach(function () {
    client = {
      get: sinon.stub(),
      post: sinon.stub(),
      requestBinary: sinon.stub(),
    }
    sleep = sinon.stub().resolves()
    server = fakeServer()
    registerCompileTools(server, { client, staticToken: '', sleep })
  })

  it('registers the compile and compiled-PDF tools', function () {
    expect([...server.tools.keys()]).to.have.members([
      'compile_project',
      'get_compile_log',
      'get_compile_pdf',
      'get_word_count',
      'sync_pdf_source',
      'diff_compiled_pdf',
      'view_compiled_pdf_page',
      'resolve_pdf_block',
      'view_compiled_pdf_overview',
      'search_compiled_pdf',
    ])
  })

  describe('compileStatus', function () {
    it('reports a PDF with log errors as success_with_errors', function () {
      expect(compileStatus('success', 2)).to.equal('success_with_errors')
    })

    it('reports a clean PDF as success', function () {
      expect(compileStatus('success', 0)).to.equal('success')
    })

    it('maps both failing CLSI outcomes to failure', function () {
      expect(compileStatus('failure', 0)).to.equal('failure')
      expect(compileStatus('stopped-on-first-error', 1)).to.equal('failure')
    })

    it('passes other statuses through unchanged', function () {
      expect(compileStatus('timedout', 0)).to.equal('timedout')
      expect(compileStatus('validation-problems', 0)).to.equal(
        'validation-problems'
      )
    })
  })

  it('compile_project posts only the options supplied', async function () {
    client.post.resolves({ status: 'success', outputFiles: [] })
    client.get.resolves(diagnostics())
    await server.call('compile_project', { projectId: 'p1', draft: true })
    expect(client.post.firstCall.args[1]).to.equal('/projects/p1/compile')
    expect(client.post.firstCall.args[2]).to.deep.equal({ draft: true, diagnostics: true })
  })

  it('compile_project cleans the build first when clean is true', async function () {
    client.post.resolves({ status: 'success', outputFiles: [] })
    client.get.resolves(diagnostics())
    await server.call('compile_project', { projectId: 'p1', clean: true })
    expect(client.post.firstCall.args[1]).to.equal('/projects/p1/compile/clean')
    expect(client.post.secondCall.args[1]).to.equal('/projects/p1/compile')
  })

  it('compile_project still accepts the deprecated clearCache alias', async function () {
    client.post.resolves({ status: 'success', outputFiles: [] })
    client.get.resolves(diagnostics())
    await server.call('compile_project', { projectId: 'p1', clearCache: true })
    expect(client.post.firstCall.args[1]).to.equal('/projects/p1/compile/clean')
    expect(client.post.secondCall.args[1]).to.equal('/projects/p1/compile')
  })

  it('compile_project waits longer for the build than the default client deadline', async function () {
    client.post.resolves({ status: 'success', outputFiles: [] })
    client.get.resolves(diagnostics())
    await server.call('compile_project', { projectId: 'p1' })
    expect(client.post.firstCall.args[1]).to.equal('/projects/p1/compile')
    // web's own compile timeout is 180 s; the client must outlast it.
    expect(client.post.firstCall.args[3].timeoutMs).to.be.above(180000)
  })

  it('compile_project still honours clearCache when clean is explicitly false', async function () {
    client.post.resolves({ status: 'success', outputFiles: [] })
    client.get.resolves(diagnostics())
    await server.call('compile_project', { projectId: 'p1', clean: false, clearCache: true })
    expect(client.post.firstCall.args[1]).to.equal('/projects/p1/compile/clean')
  })

  it('refuses a path that climbs out of the project before calling web', async function () {
    const word = await server.call('get_word_count', { projectId: 'p1', path: '../secret.tex' })
    const sync = await server.call('sync_pdf_source', {
      projectId: 'p1',
      path: '/chapters/../../secret.tex',
      line: 3,
    })
    expect(word.isError).to.be.true
    expect(sync.isError).to.be.true
    expect(client.get.called).to.be.false
  })

  it('compile_project forwards rootDocPath for this run', async function () {
    client.post.resolves({ status: 'success', outputFiles: [] })
    client.get.resolves(diagnostics())
    await server.call('compile_project', {
      projectId: 'p1',
      rootDocPath: '/thesis/main.tex',
    })
    expect(client.post.firstCall.args[2]).to.deep.equal({
      rootDocPath: '/thesis/main.tex',
      diagnostics: true,
    })
  })

  it('compile_project reads the parsed log for every build', async function () {
    client.post.resolves(PDF_BUILD)
    client.get.resolves(diagnostics())
    await server.call('compile_project', { projectId: 'p1' })
    expect(client.get.firstCall.args[1]).to.equal(
      '/projects/p1/compile/diagnostics'
    )
    expect(client.get.firstCall.args[2]).to.deep.equal({
      buildId: 'b1',
      clsiserverid: 's1',
      rootDocPath: 'main.tex',
    })
  })

  it('compile_project reports success_with_errors loudly when the PDF has log errors', async function () {
    client.post.resolves(PDF_BUILD)
    client.get.resolves(
      diagnostics({
        counts: { ...NO_PROBLEMS, errors: 1 },
        errors: [
          {
            source: 'latex',
            file: 'chapters/intro.tex',
            line: 12,
            message: 'Undefined control sequence.',
            context: 'l.12 \\foo',
          },
        ],
      })
    )
    const result = await server.call('compile_project', { projectId: 'p1' })
    const out = result.structuredContent
    expect(out.ok).to.equal(true)
    expect(out.data.status).to.equal('success_with_errors')
    expect(out.data.clsiStatus).to.equal('success')
    expect(out.data.pdfProduced).to.equal(true)
    expect(out.data.errors[0]).to.include({
      path: '/chapters/intro.tex',
      line: 12,
    })
    expect(out.data.errors[0]).to.not.have.property('file')
    expect(out.summary).to.equal(
      'success_with_errors: 1 errors, 0 warnings, 0 bad boxes  build b1'
    )
    expect(out.warnings.join(' ')).to.match(/Do not trust the PDF/)
    expect(out.nextSteps).to.be.undefined
    const text = result.content[0].text
    expect(text).to.include('E Undefined control sequence. — /chapters/intro.tex:12')
    expect(text).to.include('    l.12 \\foo')
    expect(text).to.not.include('"source"')
    expect(text).to.not.include('projectId')
  })

  it('compile_project reports a failure with no PDF and its errors', async function () {
    client.post.resolves({
      status: 'failure',
      buildId: 'b2',
      clsiServerId: 's1',
      rootDocPath: 'main.tex',
      pdf: null,
      outputFiles: [{ path: 'output.log', build: 'b2' }],
    })
    client.get.resolves(
      diagnostics({
        buildId: 'b2',
        counts: { ...NO_PROBLEMS, errors: 1 },
        errors: [
          {
            source: 'latex',
            file: 'main.tex',
            line: 3,
            message: 'Missing $ inserted.',
          },
        ],
        advice: ['Fix the errors from the top of the list.'],
      })
    )
    const out = (await server.call('compile_project', { projectId: 'p1' }))
      .structuredContent
    expect(out.ok).to.equal(true)
    expect(out.data.status).to.equal('failure')
    expect(out.data.pdf).to.equal(null)
    expect(out.summary).to.match(/^failure: 1 errors, 0 warnings, 0 bad boxes  build b2$/)
    expect(out.data.advice).to.have.length(1)
  })

  it('compile_project retries a too-recently-compiled response', async function () {
    client.post
      .onFirstCall()
      .resolves({ status: 'too-recently-compiled', outputFiles: [] })
    client.post.onSecondCall().resolves(PDF_BUILD)
    client.get.resolves(diagnostics())
    const out = (await server.call('compile_project', { projectId: 'p1' }))
      .structuredContent
    expect(client.post.callCount).to.equal(2)
    expect(sleep.callCount).to.equal(1)
    expect(out.data.status).to.equal('success')
    expect(out.data.attempts).to.equal(2)
  })

  it('compile_project gives up after three throttled attempts and says so', async function () {
    client.post.resolves({ status: 'compile-in-progress', outputFiles: [] })
    const out = (await server.call('compile_project', { projectId: 'p1' }))
      .structuredContent
    expect(client.post.callCount).to.equal(3)
    expect(client.get.called).to.equal(false)
    expect(out.data.status).to.equal('compile-in-progress')
    expect(out.data.attempts).to.equal(3)
    expect(out.warnings.join(' ')).to.match(
      /Still "compile-in-progress" after 3 attempt/
    )
  })

  it('compile_project reports validation problems without a build', async function () {
    client.post.resolves({
      status: 'validation-problems',
      validationProblems: { mainFile: 'no main file specified' },
      outputFiles: [],
    })
    const out = (await server.call('compile_project', { projectId: 'p1' }))
      .structuredContent
    expect(out.data.status).to.equal('validation-problems')
    expect(out.data.validationProblems).to.deep.equal({
      mainFile: 'no main file specified',
    })
    expect(out.warnings.join(' ')).to.match(/rejected the project/)
    expect(client.get.called).to.equal(false)
  })

  it('compile_project still succeeds, but says the log is unknown, when the log cannot be read', async function () {
    client.post.resolves(PDF_BUILD)
    client.get.rejects(
      new OverleafApiError('upstream_error', 'could not reach', 502)
    )
    const out = (await server.call('compile_project', { projectId: 'p1' }))
      .structuredContent
    expect(out.ok).to.equal(true)
    expect(out.data.logChecked).to.equal(false)
    expect(out.data.status).to.equal('success')
    expect(out.warnings.join(' ')).to.match(/errors unknown/)
    expect(out.nextSteps.join(' ')).to.match(/get_compile_log raw=true/)
    expect(out.nextSteps.join(' ')).to.not.include('clsiServerId')
  })

  it('compile_project does not call a build clean when it wrote no output.log', async function () {
    client.post.resolves(PDF_BUILD)
    client.get.resolves(diagnostics({ logAvailable: false }))
    const out = (await server.call('compile_project', { projectId: 'p1' }))
      .structuredContent
    expect(out.data.logChecked).to.equal(false)
    expect(out.warnings.join(' ')).to.match(/wrote no output.log/)
  })

  it('compile_project lists undefined references and citations by key and asks for a rerun', async function () {
    client.post.resolves(PDF_BUILD)
    client.get.resolves(
      diagnostics({
        counts: {
          ...NO_PROBLEMS,
          warnings: 2,
          undefinedReferences: 1,
          undefinedCitations: 1,
        },
        warnings: [
          {
            source: 'latex',
            kind: 'undefined-reference',
            file: 'main.tex',
            line: 5,
            message: "LaTeX Warning: Reference `fig:x' on page 1 undefined",
          },
          {
            source: 'latex',
            kind: 'undefined-citation',
            file: 'main.tex',
            line: 6,
            message: "LaTeX Warning: Citation `smith' on page 1 undefined",
          },
        ],
        rerunNeeded: true,
      })
    )
    const result = await server.call('compile_project', { projectId: 'p1' })
    const out = result.structuredContent
    expect(result.content[0].text).to.include('undefined refs: fig:x')
    expect(result.content[0].text).to.include('undefined cites: smith')
    expect(out.warnings.join(' ')).to.match(/compile again/)
    expect(out.data.rerunNeeded).to.equal(true)
    expect(out.nextSteps.join(' ')).to.match(/compile_project again/)
  })

  it('compile_project preserves upstream_error from a failed compile', async function () {
    client.post.rejects(
      new OverleafApiError('upstream_error', 'clsi unavailable', 502)
    )
    const result = await server.call('compile_project', { projectId: 'p1' })
    expect(result.isError).to.equal(true)
    expect(result.structuredContent.error.code).to.equal(
      'upstream_error'
    )
  })

  it('get_compile_log requires a buildId and reads the parsed view by default', async function () {
    client.get.resolves(
      diagnostics({
        counts: { ...NO_PROBLEMS, errors: 1, warnings: 1 },
        errors: [
          { source: 'latex', file: 'main.tex', line: 4, message: 'Oops.' },
        ],
        warnings: [
          {
            source: 'latex',
            kind: 'rerun',
            file: 'main.tex',
            line: null,
            message: 'x',
          },
        ],
      })
    )
    const out = (
      await server.call('get_compile_log', { projectId: 'p1', buildId: 'b1' })
    ).structuredContent
    expect(client.get.firstCall.args[1]).to.equal(
      '/projects/p1/compile/diagnostics'
    )
    expect(out.data.raw).to.equal(false)
    expect(out.data.errors).to.have.length(1)
    expect(out.data.warnings).to.have.length(1)
    expect(out.summary).to.equal('1 errors, 1 warnings, 0 bad boxes')
    expect(out.data.buildId).to.equal('b1')
  })

  it('get_compile_log level=errors leaves out warnings and bad boxes', async function () {
    client.get.resolves(
      diagnostics({
        counts: { ...NO_PROBLEMS, errors: 1, warnings: 1, badBoxes: 2 },
        errors: [
          { source: 'latex', file: 'main.tex', line: 4, message: 'Oops.' },
        ],
        warnings: [
          {
            source: 'latex',
            kind: 'other',
            file: 'main.tex',
            line: 1,
            message: 'x',
          },
        ],
        badBoxes: [{ file: 'main.tex', line: 2, message: 'Overfull' }],
      })
    )
    const out = (
      await server.call('get_compile_log', {
        projectId: 'p1',
        buildId: 'b1',
        level: 'errors',
      })
    ).structuredContent
    expect(out.data).to.have.property('errors')
    expect(out.data).not.to.have.property('warnings')
    expect(out.data).not.to.have.property('badBoxes')
    expect(out.summary).to.match(/showing errors/)
  })

  it('get_compile_log forwards clsiServerId to the diagnostics read', async function () {
    client.get.resolves(diagnostics())
    await server.call('get_compile_log', {
      projectId: 'p1',
      buildId: 'b1',
      clsiServerId: 's9',
    })
    expect(client.get.firstCall.args[2]).to.include({
      buildId: 'b1',
      clsiserverid: 's9',
    })
  })

  it('get_compile_log raw view returns the requested window and points at the next one', async function () {
    client.get.resolves({
      log: 'line3\nline4',
      startLine: 3,
      endLine: 4,
      totalLines: 10,
      truncated: true,
    })
    const out = (
      await server.call('get_compile_log', {
        projectId: 'p1',
        buildId: 'b1',
        raw: true,
        startLine: 3,
        maxLines: 2,
      })
    ).structuredContent
    expect(client.get.firstCall.args[1]).to.equal('/projects/p1/compile/log')
    expect(client.get.firstCall.args[2]).to.include({
      buildId: 'b1',
      fromLine: 3,
      maxLines: 2,
    })
    expect(out.data.raw).to.equal(true)
    expect(out.data.log).to.equal('line3\nline4')
    expect(out.nextSteps.join(' ')).to.match(/get_compile_log buildId=b1 raw=true startLine=5/)
  })

  it('get_compile_pdf returns a summary block followed by the PDF resource', async function () {
    client.requestBinary.resolves({
      contentType: 'application/pdf',
      base64: 'JVBERi0=',
    })
    const result = await server.call('get_compile_pdf', {
      projectId: 'p1',
      buildId: 'b1',
    })
    expect(result.content[0].type).to.equal('text')
    const block = result.content[1]
    expect(block.type).to.equal('resource')
    expect(block.resource.mimeType).to.equal('application/pdf')
    expect(block.resource.blob).to.equal('JVBERi0=')
    expect(result.structuredContent.ok).to.equal(true)
    expect(result.structuredContent.data.sizeBytes).to.equal(5)
  })

  it('get_word_count reads the wordcount route for the whole project', async function () {
    client.get.resolves({ wordCount: { textWords: 1200 } })
    const out = (await server.call('get_word_count', { projectId: 'p1' }))
      .structuredContent
    expect(client.get.firstCall.args[1]).to.equal('/projects/p1/wordcount')
    expect(client.get.firstCall.args[2]).to.deep.equal({ file: undefined })
    expect(out.data.scope).to.equal('project')
    expect(out.data.textWords).to.equal(1200)
  })

  it('get_word_count can be limited to one file', async function () {
    client.get.resolves({
      wordCount: { textWords: 300, errors: 2, messages: 'unclosed group' },
    })
    const out = (
      await server.call('get_word_count', {
        projectId: 'p1',
        path: 'chapters/intro.tex',
      })
    ).structuredContent
    expect(client.get.firstCall.args[2]).to.deep.equal({
      file: '/chapters/intro.tex',
    })
    expect(out.data.scope).to.equal('/chapters/intro.tex')
    expect(out.warnings.join(' ')).to.match(/2 error\(s\): unclosed group/)
  })

  it('sync_pdf_source samples a whole page and returns line ranges per document', async function () {
    client.get.callsFake((token, route, query) =>
      Promise.resolve({
        synctex: {
          code:
            query.v < 400
              ? [{ file: 'main.tex', line: 10, column: 0 }]
              : [{ file: 'chapters/intro.tex', line: 40 + query.v / 10, column: 0 }],
        },
      })
    )
    const result = await server.call('sync_pdf_source', { projectId: 'p1', page: 2 })
    const out = result.structuredContent
    expect(client.get.callCount).to.equal(6)
    expect(client.get.firstCall.args[1]).to.equal('/projects/p1/synctex')
    expect(client.get.firstCall.args[2]).to.include({ page: 2, h: 300 })
    expect(out.data.direction).to.equal('pdf_to_source')
    expect(out.data.ranges).to.deep.equal([
      { path: '/main.tex', startLine: 10, endLine: 10 },
      { path: '/chapters/intro.tex', startLine: 91, endLine: 119 },
    ])
    expect(out.nextSteps[0]).to.include('read_file path=/main.tex')
    const { config } = server.tools.get('sync_pdf_source')
    const validated = await config.outputSchema['~standard'].validate(out)
    expect(validated.issues).to.be.undefined
  })

  it('sync_pdf_source looks up one spot when x and y are given', async function () {
    client.get.resolves({ synctex: { code: [{ file: 'main.tex', line: 3 }] } })
    await server.call('sync_pdf_source', { projectId: 'p1', page: 1, x: 100, y: 200 })
    expect(client.get.callCount).to.equal(1)
    expect(client.get.firstCall.args[2]).to.include({ page: 1, h: 100, v: 200 })
  })

  it('sync_pdf_source maps a source line to PDF pages', async function () {
    client.get.resolves({
      synctex: { pdf: [{ page: 3, h: 72, v: 400, width: 10, height: 10 }] },
    })
    const out = (
      await server.call('sync_pdf_source', {
        projectId: 'p1',
        path: '/chapters/intro.tex',
        line: 7,
      })
    ).structuredContent
    expect(client.get.firstCall.args[2]).to.include({
      file: 'chapters/intro.tex',
      line: 7,
    })
    expect(out.data).to.deep.equal({
      direction: 'source_to_pdf',
      pdfPositions: [{ page: 3, x: 72, y: 400 }],
    })
    expect(out.summary).to.include('page 3')
  })

  it('sync_pdf_source rejects a call with neither page nor path and line', async function () {
    const result = await server.call('sync_pdf_source', { projectId: 'p1', path: '/main.tex' })
    expect(result.isError).to.be.true
    expect(result.structuredContent.error.code).to.equal('validation_error')
    expect(client.get.called).to.be.false
  })

  describe('view_compiled_pdf_page', function () {
    // The shape web returns from GET /compile/pdf-page
    function pdfPage(overrides = {}) {
      return {
        buildId: 'b1',
        page: 2,
        pageCount: 5,
        pageSize: { width: 595, height: 842 },
        region: 'full',
        span: { top: 0, bottom: 100 },
        located: null,
        sourceMap: [
          { y: 5, path: 'main.tex', line: 40 },
          { y: 55, path: 'tables/results.tex', line: 12 },
        ],
        sourceRanges: [
          { path: 'main.tex', startLine: 40, endLine: 40 },
          { path: 'tables/results.tex', startLine: 12, endLine: 12 },
        ],
        badBoxes: [
          {
            path: 'tables/results.tex',
            line: 12,
            message: 'Overfull \\hbox (48.2pt too wide) in alignment at lines 12--20',
          },
        ],
        image: {
          mediaType: 'image/png',
          data: 'iVBORw0KGgo=',
          bytes: 8,
          dpi: 150,
          width: 1240,
          height: 1754,
        },
        ...overrides,
      }
    }

    it('returns the page as an image block after the envelope', async function () {
      client.get.resolves(pdfPage())
      const result = await server.call('view_compiled_pdf_page', {
        projectId: 'p1',
        buildId: 'b1',
        clsiServerId: 's1',
        page: 2,
      })
      expect(client.get.firstCall.args[1]).to.equal('/projects/p1/compile/pdf-page')
      expect(client.get.firstCall.args[2]).to.include({
        buildId: 'b1',
        clsiserverid: 's1',
        page: 2,
      })
      expect(result.content).to.have.lengthOf(2)
      expect(result.content[1]).to.deep.equal({
        type: 'image',
        data: 'iVBORw0KGgo=',
        mimeType: 'image/png',
      })
      const out = result.structuredContent
      expect(out.summary).to.include('Page 2/5 attached')
      expect(out.data.sourceMap[1]).to.deep.equal({
        y: 55,
        path: '/tables/results.tex',
        line: 12,
      })
      expect(out.data.badBoxes[0].path).to.equal('/tables/results.tex')
      expect(out.data.image).to.deep.equal({
        mimeType: 'image/png',
        width: 1240,
        height: 1754,
        dpi: 150,
        sizeBytes: 8,
      })
      // The base64 travels in the image block only, not twice
      expect(JSON.stringify(out)).to.not.include('iVBORw0KGgo=')
      expect(result.content[0].text).to.include(
        'source:\n5% /main.tex:40\n55% /tables/results.tex:12'
      )
      expect(result.content[0].text).to.include(
        'B /tables/results.tex:12 Overfull \\hbox (48.2pt too wide) in alignment at lines 12--20'
      )
      expect(result.content[0].text).to.not.include('iVBORw0KGgo=')
      expect(result.content[0].text).to.not.include('mimeType')
      expect(out.nextSteps[0]).to.include(
        'read_file path=/main.tex startLine=40 endLine=40'
      )
      const { config } = server.tools.get('view_compiled_pdf_page')
      const validated = await config.outputSchema['~standard'].validate(out)
      expect(validated.issues).to.be.undefined
    })

    it('opens the page where a source line is typeset', async function () {
      client.get.resolves(
        pdfPage({
          page: 3,
          located: { path: 'chapters/intro.tex', line: 7, y: 41 },
        })
      )
      const result = await server.call('view_compiled_pdf_page', {
          projectId: 'p1',
          buildId: 'b1',
          path: '/chapters/intro.tex',
          line: 7,
          region: 'middle',
        })
      const out = result.structuredContent
      expect(client.get.firstCall.args[2]).to.include({
        path: 'chapters/intro.tex',
        line: 7,
        region: 'middle',
      })
      expect(out.data.located).to.deep.equal({
        path: '/chapters/intro.tex',
        line: 7,
        y: 41,
      })
      expect(result.content[0].text).to.include('located /chapters/intro.tex:7 at 41%')
      expect(out.summary).to.not.include('41%')
    })

    it('lists the source span in text when the page has no sourceMap rows', async function () {
      client.get.resolves(
        pdfPage({
          page: 4,
          sourceMap: [],
          badBoxes: [],
          sourceRanges: [{ path: 'main.tex', startLine: 3, endLine: 5 }],
        })
      )
      const result = await server.call('view_compiled_pdf_page', {
        projectId: 'p1',
        buildId: 'b1',
        page: 4,
      })
      expect(result.content[0].text).to.include('source:\n/main.tex:3-5')
      expect(result.content[0].text).to.not.include('B ')
    })

    it('needs line with path, before calling web', async function () {
      const result = await server.call('view_compiled_pdf_page', {
        projectId: 'p1',
        buildId: 'b1',
        path: '/main.tex',
      })
      expect(result.isError).to.be.true
      expect(result.structuredContent.error.code).to.equal(
        'validation_error'
      )
      expect(client.get.called).to.be.false
    })

    it('passes the page count web reports for a page that does not exist', async function () {
      client.get.rejects(
        new OverleafApiError(
          'validation_error',
          'Page 9 does not exist: the PDF has 5 page(s).',
          400,
          {
            hint: 'Pass a page between 1 and details.pageCount.',
            details: { pageCount: 5 },
          }
        )
      )
      const result = await server.call('view_compiled_pdf_page', {
        projectId: 'p1',
        buildId: 'b1',
        page: 9,
      })
      const { error } = result.structuredContent
      expect(result.isError).to.be.true
      expect(error.details).to.deep.equal({ pageCount: 5 })
      expect(error.retryable).to.be.false
    })

    it('is the visual check compile_project suggests after a clean build', async function () {
      client.post.resolves(PDF_BUILD)
      client.get.resolves(diagnostics())
      const out = (await server.call('compile_project', { projectId: 'p1' }))
        .structuredContent
      expect(out.nextSteps.join(' ')).to.include(
        'view_compiled_pdf_page page=<n> to check layout'
      )
    })
  })
})

describe('PDF tool options', function () {
  let client, sleep

  const PAGE = {
    buildId: 'b1',
    page: 2,
    pageCount: 5,
    pageSize: { width: 595, height: 842 },
    region: 'full',
    span: { top: 0, bottom: 100 },
    located: null,
    sourceMap: [{ y: 55, path: 'tables/results.tex', line: 12 }],
    sourceRanges: [{ path: 'tables/results.tex', startLine: 12, endLine: 12 }],
    badBoxes: [],
    sourceStatus: 'mapped',
    image: {
      mediaType: 'image/png',
      data: 'iVBORw0KGgo=',
      bytes: 8,
      dpi: 150,
      width: 1240,
      height: 1754,
    },
  }

  function build() {
    const srv = fakeServer()
    registerCompileTools(srv, { client, staticToken: '', sleep })
    return srv
  }

  beforeEach(function () {
    client = { get: sinon.stub(), post: sinon.stub(), requestBinary: sinon.stub() }
    sleep = sinon.stub().resolves()
  })

  describe('compileStatus with a PDF', function () {
    it('reports a failing build that still wrote a PDF as success_with_errors', function () {
      expect(compileStatus('failure', 0, true)).to.equal('success_with_errors')
      expect(compileStatus('stopped-on-first-error', 1, true)).to.equal(
        'success_with_errors'
      )
    })

    it('keeps failure when no PDF was written', function () {
      expect(compileStatus('failure', 3, false)).to.equal('failure')
    })
  })

  it('compile_project reports success_with_errors, pdfProduced and buildId for a failing build with a PDF', async function () {
    const srv = build()
    client.post.resolves({
      status: 'failure',
      buildId: 'b9',
      clsiServerId: 's1',
      pdf: { path: 'output.pdf', build: 'b9' },
    })
    client.get.resolves(
      diagnostics({
        counts: { ...NO_PROBLEMS, errors: 1 },
        errors: [{ file: 'main.tex', line: 4, message: 'Undefined control sequence' }],
      })
    )
    const out = (await srv.call('compile_project', { projectId: 'p1' })).structuredContent
    expect(out.data.status).to.equal('success_with_errors')
    expect(out.data.clsiStatus).to.equal('failure')
    expect(out.data.pdfProduced).to.be.true
    expect(out.data.buildId).to.equal('b9')
  })

  it('compile_project reports pdfProduced false when no PDF was written', async function () {
    const srv = build()
    client.post.resolves({ status: 'failure', buildId: 'b9', clsiServerId: 's1' })
    client.get.resolves(diagnostics({ counts: { ...NO_PROBLEMS, errors: 1 } }))
    const out = (await srv.call('compile_project', { projectId: 'p1' })).structuredContent
    expect(out.data.status).to.equal('failure')
    expect(out.data.pdfProduced).to.be.false
  })

  describe('view_compiled_pdf_page inputs', function () {
    it('schema takes endLine, maxEdgePx, grayscale and split', function () {
      const srv = build()
      const schema = srv.tools.get('view_compiled_pdf_page').config.inputSchema
      expect(
        schema.safeParse({
          projectId: 'p1',
          buildId: 'b1',
          path: 'main.tex',
          line: 3,
          endLine: 9,
          maxEdgePx: 2000,
          grayscale: false,
          split: 'halves',
        }).success
      ).to.be.true
    })

    it('rejects maxEdgePx below 512, accepts any larger size, and rejects an unknown split', function () {
      const srv = build()
      const schema = srv.tools.get('view_compiled_pdf_page').config.inputSchema
      const base = { projectId: 'p1', buildId: 'b1' }
      expect(schema.safeParse({ ...base, maxEdgePx: 511 }).success).to.be.false
      expect(schema.safeParse({ ...base, maxEdgePx: 2577 }).success).to.be.true
      expect(schema.safeParse({ ...base, maxEdgePx: 6000 }).success).to.be.true
      expect(schema.safeParse({ ...base, split: 'thirds' }).success).to.be.false
    })

    it('defaults to a 1024 px grayscale page and sends it to web', async function () {
      client.get.resolves(PAGE)
      await build().call('view_compiled_pdf_page', {
        projectId: 'p1',
        buildId: 'b1',
        page: 2,
      })
      expect(client.get.firstCall.args[2]).to.include({
        maxEdgePx: 1024,
        grayscale: 'true',
        split: 'none',
      })
    })

    it('keeps colour when zooming on a block with endLine', async function () {
      client.get.resolves(PAGE)
      await build().call('view_compiled_pdf_page', {
        projectId: 'p1',
        buildId: 'b1',
        path: 'tables/results.tex',
        line: 12,
        endLine: 20,
      })
      expect(client.get.firstCall.args[2]).to.include({
        path: 'tables/results.tex',
        line: 12,
        endLine: 20,
        grayscale: 'false',
      })
    })

    it('lets the caller choose grayscale, size and split', async function () {
      client.get.resolves(PAGE)
      await build().call('view_compiled_pdf_page', {
        projectId: 'p1',
        buildId: 'b1',
        page: 2,
        maxEdgePx: 2400,
        grayscale: false,
        split: 'halves',
      })
      expect(client.get.firstCall.args[2]).to.include({
        maxEdgePx: 2400,
        grayscale: 'false',
        split: 'halves',
      })
    })

    it('refuses endLine without path and line', async function () {
      const result = await build().call('view_compiled_pdf_page', {
        projectId: 'p1',
        buildId: 'b1',
        page: 2,
        endLine: 9,
      })
      expect(result.isError).to.be.true
      expect(client.get.called).to.be.false
    })
  })

  it('returns every image of a split page as its own content block', async function () {
    client.get.resolves({
      ...PAGE,
      images: [
        { part: 'top', mimeType: 'image/png', data: 'AAA=', width: 900, height: 1568, dpi: 150, bytes: 3 },
        { part: 'bottom', mimeType: 'image/png', data: 'BBB=', width: 900, height: 1568, dpi: 150, bytes: 3 },
      ],
      image: undefined,
    })
    const result = await build().call('view_compiled_pdf_page', {
      projectId: 'p1',
      buildId: 'b1',
      page: 2,
      split: 'halves',
    })
    expect(result.content.filter(b => b.type === 'image')).to.deep.equal([
      { type: 'image', data: 'AAA=', mimeType: 'image/png' },
      { type: 'image', data: 'BBB=', mimeType: 'image/png' },
    ])
    expect(result.structuredContent.data.images.map(i => i.part)).to.deep.equal([
      'top',
      'bottom',
    ])
    expect(result.structuredContent.data.image.mimeType).to.equal('image/png')
    expect(result.structuredContent.summary).to.include('2 images')
  })

  it('says a stale PDF is out of date, in the summary, warnings and data', async function () {
    client.get.resolves({
      ...PAGE,
      stale: { reason: 'docs_changed', changed: ['tables/results.tex'] },
    })
    const out = (
      await build().call('view_compiled_pdf_page', {
        projectId: 'p1',
        buildId: 'b1',
        page: 2,
      })
    ).structuredContent
    expect(out.summary).to.include('OUT OF DATE (docs_changed)')
    expect(out.warnings.join(' ')).to.include('/tables/results.tex')
    expect(out.data.stale).to.deep.equal({
      reason: 'docs_changed',
      changed: ['/tables/results.tex'],
    })
  })

  it('surfaces a source note that is not mapped, and reports the status', async function () {
    client.get.resolves({
      ...PAGE,
      sourceStatus: 'no_synctex',
      sourceNote: 'The build has no SyncTeX file, so lines cannot be matched to the page.',
      sourceMap: [],
      sourceRanges: [],
    })
    const result = await build().call('view_compiled_pdf_page', {
      projectId: 'p1',
      buildId: 'b1',
      page: 2,
    })
    expect(result.structuredContent.data.sourceStatus).to.equal('no_synctex')
    expect(result.content[0].text).to.include(
      'sourceStatus: no_synctex. The build has no SyncTeX file, so lines cannot be matched to the page.'
    )
    expect(result.content[0].text).to.not.include('source:')
  })

  it('leaves defects and blocks out when the page has none', async function () {
    client.get.resolves({ ...PAGE, blocks: [], defects: [] })
    const out = (
      await build().call('view_compiled_pdf_page', {
        projectId: 'p1',
        buildId: 'b1',
        page: 2,
      })
    ).structuredContent
    expect(out.data).to.not.have.property('blocks')
    expect(out.data).to.not.have.property('defects')
  })

  it('passes blocks and defects through', async function () {
    client.get.resolves({
      ...PAGE,
      blocks: [{ id: 'B1', page: 2, path: 'main.tex', line: 3 }],
      defects: [{ id: 'D1', category: 'overflow', severity: 'error', evidence: 'x' }],
    })
    const out = (
      await build().call(
        'view_compiled_pdf_page',
        { projectId: 'p1', buildId: 'b1', page: 2, labels: true }
      )
    ).structuredContent
    expect(out.data.blocks[0].path).to.equal('/main.tex')
    expect(out.data.defects[0].id).to.equal('D1')
    expect(client.get.firstCall.args[2]).to.include({ labels: 'true' })
  })

  describe('view_compiled_pdf_overview', function () {
    const OVERVIEW = {
      buildId: 'b1',
      fromPage: 1,
      toPage: 2,
      pageCount: 5,
      paper: { width: 595, height: 842, name: 'A4', orientation: 'portrait' },
      mixedSizes: false,
      fonts: { total: 3, notEmbedded: [], type3: [] },
      columns: 1,
      pages: [
        {
          page: 1,
          source: [{ path: 'main.tex', startLine: 1, endLine: 20 }],
          blank: false,
          endsAt: 90,
          gaps: [],
          overflow: [],
          badBoxes: 0,
          worstBadBox: null,
          unresolved: { refs: 0, cites: 0 },
        },
        {
          page: 2,
          source: [{ path: 'tables/results.tex', startLine: 3, endLine: 9 }],
          blank: false,
          endsAt: 50,
          gaps: [],
          overflow: [{ side: 'right' }],
          badBoxes: 1,
          worstBadBox: null,
          unresolved: { refs: 2, cites: 0 },
        },
      ],
      image: {
        mediaType: 'image/png',
        data: 'CCC=',
        bytes: 3,
        dpi: 100,
        width: 1200,
        height: 900,
      },
    }

    it('calls the overview route and returns the thumbnail sheet', async function () {
      client.get.resolves(OVERVIEW)
      const result = await build().call(
        'view_compiled_pdf_overview',
        { projectId: 'p1', buildId: 'b1', clsiServerId: 's1', fromPage: 1, toPage: 2 }
      )
      expect(client.get.firstCall.args[1]).to.equal(
        '/projects/p1/compile/pdf-overview'
      )
      expect(client.get.firstCall.args[2]).to.include({
        buildId: 'b1',
        clsiserverid: 's1',
        fromPage: 1,
        toPage: 2,
      })
      expect(result.content[1]).to.deep.equal({
        type: 'image',
        data: 'CCC=',
        mimeType: 'image/png',
      })
      const out = result.structuredContent
      expect(out.summary).to.include('Pages 1-2/5 attached')
      expect(out.data.pages[1].source[0].path).to.equal('/tables/results.tex')
      expect(result.content[0].text).to.equal(
        [
          'Pages 1-2/5 attached',
          'paper A4 portrait',
          'p1  /main.tex:1-20  ends at 90%',
          'p2  /tables/results.tex:3-9  overflow right, badBoxes 1, ?? 2, ends at 50%',
          '→ view_compiled_pdf_page page=<a page above> buildId=b1 to see the problem at full size',
        ].join('\n')
      )
      expect(out.warnings).to.be.undefined
      const { config } = build().tools.get(
        'view_compiled_pdf_overview'
      )
      const validated = await config.outputSchema['~standard'].validate(out)
      expect(validated.issues).to.be.undefined
    })

    it('says the overview is out of date when it is stale', async function () {
      client.get.resolves({ ...OVERVIEW, stale: { reason: 'root_changed', changed: [] } })
      const out = (
        await build().call(
          'view_compiled_pdf_overview',
          { projectId: 'p1', buildId: 'b1' }
        )
      ).structuredContent
      expect(out.summary).to.include('OUT OF DATE (root_changed)')
      expect(out.data.stale.reason).to.equal('root_changed')
    })

    it('renders the worst bad box and a non-mapped source status without JSON', async function () {
      const page = {
        ...OVERVIEW.pages[1],
        worstBadBox: {
          path: 'tables/results.tex',
          line: 7,
          message: 'Overfull \\hbox (6.1pt too wide)',
        },
        sourceStatus: 'partial',
        sourceNote: 'Only some heights are mapped.',
      }
      client.get.resolves({ ...OVERVIEW, pages: [OVERVIEW.pages[0], page] })
      const result = await build().call('view_compiled_pdf_overview', {
        projectId: 'p1',
        buildId: 'b1',
      })
      const text = result.content[0].text
      expect(text).to.include(
        'p2  /tables/results.tex:3-9  overflow right, badBoxes 1, ?? 2, ends at 50%, worst /tables/results.tex:7 Overfull \\hbox (6.1pt too wide), sourceStatus partial'
      )
      expect(text).not.to.include('sourceNote')
      expect(text).not.to.include('{')
    })
  })

  describe('search_compiled_pdf', function () {
    const FOUND = {
      query: 'Figure 3',
      fromPage: 1,
      toPage: 5,
      pageCount: 5,
      matchCount: 1,
      pages: [2],
      matches: [
        {
          page: 2,
          y: 40,
          text: 'Figure 3',
          context: 'as shown in Figure 3 below',
          path: 'main.tex',
          line: 17,
        },
      ],
      truncated: false,
    }

    it('calls the search route and reports each match with its source', async function () {
      client.get.resolves(FOUND)
      const result = await build().call(
        'search_compiled_pdf',
        { projectId: 'p1', buildId: 'b1', query: 'Figure 3', toPage: 5 }
      )
      expect(client.get.firstCall.args[1]).to.equal('/projects/p1/compile/pdf-search')
      expect(client.get.firstCall.args[2]).to.include({ query: 'Figure 3', toPage: 5 })
      const out = result.structuredContent
      expect(out.summary).to.include('1 matches on pages 2')
      expect(out.data.matches[0].path).to.equal('/main.tex')
      expect(out.nextSteps[0]).to.include('page=2')
    })

    it('says so when nothing matches', async function () {
      client.get.resolves({ ...FOUND, matchCount: 0, matches: [], pages: [] })
      const out = (
        await build().call('search_compiled_pdf', {
          projectId: 'p1',
          buildId: 'b1',
          query: 'Nope',
        })
      ).structuredContent
      expect(out.summary).to.include('No matches')
      expect(out.nextSteps).to.be.undefined
    })
  })

  describe('resolve_pdf_block', function () {
    it('turns a block id into its source lines', async function () {
      client.get.resolves({ path: 'tables/results.tex', line: 12, endLine: 20 })
      const out = (
        await build().call('resolve_pdf_block', {
          projectId: 'p1',
          buildId: 'b1',
          page: 2,
          blockId: 'B3',
        })
      ).structuredContent
      expect(client.get.firstCall.args[1]).to.equal('/projects/p1/compile/pdf-block')
      expect(client.get.firstCall.args[2]).to.include({ page: 2, blockId: 'B3' })
      expect(out.data).to.deep.equal({
        blockId: 'B3',
        page: 2,
        path: '/tables/results.tex',
        line: 12,
        endLine: 20,
      })
    })

    it('rejects a block id that is not B followed by digits', function () {
      const schema = build().tools.get(
        'resolve_pdf_block'
      ).config.inputSchema
      expect(
        schema.safeParse({ projectId: 'p1', buildId: 'b1', page: 1, blockId: 'X1' }).success
      ).to.be.false
    })
  })

  describe('diff_compiled_pdf', function () {
    const DIFF = {
      ok: true,
      changed: true,
      beforeBuildId: 'b0',
      afterBuildId: 'b1',
      dpi: 100,
      pageCount: { before: 3, after: 3 },
      pairing: 'index',
      pages: [
        {
          page: 2,
          status: 'changed',
          regions: [{ kind: 'changed', x: 0.1, y: 0.4, w: 0.5, h: 0.1 }],
          sourceRanges: [{ path: 'main.tex', startLine: 9, endLine: 12 }],
        },
      ],
      unchangedPages: [1, 3],
      summary: ['Page 2 changed: changed 40%-50% of page height.'],
      image: { mimeType: 'image/png', data: 'DDD=', width: 800, height: 1100, pages: [2] },
    }

    it('compares the build with its predecessor by default and boxes the changes in one image', async function () {
      client.get.resolves(DIFF)
      const result = await build().call(
        'diff_compiled_pdf',
        { projectId: 'p1', buildId: 'b1', clsiServerId: 's1' }
      )
      expect(client.get.firstCall.args[1]).to.equal('/projects/p1/compile/pdf-diff')
      expect(client.get.firstCall.args[2]).to.include({ buildId: 'b1', clsiserverid: 's1' })
      expect(result.content[1]).to.deep.equal({
        type: 'image',
        data: 'DDD=',
        mimeType: 'image/png',
      })
      const out = result.structuredContent
      expect(out.summary).to.include('1 of 3 page(s) changed')
      expect(out.data.pages[0]).to.include({ page: 2 })
      expect(out.data.unchangedPages).to.deep.equal([1, 3])
      expect(out.nextSteps[0]).to.include('page=2')
      const { config } = build().tools.get(
        'diff_compiled_pdf'
      )
      const validated = await config.outputSchema['~standard'].validate(out)
      expect(validated.issues).to.be.undefined
    })

    it('reports identical builds as unchanged, with no image and no next step', async function () {
      client.get.resolves({
        ...DIFF,
        changed: false,
        pages: [],
        unchangedPages: [1, 2, 3],
        summary: [],
        image: null,
      })
      const result = await build().call(
        'diff_compiled_pdf',
        { projectId: 'p1', buildId: 'b1', beforeBuildId: 'b0' }
      )
      expect(client.get.firstCall.args[2]).to.include({ beforeBuildId: 'b0' })
      expect(result.content).to.have.lengthOf(1)
      expect(result.structuredContent.summary).to.include('No page changed')
      expect(result.structuredContent.nextSteps).to.be.undefined
    })
  })
})

describe('compact text', function () {
  let client, sleep, server

  beforeEach(function () {
    client = { get: sinon.stub(), post: sinon.stub(), requestBinary: sinon.stub() }
    sleep = sinon.stub().resolves()
    server = fakeServer()
    registerCompileTools(server, { client, staticToken: '', sleep })
  })

  it('takes the diagnostics from the compile response, with no second read', async function () {
    client.post.resolves({
      ...PDF_BUILD,
      diagnostics: diagnostics({
        counts: { ...NO_PROBLEMS, errors: 1 },
        errors: [{ source: 'latex', file: 'main.tex', line: 2, message: 'Oops' }],
      }),
    })
    const result = await server.call('compile_project', { projectId: 'p1' })
    expect(client.get.called).to.be.false
    expect(result.structuredContent.data.errors[0]).to.include({ path: '/main.tex', line: 2 })
    expect(client.post.firstCall.args[2]).to.deep.equal({ diagnostics: true })
  })

  it('reports the diagnosticsError as the log problem when the fallback read also fails', async function () {
    client.post.resolves({ ...PDF_BUILD, diagnosticsError: 'log is too large' })
    client.get.rejects(new OverleafApiError('upstream_error', 'gone', 502))
    const out = (await server.call('compile_project', { projectId: 'p1' })).structuredContent
    expect(out.data.logChecked).to.equal(false)
    expect(out.warnings.join(' ')).to.include('log is too large')
  })

  it('groups compile errors by message with every place they occur, and excerpts the first three', async function () {
    client.post.resolves(PDF_BUILD)
    client.get.resolves(
      diagnostics({
        counts: { ...NO_PROBLEMS, errors: 3 },
        errors: [
          { source: 'latex', file: 'main.tex', line: 3, message: 'Undefined control sequence.', context: 'l.3 \\foo\nmore context\nthird line' },
          { source: 'latex', file: 'chapters/a.tex', line: 7, message: 'Undefined control sequence.', context: 'l.7 \\bar' },
          { source: 'latex', file: null, line: null, message: 'File missing.' },
        ],
      })
    )
    const result = await server.call('compile_project', { projectId: 'p1' })
    const text = result.content[0].text
    expect(text).to.include('E Undefined control sequence. — /main.tex:3; /chapters/a.tex:7')
    expect(text).to.include('    l.3 \\foo\n    more context')
    expect(text).to.not.include('third line')
    expect(text).to.include('E File missing. — (TeX system file)')
    expect(text).to.not.include('"message"')
    expect(text).to.not.include('clsiServerId')
    expect(text.split('\n')[0]).to.equal(
      'success_with_errors: 3 errors, 0 warnings, 0 bad boxes  build b1'
    )
  })

  it('caps error groups at 30 and says how many more there are', async function () {
    client.post.resolves(PDF_BUILD)
    client.get.resolves(
      diagnostics({
        counts: { ...NO_PROBLEMS, errors: 35 },
        errors: Array.from({ length: 35 }, (_, i) => ({
          source: 'latex',
          file: 'main.tex',
          line: i + 1,
          message: `Error ${i}`,
        })),
      })
    )
    const text = (await server.call('compile_project', { projectId: 'p1' })).content[0].text
    expect(text).to.include('E Error 29 — /main.tex:30')
    expect(text).to.not.include('E Error 30')
    expect(text).to.include('… 5 more error groups')
  })

  it('summarises log warnings: undefined keys on one line each, other kinds counted', async function () {
    client.post.resolves(PDF_BUILD)
    client.get.resolves(
      diagnostics({
        counts: { ...NO_PROBLEMS, warnings: 5, undefinedReferences: 3 },
        warnings: [
          { source: 'latex', kind: 'undefined-reference', file: 'main.tex', line: 1, message: "Reference `fig:a' undefined" },
          { source: 'latex', kind: 'undefined-reference', file: 'main.tex', line: 2, message: "Reference `fig:b' undefined" },
          { source: 'latex', kind: 'undefined-reference', file: 'main.tex', line: 3, message: "Reference `fig:a' undefined" },
          { source: 'latex', kind: 'rerun', file: 'main.tex', line: null, message: 'Label(s) may have changed' },
          { source: 'latex', kind: 'rerun', file: 'main.tex', line: null, message: 'Second rerun notice' },
        ],
      })
    )
    const text = (await server.call('compile_project', { projectId: 'p1' })).content[0].text
    expect(text).to.include(
      'undefined refs: fig:a (/main.tex:1, /main.tex:3), fig:b (/main.tex:2)'
    )
    expect(text).to.include('W rerun ×2: Label(s) may have changed')
    expect(text).to.not.include('Second rerun notice')
  })

  it('drops advice the text already says, and keeps the rest with an advice prefix', async function () {
    client.post.resolves({ ...PDF_BUILD, status: 'failure' })
    client.get.resolves(
      diagnostics({
        counts: { ...NO_PROBLEMS, errors: 1, undefinedReferences: 1 },
        errors: [{ source: 'latex', file: 'main.tex', line: 3, message: 'Missing $' }],
        advice: [
          'Fix the errors from the top of the list. Later errors are often caused by the first one.',
          'Undefined references: check that each \\ref target has a matching \\label.',
          'LaTeX stopped on a fatal error and produced no PDF. Fix the first entry in errors.',
        ],
      })
    )
    const text = (await server.call('compile_project', { projectId: 'p1' })).content[0].text
    expect(text).to.include(
      'advice: LaTeX stopped on a fatal error and produced no PDF. Fix the first entry in errors.'
    )
    expect(text).to.not.include('advice: Fix the errors from the top')
    expect(text).to.not.include('advice: Undefined references')
  })

  it('prints the validation problems as compact JSON in the text', async function () {
    client.post.resolves({
      status: 'validation-problems',
      validationProblems: { mainFile: 'no main file specified' },
      outputFiles: [],
    })
    const result = await server.call('compile_project', { projectId: 'p1' })
    expect(result.content[0].text.split('\n')[0]).to.equal(
      'validation-problems: no build, Overleaf rejected the project'
    )
    expect(result.content[0].text).to.include('validation: {"mainFile":"no main file specified"}')
  })

  it('reads a window of the raw log verbatim, defaulting to the last 200 lines', async function () {
    client.get.resolves({
      log: 'alpha\nBeta line\ngamma',
      startLine: 201,
      endLine: 203,
      totalLines: 1240,
      truncated: true,
    })
    const result = await server.call('get_compile_log', { projectId: 'p1', raw: true })
    expect(client.get.firstCall.args[2]).to.include({ maxLines: 200 })
    expect(client.get.firstCall.args[2].buildId).to.be.undefined
    expect(result.content[0].text).to.equal(
      'log lines 201-203/1240\nalpha\nBeta line\ngamma\n→ get_compile_log raw=true startLine=204'
    )
    expect(result.structuredContent.data.log).to.equal('alpha\nBeta line\ngamma')
  })

  it('filters the raw window with grep, numbering each matching line', async function () {
    client.get.resolves({
      log: 'alpha\nBeta line\ngamma beta',
      startLine: 201,
      endLine: 203,
      totalLines: 1240,
    })
    const result = await server.call('get_compile_log', {
      projectId: 'p1',
      raw: true,
      grep: 'BETA',
    })
    expect(result.content[0].text).to.equal(
      'log lines 201-203/1240, 2 match(es)\n202: Beta line\n203: gamma beta\n→ get_compile_log raw=true startLine=204'
    )
    expect(result.content[0].text).to.not.include('alpha')
  })

  it('renders the parsed log with bad boxes capped at 20 lines', async function () {
    client.get.resolves(
      diagnostics({
        counts: { ...NO_PROBLEMS, badBoxes: 25 },
        badBoxes: Array.from({ length: 25 }, (_, i) => ({
          file: 'main.tex',
          line: i + 1,
          message: `Overfull ${i}`,
        })),
      })
    )
    const result = await server.call('get_compile_log', { projectId: 'p1' })
    const lines = result.content[0].text.split('\n')
    expect(lines[0]).to.equal('0 errors, 0 warnings, 25 bad boxes')
    expect(lines[1]).to.equal('B /main.tex:1 Overfull 0')
    expect(lines).to.include('… 5 more bad boxes')
    expect(lines.filter(l => l.startsWith('B ')).length).to.equal(20)
  })

  it('reads the latest build when no buildId is given, and reports the build it used', async function () {
    client.get.resolves(diagnostics({ buildId: 'b7' }))
    const out = (await server.call('get_compile_log', { projectId: 'p1' })).structuredContent
    expect(client.get.firstCall.args[2].buildId).to.be.undefined
    expect(out.data.buildId).to.equal('b7')
  })

  it('compacts the word count into one line of body, heading and maths counts', async function () {
    client.get.resolves({
      wordCount: { textWords: 1200, headWords: 30, outside: 0, elements: 4, mathInline: 0, mathDisplay: 12 },
    })
    const result = await server.call('get_word_count', { projectId: 'p1' })
    expect(result.content[0].text).to.equal(
      'project: 1200 words\nbody 1200, headings 30, captions/floats 4, display math 12'
    )
  })

  it('writes the source ranges of a page as path:start-end lines, without the raw source lines', async function () {
    client.get.resolves({
      synctex: {
        code: [
          { file: 'main.tex', line: 10 },
          { file: 'main.tex', line: 11 },
          { file: 'chapters/intro.tex', line: 40 },
        ],
      },
    })
    const result = await server.call('sync_pdf_source', { projectId: 'p1', page: 2 })
    expect(result.content[0].text).to.equal(
      'Page 2: 2 source span(s)\n/main.tex:10-11\n/chapters/intro.tex:40\n→ read_file path=/main.tex startLine=10 endLine=11'
    )
    expect(result.structuredContent.data.sourceLines).to.have.length(3)
  })

  it('writes the PDF positions of a source line as rounded page, x and y', async function () {
    client.get.resolves({
      synctex: { pdf: [{ page: 3, h: 72.4, v: 400.6 }] },
    })
    const result = await server.call('sync_pdf_source', {
      projectId: 'p1',
      path: '/chapters/intro.tex',
      line: 7,
    })
    expect(result.content[0].text).to.equal(
      '/chapters/intro.tex line 7 is on page 3\npage 3 x72 y401'
    )
  })

  describe('view_compiled_pdf_page text', function () {
    const PAGE = {
      buildId: 'b1',
      page: 2,
      pageCount: 5,
      pageSize: { width: 595, height: 842 },
      region: 'full',
      span: { top: 0, bottom: 100 },
      located: null,
      sourceMap: [
        { y: 10, path: 'main.tex', line: 3 },
        { y: 12, path: 'main.tex', line: 5 },
        { y: 40, path: 'a.tex', line: 1 },
      ],
      sourceRanges: [{ path: 'main.tex', startLine: 3, endLine: 5 }],
      badBoxes: [],
      sourceStatus: 'mapped',
      image: { mediaType: 'image/png', data: 'AAA=', bytes: 3, dpi: 150, width: 1240, height: 1754 },
    }

    it('collapses consecutive source rows in one file and lists blocks and defects one per line', async function () {
      client.get.resolves({
        ...PAGE,
        blocks: [{ id: 'B1', page: 2, path: 'main.tex', line: 3, endLine: 9 }],
        defects: [
          {
            id: 'D1',
            category: 'overflow',
            severity: 'error',
            evidence: 'Table runs 12 pt past the margin',
            path: 'tables/r.tex',
            line: 12,
            bannedFixes: ['\\resizebox'],
          },
        ],
      })
      const result = await server.call('view_compiled_pdf_page', {
        projectId: 'p1',
        buildId: 'b1',
        page: 2,
      })
      const text = result.content[0].text
      expect(text).to.include('Page 2/5 attached')
      expect(text).to.include('source:\n10-12% /main.tex:3-5\n40% /a.tex:1')
      expect(text).to.include('B1 /main.tex:3-9')
      expect(text).to.include('D1 overflow error /tables/r.tex:12 Table runs 12 pt past the margin')
      expect(text).to.include('    banned: \\resizebox')
      expect(text).to.not.include('null')
      expect(text).to.not.include('mimeType')
      expect(text).to.not.include('AAA=')
    })

    it('caps the source rows at 12', async function () {
      client.get.resolves({
        ...PAGE,
        sourceMap: Array.from({ length: 14 }, (_, i) => ({
          y: i * 5,
          path: `f${i}.tex`,
          line: 1,
        })),
      })
      const text = (
        await server.call('view_compiled_pdf_page', { projectId: 'p1', buildId: 'b1', page: 2 })
      ).content[0].text
      expect(text).to.include('… 2 more')
      expect(text.split('\n').filter(l => l.includes('.tex:1')).length).to.equal(12)
    })
  })

  it('writes the diff summary and the unchanged pages as runs, with no image metadata', async function () {
    client.get.resolves({
      changed: true,
      beforeBuildId: 'b0',
      afterBuildId: 'b1',
      pageCount: { before: 6, after: 6 },
      pages: [{ page: 2, status: 'changed', regions: [], sourceRanges: [] }],
      unchangedPages: [1, 3, 4, 5, 6],
      summary: ['Page 2 changed: changed 40%-50% of page height.'],
      image: { mimeType: 'image/png', data: 'DDD=', width: 800, height: 1100, dpi: 100, pages: [2] },
    })
    const result = await server.call('diff_compiled_pdf', { projectId: 'p1' })
    expect(result.content[0].text).to.equal(
      [
        '1 of 6 page(s) changed',
        'Page 2 changed: changed 40%-50% of page height.',
        'unchanged: 1,3-6',
        '→ view_compiled_pdf_page page=2 to see the change at full size',
      ].join('\n')
    )
  })

  it('writes one line per search match, with its page, height, source and context', async function () {
    client.get.resolves({
      query: 'Figure 3',
      pageCount: 5,
      matchCount: 2,
      pages: [2, 4],
      matches: [
        { page: 2, y: 40.4, text: 'Figure 3', context: 'as shown in Figure 3 below', path: 'main.tex', line: 17 },
        { page: 4, y: null, text: 'Figure 3', path: null, line: null },
      ],
      truncated: false,
    })
    const result = await server.call('search_compiled_pdf', {
      projectId: 'p1',
      buildId: 'b1',
      query: 'Figure 3',
    })
    expect(result.content[0].text.split('\n')).to.deep.equal([
      '2 matches on pages 2,4',
      'p2 40% /main.tex:17  Figure 3 | as shown in Figure 3 below',
      'p4  Figure 3',
      '→ view_compiled_pdf_page page=2 buildId=b1 to see the match',
    ])
  })

  it('keeps the PDF download to one summary line', async function () {
    client.requestBinary.resolves({ contentType: 'application/pdf', base64: 'JVBERi0=' })
    const result = await server.call('get_compile_pdf', { projectId: 'p1' })
    expect(result.content[0].text).to.equal('PDF: 5 bytes')
    expect(result.structuredContent.data.buildId).to.be.null
  })

  it('names the block location in one summary line', async function () {
    client.get.resolves({ path: 'tables/results.tex', line: 12, endLine: 20 })
    const result = await server.call('resolve_pdf_block', {
      projectId: 'p1',
      page: 2,
      blockId: 'B3',
    })
    expect(result.content[0].text.split('\n')[0]).to.equal(
      'typeset at /tables/results.tex:12-20'
    )
    expect(result.content[0].text).to.not.include('B3')
  })
})
