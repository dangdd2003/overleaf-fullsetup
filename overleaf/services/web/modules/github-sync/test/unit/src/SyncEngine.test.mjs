import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

describe('SyncEngine', function () {
  let SyncEngine
  let workDir
  let upstreamDir
  let upstreamUrl

  beforeAll(async function () {
    vi.resetModules()
    vi.doMock('@overleaf/logger', () => ({
      default: {
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      },
      __esModule: true,
    }))
    ;({ default: SyncEngine } = await import('../../../app/src/SyncEngine.mjs'))
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ghsync-test-'))
    upstreamDir = path.join(workDir, 'upstream.git')
    await execFileP('git', ['init', '--bare', '-b', 'main', upstreamDir])
    upstreamUrl = upstreamDir
  })

  afterAll(async function () {
    await fs.rm(workDir, { recursive: true, force: true })
  })

  async function commitUpstream(relPath, content) {
    const seed = path.join(workDir, 'seed')
    if (!(await fs.stat(seed).catch(() => null))) {
      await execFileP('git', ['clone', upstreamDir, seed])
      await execFileP('git', ['config', 'user.email', 'seed@example.com'], { cwd: seed })
      await execFileP('git', ['config', 'user.name', 'Seed'], { cwd: seed })
      await execFileP('git', ['config', 'commit.gpgsign', 'false'], { cwd: seed })
    }
    await fs.mkdir(path.dirname(path.join(seed, relPath)), { recursive: true })
    await fs.writeFile(path.join(seed, relPath), content)
    await execFileP('git', ['add', '-A'], { cwd: seed })
    await execFileP('git', ['commit', '--allow-empty', '-m', `update ${relPath}`], { cwd: seed })
    await execFileP('git', ['push', 'origin', 'main'], { cwd: seed })
  }

  it('cloneRepo clones with a clean remote URL', async function () {
    await commitUpstream('main.tex', 'hello v1\n')
    const repoDir = path.join(workDir, 'clone-1')
    await SyncEngine.promises.cloneRepo(repoDir, upstreamUrl, 'main', 'unused')
    const content = await fs.readFile(path.join(repoDir, 'main.tex'), 'utf8')
    expect(content).to.equal('hello v1\n')
    const { stdout } = await execFileP('git', ['remote', 'get-url', 'origin'], { cwd: repoDir })
    expect(stdout.trim()).to.equal(upstreamUrl) // no token in URL
  })

  it('commitAll returns null when clean, sha when staged', async function () {
    const repoDir = path.join(workDir, 'clone-1')
    expect(
      await SyncEngine.promises.commitAll(repoDir, 'noop', 'a', 'a@e.c')
    ).to.equal(null)
    await fs.writeFile(path.join(repoDir, 'new.tex'), 'new\n')
    const sha = await SyncEngine.promises.commitAll(repoDir, 'add new', 'Octo Cat', 'octo@example.com')
    expect(sha).to.match(/^[0-9a-f]{40}$/)
  })

  it('mergeOrigin reports conflict with abort on divergence', async function () {
    const repoDir = path.join(workDir, 'clone-1')
    await fs.writeFile(path.join(repoDir, 'main.tex'), 'local edit\n')
    await SyncEngine.promises.commitAll(repoDir, 'local', 'a', 'a@e.c')
    await commitUpstream('main.tex', 'upstream edit\n')
    await SyncEngine.promises.fetchOrigin(repoDir, 'unused')
    const result = await SyncEngine.promises.mergeOrigin(repoDir, 'main')
    expect(result.conflict).to.equal(true)
    expect(result.merged).to.equal(false)
    const content = await fs.readFile(path.join(repoDir, 'main.tex'), 'utf8')
    expect(content).to.equal('local edit\n') // aborted, local intact
  })

  it('diffChangeSet reports added, modified, deleted, and renamed paths between shas', async function () {
    const repoDir = path.join(workDir, 'clone-diff')
    await SyncEngine.promises.cloneRepo(repoDir, upstreamUrl, 'main', 'unused')

    // Make changes upstream: add, modify, delete, rename
    const seed = path.join(workDir, 'seed')
    await fs.writeFile(path.join(seed, 'file-to-modify.tex'), 'v1\n')
    await fs.writeFile(path.join(seed, 'file-to-delete.tex'), 'delete me\n')
    await fs.writeFile(path.join(seed, 'file-to-rename.tex'), 'rename me\n')
    await execFileP('git', ['add', '-A'], { cwd: seed })
    await execFileP('git', ['commit', '-m', 'prep diff files'], { cwd: seed })
    await execFileP('git', ['push', 'origin', 'main'], { cwd: seed })

    await SyncEngine.promises.fetchOrigin(repoDir, 'unused')

    await fs.writeFile(path.join(seed, 'file-to-modify.tex'), 'v2\n')
    await fs.unlink(path.join(seed, 'file-to-delete.tex'))
    await execFileP('git', ['mv', 'file-to-rename.tex', 'file-renamed.tex'], { cwd: seed })
    await fs.writeFile(path.join(seed, 'new-added.tex'), 'brand new\n')
    await execFileP('git', ['add', '-A'], { cwd: seed })
    await execFileP('git', ['commit', '-m', 'make diff changes'], { cwd: seed })
    await execFileP('git', ['push', 'origin', 'main'], { cwd: seed })

    await SyncEngine.promises.fetchOrigin(repoDir, 'unused')

    const { stdout: targetPrepSha } = await execFileP('git', ['rev-parse', 'origin/main~1'], { cwd: repoDir })
    const changes = await SyncEngine.promises.diffChangeSet(repoDir, targetPrepSha.trim(), 'origin/main')

    expect(changes.find(c => c.path === 'new-added.tex')).to.deep.equal({ type: 'A', path: 'new-added.tex' })
    expect(changes.find(c => c.path === 'file-to-modify.tex')).to.deep.equal({ type: 'M', path: 'file-to-modify.tex' })
    expect(changes.find(c => c.path === 'file-to-delete.tex')).to.deep.equal({ type: 'D', path: 'file-to-delete.tex' })
    expect(changes.find(c => c.path === 'file-renamed.tex')).to.deep.equal({
      type: 'R',
      oldPath: 'file-to-rename.tex',
      path: 'file-renamed.tex',
    })
  })

  it('diffChangeSet returns unescaped non-ASCII paths', async function () {
    const repoDir = path.join(workDir, 'clone-unicode')
    await SyncEngine.promises.cloneRepo(repoDir, upstreamUrl, 'main', 'unused')
    const { stdout: baseSha } = await execFileP('git', ['rev-parse', 'origin/main'], { cwd: repoDir })

    // git's default core.quotePath=true would report this as "caf\303\251.tex"
    await commitUpstream('caf\u00e9.tex', 'unicode\n')
    await SyncEngine.promises.fetchOrigin(repoDir, 'unused')

    const changes = await SyncEngine.promises.diffChangeSet(
      repoDir,
      baseSha.trim(),
      'origin/main'
    )
    expect(changes.find(c => c.path === 'caf\u00e9.tex')).to.deep.equal({
      type: 'A',
      path: 'caf\u00e9.tex',
    })
  })

  it('runGit rejects with stderr on failure', async function () {
    try {
      await SyncEngine.promises.runGit(upstreamDir, ['rev-parse', 'no-such-ref'])
      expect.fail('should have thrown')
    } catch (err) {
      expect(err.message).to.contain('no-such-ref')
    }
  })

  it('repoDirFor returns path joined with project id', function () {
    expect(SyncEngine.promises.repoDirFor('/var/repos', 'proj123')).to.equal(
      path.join('/var/repos', 'proj123')
    )
  })

  it('writeAskpassScript creates executable script', async function () {
    const scriptPath = await SyncEngine.promises.writeAskpassScript(workDir)
    const content = await fs.readFile(scriptPath, 'utf8')
    expect(content).to.equal('#!/bin/sh\nprintf "%s" "$GH_SYNC_TOKEN"\n')
    const stat = await fs.stat(scriptPath)
    expect(stat.mode & 0o777).to.equal(0o700)
  })

  it('createRepo initializes a repo with default branch and remote origin', async function () {
    const repoDir = path.join(workDir, 'new-repo')
    await SyncEngine.promises.createRepo(repoDir, upstreamUrl, 'main')
    expect(await SyncEngine.promises.ensureRepoExists(repoDir)).to.equal(true)
    const { stdout } = await execFileP('git', ['remote', 'get-url', 'origin'], { cwd: repoDir })
    expect(stdout.trim()).to.equal(upstreamUrl)
  })

  it('pushRef pushes local ref to remote ref', async function () {
    const repoDir = path.join(workDir, 'clone-push')
    await SyncEngine.promises.cloneRepo(repoDir, upstreamUrl, 'main', 'unused')
    await fs.writeFile(path.join(repoDir, 'pushed.tex'), 'pushed\n')
    await SyncEngine.promises.commitAll(repoDir, 'push commit', 'Pusher', 'pusher@example.com')
    await SyncEngine.promises.pushRef(repoDir, 'main', 'main', 'unused')

    const seed = path.join(workDir, 'seed')
    await execFileP('git', ['pull', 'origin', 'main'], { cwd: seed })
    const content = await fs.readFile(path.join(seed, 'pushed.tex'), 'utf8')
    expect(content).to.equal('pushed\n')
  })

  it('pushRescueBranch creates and pushes rescue branch with timestamp', async function () {
    const repoDir = path.join(workDir, 'clone-rescue')
    await SyncEngine.promises.cloneRepo(repoDir, upstreamUrl, 'main', 'unused')
    await fs.writeFile(path.join(repoDir, 'rescue.tex'), 'rescue\n')
    await SyncEngine.promises.commitAll(repoDir, 'rescue commit', 'Rescuer', 'rescuer@example.com')
    const branchName = await SyncEngine.promises.pushRescueBranch(repoDir, 'unused')
    expect(branchName).to.match(/^overleaf-sync-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/)

    const seed = path.join(workDir, 'seed')
    await execFileP('git', ['fetch', 'origin'], { cwd: seed })
    const { stdout } = await execFileP('git', ['branch', '-r'], { cwd: seed })
    expect(stdout).to.contain(`origin/${branchName}`)
  })

  it('writeFileFromRepo reads file and writes to temp directory', async function () {
    const repoDir = path.join(workDir, 'clone-1')
    await fs.mkdir(path.join(repoDir, 'sub'), { recursive: true })
    await fs.writeFile(path.join(repoDir, 'sub', 'doc.tex'), 'doc content\n')
    const { tmpPath, tmpDir } = await SyncEngine.promises.writeFileFromRepo(repoDir, 'sub/doc.tex')
    const content = await fs.readFile(tmpPath, 'utf8')
    expect(content).to.equal('doc content\n')
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('deleteRepoDir removes repo directory and ensureRepoExists returns false', async function () {
    const tempRepo = path.join(workDir, 'to-delete')
    await fs.mkdir(tempRepo, { recursive: true })
    await execFileP('git', ['init', tempRepo])
    expect(await SyncEngine.promises.ensureRepoExists(tempRepo)).to.equal(true)
    await SyncEngine.promises.deleteRepoDir(tempRepo)
    expect(await SyncEngine.promises.ensureRepoExists(tempRepo)).to.equal(false)
  })

  it('fetchOrigin and token-bearing operations do not write askpass script into working tree', async function () {
    const repoDir = path.join(workDir, 'clone-clean-tree')
    await SyncEngine.promises.cloneRepo(repoDir, upstreamUrl, 'main', 'gho_secret_token')
    await commitUpstream('clean-check.tex', 'clean check\n')
    await SyncEngine.promises.fetchOrigin(repoDir, 'gho_secret_token')

    const files = await fs.readdir(repoDir)
    expect(files.some(f => f.includes('gh-askpass'))).to.equal(false)

    const { stdout: status } = await execFileP('git', ['status', '--porcelain'], { cwd: repoDir })
    expect(status.trim()).to.equal('')
  })
})
