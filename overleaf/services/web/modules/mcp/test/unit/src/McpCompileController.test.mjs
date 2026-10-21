import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Readable, Writable } from 'node:stream'
import Errors from '../../../../../app/src/Features/Errors/Errors.js'

const CompileManager = {
  promises: {
    compile: vi.fn(),
    deleteAuxFiles: vi.fn(),
    wordCount: vi.fn(),
    syncTeX: vi.fn(),
  },
}
const ClsiManager = {
  promises: { getOutputFileStream: vi.fn() },
}
const ProjectGetter = { promises: { getProject: vi.fn() } }
const AuthorizationManager = {
  promises: { canUserWriteProjectContent: vi.fn(async () => true) },
}
vi.mock(
  '../../../../../app/src/Features/Authorization/AuthorizationManager.mjs',
  () => ({ default: AuthorizationManager })
)
const ProjectLocator = { promises: { findElementByPath: vi.fn() } }
const ProjectEntityHandler = {
  promises: {
    getDocPathFromProjectByDocId: vi.fn(),
    getAllDocs: vi.fn(),
    getAllFiles: vi.fn(),
  },
}

vi.mock('../../../../../app/src/Features/Compile/CompileManager.mjs', () => ({
  default: CompileManager,
}))
vi.mock('../../../../../app/src/Features/Compile/ClsiManager.mjs', () => ({
  default: ClsiManager,
}))
vi.mock('../../../../../app/src/Features/Project/ProjectGetter.mjs', () => ({
  default: ProjectGetter,
}))
vi.mock('../../../../../app/src/Features/Project/ProjectLocator.mjs', () => ({
  default: ProjectLocator,
}))
vi.mock(
  '../../../../../app/src/Features/Project/ProjectEntityHandler.mjs',
  () => ({ default: ProjectEntityHandler })
)
const PdfPageInspector = {
  inspectPdfPage: vi.fn(),
  overviewPdfPages: vi.fn(),
  searchPdfText: vi.fn(),
  resolveBlock: vi.fn(),
}
vi.mock(
  '../../../../../app/src/Features/PdfInspection/PdfPageInspector.mjs',
  async importOriginal => ({
    ...(await importOriginal()),
    default: PdfPageInspector,
  })
)
const PdfVisualDiff = { diffBuilds: vi.fn(), rememberBuildPages: vi.fn(async () => ({ ok: true })) }
vi.mock(
  '../../../../../app/src/Features/PdfInspection/PdfVisualDiff.mjs',
  async importOriginal => ({
    ...(await importOriginal()),
    default: PdfVisualDiff,
  })
)

const { default: McpCompileController } = await import(
  '../../../app/src/McpCompileController.mjs'
)
const { resetBuildRecords, rememberBuild, findBuild } = await import(
  '../../../app/src/McpBuildRecords.mjs'
)
const { PdfPageError, PDF_PAGE_ERRORS } = await import(
  '../../../../../app/src/Features/PdfInspection/PdfPageInspector.mjs'
)

function res() {
  return {
    statusCode: 200,
    body: null,
    status(s) {
      this.statusCode = s
      return this
    },
    json(b) {
      this.body = b
      return this
    },
  }
}

beforeEach(() => vi.clearAllMocks())

describe('McpCompileController.compile', () => {
  it('passes compiler/draft options and returns a compact result', async () => {
    CompileManager.promises.compile.mockResolvedValue({
      status: 'success',
      outputFiles: [
        { path: 'output.pdf', build: 'b1', url: '/x' },
        { path: 'output.log', build: 'b1', url: '/y' },
      ],
    })
    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      body: { compiler: 'xelatex', draft: true },
    }
    const r = res()
    await McpCompileController.compile(req, r)
    expect(CompileManager.promises.compile).toHaveBeenCalledWith(
      'p1',
      'u1',
      expect.objectContaining({ compiler: 'xelatex', draft: true })
    )
    expect(r.body.status).toBe('success')
    expect(r.body.pdf).toEqual({ build: 'b1', path: 'output.pdf' })
    expect(r.body.outputFiles).toEqual([
      { path: 'output.pdf', build: 'b1' },
      { path: 'output.log', build: 'b1' },
    ])
  })

  it('returns null pdf when no output.pdf produced', async () => {
    CompileManager.promises.compile.mockResolvedValue({
      status: 'failure',
      outputFiles: [],
    })
    const req = { mcpUserId: 'u1', params: { projectId: 'p1' }, body: {} }
    const r = res()
    await McpCompileController.compile(req, r)
    expect(r.body.pdf).toBe(null)
  })
})

describe('McpCompileController.compile result', () => {
  it('returns the build id, compile server and validation problems', async () => {
    CompileManager.promises.compile.mockResolvedValue({
      status: 'validation-problems',
      buildId: 'b7',
      clsiServerId: 's3',
      validationProblems: { mainFile: 'no main file specified' },
      outputFiles: [],
    })
    const r = res()
    await McpCompileController.compile(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, body: {} },
      r
    )
    expect(r.body.buildId).toBe('b7')
    expect(r.body.clsiServerId).toBe('s3')
    expect(r.body.validationProblems).toEqual({
      mainFile: 'no main file specified',
    })
  })

  it('asks LaTeX for file:line errors on every compile', async () => {
    CompileManager.promises.compile.mockResolvedValue({
      status: 'success',
      outputFiles: [],
    })
    await McpCompileController.compile(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, body: {} },
      res()
    )
    expect(CompileManager.promises.compile).toHaveBeenCalledWith(
      'p1',
      'u1',
      expect.objectContaining({ fileLineErrors: true })
    )
  })

  it('resolves rootDocPath to a text document and passes it as the root', async () => {
    ProjectLocator.promises.findElementByPath.mockResolvedValue({
      element: { _id: 'd9' },
      type: 'doc',
      folder: {},
    })
    CompileManager.promises.compile.mockResolvedValue({
      status: 'success',
      outputFiles: [],
    })
    const r = res()
    await McpCompileController.compile(
      {
        mcpUserId: 'u1',
        params: { projectId: 'p1' },
        body: { rootDocPath: '/thesis/main.tex' },
      },
      r
    )
    expect(ProjectLocator.promises.findElementByPath).toHaveBeenCalledWith({
      project_id: 'p1',
      path: '/thesis/main.tex',
    })
    expect(CompileManager.promises.compile).toHaveBeenCalledWith(
      'p1',
      'u1',
      expect.objectContaining({
        rootDoc_id: 'd9',
        rootResourcePath: 'thesis/main.tex',
      })
    )
    expect(r.body.rootDocPath).toBe('thesis/main.tex')
  })

  it('rejects a rootDocPath that names a folder', async () => {
    ProjectLocator.promises.findElementByPath.mockResolvedValue({
      element: {},
      type: 'folder',
      folder: null,
    })
    const r = res()
    await McpCompileController.compile(
      {
        mcpUserId: 'u1',
        params: { projectId: 'p1' },
        body: { rootDocPath: '/thesis' },
      },
      r
    )
    expect(r.statusCode).toBe(400)
    expect(r.body.code).toBe('validation_error')
    expect(CompileManager.promises.compile).not.toHaveBeenCalled()
  })

  it('rejects a rootDocPath that does not exist', async () => {
    ProjectLocator.promises.findElementByPath.mockRejectedValue(
      new Errors.NotFoundError('element not found in project')
    )
    const r = res()
    await McpCompileController.compile(
      {
        mcpUserId: 'u1',
        params: { projectId: 'p1' },
        body: { rootDocPath: '/missing.tex' },
      },
      r
    )
    expect(r.statusCode).toBe(400)
    expect(CompileManager.promises.compile).not.toHaveBeenCalled()
  })

  it('reports the requested compiler, used for this compile only', async () => {
    CompileManager.promises.compile.mockResolvedValue({
      status: 'success',
      outputFiles: [],
    })
    const r = res()
    await McpCompileController.compile(
      {
        mcpUserId: 'u1',
        params: { projectId: 'p1' },
        body: { compiler: 'xelatex' },
      },
      r
    )
    expect(r.body.compiler).toBe('xelatex')
    expect(r.body).not.toHaveProperty('compilerRequested')
  })

  it('records the requested compiler in the build fingerprint', async () => {
    resetBuildRecords()
    ProjectGetter.promises.getProject.mockResolvedValue({
      compiler: 'pdflatex',
      rootDoc_id: 'd1',
      rootFolder: [],
    })
    ProjectEntityHandler.promises.getAllDocs.mockResolvedValue({})
    ProjectEntityHandler.promises.getAllFiles.mockResolvedValue({})
    CompileManager.promises.compile.mockResolvedValue({
      status: 'success',
      buildId: 'b-custom-compiler',
      outputFiles: [],
    })
    const r = res()
    await McpCompileController.compile(
      {
        mcpUserId: 'u1',
        params: { projectId: 'p1' },
        body: { compiler: 'xelatex' },
      },
      r
    )
    const record = findBuild('p1', 'b-custom-compiler')
    expect(record).not.toBeNull()
    expect(record.fingerprint.compiler).toBe('xelatex')
  })

  it('records project default compiler in fingerprint when not overridden', async () => {
    resetBuildRecords()
    ProjectGetter.promises.getProject.mockResolvedValue({
      compiler: 'lualatex',
      rootDoc_id: 'd1',
      rootFolder: [],
    })
    ProjectEntityHandler.promises.getAllDocs.mockResolvedValue({})
    ProjectEntityHandler.promises.getAllFiles.mockResolvedValue({})
    CompileManager.promises.compile.mockResolvedValue({
      status: 'success',
      buildId: 'b-default-compiler',
      outputFiles: [],
    })
    const r = res()
    await McpCompileController.compile(
      {
        mcpUserId: 'u1',
        params: { projectId: 'p1' },
        body: {},
      },
      r
    )
    const record = findBuild('p1', 'b-default-compiler')
    expect(record).not.toBeNull()
    expect(record.fingerprint.compiler).toBe('lualatex')
  })
})

describe('McpCompileController.getLog window', () => {
  it('reads a window starting at fromLine and reports the line span', async () => {
    ClsiManager.promises.getOutputFileStream.mockResolvedValue(
      Readable.from(['l1\nl2\nl3\nl4\nl5\n'])
    )
    const r = res()
    await McpCompileController.getLog(
      {
        mcpUserId: 'u1',
        params: { projectId: 'p1' },
        query: { buildId: '0a1b-2c3d', fromLine: '2', maxLines: '2' },
      },
      r
    )
    expect(r.body.log).toBe('l2\nl3')
    expect(r.body.startLine).toBe(2)
    expect(r.body.endLine).toBe(3)
    expect(r.body.totalLines).toBe(5)
    expect(r.body.truncated).toBe(true)
  })

  it('reports no span when fromLine is past the end of the log', async () => {
    ClsiManager.promises.getOutputFileStream.mockResolvedValue(
      Readable.from(['a\nb\n'])
    )
    const r = res()
    await McpCompileController.getLog(
      {
        mcpUserId: 'u1',
        params: { projectId: 'p1' },
        query: { buildId: '0a1b-2c3d', fromLine: '50' },
      },
      r
    )
    expect(r.body.log).toBe('')
    expect(r.body.startLine).toBe(null)
    expect(r.body.endLine).toBe(null)
    expect(r.body.totalLines).toBe(2)
  })
})

describe('McpCompileController.getDiagnostics', () => {
  const LOG = [
    '(./main.tex',
    './chapters/intro.tex:12: Undefined control sequence.',
    'l.12 \\foo',
    '         bar',
    '',
    "LaTeX Warning: Reference `a' on page 1 undefined on input line 2.",
    'LaTeX Warning: Label(s) may have changed. Rerun to get cross-references right.',
    '',
  ].join('\n')
  const BLG = [
    'This is BibTeX, Version 0.99d',
    "Warning--I didn't find a database entry for \"x\"",
    '--line 3 of file main.tex',
  ].join('\n')

  function outputFiles(files) {
    return async (_p, _u, _s, _b, path) => {
      if (path in files) return Readable.from([files[path]])
      throw new Errors.OutputFileFetchFailedError('missing output file')
    }
  }

  it('parses output.log and output.blg into counts, paths and advice', async () => {
    ClsiManager.promises.getOutputFileStream.mockImplementation(
      outputFiles({ 'output.log': LOG, 'output.blg': BLG })
    )
    ProjectGetter.promises.getProject.mockResolvedValue({
      rootDoc_id: 'd1',
      rootFolder: [],
    })
    ProjectEntityHandler.promises.getDocPathFromProjectByDocId.mockResolvedValue(
      '/main.tex'
    )
    const r = res()
    await McpCompileController.getDiagnostics(
      {
        mcpUserId: 'u1',
        params: { projectId: 'p1' },
        query: { buildId: '0a1b-2c3d', clsiserverid: 's1' },
      },
      r
    )
    expect(ClsiManager.promises.getOutputFileStream).toHaveBeenCalledWith(
      'p1',
      'u1',
      's1',
      '0a1b-2c3d',
      'output.log'
    )
    expect(r.body.logAvailable).toBe(true)
    expect(r.body.rootDocPath).toBe('main.tex')
    expect(r.body.counts.errors).toBe(1)
    expect(r.body.counts.undefinedReferences).toBe(1)
    expect(r.body.counts.warnings).toBe(3)
    expect(r.body.rerunNeeded).toBe(true)
    expect(r.body.errors[0]).toMatchObject({
      source: 'latex',
      file: 'chapters/intro.tex',
      line: 12,
    })
    expect(r.body.warnings.some(w => w.source === 'bibtex')).toBe(true)
    expect(r.body.advice.length).toBeGreaterThan(0)
  })

  it('treats a missing output.blg as a project without a bibliography log', async () => {
    ClsiManager.promises.getOutputFileStream.mockImplementation(
      outputFiles({ 'output.log': LOG })
    )
    ProjectGetter.promises.getProject.mockResolvedValue({
      rootDoc_id: 'd1',
      rootFolder: [],
    })
    ProjectEntityHandler.promises.getDocPathFromProjectByDocId.mockResolvedValue(
      '/main.tex'
    )
    const r = res()
    await McpCompileController.getDiagnostics(
      {
        mcpUserId: 'u1',
        params: { projectId: 'p1' },
        query: { buildId: '0a1b-2c3d' },
      },
      r
    )
    expect(r.statusCode).toBe(200)
    expect(r.body.counts.errors).toBe(1)
  })

  it('reports logAvailable false when the build wrote no log', async () => {
    ClsiManager.promises.getOutputFileStream.mockImplementation(outputFiles({}))
    ProjectGetter.promises.getProject.mockResolvedValue({ rootFolder: [] })
    const r = res()
    await McpCompileController.getDiagnostics(
      {
        mcpUserId: 'u1',
        params: { projectId: 'p1' },
        query: { buildId: '0a1b-2c3d' },
      },
      r
    )
    expect(r.body.logAvailable).toBe(false)
    expect(r.body.counts.errors).toBe(0)
    expect(r.body.errors).toEqual([])
  })

  it('uses a rootDocPath query over the current root document', async () => {
    ClsiManager.promises.getOutputFileStream.mockImplementation(
      outputFiles({ 'output.log': LOG })
    )
    const r = res()
    await McpCompileController.getDiagnostics(
      {
        mcpUserId: 'u1',
        params: { projectId: 'p1' },
        query: { buildId: '0a1b-2c3d', rootDocPath: 'thesis/main.tex' },
      },
      r
    )
    expect(ProjectGetter.promises.getProject).not.toHaveBeenCalled()
    expect(r.body.rootDocPath).toBe('thesis/main.tex')
    expect(r.body.errors[0].file).toBe('thesis/chapters/intro.tex')
  })

  it('rejects a rootDocPath with a parent segment', async () => {
    const r = res()
    await McpCompileController.getDiagnostics(
      {
        mcpUserId: 'u1',
        params: { projectId: 'p1' },
        query: { buildId: '0a1b-2c3d', rootDocPath: '../main.tex' },
      },
      r
    )
    expect(r.statusCode).toBe(400)
    expect(r.body.code).toBe('validation_error')
  })

  it('returns validation_error without a buildId', async () => {
    const r = res()
    await McpCompileController.getDiagnostics(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, query: {} },
      r
    )
    expect(r.statusCode).toBe(400)
    expect(r.body.code).toBe('validation_error')
  })
})

describe('McpCompileController.getLog', () => {
  it('reads the output.log stream and applies maxLines', async () => {
    ClsiManager.promises.getOutputFileStream.mockResolvedValue(
      Readable.from(['l1\nl2\nl3\nl4\n'])
    )
    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      query: { buildId: '0a1b-2c3d', maxLines: '2' },
    }
    const r = res()
    await McpCompileController.getLog(req, r)
    expect(ClsiManager.promises.getOutputFileStream).toHaveBeenCalledWith(
      'p1',
      'u1',
      undefined,
      '0a1b-2c3d',
      'output.log'
    )
    expect(r.body.log).toBe('l3\nl4')
    expect(r.body.truncated).toBe(true)
  })

  it('returns all lines (not truncated) when under maxLines', async () => {
    ClsiManager.promises.getOutputFileStream.mockResolvedValue(
      Readable.from(['a\nb\nc\n'])
    )
    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      query: { buildId: '0a1b-2c3d', maxLines: '10' },
    }
    const r = res()
    await McpCompileController.getLog(req, r)
    expect(r.body.log).toBe('a\nb\nc')
    expect(r.body.truncated).toBe(false)
  })

  it('returns the whole log when maxLines is omitted', async () => {
    const many = Array.from({ length: 5000 }, (_, i) => `line${i}`).join('\n')
    ClsiManager.promises.getOutputFileStream.mockResolvedValue(
      Readable.from([many])
    )
    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      query: { buildId: '0a1b-2c3d' },
    }
    const r = res()
    await McpCompileController.getLog(req, r)
    const lines = r.body.log.split('\n')
    expect(lines).toHaveLength(5000)
    expect(lines[0]).toBe('line0')
    expect(lines[lines.length - 1]).toBe('line4999')
    expect(r.body.startLine).toBe(1)
    expect(r.body.totalLines).toBe(5000)
    expect(r.body.truncated).toBe(false)
  })

  it('maps a transient upstream failure to 502', async () => {
    const err = new Error('bad gateway')
    err.info = { status: 503 }
    ClsiManager.promises.getOutputFileStream.mockRejectedValue(err)
    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      query: { buildId: '0a1b-2c3d' },
    }
    const r = res()
    await McpCompileController.getLog(req, r)
    expect(r.statusCode).toBe(502)
  })

  it('returns validation_error when buildId missing', async () => {
    const req = { mcpUserId: 'u1', params: { projectId: 'p1' }, query: {} }
    const r = res()
    await McpCompileController.getLog(req, r)
    expect(r.statusCode).toBe(400)
    expect(r.body.code).toBe('validation_error')
  })

  it('returns not_found when the log fetch fails', async () => {
    ClsiManager.promises.getOutputFileStream.mockRejectedValue(
      new Errors.OutputFileFetchFailedError('nope')
    )
    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      query: { buildId: '0a1b-2c3d' },
    }
    const r = res()
    await McpCompileController.getLog(req, r)
    expect(r.statusCode).toBe(404)
  })
})

describe('McpCompileController.getPdf', () => {
  it('streams the output.pdf bytes with a pdf content-type', async () => {
    ClsiManager.promises.getOutputFileStream.mockResolvedValue(
      Readable.from(['%PDF-1.4 body'])
    )
    const chunks = []
    const headers = {}
    const sink = new Writable({
      write(chunk, enc, cb) {
        chunks.push(chunk)
        cb()
      },
    })
    sink.setHeader = (k, v) => {
      headers[k] = v
    }
    sink.headersSent = false
    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      query: { buildId: '0a1b-2c3d' },
    }
    await McpCompileController.getPdf(req, sink)
    await new Promise(resolve => sink.on('finish', resolve))
    expect(ClsiManager.promises.getOutputFileStream).toHaveBeenCalledWith(
      'p1',
      'u1',
      undefined,
      '0a1b-2c3d',
      'output.pdf'
    )
    expect(headers['Content-Type']).toBe('application/pdf')
    expect(Buffer.concat(chunks).toString()).toBe('%PDF-1.4 body')
  })

  it('returns validation_error without a buildId', async () => {
    const req = { mcpUserId: 'u1', params: { projectId: 'p1' }, query: {} }
    const r = res()
    await McpCompileController.getPdf(req, r)
    expect(r.statusCode).toBe(400)
    expect(r.body.code).toBe('validation_error')
  })

  it('returns validation_error for a malformed buildId', async () => {
    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      query: { buildId: 'not a build id' },
    }
    const r = res()
    await McpCompileController.getPdf(req, r)
    expect(r.statusCode).toBe(400)
    expect(r.body.code).toBe('validation_error')
  })

  it('returns not_found when the build has no pdf', async () => {
    ClsiManager.promises.getOutputFileStream.mockRejectedValue(
      new Errors.OutputFileFetchFailedError('nope')
    )
    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      query: { buildId: '0a1b-2c3d' },
    }
    const r = res()
    await McpCompileController.getPdf(req, r)
    expect(r.statusCode).toBe(404)
  })
})

describe('McpCompileController.clearCache', () => {
  it('delegates to deleteAuxFiles', async () => {
    CompileManager.promises.deleteAuxFiles.mockResolvedValue()
    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      query: { clsiserverid: 'c1' },
    }
    const r = res()
    await McpCompileController.clearCache(req, r)
    expect(CompileManager.promises.deleteAuxFiles).toHaveBeenCalledWith(
      'p1',
      'u1',
      'c1'
    )
    expect(r.body).toEqual({ status: 'ok' })
  })
})

describe('McpCompileController.wordCount', () => {
  it('returns the count payload', async () => {
    CompileManager.promises.wordCount.mockResolvedValue({ textWords: 1234 })
    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      query: {},
    }
    const r = res()
    await McpCompileController.wordCount(req, r)
    expect(CompileManager.promises.wordCount).toHaveBeenCalledWith(
      'p1',
      'u1',
      false,
      undefined
    )
    expect(r.body.wordCount.textWords).toBe(1234)
  })
})

describe('McpCompileController.synctex', () => {
  it('syncs from code when no page is given', async () => {
    CompileManager.promises.syncTeX.mockResolvedValue({ pdf: [] })
    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      query: {
        file: 'main.tex',
        line: '10',
        column: '2',
        buildId: '0a1b-2c3d',
        editorId: 'e1',
      },
    }
    const r = res()
    await McpCompileController.synctex(req, r)
    expect(CompileManager.promises.syncTeX).toHaveBeenCalledWith(
      'p1',
      'u1',
      expect.objectContaining({
        direction: 'code',
        validatedOptions: expect.objectContaining({
          file: 'main.tex',
          line: 10,
          column: 2,
          buildId: '0a1b-2c3d',
          editorId: 'e1',
        }),
      })
    )
    expect(r.body.synctex).toEqual({ pdf: [] })
  })

  it('returns 400 for code direction without a line', async () => {
    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      query: { file: 'main.tex' },
    }
    const r = res()
    await McpCompileController.synctex(req, r)
    expect(r.statusCode).toBe(400)
    expect(CompileManager.promises.syncTeX).not.toHaveBeenCalled()
  })

  it('returns 400 for pdf direction without h', async () => {
    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      query: { page: '3', v: '2.5' },
    }
    const r = res()
    await McpCompileController.synctex(req, r)
    expect(r.statusCode).toBe(400)
    expect(CompileManager.promises.syncTeX).not.toHaveBeenCalled()
  })

  it('returns 400 when neither code nor pdf params are present', async () => {
    const req = { mcpUserId: 'u1', params: { projectId: 'p1' }, query: {} }
    const r = res()
    await McpCompileController.synctex(req, r)
    expect(r.statusCode).toBe(400)
  })

  it('syncs from pdf when a page is given', async () => {
    CompileManager.promises.syncTeX.mockResolvedValue({ code: [] })
    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      query: { page: '3', h: '1.5', v: '2.5', buildId: '0a1b-2c3d', editorId: 'e1' },
    }
    const r = res()
    await McpCompileController.synctex(req, r)
    expect(CompileManager.promises.syncTeX).toHaveBeenCalledWith(
      'p1',
      'u1',
      expect.objectContaining({
        direction: 'pdf',
        validatedOptions: expect.objectContaining({ page: 3, h: 1.5, v: 2.5 }),
      })
    )
  })
})

describe('McpCompileController.getPdfPage', () => {
  const BUILD_ID = '18f4c3a2b10-0123456789abcdef'

  function pageRequest(query) {
    return { mcpUserId: 'u1', params: { projectId: 'p1' }, query }
  }

  beforeEach(() => {
    ProjectGetter.promises.getProject.mockResolvedValue({
      rootDoc_id: 'd1',
      rootFolder: [],
    })
    ProjectEntityHandler.promises.getDocPathFromProjectByDocId.mockResolvedValue(
      '/thesis/main.tex'
    )
  })

  it('renders the requested page of the build with the root document for log paths', async () => {
    PdfPageInspector.inspectPdfPage.mockResolvedValue({ page: 2, image: {} })
    const r = res()
    await McpCompileController.getPdfPage(
      pageRequest({ buildId: BUILD_ID, clsiserverid: 'clsi-1', page: '2' }),
      r
    )
    expect(PdfPageInspector.inspectPdfPage).toHaveBeenCalledWith({
      projectId: 'p1',
      userId: 'u1',
      buildId: BUILD_ID,
      clsiServerId: 'clsi-1',
      page: 2,
      region: 'full',
      defects: true,
      rootDocPath: 'thesis/main.tex',
    })
    expect(r.body).toEqual({ buildId: BUILD_ID, page: 2, image: {} })
  })

  it('finds the page by source line when no page is given', async () => {
    PdfPageInspector.inspectPdfPage.mockResolvedValue({ page: 4 })
    await McpCompileController.getPdfPage(
      pageRequest({
        buildId: BUILD_ID,
        path: 'chapters/intro.tex',
        line: '12',
        region: 'top',
      }),
      res()
    )
    expect(PdfPageInspector.inspectPdfPage).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'chapters/intro.tex',
        line: 12,
        region: 'top',
      })
    )
  })

  it.each([
    [{}, 'buildId is required'],
    [{ buildId: 'not a build' }, 'invalid buildId'],
    [
      { buildId: BUILD_ID, page: '0' },
      'page, line and endLine must be whole numbers from 1',
    ],
    [{ buildId: BUILD_ID, path: 'main.tex' }, 'line is required with path'],
    [{ buildId: BUILD_ID, path: '../x.tex', line: '1' }, 'invalid path'],
    [
      { buildId: BUILD_ID, region: 'left' },
      'region must be one of full, top, middle, bottom',
    ],
  ])('rejects %o', async (query, message) => {
    const r = res()
    await McpCompileController.getPdfPage(pageRequest(query), r)
    expect(r.statusCode).toBe(400)
    expect(r.body).toMatchObject({ code: 'validation_error', message })
    expect(PdfPageInspector.inspectPdfPage).not.toHaveBeenCalled()
  })

  it('passes a page past the end through with the page count', async () => {
    PdfPageInspector.inspectPdfPage.mockRejectedValue(
      new PdfPageError(
        PDF_PAGE_ERRORS.PAGE_OUT_OF_RANGE,
        'Page 9 does not exist: the PDF has 5 page(s).',
        { pageCount: 5 }
      )
    )
    const r = res()
    await McpCompileController.getPdfPage(
      pageRequest({ buildId: BUILD_ID, page: '9' }),
      r
    )
    expect(r.statusCode).toBe(400)
    expect(r.body).toEqual({
      code: 'validation_error',
      message: 'Page 9 does not exist: the PDF has 5 page(s).',
      hint: 'Pass a page between 1 and details.pageCount.',
      details: { pageCount: 5 },
    })
  })

  it('says a build without a PDF has none, and what to do instead', async () => {
    PdfPageInspector.inspectPdfPage.mockRejectedValue(
      new PdfPageError(PDF_PAGE_ERRORS.NO_PDF, 'This build has no PDF.')
    )
    const r = res()
    await McpCompileController.getPdfPage(pageRequest({ buildId: BUILD_ID }), r)
    expect(r.statusCode).toBe(404)
    expect(r.body.hint).toContain('get_compile_log')
  })
})

describe('McpCompileController.clean', () => {
  it('cleans the build the same way the deprecated clearCache did', async () => {
    CompileManager.promises.deleteAuxFiles.mockResolvedValue()
    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      query: { clsiserverid: 'c1' },
    }
    const r = res()
    await McpCompileController.clean(req, r)
    expect(CompileManager.promises.deleteAuxFiles).toHaveBeenCalledWith(
      'p1',
      'u1',
      'c1'
    )
    expect(r.body).toEqual({ status: 'ok' })
    expect(McpCompileController.clearCache).toBe(McpCompileController.clean)
  })
})

describe('McpCompileController.compile pdfProduced', () => {
  it('reports whether output.pdf was written', async () => {
    CompileManager.promises.compile.mockResolvedValue({
      status: 'failure',
      buildId: 'b1',
      outputFiles: [{ path: 'output.pdf', build: 'b1' }],
    })
    const r = res()
    await McpCompileController.compile(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, body: {} },
      r
    )
    expect(r.body.pdfProduced).toBe(true)
    expect(r.body.buildId).toBe('b1')
  })
})

describe('McpCompileController PDF tools', () => {
  const BUILD_ID = '18f4c3a2b10-0123456789abcdef'

  function query(extra) {
    return { mcpUserId: 'u1', params: { projectId: 'p1' }, query: { buildId: BUILD_ID, ...extra } }
  }

  beforeEach(() => {
    ProjectGetter.promises.getProject.mockResolvedValue({ rootDoc_id: 'd1', rootFolder: [] })
    ProjectEntityHandler.promises.getDocPathFromProjectByDocId.mockResolvedValue('/main.tex')
  })

  it('passes maxEdgePx, grayscale and split to the inspector', async () => {
    PdfPageInspector.inspectPdfPage.mockResolvedValue({ page: 1, images: [] })
    await McpCompileController.getPdfPage(
      query({ page: '1', maxEdgePx: '1568', grayscale: 'false', split: 'halves' }),
      res()
    )
    expect(PdfPageInspector.inspectPdfPage).toHaveBeenCalledWith(
      expect.objectContaining({ maxEdgePx: 1568, grayscale: false, split: 'halves' })
    )
  })

  it.each([
    [{ maxEdgePx: '100' }, 'maxEdgePx must be a whole number of at least 512'],
    [{ maxEdgePx: 'big' }, 'maxEdgePx must be a whole number of at least 512'],
    [{ grayscale: 'yes' }, 'grayscale must be true or false'],
    [{ split: 'thirds' }, 'split must be one of none, halves'],
  ])('rejects %o', async (extra, message) => {
    const r = res()
    await McpCompileController.getPdfPage(query({ page: '1', ...extra }), r)
    expect(r.statusCode).toBe(400)
    expect(r.body.message).toBe(message)
    expect(PdfPageInspector.inspectPdfPage).not.toHaveBeenCalled()
  })

  it('passes a maxEdgePx above the old 2576 ceiling through', async () => {
    PdfPageInspector.inspectPdfPage.mockResolvedValue({ page: 1 })
    const r = res()
    await McpCompileController.getPdfPage(query({ page: '1', maxEdgePx: '4800' }), r)
    expect(r.statusCode).toBe(200)
    expect(PdfPageInspector.inspectPdfPage.mock.calls[0][0].maxEdgePx).toBe(4800)
  })

  it('always records defects, and draws labels when asked', async () => {
    PdfPageInspector.inspectPdfPage.mockResolvedValue({ page: 1 })
    await McpCompileController.getPdfPage(query({ page: '1' }), res())
    const plain = PdfPageInspector.inspectPdfPage.mock.calls[0][0]
    expect(plain).not.toHaveProperty('labels')
    expect(plain).toEqual(expect.objectContaining({ defects: true }))

    await McpCompileController.getPdfPage(query({ page: '1', labels: 'true' }), res())
    const labelled = PdfPageInspector.inspectPdfPage.mock.calls[1][0]
    expect(labelled).toEqual(expect.objectContaining({ labels: true, defects: true }))
  })

  it('returns the inspector output, including stale and source status, unchanged', async () => {
    PdfPageInspector.inspectPdfPage.mockResolvedValue({
      page: 1,
      sourceStatus: 'no_synctex',
      sourceNote: 'no SyncTeX',
      stale: { reason: 'docs_changed', changed: ['main.tex'] },
      images: [{ part: 'full', mimeType: 'image/png', data: 'AAA=' }],
    })
    const r = res()
    await McpCompileController.getPdfPage(query({ page: '1' }), r)
    expect(r.body).toMatchObject({
      buildId: BUILD_ID,
      sourceStatus: 'no_synctex',
      stale: { reason: 'docs_changed', changed: ['main.tex'] },
      images: [{ part: 'full', mimeType: 'image/png', data: 'AAA=' }],
    })
  })

  it('serves the overview', async () => {
    PdfPageInspector.overviewPdfPages.mockResolvedValue({ pageCount: 3, pages: [] })
    const on = res()
    await McpCompileController.getPdfOverview(query({ fromPage: '1', toPage: '3' }), on)
    expect(on.body).toEqual({ buildId: BUILD_ID, pageCount: 3, pages: [] })
    expect(PdfPageInspector.overviewPdfPages).toHaveBeenCalledWith(
      expect.objectContaining({ fromPage: 1, toPage: 3, rootDocPath: 'main.tex' })
    )
  })

  it('serves search', async () => {
    PdfPageInspector.searchPdfText.mockResolvedValue({ matchCount: 1, matches: [] })
    const on = res()
    await McpCompileController.searchPdf(query({ query: ' Figure ' }), on)
    expect(on.body).toEqual({ buildId: BUILD_ID, matchCount: 1, matches: [] })
    expect(PdfPageInspector.searchPdfText).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'Figure' })
    )
  })

  describe('getPdfBlock', () => {
    it('rejects a block id that is not B followed by digits', async () => {
      const r = res()
      await McpCompileController.getPdfBlock(query({ page: '2', blockId: 'x3' }), r)
      expect(r.statusCode).toBe(400)
      expect(r.body.message).toBe('blockId must look like B3')
    })

    it('resolves a block from the cached label table', async () => {
      PdfPageInspector.resolveBlock.mockResolvedValue({ path: 'main.tex', line: 4, endLine: 6 })
      const r = res()
      await McpCompileController.getPdfBlock(query({ page: '2', blockId: 'B3' }), r)
      expect(r.body).toEqual({
        buildId: BUILD_ID,
        blockId: 'B3',
        page: 2,
        path: 'main.tex',
        line: 4,
        endLine: 6,
      })
      expect(PdfPageInspector.inspectPdfPage).not.toHaveBeenCalled()
    })

    it('renders the page with labels to fill the table on a miss', async () => {
      PdfPageInspector.resolveBlock
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ path: 'main.tex', line: 9 })
      PdfPageInspector.inspectPdfPage.mockResolvedValue({ page: 2 })
      const r = res()
      await McpCompileController.getPdfBlock(query({ page: '2', blockId: 'B1' }), r)
      expect(PdfPageInspector.inspectPdfPage).toHaveBeenCalledWith(
        expect.objectContaining({ page: 2, labels: true, withImage: false })
      )
      expect(r.body).toMatchObject({ path: 'main.tex', line: 9 })
    })

    it('says so when the page has no such block', async () => {
      PdfPageInspector.resolveBlock.mockResolvedValue(null)
      PdfPageInspector.inspectPdfPage.mockResolvedValue({ page: 2 })
      const r = res()
      await McpCompileController.getPdfBlock(query({ page: '2', blockId: 'B99' }), r)
      expect(r.statusCode).toBe(404)
      expect(r.body.message).toBe('no block B99 on page 2 of this build')
    })
  })
})

describe('McpCompileController staleness', () => {
  const BUILD_ID = '18f4c3a2b10-0123456789abcdef'

  beforeEach(() => {
    resetBuildRecords()
    ProjectGetter.promises.getProject.mockResolvedValue({
      rootDoc_id: 'd1',
      rootFolder: [],
      compiler: 'pdflatex',
      imageName: 'texlive-2025',
    })
    ProjectEntityHandler.promises.getDocPathFromProjectByDocId.mockResolvedValue('/main.tex')
    ProjectEntityHandler.promises.getAllDocs.mockResolvedValue({
      'main.tex': { rev: 1 },
      'ch/intro.tex': { rev: 4 },
    })
    ProjectEntityHandler.promises.getAllFiles.mockResolvedValue({
      'fig.png': { _id: 'f1' },
    })
    CompileManager.promises.compile.mockResolvedValue({
      status: 'success',
      buildId: BUILD_ID,
      clsiServerId: 'c1',
      outputFiles: [{ path: 'output.pdf', build: BUILD_ID }],
    })
    PdfPageInspector.inspectPdfPage.mockResolvedValue({ page: 1 })
  })

  async function compileThenView() {
    await McpCompileController.compile(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, body: {} },
      res()
    )
    const r = res()
    await McpCompileController.getPdfPage(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, query: { buildId: BUILD_ID, page: '1' } },
      r
    )
    return r
  }

  it('says nothing is stale while the inputs are unchanged', async () => {
    const r = await compileThenView()
    expect(r.body).not.toHaveProperty('stale')
  })

  it('reports docs_changed with the paths that changed since the build', async () => {
    await McpCompileController.compile(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, body: {} },
      res()
    )
    ProjectEntityHandler.promises.getAllDocs.mockResolvedValue({
      'main.tex': { rev: 2 },
      'ch/intro.tex': { rev: 4 },
    })
    const r = res()
    await McpCompileController.getPdfPage(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, query: { buildId: BUILD_ID, page: '1' } },
      r
    )
    expect(r.body.stale).toEqual({ reason: 'docs_changed', changed: ['main.tex'] })
  })

  it('reports root_changed when the root document is switched', async () => {
    await McpCompileController.compile(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, body: {} },
      res()
    )
    ProjectEntityHandler.promises.getDocPathFromProjectByDocId.mockResolvedValue('/thesis.tex')
    const r = res()
    await McpCompileController.getPdfPage(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, query: { buildId: BUILD_ID, page: '1' } },
      r
    )
    expect(r.body.stale.reason).toBe('root_changed')
  })

  it('says nothing when the project cannot be read for the check', async () => {
    await McpCompileController.compile(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, body: {} },
      res()
    )
    ProjectEntityHandler.promises.getAllDocs.mockRejectedValue(new Error('docstore down'))
    const r = res()
    await McpCompileController.getPdfPage(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, query: { buildId: BUILD_ID, page: '1' } },
      r
    )
    expect(r.statusCode).toBe(200)
    expect(r.body).not.toHaveProperty('stale')
  })

  it('does not judge a build this process did not record', async () => {
    rememberBuild('p1', { buildId: 'other', fingerprint: { contentHash: 'x', entries: [] } })
    const r = res()
    await McpCompileController.getPdfPage(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, query: { buildId: BUILD_ID, page: '1' } },
      r
    )
    expect(r.body).not.toHaveProperty('stale')
  })

  it('records the build as compiled when its PDF was written', async () => {
    const r = await compileThenView()
    expect(r.body.page).toBe(1)
    expect(ProjectEntityHandler.promises.getAllDocs).toHaveBeenCalledWith('p1')
  })
})

describe('McpCompileController.getPdfDiff', () => {
  const NEW_ID = '18f4c3a2b10-0123456789abcdef'
  const OLD_ID = '18f4c3a2b00-0123456789abcd00'

  beforeEach(() => {
    resetBuildRecords()
    vi.clearAllMocks()
    rememberBuild('p1', { buildId: OLD_ID, clsiServerId: 'c0', fingerprint: { contentHash: 'a', entries: [] } })
    rememberBuild('p1', { buildId: NEW_ID, clsiServerId: 'c1', fingerprint: { contentHash: 'b', entries: [] } })
  })

  function diffRequest(query) {
    return { mcpUserId: 'u1', params: { projectId: 'p1' }, query }
  }

  it('diffs the build against the one compiled before it', async () => {
    const diff = { ok: true, changed: true, beforeBuildId: OLD_ID, afterBuildId: NEW_ID, pages: [] }
    PdfVisualDiff.diffBuilds.mockResolvedValue(diff)
    const r = res()
    await McpCompileController.getPdfDiff(diffRequest({ buildId: NEW_ID, clsiserverid: 'c1' }), r)
    expect(PdfVisualDiff.diffBuilds).toHaveBeenCalledWith({
      projectId: 'p1',
      userId: 'u1',
      beforeBuildId: OLD_ID,
      afterBuildId: NEW_ID,
      clsiServerId: 'c1',
      beforeClsiServerId: 'c0',
      pages: null,
    })
    expect(r.body).toEqual(diff)
  })

  it('uses beforeBuildId when given', async () => {
    PdfVisualDiff.diffBuilds.mockResolvedValue({ ok: true, changed: false, pages: [] })
    await McpCompileController.getPdfDiff(
      diffRequest({ buildId: NEW_ID, beforeBuildId: '18f4c3a2b20-0123456789abcd20' }),
      res()
    )
    expect(PdfVisualDiff.diffBuilds).toHaveBeenCalledWith(
      expect.objectContaining({ beforeBuildId: '18f4c3a2b20-0123456789abcd20' })
    )
  })

  it('says so when there is no earlier build to compare with', async () => {
    const r = res()
    await McpCompileController.getPdfDiff(diffRequest({ buildId: OLD_ID }), r)
    expect(r.statusCode).toBe(404)
    expect(r.body.message).toBe('there is no earlier build of this project to compare with')
    expect(PdfVisualDiff.diffBuilds).not.toHaveBeenCalled()
  })

  it.each([
    ['build_gone', 404],
    ['render_failed', 502],
  ])('maps the %s failure to %i', async (reason, status) => {
    PdfVisualDiff.diffBuilds.mockResolvedValue({ ok: false, reason, message: 'nope' })
    const r = res()
    await McpCompileController.getPdfDiff(diffRequest({ buildId: NEW_ID }), r)
    expect(r.statusCode).toBe(status)
    expect(r.body.hint).toBeTruthy()
    if (status === 502) {
      // A server-side failure keeps its details out of the response.
      expect(r.body.message).not.toBe('nope')
      expect(r.body.errorId).toMatch(/^[0-9a-f-]{36}$/)
    } else {
      expect(r.body.message).toBe('nope')
    }
  })
})

describe('McpCompileController PDF failure hints', () => {
  const BUILD_ID = '18f4c3a2b10-0123456789abcdef'

  it('tells the model to clean when the build has no SyncTeX data', async () => {
    PdfPageInspector.inspectPdfPage.mockRejectedValue(
      new PdfPageError(PDF_PAGE_ERRORS.SYNCTEX_UNAVAILABLE, 'no synctex')
    )
    const r = res()
    await McpCompileController.getPdfPage(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, query: { buildId: BUILD_ID, path: 'main.tex', line: '3' } },
      r
    )
    expect(r.statusCode).toBe(404)
    expect(r.body.hint).toContain('clean: true')
    expect(r.body.hint).not.toContain('render')
  })

  it('explains a line that is not typeset in the build, with its sourceStatus', async () => {
    PdfPageInspector.inspectPdfPage.mockRejectedValue(
      new PdfPageError(PDF_PAGE_ERRORS.LINE_NOT_IN_PDF, 'main.tex line 3 is not typeset', {
        sourceStatus: 'line_not_in_build',
        sourceNote: 'not typeset',
      })
    )
    const r = res()
    await McpCompileController.getPdfPage(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, query: { buildId: BUILD_ID, path: 'main.tex', line: '3' } },
      r
    )
    expect(r.statusCode).toBe(404)
    expect(r.body.hint).toContain('not typeset in this build')
    expect(r.body.hint).toContain('iffalse')
    expect(r.body.details).toEqual({ sourceStatus: 'line_not_in_build', sourceNote: 'not typeset' })
  })
})


describe('McpCompileController compile input and write guards', () => {
  const doc = { _id: 'd9', lines: ['\\documentclass{article}'] }

  beforeEach(() => {
    CompileManager.promises.compile.mockResolvedValue({
      status: 'success',
      outputFiles: [],
    })
  })

  it('rejects a draft flag that is not a boolean, instead of reading it as true', async () => {
    const r = res()
    await McpCompileController.compile(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, body: { draft: 'false' } },
      r
    )
    expect(r.statusCode).toBe(400)
    expect(r.body.code).toBe('validation_error')
    expect(CompileManager.promises.compile).not.toHaveBeenCalled()
  })

  it('rejects a stopOnFirstError flag that is not a boolean', async () => {
    const r = res()
    await McpCompileController.compile(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, body: { stopOnFirstError: 1 } },
      r
    )
    expect(r.body.code).toBe('validation_error')
    expect(CompileManager.promises.compile).not.toHaveBeenCalled()
  })

  it('treats an absent or null flag as false', async () => {
    const r = res()
    await McpCompileController.compile(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, body: { draft: null } },
      r
    )
    expect(CompileManager.promises.compile).toHaveBeenCalledWith(
      'p1',
      'u1',
      expect.objectContaining({ draft: false, stopOnFirstError: false })
    )
  })

  it('rejects a compiler that is not in the safe list', async () => {
    const r = res()
    await McpCompileController.compile(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, body: { compiler: 'shell-escape' } },
      r
    )
    expect(r.statusCode).toBe(400)
    expect(r.body.code).toBe('validation_error')
    expect(CompileManager.promises.compile).not.toHaveBeenCalled()
  })

  it('does not let a reader change the root document when it is unset', async () => {
    AuthorizationManager.promises.canUserWriteProjectContent.mockResolvedValueOnce(false)
    ProjectGetter.promises.getProject.mockResolvedValue({ rootDoc_id: null, rootFolder: [] })
    ProjectEntityHandler.promises.getAllDocs.mockResolvedValue({ '/main.tex': doc })
    const r = res()
    await McpCompileController.compile(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, body: {} },
      r
    )
    expect(CompileManager.promises.compile).toHaveBeenCalledWith(
      'p1',
      'u1',
      expect.objectContaining({ rootDoc_id: 'd9', rootResourcePath: 'main.tex' })
    )
  })

  it('answers a reader with no usable root without calling CompileManager', async () => {
    AuthorizationManager.promises.canUserWriteProjectContent.mockResolvedValueOnce(false)
    ProjectGetter.promises.getProject.mockResolvedValue({ rootDoc_id: null, rootFolder: [] })
    ProjectEntityHandler.promises.getAllDocs.mockResolvedValue({})
    const r = res()
    await McpCompileController.compile(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, body: {} },
      r
    )
    expect(CompileManager.promises.compile).not.toHaveBeenCalled()
    expect(r.body.status).toBe('validation-problems')
    expect(r.body.validationProblems).toEqual({ mainFile: 'no main file specified' })
  })

  it('leaves the root repair to CompileManager for a writer', async () => {
    const r = res()
    await McpCompileController.compile(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, body: {} },
      r
    )
    const options = CompileManager.promises.compile.mock.calls[0][2]
    expect(options).not.toHaveProperty('rootDoc_id')
  })
})

describe('McpCompileController output caps', () => {
  const MIB = 1024 * 1024

  it('refuses a compile log over 16 MB with output_too_large', async () => {
    ClsiManager.promises.getOutputFileStream.mockResolvedValue(
      Readable.from([Buffer.alloc(16 * MIB + 1, 'a')])
    )
    const r = res()
    await McpCompileController.getLog(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, query: { buildId: '0a1b-2c3d' } },
      r
    )
    expect(r.statusCode).toBe(413)
    expect(r.body.code).toBe('output_too_large')
  })

  it('cuts a PDF off once it passes 64 MB', async () => {
    ClsiManager.promises.getOutputFileStream.mockResolvedValue(
      Readable.from([Buffer.alloc(64 * MIB + 1, 'a')])
    )
    const sink = new Writable({
      write(chunk, enc, cb) {
        cb()
      },
    })
    sink.setHeader = () => {}
    await expect(
      McpCompileController.getPdf(
        { mcpUserId: 'u1', params: { projectId: 'p1' }, query: { buildId: '0a1b-2c3d' } },
        sink
      )
    ).rejects.toMatchObject({ code: 'OUTPUT_TOO_LARGE' })
  })
})

describe('McpCompileController pdf-diff pages and synctex column', () => {
  const OLD_ID = '18f4c3a2b00-0123456789abcd00'
  const NEW_ID = '18f4c3a2b10-0123456789abcdef'

  beforeEach(() => {
    resetBuildRecords()
    rememberBuild('p1', { buildId: OLD_ID, clsiServerId: 'c0', fingerprint: { contentHash: 'a', entries: [] } })
    rememberBuild('p1', { buildId: NEW_ID, clsiServerId: 'c1', fingerprint: { contentHash: 'b', entries: [] } })
    PdfVisualDiff.diffBuilds.mockResolvedValue({ ok: true, pages: [] })
  })

  it('passes a validated pages list to the diff', async () => {
    const r = res()
    await McpCompileController.getPdfDiff(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, query: { buildId: NEW_ID, pages: '3,4,4' } },
      r
    )
    expect(PdfVisualDiff.diffBuilds).toHaveBeenCalledWith(
      expect.objectContaining({ pages: [3, 4] })
    )
  })

  it.each(['abc', '0', '2,,3', '1.5', ['1', '2']])(
    'rejects pages=%s with validation_error',
    async pages => {
      const r = res()
      await McpCompileController.getPdfDiff(
        { mcpUserId: 'u1', params: { projectId: 'p1' }, query: { buildId: NEW_ID, pages } },
        r
      )
      expect(r.statusCode).toBe(400)
      expect(r.body.code).toBe('validation_error')
      expect(PdfVisualDiff.diffBuilds).not.toHaveBeenCalled()
    }
  )

  it('answers too_many_pages with validation_error and the pages hint', async () => {
    PdfVisualDiff.diffBuilds.mockResolvedValue({
      ok: false,
      reason: 'too_many_pages',
      message: 'A diff compares at most 40 pages at once.',
    })
    const r = res()
    await McpCompileController.getPdfDiff(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, query: { buildId: NEW_ID } },
      r
    )
    expect(r.statusCode).toBe(400)
    expect(r.body.code).toBe('validation_error')
    expect(r.body.hint).toMatch(/pages/)
  })

  it('defaults the synctex column to 0 when only a line is given', async () => {
    CompileManager.promises.syncTeX.mockResolvedValue({ pdf: [] })
    await McpCompileController.synctex(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, query: { file: 'main.tex', line: '10' } },
      res()
    )
    expect(CompileManager.promises.syncTeX).toHaveBeenCalledWith(
      'p1',
      'u1',
      expect.objectContaining({
        validatedOptions: expect.objectContaining({ file: 'main.tex', line: 10, column: 0 }),
      })
    )
  })
})

describe('McpCompileController render_failed hint', () => {
  it('keeps the region hint when a page is too dense to render', async () => {
    PdfPageInspector.inspectPdfPage.mockRejectedValue(
      new PdfPageError(PDF_PAGE_ERRORS.RENDER_FAILED, 'too big')
    )
    ProjectGetter.promises.getProject.mockResolvedValue({ rootDoc_id: null, rootFolder: [] })
    const r = res()
    await McpCompileController.getPdfPage(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, query: { buildId: '18f4c3a2b10-0123456789abcdef', page: '1' } },
      r
    )
    expect(r.statusCode).toBe(502)
    expect(r.body.hint).toMatch(/pass region/)
  })
})
