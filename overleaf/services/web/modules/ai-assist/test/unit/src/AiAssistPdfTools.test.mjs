import { describe, it } from 'vitest'
import { expect } from 'chai'
import { AiAssistTools } from '../../../app/src/AiAssistTools.mjs'
import { PdfPageError, PDF_PAGE_ERRORS } from '../../../../../app/src/Features/PdfInspection/PdfPageInspector.mjs'

const PROJECT = '507f1f77bcf86cd799439012'
const USER = '507f1f77bcf86cd799439011'
const BUILD = '19a1b2c3d4e5f6-0a1b2c3d4e5f'

function makeTools() {
  return new AiAssistTools({
    settings: {},
    // Nothing is fetched by these tests; the project reads fail quietly
    projectGetter: { getProject: async () => null },
    docUpdater: {},
    entityHandler: {},
    pdfVisualDiff: { diff: async () => ({ ok: false }), remember: async () => ({ ok: true }) },
  })
}

function names(tools) {
  return tools.getToolSpecs().map(spec => spec.name)
}

describe('PDF tools', function () {
  it('offers every PDF tool', function () {
    expect(names(makeTools())).to.include.members([
      'view_compiled_pdf_page',
      'view_compiled_pdf_overview',
      'search_compiled_pdf',
      'resolve_pdf_block',
      'diff_compiled_pdf',
      'inspect_compiled_style',
    ])
  })

  it('offers a labels argument on the page view', function () {
    const spec = makeTools()
      .getToolSpecs()
      .find(tool => tool.name === 'view_compiled_pdf_page')
    expect(spec.parameters.properties).to.have.property('labels')
  })

  it('resolves a block only from a build the model has viewed', async function () {
    const tools = makeTools()
    const none = await tools.execute(
      'resolve_pdf_block',
      { page: 1, block: 'B1' },
      { projectId: PROJECT, userId: USER }
    )
    expect(none.error).to.include('compile_project first')

    await tools._compileToolResult(
      PROJECT,
      { status: 'success', errors: [], warnings: [], buildId: BUILD },
      false
    )
    const unseen = await tools.execute(
      'resolve_pdf_block',
      { page: 1, block: 'B1' },
      { projectId: PROJECT, userId: USER }
    )
    expect(unseen.error).to.include('View that page first')
  })

  it('reports a build with errors that still wrote a PDF as success_with_errors', async function () {
    const tools = makeTools()
    const result = await tools._compileToolResult(
      PROJECT,
      {
        status: 'failure',
        errors: [{ file: 'main.tex', line: 3, message: 'Undefined control sequence.' }],
        warnings: [],
        buildId: BUILD,
      },
      false
    )
    expect(result.status).to.equal('success_with_errors')
    expect(result.pdfProduced).to.equal(true)
    expect(result.buildId).to.equal(BUILD)
  })

  it('reports a failed build with no PDF as failure, pdfProduced false', async function () {
    const tools = makeTools()
    const result = await tools._compileToolResult(
      PROJECT,
      {
        status: 'failure',
        errors: [{ file: 'main.tex', line: 3, message: 'Emergency stop.' }],
        warnings: [],
      },
      false
    )
    expect(result.status).to.equal('failure')
    expect(result.pdfProduced).to.equal(false)
    expect(result.buildId).to.equal(null)
  })

  it('runs inspect_compiled_style and returns style', async function () {
    const mockInspect = async () => ({
      style: {
        paper: 'a4',
        class: 'article 10pt',
        pages: 3,
        area: { w: 400, h: 600, cols: 1 },
      },
    })
    const tools = new AiAssistTools({
      settings: {},
      pdfStyleInspector: { inspect: mockInspect },
      projectGetter: { getProject: async () => null },
      docUpdater: {},
      entityHandler: {},
    })
    tools.lastCompileResult.set(PROJECT, { buildId: BUILD })
    const result = await tools.execute(
      'inspect_compiled_style',
      {},
      { projectId: PROJECT, userId: USER }
    )
    expect(result.status).to.equal('ok')
    expect(result.style?.paper).to.equal('a4')
  })
})

describe('highlight_in_pdf', function () {
  function makeHighlightTools({ highlight } = {}) {
    return new AiAssistTools({
      settings: { aiAssist: {} },
      projectGetter: { getProject: async () => null },
      docUpdater: {},
      entityHandler: {},
      pdfPageInspector: {
        inspect: async () => ({}),
        overview: async () => ({}),
        search: async () => ({}),
        highlight: highlight ?? (async () => []),
      },
    })
  }

  it('is offered with the other PDF tools, last', function () {
    const specs = makeHighlightTools().getToolSpecs()
    expect(specs[specs.length - 1].name).to.equal('highlight_in_pdf')
  })

  it('highlights the boxes a source line is typeset in, on every page it reaches', async function () {
    const calls = []
    const tools = makeHighlightTools({
      highlight: async options => {
        calls.push(options)
        return [
          { page: 2, h: 72, v: 300, width: 200, height: 12 },
          { page: 3, h: 72, v: 40, width: 180, height: 12 },
        ]
      },
    })
    await tools._compileToolResult(
      PROJECT,
      { status: 'success', errors: [], warnings: [], buildId: BUILD },
      false
    )
    const result = await tools.execute(
      'highlight_in_pdf',
      { path: 'sections/intro.tex', line: 12, endLine: 14 },
      { projectId: PROJECT, userId: USER }
    )
    expect(calls[0]).to.include({
      buildId: BUILD,
      path: 'sections/intro.tex',
      line: 12,
      endLine: 14,
    })
    expect(result.status).to.equal('highlighted')
    expect(result.count).to.equal(2)
    expect(result.pages).to.deep.equal([2, 3])
    expect(result.highlights).to.have.length(2)
  })

  it('defaults endLine to line', async function () {
    let seen = null
    const tools = makeHighlightTools({
      highlight: async options => {
        seen = options
        return [{ page: 1, h: 0, v: 0, width: 1, height: 1 }]
      },
    })
    await tools._compileToolResult(
      PROJECT,
      { status: 'success', errors: [], warnings: [], buildId: BUILD },
      false
    )
    await tools.execute(
      'highlight_in_pdf',
      { path: '/main.tex', line: '7' },
      { projectId: PROJECT, userId: USER }
    )
    expect(seen).to.include({ path: 'main.tex', line: 7, endLine: 7 })
  })

  it('passes a line that is not typeset as the inspector reports it', async function () {
    const tools = makeHighlightTools({
      highlight: async () => {
        throw new PdfPageError(
          PDF_PAGE_ERRORS.LINE_NOT_IN_PDF,
          'main.tex line 1 is not typeset in this PDF.'
        )
      },
    })
    await tools._compileToolResult(
      PROJECT,
      { status: 'success', errors: [], warnings: [], buildId: BUILD },
      false
    )
    const result = await tools.execute(
      'highlight_in_pdf',
      { path: 'main.tex', line: 1 },
      { projectId: PROJECT, userId: USER }
    )
    expect(result.error).to.include('not typeset')
  })

  it('needs a compiled PDF to highlight a source line', async function () {
    const tools = makeHighlightTools()
    const result = await tools.execute(
      'highlight_in_pdf',
      { path: 'main.tex', line: 1 },
      { projectId: PROJECT, userId: USER }
    )
    expect(result.error).to.include('No compile has run')
  })

  it('takes boxes as given and drops the malformed ones', async function () {
    const tools = makeHighlightTools()
    const result = await tools.execute(
      'highlight_in_pdf',
      {
        boxes: [
          { page: 1, h: 10, v: 20, width: 30, height: 5 },
          { page: 0, h: 10, v: 20, width: 30, height: 5 },
          { page: 1, h: 'x', v: 20, width: 30, height: 5 },
        ],
      },
      { projectId: PROJECT, userId: USER }
    )
    expect(result.status).to.equal('highlighted')
    expect(result.highlights).to.deep.equal([
      { page: 1, h: 10, v: 20, width: 30, height: 5 },
    ])
  })

  it('asks for a path and a line, or boxes', async function () {
    const tools = makeHighlightTools()
    const none = await tools.execute('highlight_in_pdf', {}, {
      projectId: PROJECT,
      userId: USER,
    })
    expect(none.error).to.include('a path and a line')
    const bad = await tools.execute('highlight_in_pdf', { boxes: [{ page: 1 }] }, {
      projectId: PROJECT,
      userId: USER,
    })
    expect(bad.error).to.include('non-empty list')
  })
})
