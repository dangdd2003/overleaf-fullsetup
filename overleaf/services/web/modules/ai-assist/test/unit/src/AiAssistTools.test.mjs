import { describe, it, beforeEach } from 'vitest'
import { expect } from 'chai'
import sinon from 'sinon'
import { parsePdfBoxes } from '../../../app/src/AiAssistTools.mjs'
import {
  AiAssistTools,
  endDocumentLine,
} from '../../../app/src/AiAssistTools.mjs'
import {
  PdfPageError,
  PDF_PAGE_ERRORS,
} from '../../../../../app/src/Features/PdfInspection/PdfPageInspector.mjs'

describe('AiAssistTools', function () {
  let tools
  let mockDocUpdater
  let mockEntityHandler
  let mockEditorController
  let mockCompileManager
  let mockProjectGetter
  let mockProjectOptionsHandler
  let mockUserModel
  let mockSettings

  beforeEach(function () {
    mockDocUpdater = {
      getDocument: sinon.stub().callsFake(async (pid, docId) => {
        if (docId === 'doc-1') {
          return { lines: ['line 1', 'line 2: target text', 'line 3'] }
        }
        return { lines: ['other file', 'no match here'] }
      }),
      setDocument: sinon.stub().resolves({ rev: 1, modified: true }),
    }

    mockEntityHandler = {
      getAllDocs: sinon.stub().resolves([
        { _id: 'doc-1', name: 'main.tex', path: 'main.tex' },
        {
          _id: 'doc-2',
          name: 'chapters/intro.tex',
          path: 'chapters/intro.tex',
        },
        { _id: 'doc-bib', name: 'references.bib', path: 'references.bib' },
      ]),
      getDocPathByProjectIdAndDocId: sinon
        .stub()
        .callsFake(async (pid, docId) => {
          if (docId === 'doc-1') return 'main.tex'
          if (docId === 'doc-bib') return 'references.bib'
          return 'chapters/intro.tex'
        }),
      getDocIdByPath: sinon.stub().callsFake(async (pid, path) => {
        if (path === 'main.tex') return 'doc-1'
        if (path === 'references.bib') return 'doc-bib'
        return null
      }),
    }

    mockEditorController = {
      addDoc: sinon.stub().yields(null, { _id: 'doc-new' }, 'root-folder'),
      promises: {
        renameProject: sinon.stub().resolves(),
        updateProjectDescription: sinon.stub().resolves(),
        setRootDoc: sinon.stub().resolves(),
        setMainBibliographyDoc: sinon.stub().resolves(),
      },
    }

    mockCompileManager = {
      compile: sinon.stub().resolves({ status: 'success', outputFiles: [] }),
    }

    mockProjectGetter = {
      getProject: sinon.stub().resolves({
        _id: 'p1',
        name: 'My Paper',
        description: 'A study on AI integration',
        compiler: 'xelatex',
        imageName: 'texlive-2024.1',
        rootDoc_id: 'doc-1',
        mainBibliographyDoc_id: 'doc-bib',
        spellCheckLanguage: 'en_GB',
        owner_ref: '012345678901234567890123',
        rootFolder: [{ _id: 'root-folder' }],
        draft: false,
        stopOnFirstError: false,
      }),
    }

    mockProjectOptionsHandler = {
      setCompiler: sinon.stub().resolves(),
      setImageName: sinon.stub().resolves(),
      setSpellCheckLanguage: sinon.stub().resolves(),
      setDraft: sinon.stub().resolves(),
      setStopOnFirstError: sinon.stub().resolves(),
    }

    mockUserModel = {
      findById: sinon.stub(),
    }

    mockSettings = {
      safeCompilers: ['pdflatex', 'latex', 'xelatex', 'lualatex'],
      allowedImageNames: [
        {
          imageName: 'texlive-2024.1',
          imageDesc: 'TeX Live 2024',
          default: true,
        },
      ],
      languages: [
        { code: 'en', name: 'English' },
        { code: 'fr', name: 'French' },
      ],
    }

    tools = new AiAssistTools({
      docUpdater: mockDocUpdater,
      entityHandler: mockEntityHandler,
      projectGetter: mockProjectGetter,
      editorController: mockEditorController,
      compileManager: mockCompileManager,
      projectOptionsHandler: mockProjectOptionsHandler,
      userModel: mockUserModel,
      settings: mockSettings,
      pdfVisualDiff: { diff: async () => ({ ok: false }), remember: async () => ({ ok: true }) },
    })
  })

  it('reads lines from a document via read_file', async function () {
    const res = await tools.execute(
      'read_file',
      { path: 'main.tex', from: 1, to: 2 },
      {
        projectId: 'p1',
        userId: '012345678901234567890123',
      }
    )

    expect(res.content).to.equal('1: line 1\n2: line 2: target text')
    expect(res.from).to.equal(1)
    expect(res.to).to.equal(2)
  })

  it('performs text replacement via edit_file', async function () {
    const validUserId = '012345678901234567890123'
    const res = await tools.execute(
      'edit_file',
      { path: 'main.tex', oldText: 'target text', newText: 'updated text' },
      { projectId: 'p1', userId: validUserId }
    )

    expect(res.status).to.equal('applied')
    expect(mockDocUpdater.setDocument.calledOnce).to.be.true
    const updatedLines = mockDocUpdater.setDocument.firstCall.args[3]
    expect(updatedLines[1]).to.equal('line 2: updated text')
  })

  it('creates new files via create_file', async function () {
    const res = await tools.execute(
      'create_file',
      { path: 'references.bib', content: '@article{test}' },
      { projectId: 'p1', userId: '012345678901234567890123' }
    )

    expect(res.status).to.equal('applied')
    expect(mockEditorController.addDoc.calledOnce).to.be.true
  })

  it('searches across project documents via search_text and search_project alias', async function () {
    const validUserId = '012345678901234567890123'
    const resText = await tools.execute(
      'search_text',
      { query: 'target' },
      { projectId: 'p1', userId: validUserId }
    )
    expect(resText.hits).to.have.lengthOf(1)
    expect(resText.hits[0].path).to.equal('main.tex')
    expect(resText.hits[0].line).to.equal(2)

    const resProj = await tools.execute(
      'search_project',
      { query: 'target' },
      { projectId: 'p1', userId: validUserId }
    )
    expect(resProj.hits).to.have.lengthOf(1)
    expect(resProj.hits[0].path).to.equal('main.tex')
    expect(resProj.hits[0].line).to.equal(2)
  })

  it('handles getAllDocs returning an object dictionary (Overleaf real production format)', async function () {
    mockDocUpdater.getDocument = sinon.stub().callsFake(async (pid, docId) => {
      if (docId === 'doc-bib') return { lines: ['@article{sample}'] }
      return { lines: ['line 1', 'line 2: target text', 'line 3'] }
    })
    mockEntityHandler.getAllDocs = sinon.stub().resolves({
      'main.tex': {
        _id: 'doc-1',
        name: 'main.tex',
        lines: ['line 1', 'line 2: target text', 'line 3'],
      },
      'ref.bib': {
        _id: 'doc-bib',
        name: 'ref.bib',
        lines: ['@article{sample}'],
      },
    })

    const validUserId = '012345678901234567890123'
    const readRes = await tools.execute(
      'read_file',
      { path: 'ref.bib' },
      {
        projectId: 'p1',
        userId: validUserId,
      }
    )
    expect(readRes.content).to.equal('1: @article{sample}')
    expect(readRes.totalLines).to.equal(1)

    const listRes = await tools.execute(
      'list_files',
      {},
      {
        projectId: 'p1',
        userId: validUserId,
      }
    )
    expect(listRes.files).to.have.lengthOf(2)
    expect(listRes.files.map(f => f.path)).to.include('ref.bib')

    const searchRes = await tools.execute(
      'search_project',
      { query: 'sample' },
      {
        projectId: 'p1',
        userId: validUserId,
      }
    )
    expect(searchRes.hits).to.have.lengthOf(1)
    expect(searchRes.hits[0].path).to.equal('ref.bib')
  })

  it('compiles project and parses output.log from clsi into errors and warnings', async function () {
    const fakeLog = [
      'This is pdfTeX',
      'LaTeX Warning: Reference `sec:intro` on page 1 undefined on input line 42.',
      '! Undefined control sequence.',
      'l.50 \\foobar',
    ].join('\n')

    mockCompileManager.compile.resolves({
      status: 'failure',
      outputFiles: [{ path: 'output.log' }, { path: 'output.pdf' }],
      clsiServerId: 'clsi-1',
      buildId: 'build-123',
    })

    const mockClsiManager = {
      getOutputFileStream: sinon.stub().callsFake(async () => {
        return (async function* () {
          yield Buffer.from(fakeLog)
        })()
      }),
    }

    tools = new AiAssistTools({
      docUpdater: mockDocUpdater,
      entityHandler: mockEntityHandler,
      projectGetter: mockProjectGetter,
      editorController: mockEditorController,
      compileManager: mockCompileManager,
      clsiManager: mockClsiManager,
      pdfVisualDiff: { diff: async () => ({ ok: false }), remember: async () => ({ ok: true }) },
    })

    const validUserId = '012345678901234567890123'
    const res = await tools.execute(
      'compile_project',
      {},
      { projectId: 'p1', userId: validUserId }
    )
    expect(res.status).to.equal('failure')
    expect(res.errorCount).to.equal(1)
    expect(res.warningCount).to.equal(1)
    expect(res.errors[0].message).to.equal('Undefined control sequence.')
    expect(res.errors[0].line).to.equal(50)
    expect(res.warnings[0].message).to.include(
      'Reference `sec:intro` on page 1 undefined'
    )

    const logRes = await tools.execute(
      'get_compile_result',
      { severity: 'warnings' },
      { projectId: 'p1', userId: validUserId }
    )
    expect(logRes.warningCount).to.equal(1)
    expect(logRes.warnings).to.have.lengthOf(1)
    expect(logRes.warnings[0].message).to.include('Reference `sec:intro`')
  })

  it('uses the editor compile outcome instead of compiling on the server', async function () {
    mockCompileManager.deleteAuxFiles = sinon.stub().resolves()
    const compileInEditor = sinon.stub().resolves({
      status: 'failure',
      errors: [
        { file: 'main.tex', line: 3, message: 'Undefined control sequence.' },
      ],
      warnings: [],
      rawLog: 'l.3 \\foo',
    })

    const res = await tools.execute(
      'compile_project',
      { clean: true },
      {
        projectId: 'p1',
        userId: '012345678901234567890123',
        callId: 'c1',
        compileInEditor,
      }
    )

    expect(compileInEditor.calledOnceWith({ id: 'c1', clean: true })).to.equal(
      true
    )
    expect(mockCompileManager.compile.called).to.equal(false)
    expect(mockCompileManager.deleteAuxFiles.called).to.equal(false)
    expect(res.errorCount).to.equal(1)
    expect(res.clean).to.equal(true)
  })

  it('compiles on the server when no editor answers', async function () {
    await tools.execute(
      'compile_project',
      {},
      {
        projectId: 'p1',
        userId: '012345678901234567890123',
        compileInEditor: sinon.stub().resolves(null),
      }
    )

    expect(mockCompileManager.compile.calledOnce).to.equal(true)
  })

  it('does not clear the compile cache on an ordinary compile', async function () {
    mockCompileManager.deleteAuxFiles = sinon.stub().resolves()

    await tools.execute(
      'compile_project',
      {},
      {
        projectId: 'p1',
        userId: '012345678901234567890123',
      }
    )

    expect(mockCompileManager.deleteAuxFiles.called).to.equal(false)
    expect(mockCompileManager.compile.calledOnce).to.equal(true)
  })

  it('clears the compile cache before compiling when clean is requested', async function () {
    const order = []
    mockCompileManager.deleteAuxFiles = sinon.stub().callsFake(async () => {
      order.push('clear')
    })
    mockCompileManager.compile.callsFake(async () => {
      order.push('compile')
      return { status: 'success', outputFiles: [] }
    })

    const res = await tools.execute(
      'compile_project',
      { clean: true },
      {
        projectId: 'p1',
        userId: '012345678901234567890123',
      }
    )

    // Clearing after the build would leave the stale cache in place, which is
    // the whole thing the option exists to avoid.
    expect(order).to.deep.equal(['clear', 'compile'])
    expect(mockCompileManager.deleteAuxFiles.args[0]).to.deep.equal([
      'p1',
      '012345678901234567890123',
      null,
    ])
    expect(res.status).to.equal('success')
    expect(res.clean).to.equal(true)
  })

  it('accepts the ways a model spells the clean flag', async function () {
    mockCompileManager.deleteAuxFiles = sinon.stub().resolves()

    for (const args of [
      { clean: true },
      { clean: 'true' },
      { clear_cache: true },
      { fromScratch: 'yes' },
      { rebuild: 1 },
    ]) {
      mockCompileManager.deleteAuxFiles.resetHistory()
      await tools.execute('compile_project', args, {
        projectId: 'p1',
        userId: '012345678901234567890123',
      })
      expect(
        mockCompileManager.deleteAuxFiles.calledOnce,
        JSON.stringify(args)
      ).to.equal(true)
    }
  })

  it('still compiles when clearing the cache fails', async function () {
    mockCompileManager.deleteAuxFiles = sinon
      .stub()
      .rejects(new Error('clsi unreachable'))
    mockCompileManager.compile.resolves({ status: 'success', outputFiles: [] })

    const res = await tools.execute(
      'compile_project',
      { clean: true },
      {
        projectId: 'p1',
        userId: '012345678901234567890123',
      }
    )

    expect(mockCompileManager.compile.calledOnce).to.equal(true)
    expect(res.status).to.equal('success')
    expect(res.error).to.equal(undefined)
  })

  it('compiles normally when the compile manager cannot clear the cache', async function () {
    // The injected manager may predate deleteAuxFiles; the option must degrade
    // to an incremental compile rather than throw.
    delete mockCompileManager.deleteAuxFiles

    const res = await tools.execute(
      'compile_project',
      { clean: true },
      {
        projectId: 'p1',
        userId: '012345678901234567890123',
      }
    )

    expect(mockCompileManager.compile.calledOnce).to.equal(true)
    expect(res.status).to.equal('success')
  })

  it('advertises the clean option in the compile_project tool spec', function () {
    const spec = tools
      .getToolSpecs()
      .find(tool => tool.name === 'compile_project')

    expect(spec.parameters.properties.clean.type).to.equal('boolean')
    expect(spec.description).to.match(/clean/i)
    expect(spec.description).to.match(/from scratch/i)
  })

  describe('view_compiled_pdf_page', function () {
    const USER = '012345678901234567890123'
    const BUILD_ID = '18f4c3a2b10-0123456789abcdef'
    const ctx = { projectId: 'p1', userId: USER }
    let inspect

    const PAGE = {
      page: 2,
      pageCount: 5,
      pageSize: { width: 595, height: 842 },
      region: 'full',
      span: { top: 0, bottom: 100 },
      located: null,
      sourceMap: [{ y: 35, path: 'main.tex', line: 2 }],
      sourceRanges: [{ path: 'main.tex', startLine: 2, endLine: 2 }],
      badBoxes: [],
      image: { mediaType: 'image/png', data: 'iVBORw0KGgo=', dpi: 150 },
    }

    async function compileWithPdf(extra = {}) {
      mockCompileManager.compile.resolves({
        status: 'success',
        buildId: BUILD_ID,
        clsiServerId: 'clsi-1',
        outputFiles: [{ path: 'output.pdf' }],
        ...extra,
      })
      return tools.execute('compile_project', {}, ctx)
    }

    beforeEach(function () {
      inspect = sinon.stub().resolves(PAGE)
      tools.pdfPageInspector = { inspect }
    })

    it('asks for a compile when this chat has none', async function () {
      const res = await tools.execute('view_compiled_pdf_page', {}, ctx)
      expect(res.error).to.match(/call compile_project/i)
      expect(inspect.called).to.equal(false)
    })

    it('says the last compile wrote no PDF', async function () {
      mockCompileManager.compile.resolves({ status: 'failure', outputFiles: [] })
      await tools.execute('compile_project', {}, ctx)
      const res = await tools.execute('view_compiled_pdf_page', { page: 1 }, ctx)
      expect(res.error).to.include('produced no PDF')
      expect(inspect.called).to.equal(false)
    })

    it('renders the requested page of the last build', async function () {
      await compileWithPdf()
      const res = await tools.execute(
        'view_compiled_pdf_page',
        { page: '2', region: 'top' },
        ctx
      )
      expect(inspect.firstCall.args[0]).to.deep.include({
        projectId: 'p1',
        userId: USER,
        buildId: BUILD_ID,
        clsiServerId: 'clsi-1',
        page: 2,
        region: 'top',
        rootDocPath: 'main.tex',
        withImage: true,
      })
      expect(res).to.deep.include({ status: 'ok', chosenBy: 'page', page: 2 })
      expect(res.image.data).to.equal('iVBORw0KGgo=')
      expect(res.stale).to.equal(undefined)
    })

    it('uses the build the editor compiled', async function () {
      await tools.execute('compile_project', {}, {
        ...ctx,
        compileInEditor: sinon.stub().resolves({
          status: 'success',
          errors: [],
          warnings: [],
          buildId: BUILD_ID,
          clsiServerId: 'clsi-9',
        }),
      })
      await tools.execute('view_compiled_pdf_page', { page: 1 }, ctx)
      expect(inspect.firstCall.args[0]).to.deep.include({
        buildId: BUILD_ID,
        clsiServerId: 'clsi-9',
      })
    })

    it('ignores a malformed build id from the editor', async function () {
      await tools.execute('compile_project', {}, {
        ...ctx,
        compileInEditor: sinon.stub().resolves({
          status: 'success',
          errors: [],
          warnings: [],
          buildId: '../../etc',
        }),
      })
      const res = await tools.execute('view_compiled_pdf_page', {}, ctx)
      expect(res.error).to.include('produced no PDF')
    })

    it('opens the page of a source line', async function () {
      await compileWithPdf()
      await tools.execute(
        'view_compiled_pdf_page',
        { path: '/chapters/intro.tex', line: 12 },
        ctx
      )
      expect(inspect.firstCall.args[0]).to.deep.include({
        path: 'chapters/intro.tex',
        line: 12,
      })
    })

    it('needs line with path', async function () {
      await compileWithPdf()
      const res = await tools.execute(
        'view_compiled_pdf_page',
        { path: 'main.tex' },
        ctx
      )
      expect(res.error).to.include('Pass line with path')
      expect(inspect.called).to.equal(false)
    })

    it('opens the page of the last edit by default, and says the PDF predates it', async function () {
      await compileWithPdf()
      // The edit below lands in a later millisecond than the build
      tools.lastCompileResult.get('p1').at -= 1000
      await tools.execute(
        'edit_file',
        { path: 'main.tex', oldText: 'target text', newText: 'new text' },
        ctx
      )
      const res = await tools.execute('view_compiled_pdf_page', {}, ctx)
      expect(inspect.firstCall.args[0]).to.deep.include({
        path: 'main.tex',
        line: 2,
      })
      expect(res.chosenBy).to.equal('lastEdit')
      expect(res.stale).to.equal(true)
    })

    it('falls back to page 1 when the last edit typesets nothing', async function () {
      await tools.execute(
        'edit_file',
        { path: 'main.tex', oldText: 'target text', newText: 'new text' },
        ctx
      )
      await compileWithPdf()
      inspect.onFirstCall().rejects(
        new PdfPageError(PDF_PAGE_ERRORS.LINE_NOT_IN_PDF, 'not typeset')
      )
      const res = await tools.execute('view_compiled_pdf_page', {}, ctx)
      expect(inspect.secondCall.args[0]).to.deep.include({ page: 1 })
      expect(res.chosenBy).to.equal('default')
      expect(res.note).to.include('main.tex line 2')
      expect(res.stale).to.equal(undefined)
    })

    it('returns the inspector error and its details to the model', async function () {
      await compileWithPdf()
      inspect.rejects(
        new PdfPageError(
          PDF_PAGE_ERRORS.PAGE_OUT_OF_RANGE,
          'Page 9 does not exist: the PDF has 5 page(s).',
          { pageCount: 5 }
        )
      )
      const res = await tools.execute('view_compiled_pdf_page', { page: 9 }, ctx)
      expect(res).to.deep.equal({
        error: 'Page 9 does not exist: the PDF has 5 page(s).',
        pageCount: 5,
      })
    })

    it('skips the image for a model that refused images', async function () {
      await compileWithPdf()
      const res = await tools.execute(
        'view_compiled_pdf_page',
        { page: 2 },
        { ...ctx, images: false }
      )
      expect(inspect.firstCall.args[0].withImage).to.equal(false)
      expect(res.imageOmitted).to.equal(true)
    })

    it('points a clean compile with a PDF at the visual check', async function () {
      const res = await compileWithPdf()
      expect(res.visualCheck).to.include('view_compiled_pdf_page')
      mockCompileManager.compile.resolves({ status: 'success', outputFiles: [] })
      const noPdf = await tools.execute('compile_project', {}, ctx)
      expect(noPdf.visualCheck).to.equal(undefined)
    })

    it('zooms on the block from line to endLine, and leaves region to the inspector', async function () {
      await compileWithPdf()
      await tools.execute(
        'view_compiled_pdf_page',
        { path: 'chapters/intro.tex', line: '12', endLine: '20' },
        ctx
      )
      const args = inspect.firstCall.args[0]
      expect(args).to.deep.include({
        path: 'chapters/intro.tex',
        line: 12,
        endLine: 20,
      })
      expect(args).to.not.have.property('region')
    })

    it('keeps an explicit region when it zooms on a block', async function () {
      await compileWithPdf()
      await tools.execute(
        'view_compiled_pdf_page',
        { path: 'main.tex', line: 2, endLine: 4, region: 'middle' },
        ctx
      )
      expect(inspect.firstCall.args[0]).to.deep.include({
        endLine: 4,
        region: 'middle',
      })
    })

    it('leaves region out of a page request the model did not zoom', async function () {
      await compileWithPdf()
      await tools.execute('view_compiled_pdf_page', { page: 3 }, ctx)
      expect(inspect.firstCall.args[0]).to.not.have.property('region')
      expect(inspect.firstCall.args[0]).to.not.have.property('endLine')
    })

    it('checks endLine against line, path and page', async function () {
      await compileWithPdf()
      const backwards = await tools.execute(
        'view_compiled_pdf_page',
        { path: 'main.tex', line: 12, endLine: 9 },
        ctx
      )
      expect(backwards.error).to.equal(
        'endLine must be a whole number from line (12), got 9.'
      )
      const fractional = await tools.execute(
        'view_compiled_pdf_page',
        { path: 'main.tex', line: 12, endLine: 12.5 },
        ctx
      )
      expect(fractional.error).to.include('endLine must be a whole number')
      const noLine = await tools.execute(
        'view_compiled_pdf_page',
        { path: 'main.tex', endLine: 9 },
        ctx
      )
      expect(noLine.error).to.include('Pass line with path')
      const noPath = await tools.execute(
        'view_compiled_pdf_page',
        { line: 12, endLine: 15 },
        ctx
      )
      expect(noPath.error).to.include('endLine needs path and line')
      const withPage = await tools.execute(
        'view_compiled_pdf_page',
        { page: 2, endLine: 15 },
        ctx
      )
      expect(withPage.error).to.include('goes with path and line')
      expect(inspect.called).to.equal(false)
    })

    it('names the line range of the last edit in the visual check', async function () {
      await tools.execute(
        'edit_file',
        { path: 'main.tex', oldText: 'target text', newText: 'a\nb\nc' },
        ctx
      )
      const res = await compileWithPdf()
      expect(res.visualCheck).to.include(
        'view_compiled_pdf_page with path "main.tex", line 2, endLine 4 zooms on your last edit'
      )
    })

    it('remembers the line range a new file was created with', async function () {
      await tools.execute(
        'create_file',
        { path: 'figs/new.tex', content: 'a\nb\nc' },
        ctx
      )
      const res = await compileWithPdf()
      expect(res.visualCheck).to.include(
        'view_compiled_pdf_page with path "figs/new.tex", line 1, endLine 3'
      )
    })

    it('names both views in the visual check when nothing was edited', async function () {
      const res = await compileWithPdf()
      expect(res.visualCheck).to.include('view_compiled_pdf_page with page')
      expect(res.visualCheck).to.include(
        'view_compiled_pdf_overview with fromPage 1'
      )
    })

    it('tells the model when to call it, what it returns and how to use it', function () {
      const spec = tools
        .getToolSpecs()
        .find(tool => tool.name === 'view_compiled_pdf_page')
      expect(spec.description).to.match(/after every successful compile_project/)
      expect(spec.description).to.match(/SyncTeX map/)
      expect(spec.description).to.match(/path and line/)
      expect(spec.description).to.match(/endLine/)
      expect(spec.description).to.match(/Zoom:/)
      expect(spec.description).to.match(/read_file .* edit_file, compile_project/)
      expect(spec.description).to.match(/search_compiled_pdf/)
      expect(spec.description).to.match(/view_compiled_pdf_overview/)
      expect(Object.keys(spec.parameters.properties)).to.deep.equal([
        'page',
        'path',
        'line',
        'endLine',
        'region',
        'labels',
      ])
      expect(spec.parameters.properties.region.enum).to.deep.equal([
        'full',
        'top',
        'middle',
        'bottom',
      ])
    })
  })

  it('reads project settings summary via get_project_settings', async function () {
    mockUserModel.findById.returns({
      select: sinon.stub().returns({
        exec: sinon.stub().resolves({
          _id: '012345678901234567890123',
          ace: {
            mode: 'vim',
            overallTheme: 'dark',
            fontSize: 14,
            autoComplete: true,
          },
        }),
      }),
    })

    const res = await tools.execute(
      'get_project_settings',
      {},
      {
        projectId: 'p1',
        userId: '012345678901234567890123',
      }
    )

    expect(res.status).to.equal('ok')
    expect(res.settings.compiler.compiler).to.equal('xelatex')
    expect(res.settings.compiler.imageName).to.equal('texlive-2024.1')
    expect(res.settings.compiler.rootDocPath).to.equal('main.tex')
    expect(res.settings.appearance.overallTheme).to.equal('dark')
    expect(res.settings.appearance.fontSize).to.equal(14)
    expect(res.settings.editor.mode).to.equal('vim')
    expect(res.settings.editor.autoComplete).to.be.true
    expect(res.settings.spelling.spellCheckLanguage).to.equal('en_GB')
    expect(res.settings.name).to.equal('My Paper')
  })

  it('updates compiler settings via configure_compiler_settings', async function () {
    const res = await tools.execute(
      'configure_compiler_settings',
      {
        compiler: 'lualatex',
        imageName: 'texlive-2024.1',
        rootDocPath: 'main.tex',
        draft: true,
        stopOnFirstError: true,
      },
      { projectId: 'p1', userId: '012345678901234567890123' }
    )

    expect(res.status).to.equal('applied')
    expect(mockProjectOptionsHandler.setCompiler.calledWith('p1', 'lualatex'))
      .to.be.true
    expect(
      mockProjectOptionsHandler.setImageName.calledWith('p1', 'texlive-2024.1')
    ).to.be.true
    expect(mockProjectOptionsHandler.setDraft.calledWith('p1', true)).to.be.true
    expect(mockProjectOptionsHandler.setStopOnFirstError.calledWith('p1', true))
      .to.be.true
    expect(mockEditorController.promises.setRootDoc.calledWith('p1', 'doc-1'))
      .to.be.true
  })

  it('configures appearance preferences via configure_appearance_settings', async function () {
    const saveStub = sinon.stub().resolves()
    const fakeUser = {
      _id: '012345678901234567890123',
      ace: { overallTheme: 'system', fontSize: 12 },
      save: saveStub,
    }
    mockUserModel.findById.returns({
      exec: sinon.stub().resolves(fakeUser),
    })

    const res = await tools.execute(
      'configure_appearance_settings',
      {
        overallTheme: 'dark',
        editorTheme: 'monokai',
        darkModePdf: true,
        fontSize: 16,
        fontFamily: 'consolas',
        lineHeight: 'spacious',
      },
      { projectId: 'p1', userId: '012345678901234567890123' }
    )

    expect(res.status).to.equal('applied')
    expect(fakeUser.ace.overallTheme).to.equal('')
    expect(fakeUser.ace.theme).to.equal('monokai')
    expect(fakeUser.ace.darkModePdf).to.be.true
    expect(fakeUser.ace.fontSize).to.equal(16)
    expect(fakeUser.ace.fontFamily).to.equal('consolas')
    expect(fakeUser.ace.lineHeight).to.equal('spacious')
    expect(res.updatedSettings.overallTheme).to.equal('')
    expect(res.updatedSettings.editorTheme).to.equal('monokai')
    expect(res.updatedSettings.darkModePdf).to.be.true
    expect(res.updatedSettings.fontSize).to.equal(16)
    expect(res.updatedSettings.fontFamily).to.equal('consolas')
    expect(res.updatedSettings.lineHeight).to.equal('spacious')
    expect(saveStub.calledOnce).to.be.true
  })

  it('configures editor preferences via configure_editor_settings', async function () {
    const saveStub = sinon.stub().resolves()
    const fakeUser = {
      _id: '012345678901234567890123',
      ace: { mode: 'none', fontSize: 12 },
      save: saveStub,
    }
    mockUserModel.findById.returns({
      exec: sinon.stub().resolves(fakeUser),
    })

    const res = await tools.execute(
      'configure_editor_settings',
      {
        mode: 'vim',
        autoComplete: false,
        autoPairDelimiters: false,
        syntaxValidation: true,
        pdfViewer: 'native',
        spellCheckLanguage: 'en_GB',
      },
      { projectId: 'p1', userId: '012345678901234567890123' }
    )

    expect(res.status).to.equal('applied')
    expect(fakeUser.ace.mode).to.equal('vim')
    expect(fakeUser.ace.autoComplete).to.be.false
    expect(fakeUser.ace.autoPairDelimiters).to.be.false
    expect(fakeUser.ace.syntaxValidation).to.be.true
    expect(fakeUser.ace.pdfViewer).to.equal('native')
    expect(fakeUser.ace.spellCheckLanguage).to.equal('en_GB')
    expect(res.updatedSettings.mode).to.equal('vim')
    expect(res.updatedSettings.autoComplete).to.be.false
    expect(res.updatedSettings.autoPairDelimiters).to.be.false
    expect(res.updatedSettings.syntaxValidation).to.be.true
    expect(res.updatedSettings.pdfViewer).to.equal('native')
    expect(res.updatedSettings.spellCheckLanguage).to.equal('en_GB')
    expect(saveStub.calledOnce).to.be.true
  })

  it('rejects attempt to modify account settings via configure_editor_settings and configure_appearance_settings', async function () {
    const resEd = await tools.execute(
      'configure_editor_settings',
      {
        email: 'hacked@evil.com',
        password: 'password123',
      },
      { projectId: 'p1', userId: '012345678901234567890123' }
    )
    expect(resEd.error).to.include('Cannot modify account settings')

    const resApp = await tools.execute(
      'configure_appearance_settings',
      {
        billing: 'premium',
      },
      { projectId: 'p1', userId: '012345678901234567890123' }
    )
    expect(resApp.error).to.include('Cannot modify account settings')
    expect(mockUserModel.findById.called).to.be.false
  })

  it('lists allowed options via list_available_settings', async function () {
    const res = await tools.execute(
      'list_available_settings',
      {},
      {
        projectId: 'p1',
        userId: '012345678901234567890123',
      }
    )

    expect(res.status).to.equal('ok')
    expect(res.options.compilers).to.include('pdflatex')
    expect(res.options.compilers).to.include('xelatex')
    expect(res.options.editorModes).to.include('vim')
    expect(res.options.overallThemes).to.include('dark')
    expect(res.options.editorThemes).to.include('monokai')
    expect(res.options.editorThemes).to.include('dracula')
    expect(res.options.editorThemes).to.include('tomorrow_night_eighties')
    expect(res.options.fontFamilies).to.deep.include({
      name: 'monaco',
      label: 'Monaco / Menlo / Consolas',
    })
    expect(res.options.spellCheckLanguages[0].code).to.equal('en')
  })

  describe('project snapshot', function () {
    const ctx = { projectId: 'p1', userId: '012345678901234567890123' }

    it('flushes once and reads docs in bulk instead of fetching each document', async function () {
      mockDocUpdater.flushProjectToMongo = sinon.stub().resolves()
      mockEntityHandler.getAllDocs = sinon.stub().resolves({
        '/main.tex': {
          _id: 'doc-1',
          name: 'main.tex',
          lines: ['\\section{Intro}'],
        },
        '/sections/a.tex': { _id: 'doc-2', name: 'a.tex', lines: ['text'] },
      })

      await tools.execute('list_files', {}, ctx)
      await tools.execute('search_text', { query: 'intro' }, ctx)

      expect(mockDocUpdater.flushProjectToMongo.calledOnce).to.equal(true)
      expect(mockEntityHandler.getAllDocs.calledOnce).to.equal(true)
      expect(mockDocUpdater.getDocument.called).to.equal(false)
    })

    it('falls back to per-document reads when flushing is unavailable', async function () {
      const snapshot = await tools._getSnapshot('p1')
      expect(
        snapshot.docs.find(d => d.path === 'main.tex').lines
      ).to.deep.equal(['line 1', 'line 2: target text', 'line 3'])
    })

    it('resolves the root document path', async function () {
      const snapshot = await tools._getSnapshot('p1')
      expect(snapshot.rootPath).to.equal('main.tex')
    })

    it('rebuilds after an edit is applied', async function () {
      mockDocUpdater.flushProjectToMongo = sinon.stub().resolves()
      await tools._getSnapshot('p1')
      await tools.execute(
        'edit_file',
        { path: 'main.tex', oldText: 'target text', newText: 'new text' },
        ctx
      )
      await tools._getSnapshot('p1')
      expect(mockDocUpdater.flushProjectToMongo.calledTwice).to.equal(true)
    })
  })

  describe('list_files', function () {
    const ctx = { projectId: 'p1', userId: '012345678901234567890123' }

    it('lists binary files next to docs, sorted, and filters by glob', async function () {
      mockEntityHandler.getAllFiles = sinon.stub().resolves({
        '/figures/plot.png': { _id: 'f1', name: 'plot.png' },
      })

      const all = await tools.execute('list_files', {}, ctx)
      expect(all.files.map(f => `${f.path}:${f.type}`)).to.deep.equal([
        'chapters/intro.tex:doc',
        'figures/plot.png:binary',
        'main.tex:doc',
        'references.bib:doc',
      ])
      expect(all.total).to.equal(4)
      expect(all.truncated).to.equal(false)

      const figures = await tools.execute(
        'list_files',
        { glob: 'figures/*' },
        ctx
      )
      expect(figures.files.map(f => f.path)).to.deep.equal(['figures/plot.png'])
    })
  })

  describe('matchesGlob', function () {
    it('matches like the browser helper', async function () {
      const { matchesGlob } = await import('../../../app/src/AiAssistGlob.mjs')
      const cases = [
        ['sections/a.tex', 'sections/*.tex', true],
        ['sections/deep/a.tex', 'sections/*.tex', false],
        ['sections/deep/a.tex', 'sections/**/*.tex', true],
        ['a.tex', '**/*.tex', true],
        ['main.tex', 'mai?.tex', true],
        ['file(1).tex', 'file(1).tex', true],
      ]
      for (const [path, pattern, expected] of cases) {
        expect(matchesGlob(path, pattern), `${path} ~ ${pattern}`).to.equal(
          expected
        )
      }
    })
  })

  describe('index tools', function () {
    const ctx = { projectId: 'p1', userId: '012345678901234567890123' }

    beforeEach(function () {
      mockDocUpdater.flushProjectToMongo = sinon.stub().resolves()
      mockEntityHandler.getAllDocs = sinon.stub().resolves({
        '/main.tex': {
          _id: 'doc-1',
          name: 'main.tex',
          lines: [
            '\\documentclass{article}',
            '\\usepackage[margin=1in]{geometry}',
            '\\begin{document}',
            '\\section{Intro}\\label{sec:intro}',
            'See \\ref{sec:intro} and \\ref{sec:nope} and \\cite{knuth84}.',
            '\\subsection{Background}',
            '\\section{Method}',
            '\\end{document}',
          ],
        },
        '/refs.bib': {
          _id: 'doc-bib',
          name: 'refs.bib',
          lines: ['@book{knuth84,', '}'],
        },
      })
    })

    it('get_outline returns the section tree', async function () {
      const res = await tools.execute('get_outline', {}, ctx)
      expect(res.documentClass).to.equal('article')
      expect(
        res.sections.map(s => `${s.level}:${s.title}:${s.line}`)
      ).to.deep.equal(['1:Intro:4', '2:Background:6', '1:Method:7'])
    })

    it('get_outline narrows to one section with a line range', async function () {
      const res = await tools.execute('get_outline', { section: 'intro' }, ctx)
      expect(res.range).to.deep.equal({ from: 4, to: 6 })
      expect(res.sections.map(s => s.title)).to.deep.equal([
        'Intro',
        'Background',
      ])
      expect(res.hint).to.equal(
        'read_file with path=main.tex from=4 to=6 for the body'
      )
    })

    it('get_outline reports an unknown section with candidates', async function () {
      const res = await tools.execute(
        'get_outline',
        { section: 'Results' },
        ctx
      )
      expect(res.error).to.include('No section matches')
      expect(res.candidates).to.deep.equal(['Intro', 'Background', 'Method'])
    })

    it('get_packages lists packages with locations', async function () {
      const res = await tools.execute('get_packages', {}, ctx)
      expect(res.documentClass).to.equal('article')
      expect(res.packages).to.deep.equal([
        { name: 'geometry', options: 'margin=1in', line: 2, path: 'main.tex' },
      ])
    })

    it('get_references resolves refs and citations', async function () {
      const res = await tools.execute(
        'get_references',
        { unresolvedOnly: true },
        ctx
      )
      expect(res.refs.map(r => r.key)).to.deep.equal(['sec:nope'])
      expect(res.citations).to.deep.equal([])
      expect(res.labels.map(l => l.key)).to.deep.equal(['sec:intro'])
    })
  })

  describe('search_text', function () {
    const ctx = { projectId: 'p1', userId: '012345678901234567890123' }

    beforeEach(function () {
      mockDocUpdater.flushProjectToMongo = sinon.stub().resolves()
      mockEntityHandler.getAllDocs = sinon.stub().resolves({
        '/main.tex': {
          _id: 'doc-1',
          name: 'main.tex',
          lines: ['\\section{Intro}', 'Hello World', 'bye'],
        },
        '/sections/a.tex': {
          _id: 'doc-2',
          name: 'a.tex',
          lines: ['hello again'],
        },
      })
    })

    it('is case-insensitive by default and returns context lines', async function () {
      const res = await tools.execute('search_text', { query: 'hello' }, ctx)
      expect(res.total).to.equal(2)
      expect(res.hits[0]).to.deep.equal({
        path: 'main.tex',
        line: 2,
        text: 'Hello World',
        before: ['\\section{Intro}'],
        after: ['bye'],
      })
    })

    it('honours caseSensitive, glob and contextLines 0', async function () {
      const res = await tools.execute(
        'search_text',
        {
          query: 'hello',
          caseSensitive: true,
          glob: 'sections/*.tex',
          contextLines: 0,
        },
        ctx
      )
      expect(res.hits).to.deep.equal([
        { path: 'sections/a.tex', line: 1, text: 'hello again' },
      ])
    })

    it('supports regular expressions', async function () {
      const res = await tools.execute(
        'search_text',
        { query: '^\\\\section\\{', regexp: true },
        ctx
      )
      expect(res.hits.map(h => `${h.path}:${h.line}`)).to.deep.equal([
        'main.tex:1',
      ])
    })

    it('returns an error for an invalid regular expression', async function () {
      const res = await tools.execute(
        'search_text',
        { query: '(', regexp: true },
        ctx
      )
      expect(res.error).to.include('regular expression')
    })
  })

  describe('read_file limits', function () {
    const ctx = { projectId: 'p1', userId: '012345678901234567890123' }

    it('reads at most 500 lines when no range is given and says where to continue', async function () {
      const lines = Array.from({ length: 1500 }, (_, i) => `l${i + 1}`)
      mockDocUpdater.getDocument = sinon.stub().resolves({ lines })

      const res = await tools.execute('read_file', { path: 'main.tex' }, ctx)

      expect(res.from).to.equal(1)
      expect(res.to).to.equal(500)
      expect(res.totalLines).to.equal(1500)
      expect(res.truncated).to.equal(true)
      expect(res.nextRange).to.deep.equal({ from: 501, to: 1000 })
      expect(res.content.split('\n')[499]).to.equal('500: l500')
    })

    it('caps an explicit range at 1000 lines', async function () {
      const lines = Array.from({ length: 1500 }, (_, i) => `l${i + 1}`)
      mockDocUpdater.getDocument = sinon.stub().resolves({ lines })

      const res = await tools.execute(
        'read_file',
        { path: 'main.tex', from: 1, to: 1500 },
        ctx
      )

      expect(res.to).to.equal(1000)
      expect(res.nextRange).to.deep.equal({ from: 1001, to: 1500 })
    })

    it('explains that a binary file cannot be read as text', async function () {
      mockEntityHandler.getAllFiles = sinon
        .stub()
        .resolves({ '/fig.png': { _id: 'f1', name: 'fig.png' } })
      const res = await tools.execute('read_file', { path: 'fig.png' }, ctx)
      expect(res.error).to.equal(
        'fig.png is a binary file and cannot be read as text.'
      )
    })

    it('does not resolve a.tex to data.tex', async function () {
      mockEntityHandler.getAllDocs = sinon
        .stub()
        .resolves([{ _id: 'doc-data', name: 'data.tex', path: 'data.tex' }])

      const res = await tools.execute('read_file', { path: 'a.tex' }, ctx)

      expect(res.error).to.equal('File not found: a.tex')
    })

    it('resolves a bare file name when exactly one document has it', async function () {
      mockEntityHandler.getAllDocs = sinon
        .stub()
        .resolves([
          { _id: 'doc-2', name: 'intro.tex', path: 'chapters/intro.tex' },
        ])

      const res = await tools.execute('read_file', { path: 'intro.tex' }, ctx)

      expect(res.error).to.equal(undefined)
      expect(res.totalLines).to.equal(2)
    })

    it('names the candidates when a bare file name is ambiguous', async function () {
      mockEntityHandler.getAllDocs = sinon.stub().resolves([
        { _id: 'doc-a', name: 'intro.tex', path: 'a/intro.tex' },
        { _id: 'doc-b', name: 'intro.tex', path: 'b/intro.tex' },
      ])

      const res = await tools.execute('read_file', { path: 'intro.tex' }, ctx)

      expect(res.error).to.equal(
        'File not found: intro.tex. Did you mean a/intro.tex or b/intro.tex?'
      )
    })
  })

  describe('view_compiled_pdf_overview and search_compiled_pdf', function () {
    const USER = '012345678901234567890123'
    const BUILD_ID = '18f4c3a2b10-0123456789abcdef'
    const ctx = { projectId: 'p1', userId: USER }
    let overview
    let search

    const OVERVIEW = {
      fromPage: 1,
      toPage: 3,
      pageCount: 3,
      paper: { width: 612, height: 792, name: 'Letter', orientation: 'portrait' },
      mixedSizes: false,
      fonts: { total: 4, notEmbedded: ['Arial'], type3: [] },
      columns: 4,
      pages: [
        {
          page: 1,
          source: [{ path: 'main.tex', startLine: 1, endLine: 35 }],
          blank: false,
          endsAt: null,
          gaps: [],
          overflow: [],
          badBoxes: 0,
          worstBadBox: null,
          unresolved: { refs: 0, cites: 0 },
        },
      ],
      image: { mediaType: 'image/png', data: 'iVBORw0KGgo=', bytes: 10 },
    }

    const MATCHES = {
      query: 'Figure ??',
      fromPage: 1,
      toPage: 3,
      pageCount: 3,
      matchCount: 1,
      pages: [3],
      matches: [
        {
          page: 3,
          y: 41,
          text: 'Figure ??',
          context: 'as shown in Figure ?? the model',
          path: 'main.tex',
          line: 120,
        },
      ],
      truncated: false,
    }

    async function compileWithPdf(extra = {}) {
      mockCompileManager.compile.resolves({
        status: 'success',
        buildId: BUILD_ID,
        clsiServerId: 'clsi-1',
        outputFiles: [{ path: 'output.pdf' }],
        ...extra,
      })
      return tools.execute('compile_project', {}, ctx)
    }

    beforeEach(function () {
      overview = sinon.stub().resolves(OVERVIEW)
      search = sinon.stub().resolves(MATCHES)
      tools.pdfPageInspector = { inspect: sinon.stub(), overview, search }
    })

    describe('view_compiled_pdf_overview', function () {
      it('asks for a compile when this chat has none', async function () {
        const res = await tools.execute('view_compiled_pdf_overview', {}, ctx)
        expect(res.error).to.match(/call compile_project/i)
        expect(overview.called).to.equal(false)
      })

      it('says the last compile wrote no PDF', async function () {
        mockCompileManager.compile.resolves({ status: 'failure', outputFiles: [] })
        await tools.execute('compile_project', {}, ctx)
        const res = await tools.execute('view_compiled_pdf_overview', {}, ctx)
        expect(res.error).to.include('produced no PDF')
        expect(overview.called).to.equal(false)
      })

      it('renders the range of the last build, with the paths and flags the inspector needs', async function () {
        await compileWithPdf()
        const res = await tools.execute(
          'view_compiled_pdf_overview',
          { fromPage: '1', toPage: '3' },
          ctx
        )
        expect(overview.firstCall.args[0]).to.deep.include({
          projectId: 'p1',
          userId: USER,
          buildId: BUILD_ID,
          clsiServerId: 'clsi-1',
          rootDocPath: 'main.tex',
          fromPage: 1,
          toPage: 3,
          withImage: true,
        })
        expect(res).to.deep.include({ status: 'ok', pageCount: 3, columns: 4 })
        expect(res.image.data).to.equal('iVBORw0KGgo=')
        expect(res.stale).to.equal(undefined)
        expect(res.imageOmitted).to.equal(undefined)
      })

      it('starts at page 1 and leaves the end to the inspector by default', async function () {
        await compileWithPdf()
        await tools.execute('view_compiled_pdf_overview', {}, ctx)
        expect(overview.firstCall.args[0].fromPage).to.equal(1)
        expect(overview.firstCall.args[0]).to.not.have.property('toPage')
      })

      it('rejects a page range that is not whole or does not run forward', async function () {
        await compileWithPdf()
        const zero = await tools.execute(
          'view_compiled_pdf_overview',
          { fromPage: 0 },
          ctx
        )
        expect(zero.error).to.equal(
          'fromPage must be a whole number from 1, got 0.'
        )
        const text = await tools.execute(
          'view_compiled_pdf_overview',
          { fromPage: 'two' },
          ctx
        )
        expect(text.error).to.include('fromPage must be a whole number')
        const backwards = await tools.execute(
          'view_compiled_pdf_overview',
          { fromPage: 4, toPage: 2 },
          ctx
        )
        expect(backwards.error).to.equal(
          'toPage must be a whole number from fromPage (4), got 2.'
        )
        expect(overview.called).to.equal(false)
      })

      it('skips the image for a model that refused images', async function () {
        await compileWithPdf()
        overview.resolves({ ...OVERVIEW, image: null })
        const res = await tools.execute(
          'view_compiled_pdf_overview',
          {},
          { ...ctx, images: false }
        )
        expect(overview.firstCall.args[0].withImage).to.equal(false)
        expect(res.imageOmitted).to.equal(true)
      })

      it('says the project changed after the build', async function () {
        await compileWithPdf()
        tools.lastCompileResult.get('p1').at -= 1000
        await tools.execute(
          'edit_file',
          { path: 'main.tex', oldText: 'target text', newText: 'new text' },
          ctx
        )
        const res = await tools.execute('view_compiled_pdf_overview', {}, ctx)
        expect(res.stale).to.equal(true)
      })

      it('returns the inspector error and its details to the model', async function () {
        await compileWithPdf()
        overview.rejects(
          new PdfPageError(
            PDF_PAGE_ERRORS.PAGE_OUT_OF_RANGE,
            'Page 9 does not exist: the PDF has 3 page(s).',
            { pageCount: 3 }
          )
        )
        const res = await tools.execute(
          'view_compiled_pdf_overview',
          { fromPage: 9 },
          ctx
        )
        expect(res).to.deep.equal({
          error: 'Page 9 does not exist: the PDF has 3 page(s).',
          pageCount: 3,
        })
      })

      it('describes the range and what it checks, and that thumbnails are small', function () {
        const spec = tools
          .getToolSpecs()
          .find(tool => tool.name === 'view_compiled_pdf_overview')
        expect(spec.description).to.match(/up to 12 pages/)
        expect(spec.description).to.match(/Thumbnails are too small/)
        expect(spec.description).to.match(/Returns:/)
        expect(Object.keys(spec.parameters.properties)).to.deep.equal([
          'fromPage',
          'toPage',
        ])
        expect(spec.parameters.required).to.equal(undefined)
      })
    })

    describe('search_compiled_pdf', function () {
      it('asks for a compile when this chat has none', async function () {
        const res = await tools.execute(
          'search_compiled_pdf',
          { query: 'Figure' },
          ctx
        )
        expect(res.error).to.match(/call compile_project/i)
        expect(search.called).to.equal(false)
      })

      it('says the last compile wrote no PDF', async function () {
        mockCompileManager.compile.resolves({ status: 'failure', outputFiles: [] })
        await tools.execute('compile_project', {}, ctx)
        const res = await tools.execute(
          'search_compiled_pdf',
          { query: 'Figure' },
          ctx
        )
        expect(res.error).to.include('produced no PDF')
        expect(search.called).to.equal(false)
      })

      it('searches the last build for the trimmed query, with the page range', async function () {
        await compileWithPdf()
        const res = await tools.execute(
          'search_compiled_pdf',
          { query: '  Figure ??  ', fromPage: '1', toPage: '3' },
          ctx
        )
        expect(search.firstCall.args[0]).to.deep.include({
          projectId: 'p1',
          userId: USER,
          buildId: BUILD_ID,
          clsiServerId: 'clsi-1',
          rootDocPath: 'main.tex',
          query: 'Figure ??',
          fromPage: 1,
          toPage: 3,
        })
        expect(res).to.deep.include({ status: 'ok', matchCount: 1 })
        expect(res.matches[0].line).to.equal(120)
      })

      it('leaves the page range and the image out of a search', async function () {
        await compileWithPdf()
        const res = await tools.execute(
          'search_compiled_pdf',
          { query: 'Figure' },
          { ...ctx, images: false }
        )
        expect(search.firstCall.args[0]).to.not.have.property('fromPage')
        expect(search.firstCall.args[0]).to.not.have.property('toPage')
        expect(search.firstCall.args[0]).to.not.have.property('withImage')
        expect(res).to.not.have.property('imageOmitted')
        expect(res).to.not.have.property('image')
      })

      it('takes a bare number as the text to find', async function () {
        await compileWithPdf()
        await tools.execute('search_compiled_pdf', { query: 2024 }, ctx)
        expect(search.firstCall.args[0].query).to.equal('2024')
      })

      it('refuses a missing, blank or over-long query', async function () {
        await compileWithPdf()
        for (const args of [
          {},
          { query: '   ' },
          { query: 'x'.repeat(201) },
          { query: { text: 'Figure' } },
        ]) {
          const res = await tools.execute('search_compiled_pdf', args, ctx)
          expect(res.error).to.match(/query must be the text to find/)
        }
        expect(search.called).to.equal(false)
        const longest = await tools.execute(
          'search_compiled_pdf',
          { query: 'x'.repeat(200) },
          ctx
        )
        expect(longest.error).to.equal(undefined)
        expect(search.calledOnce).to.equal(true)
      })

      it('refuses a page range that does not run forward', async function () {
        await compileWithPdf()
        const res = await tools.execute(
          'search_compiled_pdf',
          { query: 'Figure', fromPage: 5, toPage: 2 },
          ctx
        )
        expect(res.error).to.equal(
          'toPage must be a whole number from fromPage (5), got 2.'
        )
        expect(search.called).to.equal(false)
      })

      it('says the project changed after the build', async function () {
        await compileWithPdf()
        tools.lastCompileResult.get('p1').at -= 1000
        await tools.execute(
          'edit_file',
          { path: 'main.tex', oldText: 'target text', newText: 'new text' },
          ctx
        )
        const res = await tools.execute(
          'search_compiled_pdf',
          { query: 'Figure' },
          ctx
        )
        expect(res.stale).to.equal(true)
      })

      it('returns the inspector error to the model', async function () {
        await compileWithPdf()
        search.rejects(
          new PdfPageError('invalid_query', 'The query is empty.')
        )
        const res = await tools.execute(
          'search_compiled_pdf',
          { query: 'Figure' },
          ctx
        )
        expect(res).to.deep.equal({ error: 'The query is empty.' })
      })

      it('describes the matching rules and what comes back', function () {
        const spec = tools
          .getToolSpecs()
          .find(tool => tool.name === 'search_compiled_pdf')
        expect(spec.description).to.match(/Matching ignores case/)
        expect(spec.description).to.match(/Returns up to 20 matches/)
        expect(spec.description).to.match(/search_text searches the \.tex source/)
        expect(Object.keys(spec.parameters.properties)).to.deep.equal([
          'query',
          'fromPage',
          'toPage',
        ])
        expect(spec.parameters.required).to.deep.equal(['query'])
      })
    })
  })

  it('lists the PDF tools right after get_compile_result, in order', function () {
    const names = tools.getToolSpecs().map(spec => spec.name)
    const at = names.indexOf('get_compile_result')
    expect(names.slice(at + 1, at + 7)).to.deep.equal([
      'view_compiled_pdf_page',
      'view_compiled_pdf_overview',
      'search_compiled_pdf',
      'resolve_pdf_block',
      'diff_compiled_pdf',
      'inspect_compiled_style',
    ])
  })

  it('returns all 22 tool specifications in getToolSpecs', function () {
    const specs = tools.getToolSpecs()
    const names = specs.map(s => s.name)
    const expected = [
      'get_outline',
      'get_packages',
      'get_references',
      'list_files',
      'read_file',
      'search_text',
      'edit_file',
      'create_file',
      'compile_project',
      'get_compile_result',
      'view_compiled_pdf_page',
      'view_compiled_pdf_overview',
      'search_compiled_pdf',
      'resolve_pdf_block',
      'diff_compiled_pdf',
      'inspect_compiled_style',
      'get_project_settings',
      'configure_appearance_settings',
      'configure_compiler_settings',
      'configure_editor_settings',
      'list_available_settings',
      'highlight_in_pdf',
    ]

    expect(names).to.deep.equal(expected)
    expect(specs).to.have.lengthOf(22)

    // Verify parameter schemas for settings specs
    const compSpec = specs.find(s => s.name === 'configure_compiler_settings')
    expect(compSpec.parameters.properties).to.have.all.keys(
      'compiler',
      'imageName',
      'rootDocPath',
      'draft',
      'stopOnFirstError'
    )

    const appSpec = specs.find(s => s.name === 'configure_appearance_settings')
    expect(appSpec.parameters.properties).to.have.all.keys(
      'overallTheme',
      'editorTheme',
      'editorLightTheme',
      'editorDarkTheme',
      'darkModePdf',
      'fontSize',
      'fontFamily',
      'lineHeight'
    )

    const edSpec = specs.find(s => s.name === 'configure_editor_settings')
    expect(edSpec.parameters.properties).to.have.all.keys(
      'mode',
      'autoComplete',
      'autoPairDelimiters',
      'syntaxValidation',
      'pdfViewer',
      'mathPreview',
      'breadcrumbs',
      'editorTabs',
      'spellCheckLanguage'
    )
  })

  it('keeps the tool schemas lean', function () {
    const specs = tools.getToolSpecs()
    const search = specs.find(s => s.name === 'search_text')
    expect(search.parameters.properties).to.not.have.property('path')
    const appearance = specs.find(
      s => s.name === 'configure_appearance_settings'
    )
    expect(
      appearance.parameters.properties.editorTheme.description.length
    ).to.be.lessThan(120)
    const available = specs.find(s => s.name === 'list_available_settings')
    expect(available.description.length).to.be.lessThan(200)
  })

  it('search_text still honours a path argument', async function () {
    const res = await tools.execute(
      'search_text',
      { query: 'no match', path: 'chapters/*.tex' },
      { projectId: 'p1', userId: '012345678901234567890123' }
    )
    expect(res.hits.map(hit => hit.path)).to.deep.equal(['chapters/intro.tex'])
  })

  it('rejects execution when userId is missing or invalid without falling back to owner_ref', async function () {
    const customTools = new AiAssistTools({
      projectGetter: {
        getProject: sinon
          .stub()
          .resolves({ owner_ref: '507f1f77bcf86cd799439011' }),
      },
    })

    const result = await customTools.execute(
      'edit_file',
      { path: 'main.tex', oldText: 'a', newText: 'b' },
      {
        projectId: '507f1f77bcf86cd799439012',
        userId: null,
      }
    )

    expect(result.error).to.include('user')
    expect(customTools.projectGetter.getProject.called).to.be.false
  })

  it('rejects path traversal attempts in read_file and edit_file', async function () {
    const customTools = new AiAssistTools()
    const badPaths = ['../../etc/passwd', '../secret.tex', '/../root.tex']

    for (const path of badPaths) {
      const readResult = await customTools.execute(
        'read_file',
        { path },
        {
          projectId: '507f1f77bcf86cd799439012',
          userId: '507f1f77bcf86cd799439011',
        }
      )
      expect(readResult.error, `read_file should reject ${path}`).to.include(
        'traversal'
      )

      const editResult = await customTools.execute(
        'edit_file',
        { path, oldText: 'x', newText: 'y' },
        {
          projectId: '507f1f77bcf86cd799439012',
          userId: '507f1f77bcf86cd799439011',
        }
      )
      expect(editResult.error, `edit_file should reject ${path}`).to.include(
        'traversal'
      )
    }
  })

  describe('edit planning', function () {
    const ctx = { projectId: 'p1', userId: '012345678901234567890123' }

    it('checkEdit accepts an edit whose anchor is unique, without writing', async function () {
      const res = await tools.checkEdit(
        { path: 'main.tex', oldText: 'target text', newText: 'x' },
        ctx
      )
      expect(res.status).to.equal('ok')
      expect(res.path).to.equal('main.tex')
      expect(res.oldText).to.equal('target text')
      expect(res.newText).to.equal('x')
      expect(res.startLine).to.be.a('number')
      expect(mockDocUpdater.setDocument.called).to.equal(false)
    })

    it('checkEdit reports noMatch when the anchor is nowhere in the project', async function () {
      const res = await tools.checkEdit(
        { path: 'main.tex', oldText: 'nope', newText: 'x' },
        ctx
      )
      expect(res.status).to.equal('noMatch')
      expect(res.error).to.be.a('string')
    })

    it('checkEdit reports noMatch for a whitespace-only anchor the range lacks', async function () {
      const res = await tools.checkEdit(
        { path: 'main.tex', oldText: ' ', newText: ' ', startLine: 1 },
        ctx
      )
      expect(res.status).to.equal('noMatch')
    })

    it('checkEdit reports ambiguous with the match count', async function () {
      const res = await tools.checkEdit(
        { path: 'main.tex', oldText: 'line', newText: 'x' },
        ctx
      )
      expect(res.status).to.equal('ambiguous')
      expect(res.matches).to.equal(3)
    })

    it('checkEdit rejects path traversal', async function () {
      const res = await tools.checkEdit(
        { path: '../secret.tex', oldText: 'a', newText: 'b' },
        ctx
      )
      expect(res.status).to.equal('error')
      expect(res.error).to.include('traversal')
    })

    it('edit_file returns a noMatch status instead of a bare error', async function () {
      const res = await tools.execute(
        'edit_file',
        { path: 'main.tex', oldText: 'nope', newText: 'x' },
        ctx
      )
      expect(res.status).to.equal('noMatch')
      expect(mockDocUpdater.setDocument.called).to.equal(false)
    })

    it('sanitizes line-number prefixes from newText in edit_file', async function () {
      const result = await tools.execute(
        'edit_file',
        {
          path: 'main.tex',
          oldText: 'line 2: target text',
          newText: '2: line 2: replaced text',
        },
        ctx
      )
      expect(result.status).to.equal('applied')
      expect(mockDocUpdater.setDocument.calledOnce).to.be.true
      const lines = mockDocUpdater.setDocument.firstCall.args[3]
      expect(lines).to.deep.equal(['line 1', 'line 2: replaced text', 'line 3'])
    })

    it('edit_file deletes a line range without oldText', async function () {
      const res = await tools.execute(
        'edit_file',
        { path: 'main.tex', startLine: 2, endLine: 3, newText: '' },
        ctx
      )
      expect(res.status).to.equal('applied')
      expect(mockDocUpdater.setDocument.firstCall.args[3]).to.deep.equal([
        'line 1',
      ])
      expect(res).to.include({
        startLine: 2,
        endLine: null,
        lineDelta: -2,
        excerpt: '1: line 1',
      })
    })

    it('edit_file reports the new line range, the line shift and the lines around it', async function () {
      const res = await tools.execute(
        'edit_file',
        { path: 'main.tex', oldText: 'target text', newText: 'a\nb' },
        ctx
      )

      expect(res.status).to.equal('applied')
      expect(res).to.include({
        path: 'main.tex',
        startLine: 2,
        endLine: 3,
        lineDelta: 1,
      })
      expect(res.excerpt).to.equal('1: line 1\n2: line 2: a\n3: b\n4: line 3')
    })

    it('checkEdit uses startLine to pick one of two identical anchors', async function () {
      mockDocUpdater.getDocument = sinon
        .stub()
        .resolves({ lines: ['a', 'dup', 'b', 'dup'] })

      const res = await tools.checkEdit(
        { path: 'main.tex', oldText: 'dup', newText: 'X', startLine: 4 },
        ctx
      )

      expect(res.status).to.equal('ok')
      expect(res.startLine).to.equal(4)
    })

    it('checkEdit accepts startLine sent as a string', async function () {
      mockDocUpdater.getDocument = sinon
        .stub()
        .resolves({ lines: ['a', 'dup', 'b', 'dup'] })

      const res = await tools.checkEdit(
        { path: 'main.tex', oldText: 'dup', newText: 'X', startLine: '4' },
        ctx
      )

      expect(res.status).to.equal('ok')
      expect(res.startLine).to.equal(4)
    })

    it('does not move an edit to another file on a whitespace-only match', async function () {
      const res = await tools.checkEdit(
        { path: 'main.tex', oldText: 'no   match  here', newText: 'x' },
        ctx
      )

      expect(res.status).to.equal('noMatch')
    })

    it('moves an edit to the file that contains the exact anchor', async function () {
      const res = await tools.checkEdit(
        { path: 'main.tex', oldText: 'no match here', newText: 'x' },
        ctx
      )

      expect(res.status).to.equal('ok')
      expect(res.path).to.equal('chapters/intro.tex')
    })

    it('endDocumentLine finds the last uncommented \\end{document}', function () {
      expect(endDocumentLine('a\n\\end{document}\n')).to.equal(2)
      expect(endDocumentLine('a\n% \\end{document}\n')).to.equal(null)
      expect(endDocumentLine('\\end{document} % done')).to.equal(1)
      expect(endDocumentLine('no end here')).to.equal(null)
    })

    it('refuses to append after \\end{document}', async function () {
      mockDocUpdater.getDocument = sinon
        .stub()
        .resolves({ lines: ['\\begin{document}', 'x', '\\end{document}'] })

      const res = await tools.checkEdit(
        { path: 'main.tex', oldText: '', newText: 'y' },
        ctx
      )

      expect(res.status).to.equal('error')
      expect(res.error).to.include('line 3')
    })

    it('still appends to a file without \\end{document}', async function () {
      const res = await tools.checkEdit(
        { path: 'main.tex', oldText: '', newText: 'line 4' },
        ctx
      )

      expect(res.status).to.equal('ok')
    })

    it('checkEdit resolves a line range to the text it replaces, and re-applies from that', async function () {
      const args = {
        path: 'main.tex',
        startLine: 1,
        endLine: 2,
        newText: 'new',
      }
      const plan = await tools.checkEdit(args, ctx)
      expect(plan).to.include({
        status: 'ok',
        oldText: 'line 1\nline 2: target text',
        newText: 'new',
        startLine: 1,
      })

      // The run loop executes with the resolved oldText alongside the original range.
      const res = await tools.execute(
        'edit_file',
        { ...args, oldText: plan.oldText },
        ctx
      )
      expect(res.status).to.equal('applied')
      expect(mockDocUpdater.setDocument.firstCall.args[3]).to.deep.equal([
        'new',
        'line 3',
      ])
    })

    it('edit_file rejects a line range that starts past the end of the file', async function () {
      const res = await tools.checkEdit(
        { path: 'main.tex', startLine: 9, endLine: 12, newText: '' },
        ctx
      )
      expect(res.status).to.equal('error')
      expect(res.error).to.include('3 lines')
    })

    it('edit_file appends when the line range starts one past the last line', async function () {
      const res = await tools.execute(
        'edit_file',
        { path: 'main.tex', startLine: 4, endLine: 4, newText: 'line 4' },
        ctx
      )
      expect(res.status).to.equal('applied')
      expect(mockDocUpdater.setDocument.firstCall.args[3]).to.deep.equal([
        'line 1',
        'line 2: target text',
        'line 3',
        'line 4',
      ])
    })

    it('edit_file schema lets a line range stand in for oldText', function () {
      const editSpec = tools.getToolSpecs().find(s => s.name === 'edit_file')
      expect(editSpec.parameters.required).to.deep.equal(['path', 'newText'])
    })

    it('edit_file schema describes oldText: "" strictly for appending, not replacing', function () {
      const specs = tools.getToolSpecs()
      const editSpec = specs.find(s => s.name === 'edit_file')
      expect(editSpec.description).to.not.include(
        'empty string "" if replacing the entire file'
      )
      expect(editSpec.parameters.properties.oldText.description).to.include(
        'append'
      )
      expect(editSpec.parameters.properties).to.have.property('startLine')
      expect(editSpec.parameters.properties).to.have.property('endLine')
    })

    it('reports error deltas and regressed flag in compile_project', async function () {
      const validUserId = '012345678901234567890123'
      const log1 = [
        './main.tex:10: Undefined control sequence.',
        'l.10 \\foo',
      ].join('\n')

      tools.clsiManager = {
        getOutputFileStream: sinon.stub().resolves([Buffer.from(log1)]),
      }
      mockCompileManager.compile.resolves({
        status: 'failure',
        buildId: 'b1',
        clsiServerId: 's1',
        outputFiles: [{ path: 'output.log' }],
      })

      const firstCompile = await tools.execute(
        'compile_project',
        {},
        { projectId: 'p1', userId: validUserId }
      )
      expect(firstCompile.status).to.equal('failure')
      expect(firstCompile.errorCount).to.equal(1)
      expect(firstCompile.errorDelta).to.equal(0)
      expect(firstCompile.primaryError.message).to.equal(
        'Undefined control sequence.'
      )

      // Second compile introduces an additional error
      const log2 = [
        './main.tex:15: Undefined control sequence.',
        'l.15 \\foo',
        './main.tex:20: Missing $ inserted.',
        'l.20 $',
      ].join('\n')
      tools.clsiManager.getOutputFileStream = sinon
        .stub()
        .resolves([Buffer.from(log2)])

      const secondCompile = await tools.execute(
        'compile_project',
        {},
        { projectId: 'p1', userId: validUserId }
      )
      expect(secondCompile.errorCount).to.equal(2)
      expect(secondCompile.errorDelta).to.equal(1)
      expect(secondCompile.newErrorsCount).to.equal(1)
      expect(secondCompile.regressed).to.equal(true)
      expect(secondCompile.message).to.match(/WARNING: Compilation worsened/i)
      expect(secondCompile.cascadingErrorsCount).to.equal(1)
    })

    it('defaults includeRaw to true in get_compile_result', async function () {
      const validUserId = '012345678901234567890123'
      const log = [
        './main.tex:10: Undefined control sequence.',
        'l.10 \\foo',
      ].join('\n')

      tools.clsiManager = {
        getOutputFileStream: sinon.stub().resolves([Buffer.from(log)]),
      }
      mockCompileManager.compile.resolves({
        status: 'failure',
        buildId: 'b1',
        clsiServerId: 's1',
        outputFiles: [{ path: 'output.log' }],
      })

      await tools.execute(
        'compile_project',
        {},
        { projectId: 'p1', userId: validUserId }
      )
      const res = await tools.execute(
        'get_compile_result',
        {},
        { projectId: 'p1', userId: validUserId }
      )

      expect(res.status).to.equal('failure')
      expect(res.primaryError).to.not.equal(null)
      expect(res.errors[0].excerpt).to.include('l.10 \\foo')
    })

    it('gives each error its own log excerpt, even when messages repeat', async function () {
      const validUserId = '012345678901234567890123'
      const log = [
        './main.tex:3: Undefined control sequence.',
        'l.3 \\foo',
        '',
        './main.tex:9: Undefined control sequence.',
        'l.9 \\bar',
      ].join('\n')
      tools.clsiManager = {
        getOutputFileStream: sinon.stub().resolves([Buffer.from(log)]),
      }
      mockCompileManager.compile.resolves({
        status: 'failure',
        buildId: 'b1',
        clsiServerId: 's1',
        outputFiles: [{ path: 'output.log' }],
      })

      const res = await tools.execute(
        'compile_project',
        {},
        { projectId: 'p1', userId: validUserId }
      )

      expect(res.errors).to.have.length(2)
      expect(res.errors[0].excerpt).to.equal('l.3 \\foo')
      expect(res.errors[1].excerpt).to.equal('l.9 \\bar')
    })

    it('never attaches excerpts to warnings and strips them when includeRaw is false', async function () {
      const validUserId = '012345678901234567890123'
      const log = [
        'LaTeX Warning: Reference `a` on page 1 undefined on input line 4.',
        './main.tex:3: Undefined control sequence.',
        'l.3 \\foo',
      ].join('\n')
      tools.clsiManager = {
        getOutputFileStream: sinon.stub().resolves([Buffer.from(log)]),
      }
      mockCompileManager.compile.resolves({
        status: 'failure',
        buildId: 'b1',
        clsiServerId: 's1',
        outputFiles: [{ path: 'output.log' }],
      })
      await tools.execute(
        'compile_project',
        {},
        { projectId: 'p1', userId: validUserId }
      )

      const all = await tools.execute(
        'get_compile_result',
        {},
        { projectId: 'p1', userId: validUserId }
      )
      expect(all.warnings[0]).to.not.have.property('excerpt')
      expect(all.errors[0].excerpt).to.equal('l.3 \\foo')

      const bare = await tools.execute(
        'get_compile_result',
        { includeRaw: false },
        { projectId: 'p1', userId: validUserId }
      )
      expect(bare.errors[0]).to.not.have.property('excerpt')
    })

    it('get_compile_result never compiles', async function () {
      const validUserId = '012345678901234567890123'
      const res = await tools.execute(
        'get_compile_result',
        {},
        { projectId: 'never-compiled', userId: validUserId }
      )

      expect(res.status).to.equal('none')
      expect(res.message).to.include('compile_project')
      expect(mockCompileManager.compile.called).to.equal(false)
    })

    it('remembers compiles for at most 100 projects and keeps no raw log', async function () {
      const validUserId = '012345678901234567890123'
      for (let index = 0; index <= 100; index++) {
        await tools.execute(
          'compile_project',
          {},
          { projectId: `p${index}`, userId: validUserId }
        )
      }

      expect(tools.lastCompileResult.size).to.equal(100)
      expect(tools.lastCompileResult.has('p0')).to.equal(false)
      expect(tools.lastCompileResult.get('p100')).to.not.have.property('rawLog')
    })
  })
})

describe('project instructions (AGENTS.md)', function () {
  function toolsWith(docs, { failDocs = false } = {}) {
    return new AiAssistTools({
      docUpdater: { flushProjectToMongo: async () => {} },
      entityHandler: {
        getAllDocs: async () => {
          if (failDocs) throw new Error('mongo down')
          return docs
        },
        getAllFiles: async () => ({}),
      },
      projectGetter: { getProject: async () => ({}) },
    })
  }
  const doc = lines => ({ _id: 'd1', name: 'x', lines })

  it('reads the root AGENTS.md whatever its case', async function () {
    const tools = toolsWith({ '/Agents.MD': doc(['Use British spelling.']) })
    expect(await tools.getProjectInstructions('p1')).to.deep.equal({
      path: 'Agents.MD',
      text: 'Use British spelling.',
    })
  })

  it('reads full file content without size limit', async function () {
    const longLines = Array.from({ length: 5000 }, (_, i) => `Line ${i}`)
    const tools = toolsWith({ '/AGENTS.md': doc(longLines) })
    const result = await tools.getProjectInstructions('p1')
    expect(result.path).to.equal('AGENTS.md')
    expect(result.text).to.equal(longLines.join('\n'))
  })

  it('ignores an AGENTS.md in a folder', async function () {
    const tools = toolsWith({ '/chapters/AGENTS.md': doc(['x']) })
    expect(await tools.getProjectInstructions('p2')).to.equal(null)
  })

  it('treats a blank file as none', async function () {
    const tools = toolsWith({ '/AGENTS.md': doc(['', '   ']) })
    expect(await tools.getProjectInstructions('p3')).to.equal(null)
  })

  it('returns null when the project cannot be read', async function () {
    const tools = toolsWith({}, { failDocs: true })
    expect(await tools.getProjectInstructions('p5')).to.equal(null)
  })
})

describe('parsePdfBoxes', function () {
  it('keeps at most 200 boxes', function () {
    const boxes = Array.from({ length: 500 }, () => ({
      page: 1,
      h: 1,
      v: 1,
      width: 1,
      height: 1,
    }))
    expect(parsePdfBoxes(boxes)).to.have.lengthOf(200)
  })

  it('drops boxes whose numbers are not bounded finite numbers', function () {
    const boxes = parsePdfBoxes([
      { page: 1, h: 1, v: 1, width: 1, height: 1 },
      { page: 1, h: '1', v: 1, width: 1, height: 1 },
      { page: 1, h: 1e9, v: 1, width: 1, height: 1 },
      { page: 1e9, h: 1, v: 1, width: 1, height: 1 },
      { page: 1, h: 1, v: 1, width: -1, height: 1 },
    ])
    expect(boxes).to.have.lengthOf(1)
  })
})
