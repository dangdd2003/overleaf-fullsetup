import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const calls = { upsertDoc: [], upsertFile: [], delete: [] }

const editorControllerMock = () => ({
  default: {
    promises: {
      upsertDocWithPath: async (...args) => {
        calls.upsertDoc.push(args)
      },
      upsertFileWithPath: async (...args) => {
        calls.upsertFile.push(args)
      },
      deleteEntityWithPath: async (...args) => {
        calls.delete.push(args)
      },
    },
  },
})

const syncEngineMock = () => ({
  default: {
    promises: {
      writeFileFromRepo: async (repoDir, relPath) => ({
        tmpPath: `/tmp/fake/${relPath}`,
        tmpDir: '/tmp/fake',
      }),
    },
  },
})

const projectContentIOMock = () => ({
  default: {
    promises: {
      readProjectTree: async () => [
        { relPath: 'new.tex', sizeBytes: 10, symlinkTarget: null },
        { relPath: 'img.png', sizeBytes: 10, symlinkTarget: null },
        { relPath: 'big.bin', sizeBytes: 60 * 1024 * 1024, symlinkTarget: null },
      ],
    },
  },
})

vi.doMock('../../../../../app/src/Features/Editor/EditorController.mjs', editorControllerMock)
vi.doMock('../../../app/src/SyncEngine.mjs', syncEngineMock)
vi.doMock('../../../app/src/ProjectContentIO.mjs', projectContentIOMock)

describe('SyncFileOps', function () {
  let SyncFileOps
  let repoDir

  beforeEach(async function () {
    calls.upsertDoc.length = 0
    calls.upsertFile.length = 0
    calls.delete.length = 0
    repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ghsync-ops-'))
    await fs.writeFile(path.join(repoDir, 'new.tex'), 'line one\nline two\n')
    vi.resetModules()
    vi.doMock('../../../../../app/src/Features/Editor/EditorController.mjs', editorControllerMock)
    vi.doMock('../../../app/src/SyncEngine.mjs', syncEngineMock)
    vi.doMock('../../../app/src/ProjectContentIO.mjs', projectContentIOMock)
    SyncFileOps = (await import('../../../app/src/SyncFileOps.mjs')).default
  })

  it('applies adds as doc or file upserts with source github', async function () {
    const changes = [
      { type: 'A', path: 'new.tex' },
      { type: 'A', path: 'img.png' },
    ]
    const warnings = await SyncFileOps.promises.applyChangeSet('proj1', 'user1', repoDir, changes)
    expect(warnings).to.deep.equal([])
    expect(calls.upsertDoc).to.have.length(1)
    const [, elPath, lines, source] = calls.upsertDoc[0]
    expect(elPath).to.equal('new.tex')
    expect(lines).to.deep.equal(['line one', 'line two'])
    expect(source).to.equal('github')
    expect(calls.upsertFile).to.have.length(1)
    expect(calls.upsertFile[0][3]).to.equal(null) // linkedFileData
  })

  it('deletes deepest paths first', async function () {
    const changes = [
      { type: 'D', path: 'a.tex' },
      { type: 'D', path: 'sub/dir/deep/b.tex' },
      { type: 'D', path: 'sub/c.tex' },
    ]
    await SyncFileOps.promises.applyChangeSet('proj1', 'user1', repoDir, changes)
    expect(calls.delete.map(c => c[1])).to.deep.equal([
      'sub/dir/deep/b.tex',
      'sub/c.tex',
      'a.tex',
    ])
  })

  it('treats renames as delete old path + add new path', async function () {
    await fs.rename(path.join(repoDir, 'new.tex'), path.join(repoDir, 'renamed.tex'))
    const changes = [{ type: 'R', oldPath: 'new.tex', path: 'renamed.tex' }]
    await SyncFileOps.promises.applyChangeSet('proj1', 'user1', repoDir, changes)
    expect(calls.delete.map(c => c[1])).to.deep.equal(['new.tex'])
    expect(calls.upsertDoc.map(c => c[1])).to.deep.equal(['renamed.tex'])
  })

  it('collects warnings for excluded entries during import', async function () {
    const warnings = await SyncFileOps.promises.applyImportTree('proj1', 'user1', repoDir)
    expect(warnings.map(w => w.code)).to.deep.equal(['github_large_files_error'])
  })
})
