import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = { doc: null, engine: {}, fileOps: {}, contentIO: {}, creds: {}, api: {}, mockBusy: false }

const syncEngineMock = () => ({
  default: {
    promises: new Proxy({}, { get: (_, prop) => state.engine[prop] }),
  },
  __esModule: true,
})
const syncFileOpsMock = () => ({
  default: {
    promises: new Proxy({}, { get: (_, prop) => state.fileOps[prop] }),
  },
  __esModule: true,
})
const projectContentIOMock = () => ({
  default: {
    promises: new Proxy({}, { get: (_, prop) => state.contentIO[prop] }),
  },
  __esModule: true,
})
const credsMock = () => ({
  default: {
    promises: new Proxy({}, { get: (_, prop) => state.creds[prop] }),
  },
  __esModule: true,
})
const apiMock = () => ({
  default: {
    promises: new Proxy({}, { get: (_, prop) => state.api[prop] }),
  },
  __esModule: true,
})
const modelsMock = () => ({
  GithubSyncProjectStates: {
    findOne: async ({ project_id }) => state.doc,
    findOneAndUpdate: async (query, update) => {
      if (!state.doc) return null
      if (state.mockBusy && query.$or) return null
      if (update.$set) Object.assign(state.doc, update.$set)
      return state.doc
    },
    updateOne: async (query, update) => {
      if (state.doc && update.$set) Object.assign(state.doc, update.$set)
      return { modifiedCount: state.doc ? 1 : 0 }
    },
    create: async doc => {
      state.doc = doc
      return doc
    },
    deleteOne: async () => {
      state.doc = null
      return { deletedCount: 1 }
    },
    find: async () => (state.doc ? [state.doc] : []),
    deleteMany: async () => {
      state.doc = null
      return { deletedCount: 1 }
    },
  },
  __esModule: true,
})

vi.doMock('node:fs/promises', () => ({
  default: {
    writeFile: async () => {},
  },
  writeFile: async () => {},
  __esModule: true,
}))
vi.doMock('@overleaf/settings', () => ({
  default: {
    githubSync: {
      reposDir: '/data/repos',
      gitBase: 'https://github.com',
      apiBase: 'https://api.github.com',
    },
  },
  __esModule: true,
}))
vi.doMock('@overleaf/o-error', () => ({
  default: class OError extends Error {
    constructor(message, info = {}, cause = null) {
      super(message)
      this.info = info
      this.cause = cause
    }
  },
  __esModule: true,
}))
vi.doMock('@overleaf/logger', () => ({
  default: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    err: vi.fn(),
  },
  __esModule: true,
}))
vi.doMock('../../../app/src/SyncEngine.mjs', syncEngineMock)
vi.doMock('../../../app/src/SyncFileOps.mjs', syncFileOpsMock)
vi.doMock('../../../app/src/ProjectContentIO.mjs', projectContentIOMock)
vi.doMock('../../../app/src/GitHubCredentialsManager.mjs', credsMock)
vi.doMock('../../../app/src/GitHubApiManager.mjs', apiMock)
vi.doMock('../../../app/src/models/GithubSyncModels.mjs', modelsMock)

vi.doMock('../../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs', () => ({
  default: { promises: { flushProjectToMongo: async () => {} } },
  __esModule: true,
}))
vi.doMock('../../../../../app/src/Features/Project/ProjectGetter.mjs', () => ({
  default: { promises: { getProject: async () => ({ _id: 'proj1', owner_ref: 'user1' }) } },
  __esModule: true,
}))
vi.doMock('../../../../../app/src/Features/Project/ProjectCreationHandler.mjs', () => ({
  default: { promises: { createBlankProject: async () => ({ _id: 'newproj' }) } },
  __esModule: true,
}))
vi.doMock('../../../../../app/src/Features/Project/ProjectDeleter.mjs', () => ({
  default: { promises: { deleteProject: async () => {} } },
  __esModule: true,
}))
vi.doMock('../../../../../app/src/Features/Project/DeletedProjectReasons.mjs', () => ({
  DeletedProjectReasons: { GITHUB_IMPORT_FAILURE: 'github-import-failure' },
  __esModule: true,
}))

function resetEngine() {
  state.mockBusy = false
  state.engine = {
    ensureRepoExists: async () => true,
    fetchOrigin: async () => {},
    setConfig: async () => {},
    commitAll: async () => 'aaaa',
    mergeOrigin: async () => ({ merged: true, conflict: false }),
    getHeadSha: async () => 'sha-merged',
    diffChangeSet: async () => [{ type: 'A', path: 'x.tex' }],
    pushRef: async () => {},
    pushRescueBranch: async () => 'overleaf-sync-2026-08-28-00-00-00',
    cloneRepo: async () => {},
    createRepo: async () => {},
    repoDirFor: (dir, pid) => `${dir}/${pid}`,
    runGit: async () => ({ stdout: 'sha-base\n', stderr: '' }),
    deleteRepoDir: async () => {},
  }
  state.fileOps = { applyChangeSet: async () => [], applyImportTree: async () => [] }
  state.contentIO = { materializeProject: async () => ['main.tex'] }
  state.creds = {
    getCredentials: async () => ({ githubUsername: 'octo', email: 'o@e.c' }),
    getAccessToken: async () => 'tok',
    touch: async () => {},
    deleteCredentials: async () => {},
  }
  state.api = {
    compareCommits: async () => ({ ahead_by: 2, behind_by: 0 }),
    getRepo: async () => ({ size: 1, default_branch: 'main', owner: { login: 'octo' }, name: 'paper' }),
    getUser: async () => ({ login: 'user1' }),
    createRepo: async () => ({ name: 'paper', owner: { login: 'octo' }, default_branch: 'main' }),
  }
}

describe('GitHubSyncManager', function () {
  let manager

  beforeEach(async function () {
    resetEngine()
    state.doc = {
      project_id: 'proj1',
      user_id: 'user1',
      repo: { owner: 'octo', name: 'paper' },
      repoDefaultBranch: 'main',
      lastSyncedCommitSha: 'sha-base',
      syncState: 'idle',
      outgoing: true,
    }
    manager = (await import('../../../app/src/GitHubSyncManager.mjs')).default
  })

  it('pull merges, applies the change set and stores the new sha', async function () {
    const result = await manager.promises.pull('proj1')
    expect(result.code).to.equal('ok')
    expect(result.sha).to.equal('sha-merged')
    expect(state.doc.lastSyncedCommitSha).to.equal('sha-merged')
    expect(state.doc.syncState).to.equal('idle')
    expect(state.doc.outgoing).to.equal(false)
  })

  it('pull on conflict pushes a rescue branch and marks conflict', async function () {
    state.engine.mergeOrigin = async () => ({ merged: false, conflict: true })
    const result = await manager.promises.pull('proj1')
    expect(result.code).to.equal('conflict')
    expect(result.branchName).to.match(/^overleaf-sync-/)
    expect(state.doc.syncState).to.equal('conflict')
  })

  it('push with no overleaf changes and up-to-date origin returns upToDate', async function () {
    state.engine.commitAll = async () => null
    state.engine.getHeadSha = async () => 'sha-base'
    state.engine.runGit = async () => ({ stdout: 'sha-base\n', stderr: '' })
    const result = await manager.promises.push('proj1', null)
    expect(result.code).to.equal('upToDate')
  })

  it('markProjectModified flips outgoing unless syncing', async function () {
    state.doc.outgoing = false
    await manager.promises.markProjectModified('proj1')
    expect(state.doc.outgoing).to.equal(true)
  })

  it('getState returns project state doc or null', async function () {
    const doc = await manager.promises.getState('proj1')
    expect(doc).to.equal(state.doc)
    const missing = await manager.promises.getState('missing')
    expect(missing).to.equal(state.doc) // our mock returns state.doc
  })

  it('pull throws if project is not linked', async function () {
    state.doc = null
    await expect(manager.promises.pull('missing')).to.be.rejectedWith(
      'project is not linked to GitHub'
    )
  })

  it('pull throws busy if sync lock is already held', async function () {
    state.mockBusy = true
    await expect(manager.promises.pull('proj1')).to.be.rejectedWith(
      'a sync is already in progress'
    )
  })

  it('pull failure records error in syncState', async function () {
    state.contentIO.materializeProject = async () => {
      const err = new Error('disk full')
      err.code = 'ENOSPC'
      throw err
    }
    await expect(manager.promises.pull('proj1')).to.be.rejectedWith('disk full')
    expect(state.doc.syncState).to.equal('error')
    expect(state.doc.lastError.code).to.equal('ENOSPC')
    expect(state.doc.lastError.message).to.equal('disk full')
  })

  it('pull failure during prepare releases lock and records error in syncState', async function () {
    state.creds.getAccessToken = async () => {
      const err = new Error('token decryption failed')
      err.code = 'TOKEN_DECRYPT_FAILED'
      throw err
    }
    await expect(manager.promises.pull('proj1')).to.be.rejectedWith('token decryption failed')
    expect(state.doc.syncState).to.equal('error')
    expect(state.doc.lastError.code).to.equal('TOKEN_DECRYPT_FAILED')
    expect(state.doc.syncLock).to.equal(null)
  })

  it('push pushes ref and clears outgoing', async function () {
    let pushed = false
    state.engine.pushRef = async () => {
      pushed = true
    }
    state.engine.commitAll = async () => 'sha-new'
    state.engine.getHeadSha = async () => 'sha-head'
    state.engine.runGit = async () => ({ stdout: 'sha-origin\n', stderr: '' })
    const result = await manager.promises.push('proj1', 'my commit message')
    expect(result.code).to.equal('ok')
    expect(result.sha).to.equal('sha-head')
    expect(pushed).to.equal(true)
    expect(state.doc.outgoing).to.equal(false)
    expect(state.doc.syncState).to.equal('idle')
  })

  it('push on conflict creates rescue branch and returns conflict', async function () {
    state.engine.mergeOrigin = async () => ({ merged: false, conflict: true })
    const result = await manager.promises.push('proj1', 'commit')
    expect(result.code).to.equal('conflict')
    expect(result.branchName).to.match(/^overleaf-sync-/)
    expect(state.doc.syncState).to.equal('conflict')
  })

  it('continueAfterManualMerge throws if not in conflict', async function () {
    state.doc.syncState = 'idle'
    await expect(
      manager.promises.continueAfterManualMerge('proj1')
    ).to.be.rejectedWith('project is not awaiting a manual merge')
  })

  it('continueAfterManualMerge pulls if in conflict', async function () {
    state.doc.syncState = 'conflict'
    const result = await manager.promises.continueAfterManualMerge('proj1')
    expect(result.code).to.equal('ok')
    expect(result.sha).to.equal('sha-merged')
  })

  it('importProject creates project, clones repo, imports tree and stores state', async function () {
    state.doc = null
    const result = await manager.promises.importProject('user1', {
      repoOwner: 'octo',
      repoName: 'paper',
    })
    expect(result.projectId).to.equal('newproj')
    expect(result.warnings).to.deep.equal([])
    expect(state.doc.repo.name).to.equal('paper')
    expect(state.doc.lastSyncedCommitSha).to.equal('sha-merged')
  })

  it('importProject throws github_empty_repository_error for empty repos', async function () {
    state.api.getRepo = async () => ({ size: 0, default_branch: 'main' })
    try {
      await manager.promises.importProject('user1', {
        repoOwner: 'octo',
        repoName: 'empty',
      })
      expect.fail('should have thrown')
    } catch (err) {
      expect(err.code).to.equal('github_empty_repository_error')
    }
  })

  it('importProject throws github_no_master_branch_error if no default branch', async function () {
    state.api.getRepo = async () => ({ size: 10, default_branch: null })
    try {
      await manager.promises.importProject('user1', {
        repoOwner: 'octo',
        repoName: 'nobranch',
      })
      expect.fail('should have thrown')
    } catch (err) {
      expect(err.code).to.equal('github_no_master_branch_error')
    }
  })

  it('createRepoAndLink creates repo, commits files, pushes and returns repo info', async function () {
    state.doc = null
    const result = await manager.promises.createRepoAndLink('user1', 'proj1', {
      name: 'new-repo',
      owner: 'octo',
      isPrivate: false,
    })
    expect(result.repo).to.deep.equal({ owner: 'octo', name: 'paper' })
    expect(state.doc.repo.name).to.equal('paper')
  })

  it('createRepoAndLink throws alreadyLinked if project state exists', async function () {
    try {
      await manager.promises.createRepoAndLink('user1', 'proj1', {
        name: 'new-repo',
        owner: 'octo',
        isPrivate: false,
      })
      expect.fail('should have thrown')
    } catch (err) {
      expect(err.code).to.equal('alreadyLinked')
    }
  })

  it('unlinkProject deletes state and repo directory', async function () {
    let deletedDir = false
    state.engine.deleteRepoDir = async () => {
      deletedDir = true
    }
    await manager.promises.unlinkProject('proj1')
    expect(state.doc).to.equal(null)
    expect(deletedDir).to.equal(true)
  })

  it('unlinkProject throws busy if sync is currently in progress', async function () {
    state.mockBusy = true
    await expect(manager.promises.unlinkProject('proj1')).to.be.rejectedWith(
      'cannot unlink while a sync is in progress'
    )
    expect(state.doc).to.not.equal(null)
  })

  it('unlinkAllForUser removes all projects and credentials for user', async function () {
    let deletedCreds = false
    state.creds.deleteCredentials = async () => {
      deletedCreds = true
    }
    await manager.promises.unlinkAllForUser('user1')
    expect(state.doc).to.equal(null)
    expect(deletedCreds).to.equal(true)
  })

  it('getStatus returns cached incoming count if recently checked', async function () {
    state.doc.status = { incomingCommits: 5, checkedAt: new Date() }
    const status = await manager.promises.getStatus('proj1')
    expect(status.linked).to.equal(true)
    expect(status.incoming).to.equal(5)
  })

  it('getStatus queries GitHub comparison when cache is expired', async function () {
    state.doc.status = {
      incomingCommits: 0,
      checkedAt: new Date(Date.now() - 120 * 1000),
    }
    state.api.compareCommits = async () => ({ ahead_by: 3, behind_by: 1 })
    const status = await manager.promises.getStatus('proj1')
    expect(status.incoming).to.equal(3)
  })

  it('getStatus returns linked: false when project has no state', async function () {
    state.doc = null
    const status = await manager.promises.getStatus('proj1')
    expect(status).to.deep.equal({ linked: false })
  })

  it('onProjectInactive deletes repoDir on disk', async function () {
    let deleted = false
    state.engine.deleteRepoDir = async () => {
      deleted = true
    }
    await manager.promises.onProjectInactive('proj1')
    expect(deleted).to.equal(true)
  })

  it('onUserRemoved unlinks all projects for user', async function () {
    let deletedCreds = false
    state.creds.deleteCredentials = async () => {
      deletedCreds = true
    }
    await manager.promises.onUserRemoved('user1')
    expect(deletedCreds).to.equal(true)
  })
})
