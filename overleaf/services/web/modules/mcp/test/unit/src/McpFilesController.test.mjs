import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import { PassThrough } from 'node:stream'

const ProjectEntityHandler = {
  promises: { getAllEntities: vi.fn() },
}
const DocstoreManager = {
  promises: { getDoc: vi.fn(), getAllDocs: vi.fn() },
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
    deleteEntity: vi.fn(),
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
vi.mock('../../../app/src/McpUrlFetcher.mjs', () => ({
  default: McpUrlFetcher,
}))
vi.mock('node:fs/promises', () => ({ default: fsPromises, ...fsPromises }))

const { default: McpFilesController, suggestPaths } = await import(
  '../../../app/src/McpFilesController.mjs'
)

function res() {
  return Object.assign(new PassThrough(), {
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
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  fsPromises.writeFile.mockImplementation(async () => undefined)
  fsPromises.unlink.mockImplementation(async () => undefined)
  ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
    docs: [],
    files: [],
    folders: [],
  })
})

const MIB = 1024 * 1024

describe('McpFilesController guards and caps', () => {
  const projectWith = ({ docs = [], files = [], folders = [] }) =>
    ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
      docs,
      files,
      folders,
    })

  it('refuses a binary upload over a text document unless overwrite is set', async () => {
    projectWith({ docs: [{ path: '/main.tex', doc: { _id: 'd1' } }] })
    const r = res()
    await McpFilesController.uploadFile(
      {
        mcpUserId: 'u1',
        params: { projectId: 'p1' },
        body: { path: '/main.tex', contentBase64: 'AAAA' },
      },
      r
    )
    expect(r.statusCode).toBe(409)
    expect(r.body.code).toBe('conflict')
    expect(McpUrlFetcher.fetchToBuffer).not.toHaveBeenCalled()
    expect(EditorController.promises.upsertFileWithPath).not.toHaveBeenCalled()
  })

  it('replaces a text document with a binary file when overwrite is true', async () => {
    projectWith({ docs: [{ path: '/main.tex', doc: { _id: 'd1' } }] })
    EditorController.promises.upsertFileWithPath.mockResolvedValue({
      file: { _id: 'f1' },
    })
    const r = res()
    await McpFilesController.uploadFile(
      {
        mcpUserId: 'u1',
        params: { projectId: 'p1' },
        body: { path: '/main.tex', contentBase64: 'AAAA', overwrite: true },
      },
      r
    )
    expect(r.statusCode).toBe(200)
    expect(EditorController.promises.upsertFileWithPath).toHaveBeenCalled()
  })

  it('refuses a folder path that differs from an existing folder only in case', async () => {
    projectWith({ folders: [{ path: '/', folder: {} }, { path: '/chapters', folder: {} }] })
    const r = res()
    await McpFilesController.createFolder(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, body: { path: '/Chapters' } },
      r
    )
    expect(r.statusCode).toBe(409)
    expect(r.body.details).toEqual({ folder: '/chapters' })
    expect(EditorController.promises.mkdirp).not.toHaveBeenCalled()
  })

  it('refuses a write through a folder path that differs only in case', async () => {
    projectWith({ folders: [{ path: '/', folder: {} }, { path: '/chapters', folder: {} }] })
    const r = res()
    await McpFilesController.writeDoc(
      {
        mcpUserId: 'u1',
        params: { projectId: 'p1' },
        body: { path: '/Chapters/a.tex', content: 'x' },
      },
      r
    )
    expect(r.statusCode).toBe(409)
    expect(EditorController.promises.upsertDocWithPath).not.toHaveBeenCalled()
  })

  it('creates a folder whose name does not exist in any case', async () => {
    projectWith({ folders: [{ path: '/', folder: {} }, { path: '/chapters', folder: {} }] })
    const r = res()
    await McpFilesController.createFolder(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, body: { path: '/appendix' } },
      r
    )
    expect(r.statusCode).toBe(200)
    expect(EditorController.promises.mkdirp).toHaveBeenCalledWith('p1', '/appendix', 'u1')
  })

  it('returns the hash that a write accepts as expectedHash', async () => {
    projectWith({ docs: [{ path: '/main.tex', doc: { _id: 'd1' } }] })
    DocstoreManager.promises.getDoc.mockResolvedValue({ lines: ['a', 'b'] })
    const read = res()
    await McpFilesController.getDoc(
      { params: { projectId: 'p1' }, query: { path: '/main.tex', startLine: '2' } },
      read
    )
    const expected = (await import('node:crypto'))
      .createHash('sha256')
      .update('a\nb')
      .digest('hex')
    expect(read.body.hash).toBe(expected)

    EditorController.promises.upsertDocWithPath.mockResolvedValue({ doc: { _id: 'd1' } })
    const write = res()
    await McpFilesController.writeDoc(
      {
        mcpUserId: 'u1',
        params: { projectId: 'p1' },
        body: { path: '/main.tex', content: 'c', expectedHash: read.body.hash },
      },
      write
    )
    expect(write.statusCode).toBe(200)
  })

  it('rejects a maxMatches or contextLines above the caps', async () => {
    for (const query of [
      { query: 'hit', maxMatches: '501' },
      { query: 'hit', contextLines: '21' },
    ]) {
      const r = res()
      await McpFilesController.searchFiles(
        { mcpUserId: 'u1', params: { projectId: 'p1' }, query },
        r
      )
      expect(r.statusCode, JSON.stringify(query)).toBe(400)
      expect(r.body.code).toBe('validation_error')
    }
  })

  it('refuses a regex search over the text cap before fetching the rest of the project', async () => {
    projectWith({
      docs: [
        { path: '/a.tex', doc: { _id: 'd1' } },
        { path: '/b.tex', doc: { _id: 'd2' } },
        { path: '/c.tex', doc: { _id: 'd3' } },
      ],
    })
    DocstoreManager.promises.getDoc.mockResolvedValue({
      lines: ['x'.repeat(6 * MIB)],
    })
    const r = res()
    await McpFilesController.searchFiles(
      {
        mcpUserId: 'u1',
        params: { projectId: 'p1' },
        query: { query: 'x', regex: 'true' },
      },
      r
    )
    expect(r.statusCode).toBe(400)
    expect(r.body.message).toContain('too large for a regular expression search')
  })

  it('refuses a project zip whose binary files exceed the cap before streaming', async () => {
    ProjectGetter.promises.getProject.mockResolvedValue({ name: 'Big' })
    projectWith({
      files: [{ path: '/video.mp4', file: { _id: 'f1', size: 70 * MIB } }],
    })
    const r = res()
    await McpFilesController.downloadProjectZip(
      { mcpUserId: 'u1', params: { projectId: 'p1' } },
      r
    )
    expect(r.statusCode).toBe(413)
    expect(r.body.code).toBe('output_too_large')
    expect(ProjectZipStreamManager.createZipStreamForProject).not.toHaveBeenCalled()
  })

  it('refuses a multi-project zip whose binary files together exceed the cap', async () => {
    AuthorizationManager.promises.canUserReadProject.mockResolvedValue(true)
    ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
      docs: [],
      files: [{ path: '/a.bin', file: { _id: 'f1', size: 40 * MIB } }],
      folders: [],
    })
    const r = res()
    await McpFilesController.downloadMultipleProjectsZip(
      { mcpUserId: 'u1', body: { projectIds: ['p1', 'p2'] } },
      r
    )
    expect(r.statusCode).toBe(413)
    expect(r.body.code).toBe('output_too_large')
    expect(
      ProjectZipStreamManager.createZipStreamForMultipleProjects
    ).not.toHaveBeenCalled()
  })
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
      folders: [],
      rootDocPath: null,
    })
  })

  it('reports the root document, folders and the size of binary files', async () => {
    ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
      docs: [
        { path: '/main.tex', doc: { _id: 'd1' } },
        { path: '/chapters/a.tex', doc: { _id: 'd2' } },
      ],
      files: [{ path: '/fig/plot.png', file: { _id: 'f1', size: 2048 } }],
      folders: [
        { path: '/', folder: { _id: 'root' } },
        { path: '/chapters', folder: { _id: 'c1' } },
      ],
    })
    ProjectGetter.promises.getProject.mockResolvedValue({ rootDoc_id: 'd1' })
    const r = res()
    await McpFilesController.getTree({ params: { projectId: 'p1' } }, r)
    expect(r.body.rootDocPath).toBe('/main.tex')
    expect(r.body.folders).toEqual([{ path: '/chapters', id: 'c1' }])
    expect(r.body.files).toEqual([{ path: '/fig/plot.png', id: 'f1', size: 2048 }])
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

  it('returns the total line count and the range it actually served', async () => {
    DocstoreManager.promises.getDoc.mockResolvedValue({ lines: ['a', 'b', 'c'] })
    ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
      docs: [{ path: '/main.tex', doc: { _id: 'd1' } }],
      files: [],
      folders: [],
    })
    const r = res()
    await McpFilesController.getDoc(
      { params: { projectId: 'p1' }, query: { path: '/main.tex', startLine: '2', endLine: '99' } },
      r
    )
    expect(r.body).toEqual({
      path: '/main.tex',
      content: 'b\nc',
      totalLines: 3,
      startLine: 2,
      endLine: 3,
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
  })

  it('reports the line count when startLine is past the end', async () => {
    DocstoreManager.promises.getDoc.mockResolvedValue({ lines: ['a', 'b'] })
    ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
      docs: [{ path: '/main.tex', doc: { _id: 'd1' } }],
      files: [],
      folders: [],
    })
    const r = res()
    await McpFilesController.getDoc(
      { params: { projectId: 'p1' }, query: { path: '/main.tex', startLine: '9' } },
      r
    )
    expect(r.statusCode).toBe(400)
    expect(r.body.code).toBe('validation_error')
    expect(r.body.details).toEqual({ totalLines: 2 })
  })

  it('returns the closest real paths as candidates for an unknown path', async () => {
    ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
      docs: [{ path: '/chapters/intro.tex', doc: { _id: 'd1' } }],
      files: [{ path: '/figures/plot.png', file: { _id: 'f1' } }],
      folders: [],
    })
    const r = res()
    await McpFilesController.getDoc(
      { params: { projectId: 'p1' }, query: { path: '/chapter/intro.tex' } },
      r
    )
    expect(r.statusCode).toBe(404)
    expect(r.body.details.candidates).toEqual(['/chapters/intro.tex'])
  })

  it('points a binary file at download_file instead of returning not_found', async () => {
    ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
      docs: [],
      files: [{ path: '/figures/plot.png', file: { _id: 'f1' } }],
      folders: [],
    })
    const r = res()
    await McpFilesController.getDoc(
      { params: { projectId: 'p1' }, query: { path: '/figures/plot.png' } },
      r
    )
    expect(r.statusCode).toBe(400)
    expect(r.body.hint).toMatch(/download_file/)
  })
})

describe('McpFilesController.readDocs', () => {
  const sha = lines =>
    crypto.createHash('sha256').update(lines.join('\n')).digest('hex')

  const project = (docs, files = []) =>
    ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
      docs: docs.map(([p, id]) => ({ path: p, doc: { _id: id } })),
      files: files.map(p => ({ path: p, file: { _id: 'f-' + p } })),
      folders: [],
    })

  const run = async b => {
    const r = res()
    await McpFilesController.readDocs(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, body: b },
      r
    )
    return r
  }

  it('returns documents in the order of paths, with missing entries', async () => {
    project([
      ['/a.tex', 'ida'],
      ['/b.tex', 'idb'],
    ], ['/img/x.png'])
    DocstoreManager.promises.getAllDocs.mockResolvedValue([
      { _id: 'ida', lines: ['a1'] },
      { _id: 'idb', lines: ['b1', 'b2'] },
    ])
    const r = await run({
      paths: ['b.tex', '/nope.tex', '/img/x.png', '/a.tex'],
    })
    expect(r.statusCode).toBe(200)
    expect(r.body.documents.map(d => d.path)).toEqual(['/b.tex', '/a.tex'])
    expect(r.body.missing).toEqual([
      { path: '/nope.tex', reason: 'not_found' },
      { path: '/img/x.png', reason: 'binary' },
    ])
  })

  it('applies the line range to every document and clamps endLine', async () => {
    project([
      ['/a.tex', 'ida'],
      ['/b.tex', 'idb'],
    ])
    DocstoreManager.promises.getAllDocs.mockResolvedValue([
      { _id: 'ida', lines: ['a', 'b', 'c', 'd'] },
      { _id: 'idb', lines: ['x', 'y'] },
    ])
    const r = await run({
      paths: ['/a.tex', '/b.tex'],
      startLine: 2,
      endLine: 3,
    })
    expect(r.body.documents[0]).toEqual({
      path: '/a.tex',
      content: 'b\nc',
      totalLines: 4,
      startLine: 2,
      endLine: 3,
      hash: sha(['a', 'b', 'c', 'd']),
    })
    expect(r.body.documents[1]).toEqual({
      path: '/b.tex',
      content: 'y',
      totalLines: 2,
      startLine: 2,
      endLine: 2,
      hash: sha(['x', 'y']),
    })
  })

  it('reports an error entry for a document past the range start', async () => {
    project([
      ['/a.tex', 'ida'],
      ['/b.tex', 'idb'],
    ])
    DocstoreManager.promises.getAllDocs.mockResolvedValue([
      { _id: 'ida', lines: ['a', 'b'] },
      { _id: 'idb', lines: ['x'] },
    ])
    const r = await run({ paths: ['/a.tex', '/b.tex'], startLine: 2 })
    expect(r.statusCode).toBe(200)
    expect(r.body.documents[0].content).toBe('b')
    expect(r.body.documents[1]).toEqual({
      path: '/b.tex',
      totalLines: 1,
      error: 'startLine 2 is past the end (1 lines)',
    })
  })

  it('filters by extension case-insensitively, sorted by path', async () => {
    project([
      ['/z.TEX', 'idz'],
      ['/a.tex', 'ida'],
      ['/notes.md', 'idn'],
    ])
    DocstoreManager.promises.getAllDocs.mockResolvedValue([
      { _id: 'ida', lines: ['a'] },
      { _id: 'idz', lines: ['z'] },
      { _id: 'idn', lines: ['n'] },
    ])
    const r = await run({ ext: '.tex' })
    expect(r.body.documents.map(d => d.path)).toEqual(['/a.tex', '/z.TEX'])
    expect(r.body.missing).toEqual([])
  })

  it('returns every document when neither paths nor ext is given', async () => {
    project([
      ['/b.tex', 'idb'],
      ['/a.md', 'ida'],
    ])
    DocstoreManager.promises.getAllDocs.mockResolvedValue([
      { _id: 'ida', lines: ['a'] },
      { _id: 'idb', lines: ['b'] },
    ])
    const r = await run({})
    expect(r.body.documents.map(d => d.path)).toEqual(['/a.md', '/b.tex'])
  })

  it('treats null paths and ext as absent', async () => {
    project([
      ['/b.tex', 'idb'],
      ['/a.md', 'ida'],
    ])
    DocstoreManager.promises.getAllDocs.mockResolvedValue([
      { _id: 'ida', lines: ['a'] },
      { _id: 'idb', lines: ['b'] },
    ])
    const r = await run({ paths: null, ext: null })
    expect(r.statusCode).toBe(200)
    expect(r.body.documents.map(d => d.path)).toEqual(['/a.md', '/b.tex'])
  })

  it('fetches all doc lines once and falls back to getDoc for missing ids', async () => {
    project([
      ['/a.tex', 'ida'],
      ['/b.tex', 'idb'],
    ])
    DocstoreManager.promises.getAllDocs.mockResolvedValue([
      { _id: 'ida', lines: ['a'] },
    ])
    DocstoreManager.promises.getDoc.mockResolvedValue({ lines: ['b'] })
    const r = await run({ paths: ['/a.tex', '/b.tex'] })
    expect(DocstoreManager.promises.getAllDocs).toHaveBeenCalledTimes(1)
    expect(DocstoreManager.promises.getAllDocs).toHaveBeenCalledWith('p1')
    expect(DocstoreManager.promises.getDoc).toHaveBeenCalledTimes(1)
    expect(DocstoreManager.promises.getDoc).toHaveBeenCalledWith('p1', 'idb')
    expect(r.body.documents.map(d => d.content)).toEqual(['a', 'b'])
  })

  it('returns an empty result without reading docstore when nothing matches', async () => {
    project([])
    const r = await run({ paths: [] })
    expect(r.body).toEqual({ documents: [], missing: [] })
    expect(DocstoreManager.promises.getAllDocs).not.toHaveBeenCalled()
  })

  it('treats a document with no lines as one empty line', async () => {
    project([['/e.tex', 'ide']])
    DocstoreManager.promises.getAllDocs.mockResolvedValue([
      { _id: 'ide', lines: [] },
    ])
    const r = await run({ paths: ['/e.tex'] })
    expect(r.body.documents[0]).toMatchObject({ content: '', totalLines: 1 })
  })

  it.each([
    ['paths not an array', { paths: '/a.tex' }],
    ['a non-string path', { paths: [1] }],
    ['an empty path', { paths: [''] }],
    [
      'more than 200 paths',
      { paths: Array.from({ length: 201 }, (_, i) => `/f${i}.tex`) },
    ],
    ['a zero startLine', { paths: ['/a.tex'], startLine: 0 }],
    ['a fractional endLine', { endLine: 1.5 }],
    ['endLine before startLine', { startLine: 5, endLine: 2 }],
    ['a .. segment', { paths: ['/a/../../b.tex'] }],
    ['an empty ext', { ext: '  ' }],
    ['an ext of only a dot', { ext: '.' }],
  ])('rejects %s with a validation error', async (_name, b) => {
    const r = await run(b)
    expect(r.statusCode).toBe(400)
    expect(r.body.code).toBe('validation_error')
    expect(DocstoreManager.promises.getAllDocs).not.toHaveBeenCalled()
  })
})

describe('suggestPaths', () => {
  it('ranks a near miss first and ignores unrelated paths', () => {
    expect(
      suggestPaths('/chapters/intro.tex', ['/appendix.tex', '/chapters/intro.tex', '/x/y.bib'])
    ).toEqual(['/chapters/intro.tex'])
  })

  it('matches a bare name against its .tex file', () => {
    expect(suggestPaths('/chapters/intro', ['/chapters/intro.tex'])).toEqual([
      '/chapters/intro.tex',
    ])
  })

  it('returns nothing when no path is close', () => {
    expect(suggestPaths('/zzzzzzzz.tex', ['/main.tex'])).toEqual([])
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
    ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
      docs: [],
      files: [],
      folders: [],
    })
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
    expect(r.body.created).toBe(true)
    expect(r.body.lineCount).toBe(2)
  })

  it('reports how many lines an overwrite replaced', async () => {
    ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
      docs: [{ path: '/main.tex', doc: { _id: 'd1' } }],
      files: [],
      folders: [],
    })
    DocstoreManager.promises.getDoc.mockResolvedValue({ lines: ['a', 'b', 'c'] })
    EditorController.promises.upsertDocWithPath.mockResolvedValue({ doc: { _id: 'd1' } })
    const r = res()
    await McpFilesController.writeDoc(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, body: { path: '/main.tex', content: 'x' } },
      r
    )
    expect(r.body.created).toBe(false)
    expect(r.body.previousLineCount).toBe(3)
    expect(r.body.lineCount).toBe(1)
  })

  it('refuses to write over a binary file at the same path', async () => {
    ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
      docs: [],
      files: [{ path: '/logo.png', file: { _id: 'f1' } }],
      folders: [],
    })
    const r = res()
    await McpFilesController.writeDoc(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, body: { path: '/logo.png', content: 'x' } },
      r
    )
    expect(r.statusCode).toBe(409)
    expect(r.body.code).toBe('conflict')
    expect(EditorController.promises.upsertDocWithPath).not.toHaveBeenCalled()
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

  it('refuses to move or rename the project root', async () => {
    ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
      docs: [],
      files: [],
      folders: [{ path: '/', folder: { _id: 'root' } }],
    })
    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      body: { oldPath: '/', newPath: '/renamed' },
    }
    const r = res()
    await McpFilesController.moveEntity(req, r)
    expect(r.statusCode).toBe(400)
    expect(r.body.code).toBe('validation_error')
    expect(EditorController.promises.renameEntity).not.toHaveBeenCalled()
    expect(EditorController.promises.moveEntity).not.toHaveBeenCalled()
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
    expect(r.statusCode).toBe(409)
    expect(r.body.message).toContain('already exists')
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

  it('rejects renaming a folder when destination differs only in letter case from existing folder', async () => {
    ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
      docs: [],
      files: [],
      folders: [
        { path: '/', folder: { _id: 'root' } },
        { path: '/chapters', folder: { _id: 'f1' } },
        { path: '/other', folder: { _id: 'f2' } },
      ],
    })
    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      body: { oldPath: '/other', newPath: '/Chapters' },
    }
    const r = res()
    await McpFilesController.moveEntity(req, r)
    expect(r.statusCode).toBe(409)
    expect(r.body.code).toBe('conflict')
    expect(r.body.message).toBe(
      'a folder named /chapters already exists, and /Chapters differs from it only in letter case'
    )
    expect(EditorController.promises.moveEntity).not.toHaveBeenCalled()
    expect(EditorController.promises.renameEntity).not.toHaveBeenCalled()
  })

  it('rejects moving an entity when destination folder path differs only in letter case', async () => {
    ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
      docs: [{ path: '/a.tex', doc: { _id: 'd1' } }],
      files: [],
      folders: [
        { path: '/', folder: { _id: 'root' } },
        { path: '/chapters', folder: { _id: 'f1' } },
      ],
    })
    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      body: { oldPath: '/a.tex', newPath: '/Chapters/a.tex' },
    }
    const r = res()
    await McpFilesController.moveEntity(req, r)
    expect(r.statusCode).toBe(409)
    expect(r.body.code).toBe('conflict')
    expect(r.body.message).toBe(
      'a folder named /chapters already exists, and /Chapters differs from it only in letter case'
    )
    expect(EditorController.promises.moveEntity).not.toHaveBeenCalled()
    expect(EditorController.promises.renameEntity).not.toHaveBeenCalled()
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

  it('stores a file whatever its extension', async () => {
    EditorController.promises.upsertFileWithPath.mockResolvedValue({
      file: { _id: 'f3' },
    })
    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      body: { path: 'bin/tool.exe', contentBase64: 'AA==' },
    }
    const r = res()
    await McpFilesController.uploadFile(req, r)
    expect(r.statusCode).toBe(200)
    expect(EditorController.promises.upsertFileWithPath).toHaveBeenCalledWith(
      'p1',
      '/bin/tool.exe',
      expect.any(String),
      null,
      'mcp',
      'u1'
    )
  })

  it('stores a base64 payload larger than the old JSON body cap', async () => {
    EditorController.promises.upsertFileWithPath.mockResolvedValue({
      file: { _id: 'f4' },
    })
    const size = 9 * 1024 * 1024
    const big = Buffer.alloc(size, 1).toString('base64')
    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      body: { path: 'x.png', contentBase64: big },
    }
    const r = res()
    await McpFilesController.uploadFile(req, r)
    expect(r.statusCode).toBe(200)
    expect(fsPromises.writeFile.mock.calls.at(-1)[1].length).toBe(size)
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
    // The fetch is capped at the MCP body limit, so a remote body cannot
    // exhaust memory.
    expect(McpUrlFetcher.fetchToBuffer).toHaveBeenCalledWith(
      'https://example.com/i.png',
      { maxBytes: 50 * 1024 * 1024 }
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
    const mockStream = new PassThrough()
    ProjectZipStreamManager.createZipStreamForProject.mockImplementation(
      (pid, hist, hId, cb) => {
        cb(null, mockStream)
        mockStream.end('zip content')
      }
    )

    const req = { mcpUserId: 'u1', params: { projectId: 'p1' } }
    const r = res()
    await McpFilesController.downloadProjectZip(req, r)

    expect(r.headers['content-type']).toBe('application/zip')
    expect(r.headers['content-disposition']).toBe('attachment; filename="My_Thesis.zip"')
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

  it('accepts more than 50 projects', async () => {
    AuthorizationManager.promises.canUserReadProject.mockResolvedValue(true)
    const projectIds = Array.from({ length: 51 }, (_, i) => `p${i}`)
    const req = { mcpUserId: 'u1', body: { projectIds } }
    const r = res()
    await McpFilesController.downloadMultipleProjectsZip(req, r)
    expect(
      ProjectZipStreamManager.createZipStreamForMultipleProjects.mock.calls.at(-1)[0]
    ).toEqual(projectIds)
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
    const mockStream = new PassThrough()
    ProjectZipStreamManager.createZipStreamForMultipleProjects.mockImplementation(
      (pids, hist, cb) => {
        cb(null, mockStream)
        mockStream.end('zip content')
      }
    )

    const req = { mcpUserId: 'u1', body: { projectIds: ['p1', 'p2'] } }
    const r = res()
    await McpFilesController.downloadMultipleProjectsZip(req, r)

    expect(r.headers['content-type']).toBe('application/zip')
    // Overleaf Projects <date> <clock> UTC (<count> projects).zip
    expect(r.headers['content-disposition']).toMatch(
      /^attachment; filename="Overleaf Projects \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2} UTC \(2 projects\)\.zip"$/
    )
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

  it('names a file with non-Latin-1 characters with an RFC 5987 filename parameter', async () => {
    ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
      docs: [{ path: '/bảng.tex', doc: { _id: 'd1' } }],
      files: [],
      folders: [],
    })
    DocstoreManager.promises.getDoc.mockResolvedValue({ lines: ['x'] })

    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      query: { path: '/bảng.tex' },
    }
    const r = res()
    r.send = vi.fn(() => r)

    await McpFilesController.downloadFile(req, r)

    expect(r.statusCode).toBe(200)
    expect(r.headers['content-disposition']).toBe(
      `attachment; filename="b_ng.tex"; filename*=UTF-8''b%E1%BA%A3ng.tex`
    )
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

  it('searches project documents and returns matching lines with line numbers and text', async () => {
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
        text: 'Theorem 1 is important.',
        before: [],
        after: [],
      },
    ])
    expect(r.body.truncated).toBe(false)
    expect(r.body.filesSearched).toBe(2)
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
    expect(r.body.matches[0].text).toBe('Hello world')
  })

  it('filters by a glob and a folder prefix that matches whole segments only', async () => {
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
      query: { query: 'findme', path: '/chapters', glob: '*.tex' },
    }
    const r = res()
    await McpFilesController.searchFiles(req, r)

    expect(r.body.totalMatches).toBe(1)
    expect(r.body.matches[0].path).toBe('/chapters/ch1.tex')

    const prefixReq = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      query: { query: 'findme', path: '/chap' },
    }
    const prefixRes = res()
    await McpFilesController.searchFiles(prefixReq, prefixRes)
    expect(prefixRes.body.totalMatches).toBe(0)
  })

  it('treats the query as a regular expression when regex=true', async () => {
    ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
      docs: [{ path: '/main.tex', doc: { _id: 'd1' } }],
      files: [],
      folders: [],
    })
    DocstoreManager.promises.getDoc.mockResolvedValue({
      lines: ['\\label{eq:one}', '\\label{fig:two}', 'plain'],
    })
    const r = res()
    await McpFilesController.searchFiles(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, query: { query: '\\\\label\\{eq:', regex: 'true' } },
      r
    )
    expect(r.body.regex).toBe(true)
    expect(r.body.matches.map(m => m.line)).toEqual([1])
  })

  it('rejects an invalid regular expression with validation_error', async () => {
    const r = res()
    await McpFilesController.searchFiles(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, query: { query: '(', regex: 'true' } },
      r
    )
    expect(r.statusCode).toBe(400)
    expect(r.body.message).toMatch(/invalid regular expression/)
  })

  it('stops a catastrophic regular expression once the client disconnects', async () => {
    ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
      docs: [{ path: '/main.tex', doc: { _id: 'd1' } }],
      files: [],
      folders: [],
    })
    DocstoreManager.promises.getDoc.mockResolvedValue({
      lines: [`${'a'.repeat(40)}!`],
    })
    const r = res()
    const started = Date.now()
    const search = McpFilesController.searchFiles(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, query: { query: '^(a+)+$', regex: 'true' } },
      r
    )
    setTimeout(() => r.emit('close'), 100)
    await search
    expect(Date.now() - started).toBeLessThan(5000)
    expect(r.body).toBeNull()
  })

  it('has no length limit on the query', async () => {
    ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
      docs: [{ path: '/main.tex', doc: { _id: 'd1' } }],
      files: [],
      folders: [],
    })
    DocstoreManager.promises.getDoc.mockResolvedValue({ lines: ['x'] })
    const query = 'q'.repeat(600)
    const r = res()
    await McpFilesController.searchFiles(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, query: { query } },
      r
    )
    expect(r.statusCode).toBe(200)
    expect(r.body.totalMatches).toBe(0)
  })

  it('returns context lines around each match', async () => {
    ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
      docs: [{ path: '/main.tex', doc: { _id: 'd1' } }],
      files: [],
      folders: [],
    })
    DocstoreManager.promises.getDoc.mockResolvedValue({
      lines: ['one', 'two', 'needle', 'four', 'five'],
    })
    const r = res()
    await McpFilesController.searchFiles(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, query: { query: 'needle', contextLines: '2' } },
      r
    )
    expect(r.body.matches[0]).toMatchObject({
      line: 3,
      before: ['one', 'two'],
      after: ['four', 'five'],
    })
  })

  it('accepts a maxMatches and contextLines above the old caps', async () => {
    ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
      docs: [{ path: '/main.tex', doc: { _id: 'd1' } }],
      files: [],
      folders: [],
    })
    DocstoreManager.promises.getDoc.mockResolvedValue({
      lines: Array.from({ length: 300 }, (_, i) => `hit ${i}`),
    })
    const r = res()
    await McpFilesController.searchFiles(
      {
        mcpUserId: 'u1',
        params: { projectId: 'p1' },
        query: { query: 'hit', maxMatches: '250', contextLines: '8' },
      },
      r
    )
    expect(r.statusCode).toBe(200)
    expect(r.body.totalMatches).toBe(250)
  })

  it('rejects a maxMatches below 1', async () => {
    const r = res()
    await McpFilesController.searchFiles(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, query: { query: 'hit', maxMatches: '0' } },
      r
    )
    expect(r.statusCode).toBe(400)
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
    expect(r.body.truncated).toBe(true)
  })
})

describe('McpFilesController.deleteEntity', () => {
  it('rejects a missing path and the project root', async () => {
    const missing = res()
    await McpFilesController.deleteEntity({ params: { projectId: 'p1' }, query: {} }, missing)
    expect(missing.statusCode).toBe(400)
    const root = res()
    await McpFilesController.deleteEntity({ params: { projectId: 'p1' }, query: { path: '/' } }, root)
    expect(root.statusCode).toBe(400)
    expect(EditorController.promises.deleteEntity).not.toHaveBeenCalled()
  })

  it('deletes a document by id and reports what was removed', async () => {
    ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
      docs: [{ path: '/old.tex', doc: { _id: 'd9' } }],
      files: [],
      folders: [],
    })
    ProjectGetter.promises.getProject.mockResolvedValue({ rootDoc_id: 'd1' })
    EditorController.promises.deleteEntity.mockResolvedValue()
    const r = res()
    await McpFilesController.deleteEntity(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, query: { path: 'old.tex' } },
      r
    )
    expect(EditorController.promises.deleteEntity).toHaveBeenCalledWith(
      'p1',
      'd9',
      'doc',
      'mcp',
      'u1'
    )
    expect(r.body.deleted).toEqual({ docs: 1, files: 0, folders: 0 })
  })

  it('counts everything inside a folder before deleting it', async () => {
    ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
      docs: [
        { path: '/fig/a.tex', doc: { _id: 'd1' } },
        { path: '/main.tex', doc: { _id: 'd2' } },
      ],
      files: [{ path: '/fig/p.png', file: { _id: 'f1' } }],
      folders: [
        { path: '/', folder: { _id: 'root' } },
        { path: '/fig', folder: { _id: 'fo1' } },
      ],
    })
    ProjectGetter.promises.getProject.mockResolvedValue({ rootDoc_id: 'd2' })
    EditorController.promises.deleteEntity.mockResolvedValue()
    const r = res()
    await McpFilesController.deleteEntity(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, query: { path: '/fig' } },
      r
    )
    expect(EditorController.promises.deleteEntity).toHaveBeenCalledWith(
      'p1',
      'fo1',
      'folder',
      'mcp',
      'u1'
    )
    expect(r.body.deleted).toEqual({ docs: 1, files: 1, folders: 1 })
  })

  it('refuses to delete a folder that holds the root document', async () => {
    ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
      docs: [{ path: '/src/main.tex', doc: { _id: 'd1' } }],
      files: [],
      folders: [{ path: '/src', folder: { _id: 'fo1' } }],
    })
    ProjectGetter.promises.getProject.mockResolvedValue({ rootDoc_id: 'd1' })
    const r = res()
    await McpFilesController.deleteEntity(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, query: { path: '/src' } },
      r
    )
    expect(r.statusCode).toBe(400)
    expect(r.body.message).toMatch(/root document/)
    expect(EditorController.promises.deleteEntity).not.toHaveBeenCalled()
  })

  it('returns not_found with candidates for an unknown path', async () => {
    ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
      docs: [{ path: '/main.tex', doc: { _id: 'd1' } }],
      files: [],
      folders: [],
    })
    ProjectGetter.promises.getProject.mockResolvedValue({})
    const r = res()
    await McpFilesController.deleteEntity(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, query: { path: '/mian.tex' } },
      r
    )
    expect(r.statusCode).toBe(404)
    expect(r.body.details.candidates).toEqual(['/main.tex'])
  })
})
