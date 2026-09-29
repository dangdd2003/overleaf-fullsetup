import { describe, it, expect, vi, beforeEach } from 'vitest'
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

vi.mock('../../../../../app/src/Features/Compile/CompileManager.mjs', () => ({
  default: CompileManager,
}))
vi.mock('../../../../../app/src/Features/Compile/ClsiManager.mjs', () => ({
  default: ClsiManager,
}))

const { default: McpCompileController } = await import(
  '../../../../../app/src/Features/Mcp/McpCompileController.mjs'
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

  it('bounds the read with a default even when maxLines is omitted', async () => {
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
    expect(lines).toHaveLength(1000)
    expect(lines[lines.length - 1]).toBe('line4999')
    expect(r.body.truncated).toBe(true)
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
