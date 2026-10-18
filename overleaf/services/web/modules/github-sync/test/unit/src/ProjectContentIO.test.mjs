import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { Readable } from 'node:stream'

describe('resolveSafeWritePath', function () {
  it('refuses a write that would go through a symlink in the working tree', async function () {
    const { resolveSafeWritePath } = await import('../../../app/src/ProjectContentIO.mjs')
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'ghsync-repo-'))
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ghsync-outside-'))
    try {
      await fs.symlink(outside, path.join(repo, 'docs'))
      await fs.symlink(path.join(outside, 'target.tex'), path.join(repo, 'main.tex'))
      expect(await resolveSafeWritePath(repo, 'docs/chapter.tex')).toBeNull()
      expect(await resolveSafeWritePath(repo, 'main.tex')).toBeNull()
      expect(await resolveSafeWritePath(repo, 'new/dir/file.tex')).toBe(
        path.join(repo, 'new/dir/file.tex')
      )
      expect(await resolveSafeWritePath(repo, '../escape.tex')).toBeNull()
    } finally {
      await fs.rm(repo, { recursive: true, force: true })
      await fs.rm(outside, { recursive: true, force: true })
    }
  })
})

describe('ProjectContentIO', function () {
  let ProjectContentIO
  let workDir
  let mockEntities
  let mockDocs
  let mockBlobStreams

  beforeEach(async function () {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ghsync-io-test-'))

    mockEntities = {
      docs: [{ path: 'main.tex', doc: { _id: 'doc1' } }],
      files: [{ path: 'img/logo.png', file: { _id: 'f1', hash: 'h1' } }],
      folders: [],
    }

    mockDocs = [{ _id: 'doc1', lines: ['hello', 'world'] }]

    mockBlobStreams = {
      h1: () => ({
        stream: Readable.from([Buffer.from('PNGDATA')]),
        contentLength: 7,
      }),
    }

    vi.resetModules()

    const projectEntityHandlerMock = {
      default: {
        promises: {
          getAllEntities: async () => mockEntities,
        },
      },
      __esModule: true,
    }

    const docstoreManagerMock = {
      default: {
        promises: {
          getAllDocs: async () => mockDocs,
        },
      },
      __esModule: true,
    }

    const historyManagerMock = {
      default: {
        promises: {
          requestBlobWithProjectId: async (projectId, hash) => {
            const fn = mockBlobStreams[hash]
            if (fn) return fn()
            return {
              stream: Readable.from([Buffer.from('')]),
              contentLength: 0,
            }
          },
        },
      },
      __esModule: true,
    }

    vi.doMock(
      '../../../../../app/src/Features/Project/ProjectEntityHandler.mjs',
      () => projectEntityHandlerMock
    )

    vi.doMock(
      '../../../../../app/src/Features/Docstore/DocstoreManager.mjs',
      () => docstoreManagerMock
    )

    vi.doMock(
      '../../../../../app/src/Features/History/HistoryManager.mjs',
      () => historyManagerMock
    )

    ;({ default: ProjectContentIO } = await import(
      '../../../app/src/ProjectContentIO.mjs'
    ))
  })

  afterEach(async function () {
    if (workDir) {
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('materializes docs and files to disk and returns a manifest', async function () {
    const manifest = await ProjectContentIO.promises.materializeProject(
      'proj1',
      workDir
    )
    expect(manifest.sort()).to.deep.equal(['img/logo.png', 'main.tex'])
    expect(await fs.readFile(path.join(workDir, 'main.tex'), 'utf8')).to.equal(
      'hello\nworld\n'
    )
    expect(await fs.readFile(path.join(workDir, 'img/logo.png'))).to.deep.equal(
      Buffer.from('PNGDATA')
    )
  })

  it('reads the project tree back with sizes', async function () {
    await ProjectContentIO.promises.materializeProject('proj1', workDir)
    const tree = await ProjectContentIO.promises.readProjectTree(workDir)
    const tex = tree.find(e => e.relPath === 'main.tex')
    expect(tex).to.exist
    expect(tex.sizeBytes).to.be.greaterThan(0)
    expect(tex.symlinkTarget).to.equal(null)

    const img = tree.find(e => e.relPath === 'img/logo.png')
    expect(img).to.exist
    expect(img.sizeBytes).to.equal(7)
    expect(img.symlinkTarget).to.equal(null)

    expect(tree.some(e => e.relPath.startsWith('.git'))).to.equal(false)
  })

  it('handles symlinks in readProjectTree', async function () {
    const targetFile = path.join(workDir, 'target.txt')
    const linkFile = path.join(workDir, 'link.txt')
    await fs.writeFile(targetFile, 'content')
    await fs.symlink('target.txt', linkFile)

    const tree = await ProjectContentIO.promises.readProjectTree(workDir)
    const link = tree.find(e => e.relPath === 'link.txt')
    expect(link).to.exist
    expect(link.symlinkTarget).to.equal('target.txt')
    expect(link.sizeBytes).to.equal(0)
  })

  it('skips .git directory and internal git files in readProjectTree', async function () {
    const gitDir = path.join(workDir, '.git')
    await fs.mkdir(gitDir, { recursive: true })
    await fs.writeFile(path.join(gitDir, 'config'), 'gitconfig')
    await fs.mkdir(path.join(gitDir, 'objects'), { recursive: true })
    await fs.writeFile(path.join(gitDir, 'objects', 'abc'), 'blob')

    await fs.writeFile(path.join(workDir, 'file.txt'), 'data')

    const tree = await ProjectContentIO.promises.readProjectTree(workDir)
    expect(tree).to.have.lengthOf(1)
    expect(tree[0].relPath).to.equal('file.txt')
  })

  it('removes stale on-disk files no longer in Overleaf', async function () {
    // Pre-create an obsolete file
    await fs.writeFile(path.join(workDir, 'old-file.tex'), 'obsolete')
    const oldSubDir = path.join(workDir, 'old-dir')
    await fs.mkdir(oldSubDir, { recursive: true })
    await fs.writeFile(path.join(oldSubDir, 'nested.tex'), 'obsolete nested')

    // Also create a .git file to ensure it is not deleted
    const gitDir = path.join(workDir, '.git')
    await fs.mkdir(gitDir, { recursive: true })
    await fs.writeFile(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main')

    const manifest = await ProjectContentIO.promises.materializeProject(
      'proj1',
      workDir
    )
    expect(manifest.sort()).to.deep.equal(['img/logo.png', 'main.tex'])

    // Old files should be removed
    expect(await fs.stat(path.join(workDir, 'old-file.tex')).catch(() => null)).to.be.null
    expect(await fs.stat(path.join(oldSubDir, 'nested.tex')).catch(() => null)).to.be.null

    // .git file should remain
    expect(await fs.readFile(path.join(gitDir, 'HEAD'), 'utf8')).to.equal(
      'ref: refs/heads/main'
    )
  })

  it('keeps repo files that sync deliberately excludes', async function () {
    // None of these ever enter Overleaf, so they are absent from the manifest.
    // Deleting them would let `git add -A` commit the removal and the next push
    // would drop them from the user's GitHub repo.
    const wfDir = path.join(workDir, '.github', 'workflows')
    await fs.mkdir(wfDir, { recursive: true })
    await fs.writeFile(path.join(wfDir, 'ci.yml'), 'on: push')
    await fs.writeFile(path.join(workDir, '.gitignore'), '*.aux\n')
    await fs.writeFile(path.join(workDir, 'target.txt'), 'content')
    await fs.symlink('target.txt', path.join(workDir, 'link.txt'))
    await fs.writeFile(path.join(workDir, 'stale.tex'), 'obsolete')

    await ProjectContentIO.promises.materializeProject('proj1', workDir)

    expect(await fs.readFile(path.join(wfDir, 'ci.yml'), 'utf8')).to.equal('on: push')
    expect(await fs.readFile(path.join(workDir, '.gitignore'), 'utf8')).to.equal('*.aux\n')
    expect(await fs.lstat(path.join(workDir, 'link.txt')).catch(() => null)).to.not.be.null

    // a plain stale file is still pruned
    expect(await fs.stat(path.join(workDir, 'stale.tex')).catch(() => null)).to.be.null
  })

  it('keeps oversized repo files that exceed the sync limit', async function () {
    const bigPath = path.join(workDir, 'huge.bin')
    await fs.writeFile(bigPath, Buffer.alloc(1024))
    await fs.truncate(bigPath, 51 * 1024 * 1024)

    await ProjectContentIO.promises.materializeProject('proj1', workDir)

    expect(await fs.stat(bigPath).catch(() => null)).to.not.be.null
  })

  it('refuses a project over the entry cap before writing anything', async function () {
    mockEntities = {
      docs: [],
      files: Array.from({ length: 5001 }, (_, i) => ({
        path: `f${i}.png`,
        file: { _id: `id${i}`, hash: 'h1' },
      })),
      folders: [],
    }
    const err = await ProjectContentIO.promises
      .materializeProject('proj1', workDir)
      .catch(e => e)
    expect(err.code).to.equal('project_too_large')
    expect(err.status).to.equal(413)
    expect(await fs.readdir(workDir)).to.deep.equal([])
  })

  it('refuses a repo tree over the byte cap', async function () {
    // A sparse file: the size counts against the cap without using disk
    const bigPath = path.join(workDir, 'huge.bin')
    await fs.writeFile(bigPath, '')
    await fs.truncate(bigPath, 501 * 1024 * 1024)
    const err = await ProjectContentIO.promises
      .readProjectTree(workDir)
      .catch(e => e)
    expect(err.code).to.equal('project_too_large')
    expect(err.status).to.equal(413)
  })

  it('refuses a repo tree over the entry cap', async function () {
    for (let i = 0; i < 5001; i++) {
      await fs.writeFile(path.join(workDir, `f${i}.txt`), '')
    }
    const err = await ProjectContentIO.promises
      .readProjectTree(workDir)
      .catch(e => e)
    expect(err.code).to.equal('project_too_large')
  })

  it('handles empty doc lines or missing docs gracefully', async function () {
    mockEntities = {
      docs: [
        { path: 'empty.tex', doc: { _id: 'doc-empty' } },
        { path: 'missing.tex', doc: { _id: 'doc-missing' } },
      ],
      files: [],
      folders: [],
    }
    mockDocs = [{ _id: 'doc-empty', lines: [] }]

    const manifest = await ProjectContentIO.promises.materializeProject(
      'proj1',
      workDir
    )
    expect(manifest.sort()).to.deep.equal(['empty.tex', 'missing.tex'])
    expect(await fs.readFile(path.join(workDir, 'empty.tex'), 'utf8')).to.equal('\n')
    expect(await fs.readFile(path.join(workDir, 'missing.tex'), 'utf8')).to.equal('\n')
  })
})
