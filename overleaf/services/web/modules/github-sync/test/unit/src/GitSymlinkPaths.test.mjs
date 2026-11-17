import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

describe('Git symlink index modes', function () {
  let repoDir
  let execFile
  let SyncEngine

  beforeEach(async function () {
    repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ghsync-index-'))
    vi.resetModules()
    execFile = vi.fn()
    vi.doMock('node:child_process', () => ({ execFile }))
    vi.doMock('@overleaf/logger', () => ({ default: { warn: vi.fn() } }))
    ;({ default: SyncEngine } = await import('../../../app/src/SyncEngine.mjs'))
  })

  afterEach(async function () {
    vi.doUnmock('node:child_process')
    vi.doUnmock('@overleaf/logger')
    await fs.rm(repoDir, { recursive: true, force: true })
  })

  it('reads mode 120000 using NUL-delimited paths without interpreting link contents', async function () {
    await fs.mkdir(path.join(repoDir, '.git'))
    const names = ['link.tex', 'nested/café\tchapter\n.tex']
    const oid = 'a'.repeat(40)
    execFile.mockImplementation((_command, _args, _options, callback) => {
      callback(null, [
        `100644 ${oid} 0\tmain.tex`,
        ...names.map(name => `120000 ${oid} 0\t${name}`),
        `160000 ${oid} 0\tsubmodule`,
        '',
      ].join('\0'), '')
    })

    expect(await SyncEngine.promises.getSymlinkPaths(repoDir)).to.deep.equal(new Set(names))
    expect(execFile.mock.calls[0][1]).to.deep.equal(['ls-files', '--stage', '-z'])
  })

  it('supports a worktree Git metadata file', async function () {
    await fs.writeFile(path.join(repoDir, '.git'), 'gitdir: /unused/test-metadata')
    execFile.mockImplementation((_command, _args, _options, callback) => {
      callback(null, `120000 ${'b'.repeat(40)} 0\tlink.tex\0`, '')
    })
    expect(await SyncEngine.promises.getSymlinkPaths(repoDir)).to.deep.equal(new Set(['link.tex']))
  })

  it('returns no Git symlinks for a directory without Git metadata', async function () {
    expect(await SyncEngine.promises.getSymlinkPaths(repoDir)).to.deep.equal(new Set())
    expect(execFile).not.toHaveBeenCalled()
  })
})
