import { describe, it, expect, vi, beforeEach } from 'vitest'
import Settings from '@overleaf/settings'

const ProjectEntityHandler = {
  promises: { getAllEntities: vi.fn() },
}
const DocstoreManager = {
  promises: { getDoc: vi.fn() },
}
const DocumentUpdaterHandler = {
  promises: { setDocument: vi.fn(), flushProjectToMongo: vi.fn().mockResolvedValue() },
}
const ProjectGetter = {
  promises: { getProject: vi.fn() },
}
const ProjectZipStreamManager = {
  createZipStreamForProject: vi.fn(),
  createZipStreamForMultipleProjects: vi.fn(),
}
const HistoryManager = {
  promises: { requestBlobWithProjectId: vi.fn() },
}
const AuthorizationManager = {
  promises: { canUserReadProject: vi.fn() },
}
const EditorController = {
  promises: {
    upsertDocWithPath: vi.fn(),
    upsertFileWithPath: vi.fn(),
    mkdirp: vi.fn(),
    moveEntity: vi.fn(),
    renameEntity: vi.fn(),
  },
}
const McpUrlFetcher = { fetchToBuffer: vi.fn() }
const fsPromises = {
  writeFile: vi.fn(async () => undefined),
  unlink: vi.fn(async () => undefined),
}

vi.mock(
  '../../../../../app/src/Features/Project/ProjectEntityHandler.mjs',
  () => ({ default: ProjectEntityHandler })
)
vi.mock('../../../../../app/src/Features/Project/ProjectGetter.mjs', () => ({
  default: ProjectGetter,
}))
vi.mock(
  '../../../../../app/src/Features/Downloads/ProjectZipStreamManager.mjs',
  () => ({ default: ProjectZipStreamManager })
)
vi.mock(
  '../../../../../app/src/Features/History/HistoryManager.mjs',
  () => ({ default: HistoryManager })
)
vi.mock(
  '../../../../../app/src/Features/Authorization/AuthorizationManager.mjs',
  () => ({ default: AuthorizationManager })
)
vi.mock('../../../../../app/src/Features/Docstore/DocstoreManager.mjs', () => ({
  default: DocstoreManager,
}))
vi.mock(
  '../../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs',
  () => ({ default: DocumentUpdaterHandler })
)
vi.mock('../../../../../app/src/Features/Editor/EditorController.mjs', () => ({
  default: EditorController,
}))
vi.mock('../../../../../app/src/Features/Mcp/McpUrlFetcher.mjs', () => ({
  default: McpUrlFetcher,
}))
vi.mock('node:fs/promises', () => ({ default: fsPromises, ...fsPromises }))

const { default: McpFilesController } = await import(
  '../../../../../app/src/Features/Mcp/McpFilesController.mjs'
)

function res() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    contentType(t) {
      this.headers['content-type'] = t
      return this
    },
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v
      return this
    },
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

beforeEach(() => {
  vi.clearAllMocks()
  fsPromises.writeFile.mockImplementation(async () => undefined)
  fsPromises.unlink.mockImplementation(async () => undefined)
})

describe('McpFilesController.getTree', () => {
  it('returns docs and files with normalised paths and ids', async () => {
    ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
      docs: [{ path: '/main.tex', doc: { _id: 'd1' } }],
      files: [{ path: '/logo.png', file: { _id: 'f1' } }],
      folders: [],
    })
    const req = { mcpUserId: 'u1', params: { projectId: 'p1' } }
    const r = res()
    await McpFilesController.getTree(req, r)
    expect(r.body).toEqual({
      docs: [{ path: '/main.tex', id: 'd1' }],
      files: [{ path: '/logo.png', id: 'f1' }],
    })
  })
})

describe('McpFilesController.getDoc', () => {
  it('applies a 1-indexed inclusive line range', async () => {
    DocstoreManager.promises.getDoc.mockResolvedValue({
      lines: ['a', 'b', 'c', 'd'],
    })
    ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
      docs: [{ path: '/main.tex', doc: { _id: 'd1' } }],
      files: [],
      folders: [],
    })
    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      query: { path: 'main.tex', startLine: '2', endLine: '3' },
    }
    const r = res()
    await McpFilesController.getDoc(req, r)
    expect(r.body.content).toBe('b\nc')
  })

  it('returns not_found for an unknown path', async () => {
    ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
      docs: [],
      files: [],
      folders: [],
    })
    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      query: { path: 'nope.tex' },
    }
    const r = res()
    await McpFilesController.getDoc(req, r)
    expect(r.statusCode).toBe(404)
  })
})

describe('McpFilesController.writeDoc', () => {
  it('validates path and content', async () => {
    const req = { mcpUserId: 'u1', params: { projectId: 'p1' }, body: {} }
    const r = res()
    await McpFilesController.writeDoc(req, r)
    expect(r.statusCode).toBe(400)
  })

  it('rejects path traversal attempts', async () => {
    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      body: { path: '../main.tex', content: 'test' },
    }
    const r = res()
    await McpFilesController.writeDoc(req, r)
    expect(r.statusCode).toBe(400)
    expect(EditorController.promises.upsertDocWithPath).not.toHaveBeenCalled()
  })

  it('delegates atomically to EditorController.upsertDocWithPath under lock', async () => {
    EditorController.promises.upsertDocWithPath.mockResolvedValue({
      doc: { _id: 'd1' },
    })
    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      body: { path: 'chapters/intro.tex', content: 'hello\nworld' },
    }
    const r = res()
    await McpFilesController.writeDoc(req, r)
    expect(EditorController.promises.upsertDocWithPath).toHaveBeenCalledWith(
      'p1',
      '/chapters/intro.tex',
      ['hello', 'world'],
      'mcp',
      'u1'
    )
    expect(r.body.status).toBe('ok')
    expect(r.body.docId).toBe('d1')
  })
})

describe('McpFilesController.createFolder', () => {
  it('validates path', async () => {
    const req = { mcpUserId: 'u1', params: { projectId: 'p1' }, body: {} }
    const r = res()
    await McpFilesController.createFolder(req, r)
    expect(r.statusCode).toBe(400)
  })

  it('calls mkdirp with the normalised path', async () => {
    EditorController.promises.mkdirp.mockResolvedValue({ lastFolder: { _id: 'x' } })
    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      body: { path: 'chapters/new' },
    }
    const r = res()
    await McpFilesController.createFolder(req, r)
    expect(EditorController.promises.mkdirp).toHaveBeenCalledWith(
      'p1',
      '/chapters/new',
      'u1'
    )
    expect(r.body.status).toBe('ok')
  })
})

describe('McpFilesController.moveEntity', () => {
  it('validates oldPath and newPath', async () => {
    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      body: { oldPath: 'a.tex' },
    }
    const r = res()
    await McpFilesController.moveEntity(req, r)
    expect(r.statusCode).toBe(400)
  })

  it('returns not_found when the source entity does not exist', async () => {
    ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
      docs: [],
      files: [],
      folders: [{ path: '/', folder: { _id: 'root' } }],
    })
    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      body: { oldPath: 'a.tex', newPath: 'b.tex' },
    }
    const r = res()
    await McpFilesController.moveEntity(req, r)
    expect(r.statusCode).toBe(404)
  })

  it('moves a doc into another folder', async () => {
    ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
      docs: [{ path: '/a.tex', doc: { _id: 'd1' } }],
      files: [],
      folders: [
        { path: '/', folder: { _id: 'root' } },
        { path: '/chapters', folder: { _id: 'fold1' } },
      ],
    })
    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      body: { oldPath: 'a.tex', newPath: 'chapters/a.tex' },
    }
    const r = res()
    await McpFilesController.moveEntity(req, r)
    expect(EditorController.promises.moveEntity).toHaveBeenCalledWith(
      'p1',
      'd1',
      'fold1',
      'doc',
      'u1',
      'mcp'
    )
    expect(EditorController.promises.renameEntity).not.toHaveBeenCalled()
    expect(r.body.status).toBe('ok')
  })

  it('renames a doc in place when only the basename changes', async () => {
    ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
      docs: [{ path: '/a.tex', doc: { _id: 'd1' } }],
      files: [],
      folders: [{ path: '/', folder: { _id: 'root' } }],
    })
    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      body: { oldPath: 'a.tex', newPath: 'b.tex' },
    }
    const r = res()
    await McpFilesController.moveEntity(req, r)
    expect(EditorController.promises.moveEntity).not.toHaveBeenCalled()
    expect(EditorController.promises.renameEntity).toHaveBeenCalledWith(
      'p1',
      'd1',
      'doc',
      'b.tex',
      'u1',
      'mcp'
    )
    expect(r.body.status).toBe('ok')
  })

  it('rejects if the destination path already exists', async () => {
    ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
      docs: [
        { path: '/a.tex', doc: { _id: 'd1' } },
        { path: '/b.tex', doc: { _id: 'd2' } },
      ],
      files: [],
      folders: [{ path: '/', folder: { _id: 'root' } }],
    })
    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      body: { oldPath: 'a.tex', newPath: 'b.tex' },
    }
    const r = res()
    await McpFilesController.moveEntity(req, r)
    expect(r.statusCode).toBe(400)
    expect(r.body.message).toContain('destination path already exists')
    expect(EditorController.promises.moveEntity).not.toHaveBeenCalled()
    expect(EditorController.promises.renameEntity).not.toHaveBeenCalled()
  })

  it('rolls back move if rename fails during cross-folder move and rename', async () => {
    ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
      docs: [{ path: '/a.tex', doc: { _id: 'd1' } }],
      files: [],
      folders: [
        { path: '/', folder: { _id: 'root' } },
        { path: '/sub', folder: { _id: 'sub1' } },
      ],
    })
    EditorController.promises.renameEntity.mockRejectedValue(
      new Error('rename failed')
    )
    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      body: { oldPath: 'a.tex', newPath: 'sub/b.tex' },
    }
    const r = res()
    let err
    try {
      await McpFilesController.moveEntity(req, r)
    } catch (e) {
      err = e
    }
    expect(err).toBeDefined()
    expect(err.message).toBe('rename failed')
    // First moved to sub1
    expect(EditorController.promises.moveEntity).toHaveBeenNthCalledWith(
      1,
      'p1',
      'd1',
      'sub1',
      'doc',
      'u1',
      'mcp'
    )
    // Then rolled back to root
    expect(EditorController.promises.moveEntity).toHaveBeenNthCalledWith(
      2,
      'p1',
      'd1',
      'root',
      'doc',
      'u1',
      'mcp'
    )
  })
})

describe('McpFilesController.uploadFile', () => {
  it('rejects a missing path', async () => {
    const req = { mcpUserId: 'u1', params: { projectId: 'p1' }, body: {} }
    const r = res()
    await McpFilesController.uploadFile(req, r)
    expect(r.statusCode).toBe(400)
    expect(r.body.code).toBe('validation_error')
  })

  it('rejects a path containing ..', async () => {
    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      body: { path: '../secrets/x.png', contentBase64: 'AA==' },
    }
    const r = res()
    await McpFilesController.uploadFile(req, r)
    expect(r.statusCode).toBe(400)
  })

  it('rejects a disallowed extension', async () => {
    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      body: { path: 'x.exe', contentBase64: 'AA==' },
    }
    const r = res()
    await McpFilesController.uploadFile(req, r)
    expect(r.statusCode).toBe(400)
    expect(r.body.code).toBe('validation_error')
  })

  it('rejects an oversize base64 payload', async () => {
    const big = Buffer.alloc(Settings.mcp.maxUploadBytes + 1).toString('base64')
    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      body: { path: 'x.png', contentBase64: big },
    }
    const r = res()
    await McpFilesController.uploadFile(req, r)
    expect(r.statusCode).toBe(400)
  })

  it('requires contentBase64 or url', async () => {
    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      body: { path: 'x.png' },
    }
    const r = res()
    await McpFilesController.uploadFile(req, r)
    expect(r.statusCode).toBe(400)
  })

  it('maps an SSRF-blocked url to validation_error', async () => {
    McpUrlFetcher.fetchToBuffer.mockRejectedValue(
      Object.assign(new Error('blocked'), { info: { code: 'ssrf_blocked' } })
    )
    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      body: { path: 'figs/plot.png', url: 'http://169.254.169.254/' },
    }
    const r = res()
    await McpFilesController.uploadFile(req, r)
    expect(r.statusCode).toBe(400)
    expect(r.body.message).toMatch(/ssrf_blocked/)
  })

  it('stores an allowed base64 image via upsertFileWithPath', async () => {
    EditorController.promises.upsertFileWithPath.mockResolvedValue({
      file: { _id: 'f1' },
    })
    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      body: {
        path: 'figs/plot.png',
        contentBase64: Buffer.from('x').toString('base64'),
      },
    }
    const r = res()
    await McpFilesController.uploadFile(req, r)
    expect(fsPromises.writeFile).toHaveBeenCalled()
    expect(EditorController.promises.upsertFileWithPath).toHaveBeenCalledWith(
      'p1',
      '/figs/plot.png',
      expect.any(String),
      null,
      'mcp',
      'u1'
    )
    expect(fsPromises.unlink).toHaveBeenCalled()
    expect(r.body.status).toBe('ok')
    expect(r.body.fileId).toBe('f1')
  })

  it('fetches from a url and stores it', async () => {
    McpUrlFetcher.fetchToBuffer.mockResolvedValue({
      buffer: Buffer.from('img'),
      contentType: 'image/png',
    })
    EditorController.promises.upsertFileWithPath.mockResolvedValue({
      file: { _id: 'f2' },
    })
    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      body: { path: 'figs/remote.png', url: 'https://example.com/i.png' },
    }
    const r = res()
    await McpFilesController.uploadFile(req, r)
    expect(McpUrlFetcher.fetchToBuffer).toHaveBeenCalledWith(
      'https://example.com/i.png',
      { maxBytes: Settings.mcp.maxUploadBytes }
    )
    expect(r.body.status).toBe('ok')
  })

  it('always cleans up the temp file even when the manager throws', async () => {
    EditorController.promises.upsertFileWithPath.mockRejectedValue(
      new Error('boom')
    )
    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      body: {
        path: 'figs/plot.png',
        contentBase64: Buffer.from('x').toString('base64'),
      },
    }
    const r = res()
    let thrown
    try {
      await McpFilesController.uploadFile(req, r)
    } catch (e) {
      thrown = e
    }
    expect(thrown?.message).toBe('boom')
    expect(fsPromises.unlink).toHaveBeenCalled()
  })
})

describe('McpFilesController.downloadProjectZip', () => {
  it('returns not_found if project does not exist', async () => {
    ProjectGetter.promises.getProject.mockResolvedValue(null)
    const req = { mcpUserId: 'u1', params: { projectId: 'p1' } }
    const r = res()
    await McpFilesController.downloadProjectZip(req, r)
    expect(r.statusCode).toBe(404)
  })

  it('streams zip archive with content-type and filename header', async () => {
    ProjectGetter.promises.getProject.mockResolvedValue({ name: 'My Thesis' })
    const mockStream = { pipe: vi.fn() }
    ProjectZipStreamManager.createZipStreamForProject.mockImplementation(
      (pid, hist, hId, cb) => cb(null, mockStream)
    )

    const req = { mcpUserId: 'u1', params: { projectId: 'p1' } }
    const r = res()
    await McpFilesController.downloadProjectZip(req, r)

    expect(r.headers['content-type']).toBe('application/zip')
    expect(r.headers['content-disposition']).toBe('attachment; filename="My_Thesis.zip"')
    expect(mockStream.pipe).toHaveBeenCalledWith(r)
  })
})

describe('McpFilesController.downloadMultipleProjectsZip', () => {
  it('rejects empty or non-array projectIds with validation_error', async () => {
    const req1 = { mcpUserId: 'u1', body: {} }
    const r1 = res()
    await McpFilesController.downloadMultipleProjectsZip(req1, r1)
    expect(r1.statusCode).toBe(400)
    expect(r1.body.code).toBe('validation_error')

    const req2 = { mcpUserId: 'u1', body: { projectIds: [] } }
    const r2 = res()
    await McpFilesController.downloadMultipleProjectsZip(req2, r2)
    expect(r2.statusCode).toBe(400)
  })

  it('rejects more than 50 projects', async () => {
    const projectIds = Array.from({ length: 51 }, (_, i) => `p${i}`)
    const req = { mcpUserId: 'u1', body: { projectIds } }
    const r = res()
    await McpFilesController.downloadMultipleProjectsZip(req, r)
    expect(r.statusCode).toBe(400)
    expect(r.body.message).toContain('cannot download more than 50')
  })

  it('rejects with not_found if user cannot read any project', async () => {
    AuthorizationManager.promises.canUserReadProject
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    const req = { mcpUserId: 'u1', body: { projectIds: ['p1', 'p2'] } }
    const r = res()
    await McpFilesController.downloadMultipleProjectsZip(req, r)
    expect(r.statusCode).toBe(404)
    expect(r.body.message).toContain('p2')
  })

  it('streams combined zip archive for multiple accessible projects', async () => {
    AuthorizationManager.promises.canUserReadProject.mockResolvedValue(true)
    const mockStream = { pipe: vi.fn() }
    ProjectZipStreamManager.createZipStreamForMultipleProjects.mockImplementation(
      (pids, hist, cb) => cb(null, mockStream)
    )

    const req = { mcpUserId: 'u1', body: { projectIds: ['p1', 'p2'] } }
    const r = res()
    await McpFilesController.downloadMultipleProjectsZip(req, r)

    expect(r.headers['content-type']).toBe('application/zip')
    expect(r.headers['content-disposition']).toBe(
      'attachment; filename="Overleaf Projects (2 items).zip"'
    )
    expect(mockStream.pipe).toHaveBeenCalledWith(r)
  })
})

describe('McpFilesController.downloadFile', () => {
  it('validates path parameter', async () => {
    const req = { mcpUserId: 'u1', params: { projectId: 'p1' }, query: {} }
    const r = res()
    await McpFilesController.downloadFile(req, r)
    expect(r.statusCode).toBe(400)
    expect(r.body.code).toBe('validation_error')
  })

  it('streams a binary file from HistoryManager with content-type', async () => {
    ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
      docs: [],
      files: [
        {
          path: '/figures/plot.png',
          file: { _id: 'f1', hash: 'h123' },
        },
      ],
      folders: [],
    })
    const mockStream = new (await import('node:stream')).PassThrough()
    HistoryManager.promises.requestBlobWithProjectId.mockResolvedValue({
      stream: mockStream,
      contentLength: 1234,
    })

    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      query: { path: '/figures/plot.png' },
    }
    const r = res()
    r.write = vi.fn()
    r.end = vi.fn()
    r.on = vi.fn((event, cb) => {
      if (event === 'finish') setImmediate(cb)
      return r
    })
    r.once = vi.fn()
    r.emit = vi.fn()

    const downloadPromise = McpFilesController.downloadFile(req, r)
    mockStream.end('binary-data')
    await downloadPromise

    expect(r.headers['content-type']).toBe('image/png')
    expect(r.headers['content-disposition']).toBe('attachment; filename="plot.png"')
    expect(r.headers['content-length']).toBe(1234)
  })

  it('returns text content for a text document', async () => {
    ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
      docs: [
        {
          path: '/main.tex',
          doc: { _id: 'd1' },
        },
      ],
      files: [],
      folders: [],
    })
    DocstoreManager.promises.getDoc.mockResolvedValue({
      lines: ['\\documentclass{article}', '\\begin{document}', '\\end{document}'],
    })

    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      query: { path: '/main.tex' },
    }
    const r = res()
    r.send = vi.fn(content => {
      r.body = content
      return r
    })

    await McpFilesController.downloadFile(req, r)

    expect(r.headers['content-disposition']).toBe('attachment; filename="main.tex"')
    expect(r.body).toBe('\\documentclass{article}\n\\begin{document}\n\\end{document}')
  })

  it('returns not_found if path does not match any doc or file', async () => {
    ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
      docs: [],
      files: [],
      folders: [],
    })

    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      query: { path: '/nonexistent.png' },
    }
    const r = res()
    await McpFilesController.downloadFile(req, r)
    expect(r.statusCode).toBe(404)
  })
})

describe('McpFilesController.searchFiles', () => {
  it('rejects missing or empty query with validation_error', async () => {
    const req = { mcpUserId: 'u1', params: { projectId: 'p1' }, query: {} }
    const r = res()
    await McpFilesController.searchFiles(req, r)
    expect(r.statusCode).toBe(400)
    expect(r.body.code).toBe('validation_error')
    expect(r.body.message).toContain('query is required')
  })

  it('searches project documents and returns matching lines with line numbers and preview', async () => {
    ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
      docs: [
        { path: '/main.tex', doc: { _id: 'd1' } },
        { path: '/chapters/intro.tex', doc: { _id: 'd2' } },
      ],
      files: [],
      folders: [],
    })
    DocstoreManager.promises.getDoc.mockImplementation((pid, did) => {
      if (did === 'd1') {
        return Promise.resolve({
          lines: ['\\documentclass{article}', '\\input{chapters/intro}', '\\end{document}'],
        })
      }
      if (did === 'd2') {
        return Promise.resolve({
          lines: ['\\section{Intro}', 'Theorem 1 is important.', '\\label{thm:one}'],
        })
      }
      return Promise.resolve({ lines: [] })
    })

    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      query: { query: 'theorem' },
    }
    const r = res()
    await McpFilesController.searchFiles(req, r)

    expect(r.statusCode).toBe(200)
    expect(r.body.query).toBe('theorem')
    expect(r.body.totalMatches).toBe(1)
    expect(r.body.matches).toEqual([
      {
        path: '/chapters/intro.tex',
        line: 2,
        preview: 'Theorem 1 is important.',
      },
    ])
  })

  it('supports case-sensitive search when caseSensitive=true', async () => {
    ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
      docs: [{ path: '/main.tex', doc: { _id: 'd1' } }],
      files: [],
      folders: [],
    })
    DocstoreManager.promises.getDoc.mockResolvedValue({
      lines: ['Hello world', 'hello there', 'HELLO AGAIN'],
    })

    const reqCase = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      query: { query: 'Hello', caseSensitive: 'true' },
    }
    const r = res()
    await McpFilesController.searchFiles(reqCase, r)

    expect(r.body.totalMatches).toBe(1)
    expect(r.body.matches[0].line).toBe(1)
    expect(r.body.matches[0].preview).toBe('Hello world')
  })

  it('filters by path prefix and fileTypes extension', async () => {
    ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
      docs: [
        { path: '/chapters/ch1.tex', doc: { _id: 'd1' } },
        { path: '/chapters/notes.txt', doc: { _id: 'd2' } },
        { path: '/appendix/app.tex', doc: { _id: 'd3' } },
      ],
      files: [],
      folders: [],
    })
    DocstoreManager.promises.getDoc.mockImplementation((pid, did) => {
      if (did === 'd1') return Promise.resolve({ lines: ['findme here'] })
      if (did === 'd2') return Promise.resolve({ lines: ['findme in text'] })
      if (did === 'd3') return Promise.resolve({ lines: ['findme in app'] })
      return Promise.resolve({ lines: [] })
    })

    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      query: { query: 'findme', path: '/chapters', fileTypes: '.tex' },
    }
    const r = res()
    await McpFilesController.searchFiles(req, r)

    expect(r.body.totalMatches).toBe(1)
    expect(r.body.matches[0].path).toBe('/chapters/ch1.tex')
  })

  it('respects maxMatches limit', async () => {
    ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
      docs: [{ path: '/main.tex', doc: { _id: 'd1' } }],
      files: [],
      folders: [],
    })
    DocstoreManager.promises.getDoc.mockResolvedValue({
      lines: ['match 1', 'match 2', 'match 3', 'match 4'],
    })

    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      query: { query: 'match', maxMatches: '2' },
    }
    const r = res()
    await McpFilesController.searchFiles(req, r)

    expect(r.body.totalMatches).toBe(2)
    expect(r.body.matches).toHaveLength(2)
  })
})
