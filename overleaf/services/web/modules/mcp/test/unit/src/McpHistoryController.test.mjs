import { describe, it, expect, vi, beforeEach } from 'vitest'

const HistoryManager = {
  promises: {
    flushProject: vi.fn(),
    injectUserDetails: vi.fn(data => data),
    getContentAtVersion: vi.fn(),
    requestBlob: vi.fn(),
  },
}
const RestoreManager = { promises: { revertFile: vi.fn() } }
const ProjectAuditLogHandler = { addEntryIfManagedInBackground: vi.fn() }
const ProjectGetter = { promises: { getProject: vi.fn() } }
const fetchJson = vi.fn()

class RequestFailedError extends Error {
  constructor(status) {
    super('request failed')
    this.response = { status }
  }
}

vi.mock('@overleaf/fetch-utils', () => ({ fetchJson, RequestFailedError }))
// A snapshot is a map from path to file here; Snapshot.fromRaw is the identity.
vi.mock('overleaf-editor-core', () => ({ Snapshot: { fromRaw: raw => raw } }))
vi.mock(
  '../../../../../app/src/Features/Project/ProjectGetter.mjs',
  () => ({ default: ProjectGetter })
)
vi.mock('../../../../../app/src/Features/History/HistoryManager.mjs', () => ({
  default: HistoryManager,
}))
vi.mock('../../../../../app/src/Features/History/RestoreManager.mjs', () => ({
  default: RestoreManager,
}))
vi.mock(
  '../../../../../app/src/Features/Project/ProjectAuditLogHandler.mjs',
  () => ({ default: ProjectAuditLogHandler })
)

const { default: McpHistoryController, summariseDiff } = await import(
  '../../../app/src/McpHistoryController.mjs'
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
    setHeader() {},
  }
}

function snapshotWith(files) {
  return { getFile: pathname => files[pathname] }
}

const editableFile = {
  isEditable: () => true,
  getHash: () => 'h1',
}
const binaryFile = {
  isEditable: () => false,
  getHash: () => 'h2',
}

beforeEach(() => {
  vi.clearAllMocks()
  HistoryManager.promises.injectUserDetails.mockImplementation(data => data)
  ProjectGetter.promises.getProject.mockResolvedValue({
    overleaf: { history: { id: 'hist1', rangesSupportEnabled: true } },
  })
  HistoryManager.promises.getContentAtVersion.mockResolvedValue(
    snapshotWith({
      'chapters/intro.tex': editableFile,
      'fig/plot.png': binaryFile,
    })
  )
  HistoryManager.promises.requestBlob.mockResolvedValue({
    stream: { destroy: vi.fn() },
  })
  RestoreManager.promises.revertFile.mockResolvedValue({ _id: 'd9', type: 'doc' })
})

describe('McpHistoryController.listHistory', () => {
  const update = {
    fromV: 4,
    toV: 6,
    meta: {
      start_ts: 1700000000000,
      end_ts: 1700000060000,
      users: [{ first_name: 'Ada', last_name: 'Lovelace', email: 'a@x' }],
    },
    labels: [],
    pathnames: ['main.tex'],
    project_ops: [{ remove: { pathname: 'old.tex' } }],
  }

  it('flushes, then returns versions with paths that carry a leading slash', async () => {
    fetchJson.mockResolvedValue({ updates: [update], nextBeforeTimestamp: 17 })
    const r = res()
    await McpHistoryController.listHistory(
      { params: { projectId: 'p1' }, query: { limit: '5' }, mcpUserId: 'u1' },
      r
    )
    expect(HistoryManager.promises.flushProject).toHaveBeenCalledWith('p1')
    expect(String(fetchJson.mock.calls[0][0])).toContain('min_count=5')
    expect(r.body.nextBefore).toBe(17)
    const [entry] = r.body.entries
    expect(entry.fromVersion).toBe(4)
    expect(entry.toVersion).toBe(6)
    expect(entry.authors).toEqual(['Ada Lovelace'])
    expect(entry.changes).toEqual([
      { path: '/main.tex', change: 'edited' },
      { path: '/old.tex', change: 'deleted' },
    ])
  })

  it('keeps only entries that touched the requested path', async () => {
    fetchJson.mockResolvedValue({ updates: [update] })
    const r = res()
    await McpHistoryController.listHistory(
      { params: { projectId: 'p1' }, query: { path: 'other.tex' } },
      r
    )
    expect(r.body.entries).toEqual([])
    expect(r.body.path).toBe('/other.tex')
  })

  it('rejects a limit below 1 or not a whole number', async () => {
    for (const limit of ['0', '2.5', 'many']) {
      const r = res()
      await McpHistoryController.listHistory(
        { params: { projectId: 'p1' }, query: { limit } },
        r
      )
      expect(r.statusCode, limit).toBe(400)
    }
    expect(fetchJson).not.toHaveBeenCalled()
  })

  it('accepts a limit above 100', async () => {
    fetchJson.mockResolvedValue({ updates: [] })
    const r = res()
    await McpHistoryController.listHistory(
      { params: { projectId: 'p1' }, query: { limit: '500' }, mcpUserId: 'u1' },
      r
    )
    expect(r.statusCode).toBe(200)
    expect(fetchJson.mock.calls[0][0].searchParams.get('min_count')).toBe('500')
  })
})

describe('McpHistoryController.listHistory path filter paging', () => {
  const touching = {
    fromV: 1,
    toV: 2,
    meta: { start_ts: 1, end_ts: 2, users: [] },
    labels: [],
    pathnames: ['main.tex'],
    project_ops: [],
  }
  const elsewhere = { ...touching, pathnames: ['other.tex'] }

  it('keeps reading older pages until the filtered list fills', async () => {
    fetchJson
      .mockResolvedValueOnce({ updates: [elsewhere], nextBeforeTimestamp: 9 })
      .mockResolvedValueOnce({ updates: [touching], nextBeforeTimestamp: 4 })
    const r = res()
    await McpHistoryController.listHistory(
      {
        params: { projectId: 'p1' },
        query: { path: 'main.tex', limit: '1' },
        mcpUserId: 'u1',
      },
      r
    )
    expect(fetchJson).toHaveBeenCalledTimes(2)
    expect(String(fetchJson.mock.calls[1][0])).toContain('before=9')
    expect(r.body.entries).toHaveLength(1)
    expect(r.body.nextBefore).toBe(4)
  })

  it('trims an overshooting page to limit and resumes after the last kept entry', async () => {
    const page = [
      { ...touching, fromV: 30, toV: 31 },
      { ...touching, fromV: 20, toV: 21 },
      { ...touching, fromV: 10, toV: 11 },
    ]
    fetchJson.mockResolvedValueOnce({ updates: page, nextBeforeTimestamp: 5 })
    const r = res()
    await McpHistoryController.listHistory(
      {
        params: { projectId: 'p1' },
        query: { path: 'main.tex', limit: '2' },
        mcpUserId: 'u1',
      },
      r
    )
    expect(fetchJson).toHaveBeenCalledTimes(1)
    expect(r.body.entries.map(e => e.fromVersion)).toEqual([30, 20])
    expect(r.body.nextBefore).toBe(20)
  })

  it('stops when history runs out, returning no nextBefore', async () => {
    fetchJson.mockResolvedValueOnce({ updates: [elsewhere] })
    const r = res()
    await McpHistoryController.listHistory(
      { params: { projectId: 'p1' }, query: { path: 'main.tex' }, mcpUserId: 'u1' },
      r
    )
    expect(fetchJson).toHaveBeenCalledTimes(1)
    expect(r.body.entries).toEqual([])
    expect(r.body.nextBefore).toBeNull()
  })

  it('stops after the page budget and resumes from the last page read', async () => {
    fetchJson.mockResolvedValue({ updates: [elsewhere], nextBeforeTimestamp: 7 })
    const r = res()
    await McpHistoryController.listHistory(
      { params: { projectId: 'p1' }, query: { path: 'main.tex', limit: '5' }, mcpUserId: 'u1' },
      r
    )
    expect(fetchJson).toHaveBeenCalledTimes(10)
    expect(r.body.entries).toEqual([])
    expect(r.body.nextBefore).toBe(7)
  })
})

describe('McpHistoryController.restoreFile guards', () => {
  const body = { path: '/chapters/intro.tex', version: 12 }

  it('returns 400 and deletes nothing when the project lacks ranges support', async () => {
    ProjectGetter.promises.getProject.mockResolvedValue({
      overleaf: { history: { id: 'hist1', rangesSupportEnabled: false } },
    })
    const r = res()
    await McpHistoryController.restoreFile(
      { params: { projectId: 'p1' }, body, mcpUserId: 'u1', ip: '1' },
      r
    )
    expect(r.statusCode).toBe(400)
    expect(RestoreManager.promises.revertFile).not.toHaveBeenCalled()
  })

  it('returns 404 when the version cannot be loaded from history', async () => {
    const { RequestFailedError } = await import('@overleaf/fetch-utils')
    HistoryManager.promises.getContentAtVersion.mockRejectedValue(
      new RequestFailedError(404)
    )
    const r = res()
    await McpHistoryController.restoreFile(
      { params: { projectId: 'p1' }, body, mcpUserId: 'u1', ip: '1' },
      r
    )
    expect(r.statusCode).toBe(404)
    expect(RestoreManager.promises.revertFile).not.toHaveBeenCalled()
  })

  it('returns 404 when the path is not in that version, before deleting anything', async () => {
    const r = res()
    await McpHistoryController.restoreFile(
      { params: { projectId: 'p1' }, body: { path: '/gone.tex', version: 12 }, mcpUserId: 'u1', ip: '1' },
      r
    )
    expect(r.statusCode).toBe(404)
    expect(RestoreManager.promises.revertFile).not.toHaveBeenCalled()
  })

  it('checks that a binary file blob can be fetched before deleting the current file', async () => {
    const r = res()
    await McpHistoryController.restoreFile(
      { params: { projectId: 'p1' }, body: { path: '/fig/plot.png', version: 12 }, mcpUserId: 'u1', ip: '1' },
      r
    )
    expect(HistoryManager.promises.requestBlob).toHaveBeenCalledWith('hist1', 'h2')
    expect(RestoreManager.promises.revertFile).toHaveBeenCalled()
  })

  it('returns 404 when the blob is not available in the history store', async () => {
    HistoryManager.promises.requestBlob.mockRejectedValue(
      new RequestFailedError(404)
    )
    const r = res()
    await McpHistoryController.restoreFile(
      {
        params: { projectId: 'p1' },
        body: { path: '/fig/plot.png', version: 12 },
        mcpUserId: 'u1',
        ip: '1',
      },
      r
    )
    expect(r.statusCode).toBe(404)
    expect(r.body.code).toBe('not_found')
    expect(r.body.message).toBe(
      'content for /fig/plot.png at version 12 is not available in the history store'
    )
    expect(RestoreManager.promises.revertFile).not.toHaveBeenCalled()
  })

  it('re-throws when requestBlob fails with a non-404 error', async () => {
    const error = new Error('storage connection error')
    HistoryManager.promises.requestBlob.mockRejectedValue(error)
    const r = res()
    let err
    try {
      await McpHistoryController.restoreFile(
        {
          params: { projectId: 'p1' },
          body: { path: '/fig/plot.png', version: 12 },
          mcpUserId: 'u1',
          ip: '1',
        },
        r
      )
    } catch (e) {
      err = e
    }
    expect(err).toBe(error)
    expect(RestoreManager.promises.revertFile).not.toHaveBeenCalled()
  })

  it('does not fetch a blob for a text document', async () => {
    await McpHistoryController.restoreFile(
      { params: { projectId: 'p1' }, body, mcpUserId: 'u1', ip: '1' },
      res()
    )
    expect(HistoryManager.promises.requestBlob).not.toHaveBeenCalled()
    expect(RestoreManager.promises.revertFile).toHaveBeenCalled()
  })
})

describe('summariseDiff', () => {
  it('anchors inserts and deletes to lines of the newer version', () => {
    const result = summariseDiff([
      { u: 'a\nb\n' },
      { d: 'old\n' },
      { i: 'new\n' },
      { u: 'c\n' },
      { i: 'tail' },
    ])
    expect(result.changes).toEqual([
      { type: 'delete', line: 3, text: 'old\n', author: null },
      { type: 'insert', line: 3, text: 'new\n', author: null },
      { type: 'insert', line: 5, text: 'tail', author: null },
    ])
    expect(result.insertedChars).toBe(8)
    expect(result.deletedChars).toBe(4)
  })

  it('returns every change and the full text of a large insert', () => {
    const big = 'x'.repeat(5000)
    const chunks = Array.from({ length: 250 }, (_, i) => ({ i: `l${i}\n` }))
    chunks.push({ i: big })
    const result = summariseDiff(chunks)
    expect(result.changes).toHaveLength(251)
    expect(result.changes.at(-1).text).toBe(big)
  })
})

describe('McpHistoryController.getDiff', () => {
  it('requires both versions in order', async () => {
    const r = res()
    await McpHistoryController.getDiff(
      {
        params: { projectId: 'p1' },
        query: { path: '/main.tex', fromVersion: '5', toVersion: '2' },
      },
      r
    )
    expect(r.statusCode).toBe(400)
  })

  it('reports a binary file without changes', async () => {
    fetchJson.mockResolvedValue({ diff: { binary: true } })
    const r = res()
    await McpHistoryController.getDiff(
      {
        params: { projectId: 'p1' },
        query: { path: '/fig.png', fromVersion: '1', toVersion: '2' },
      },
      r
    )
    expect(r.body.binary).toBe(true)
    expect(r.body.changes).toEqual([])
  })
})

describe('McpHistoryController.restoreFile', () => {
  it('reverts the file without its leading slash and audits it', async () => {
    RestoreManager.promises.revertFile.mockResolvedValue({
      _id: 'd9',
      type: 'doc',
    })
    const r = res()
    await McpHistoryController.restoreFile(
      {
        params: { projectId: 'p1' },
        body: { path: '/chapters/intro.tex', version: 12 },
        mcpUserId: 'u1',
        ip: '1.2.3.4',
      },
      r
    )
    expect(RestoreManager.promises.revertFile).toHaveBeenCalledWith(
      'u1',
      'p1',
      12,
      'chapters/intro.tex',
      {}
    )
    expect(
      ProjectAuditLogHandler.addEntryIfManagedInBackground
    ).toHaveBeenCalled()
    expect(r.body).toEqual({
      path: '/chapters/intro.tex',
      version: 12,
      type: 'doc',
      id: 'd9',
    })
  })

  it('rejects a missing version', async () => {
    const r = res()
    await McpHistoryController.restoreFile(
      { params: { projectId: 'p1' }, body: { path: '/main.tex' } },
      r
    )
    expect(r.statusCode).toBe(400)
    expect(RestoreManager.promises.revertFile).not.toHaveBeenCalled()
  })

  it.each([
    [{ path: '' }, 'empty path'],
    [{ path: '   ' }, 'blank path'],
    [{ path: ['/main.tex'] }, 'non-string path'],
    [{ path: { $ne: null } }, 'object path'],
    [{ path: undefined }, 'missing path'],
    [{ path: '../secrets.tex' }, 'parent segment'],
    [{ path: '/chapters/../../x.tex' }, 'nested parent segment'],
    [{ path: '/chapters/./intro.tex' }, 'dot segment'],
    [{ path: '/' }, 'root only'],
  ])('rejects a %s as a validation error', async (body, _label) => {
    const r = res()
    await McpHistoryController.restoreFile(
      { params: { projectId: 'p1' }, body: { ...body, version: 3 } },
      r
    )
    expect(r.statusCode).toBe(400)
    expect(r.body.code).toBe('validation_error')
    expect(RestoreManager.promises.revertFile).not.toHaveBeenCalled()
  })

  it('rejects a non-integer or negative version', async () => {
    for (const version of [-1, 1.5, '3', null]) {
      const r = res()
      await McpHistoryController.restoreFile(
        { params: { projectId: 'p1' }, body: { path: '/main.tex', version } },
        r
      )
      expect(r.statusCode, String(version)).toBe(400)
    }
    expect(RestoreManager.promises.revertFile).not.toHaveBeenCalled()
  })
})
