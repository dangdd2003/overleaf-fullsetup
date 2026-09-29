import fs from 'node:fs/promises'
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import OError from '@overleaf/o-error'
import SyncEngine from './SyncEngine.mjs'
import SyncFileOps from './SyncFileOps.mjs'
import ProjectContentIO from './ProjectContentIO.mjs'
import GitHubApiManager from './GitHubApiManager.mjs'
import GitHubCredentialsManager from './GitHubCredentialsManager.mjs'
import { GithubSyncProjectStates } from './models/GithubSyncModels.mjs'
import DocumentUpdaterHandler from '../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs'
import ProjectGetter from '../../../../app/src/Features/Project/ProjectGetter.mjs'
import ProjectCreationHandler from '../../../../app/src/Features/Project/ProjectCreationHandler.mjs'
import ProjectDeleter from '../../../../app/src/Features/Project/ProjectDeleter.mjs'
import { DeletedProjectReasons } from '../../../../app/src/Features/Project/DeletedProjectReasons.mjs'

export const LOCK_TTL_MS = 10 * 60 * 1000
export const STATUS_CACHE_MS = 60 * 1000

const TEX_GITIGNORE =
  '## Core latex/pdflatex auxiliary files:\n*.aux\n*.log\n*.out\n*.toc\n' +
  '*.synctex.gz\n*.fls\n*.fdb_latexmk\n'

async function _exists(filePath) {
  try {
    await fs.stat(filePath)
    return true
  } catch {
    return false
  }
}

function _reposDir() {
  return Settings.githubSync.reposDir
}
function _repoUrl(repo) {
  return `${Settings.githubSync.gitBase}/${repo.owner}/${repo.name}.git`
}

async function getState(projectId) {
  return GithubSyncProjectStates.findOne({ project_id: projectId })
}

async function claimLock(projectId) {
  const now = new Date()
  return GithubSyncProjectStates.findOneAndUpdate(
    {
      project_id: projectId,
      $or: [
        { syncLock: { $exists: false } },
        { syncLock: null },
        { 'syncLock.expiresAt': { $lt: now } },
      ],
    },
    {
      $set: {
        syncLock: {
          lockedAt: now,
          expiresAt: new Date(now.getTime() + LOCK_TTL_MS),
        },
        syncState: 'syncing',
        updatedAt: now,
      },
    },
    { new: true }
  )
}

async function releaseLock(projectId, patch = {}) {
  await GithubSyncProjectStates.findOneAndUpdate(
    { project_id: projectId },
    { $set: { syncLock: null, ...patch, updatedAt: new Date() } }
  )
}

async function _failSync(projectId, err) {
  await releaseLock(projectId, {
    syncState: 'error',
    lastError: { code: err.code || 'error', message: err.message, at: new Date() },
  })
}

async function _prepare(projectId) {
  const stateDoc = await getState(projectId)
  if (!stateDoc) {
    throw new OError('project is not linked to GitHub', { projectId })
  }
  const claimed = await claimLock(projectId)
  if (!claimed) {
    const err = new Error('a sync is already in progress')
    err.code = 'busy'
    throw err
  }
  try {
    const token = await GitHubCredentialsManager.promises.getAccessToken(stateDoc.user_id)
    await GitHubCredentialsManager.promises.touch(stateDoc.user_id)
    const creds = await GitHubCredentialsManager.promises.getCredentials(stateDoc.user_id)
    const repoDir = SyncEngine.promises.repoDirFor(_reposDir(), projectId)
    if (!(await SyncEngine.promises.ensureRepoExists(repoDir))) {
      await SyncEngine.promises.cloneRepo(
        repoDir,
        _repoUrl(stateDoc.repo),
        stateDoc.repoDefaultBranch,
        token
      )
    }
    await DocumentUpdaterHandler.promises.flushProjectToMongo(projectId)
    await SyncEngine.promises.fetchOrigin(repoDir, token)
    return { stateDoc, token, creds, repoDir }
  } catch (err) {
    await _failSync(projectId, err)
    throw err
  }
}

async function pull(projectId) {
  const { stateDoc, token, creds, repoDir } = await _prepare(projectId)
  try {
    await ProjectContentIO.promises.materializeProject(projectId, repoDir)
    await SyncEngine.promises.commitAll(repoDir, 'Sync from Overleaf', creds.githubUsername, creds.email)
    const { conflict } = await SyncEngine.promises.mergeOrigin(repoDir, stateDoc.repoDefaultBranch)
    if (conflict) {
      const branchName = await SyncEngine.promises.pushRescueBranch(repoDir, token)
      await releaseLock(projectId, {
        syncState: 'conflict',
        lastError: { code: 'conflict', message: branchName, at: new Date() },
      })
      return { code: 'conflict', branchName }
    }
    const mergedSha = await SyncEngine.promises.getHeadSha(repoDir)
    const changes = await SyncEngine.promises.diffChangeSet(
      repoDir,
      stateDoc.lastSyncedCommitSha,
      mergedSha
    )
    const warnings = await SyncFileOps.promises.applyChangeSet(
      projectId,
      stateDoc.user_id,
      repoDir,
      changes
    )
    await releaseLock(projectId, {
      syncState: 'idle',
      outgoing: false,
      lastSyncedCommitSha: mergedSha,
      lastError: null,
      status: { incomingCommits: 0, checkedAt: new Date() },
    })
    return { code: 'ok', sha: mergedSha, warnings }
  } catch (err) {
    await _failSync(projectId, err)
    throw err
  }
}

async function push(projectId, commitMessage) {
  const { stateDoc, token, creds, repoDir } = await _prepare(projectId)
  try {
    await ProjectContentIO.promises.materializeProject(projectId, repoDir)
    const localSha = await SyncEngine.promises.commitAll(
      repoDir,
      commitMessage || 'Update from Overleaf',
      creds.githubUsername,
      creds.email
    )
    const { conflict } = await SyncEngine.promises.mergeOrigin(repoDir, stateDoc.repoDefaultBranch)
    if (conflict) {
      const branchName = await SyncEngine.promises.pushRescueBranch(repoDir, token)
      await releaseLock(projectId, {
        syncState: 'conflict',
        lastError: { code: 'conflict', message: branchName, at: new Date() },
      })
      return { code: 'conflict', branchName }
    }
    const headSha = await SyncEngine.promises.getHeadSha(repoDir)
    const { stdout } = await SyncEngine.promises.runGit(repoDir, [
      'rev-parse',
      `origin/${stateDoc.repoDefaultBranch}`,
    ])
    const originSha = stdout.trim()
    if (!localSha && headSha === originSha) {
      await releaseLock(projectId, {
        syncState: 'idle',
        outgoing: false,
        lastSyncedCommitSha: headSha,
        status: { incomingCommits: 0, checkedAt: new Date() },
      })
      return { code: 'upToDate' }
    }
    await SyncEngine.promises.pushRef(repoDir, 'HEAD', stateDoc.repoDefaultBranch, token)
    await releaseLock(projectId, {
      syncState: 'idle',
      outgoing: false,
      lastSyncedCommitSha: headSha,
      lastError: null,
      status: { incomingCommits: 0, checkedAt: new Date() },
    })
    return { code: 'ok', sha: headSha }
  } catch (err) {
    await _failSync(projectId, err)
    throw err
  }
}

async function continueAfterManualMerge(projectId) {
  const stateDoc = await getState(projectId)
  if (!stateDoc) {
    throw new OError('project is not linked to GitHub', { projectId })
  }
  if (stateDoc.syncState !== 'conflict') {
    const err = new Error('project is not awaiting a manual merge')
    err.code = 'notInConflict'
    throw err
  }
  return pull(projectId)
}

async function importProject(userId, { repoOwner, repoName, branch, projectName }) {
  const token = await GitHubCredentialsManager.promises.getAccessToken(userId)
  const repoInfo = await GitHubApiManager.promises.getRepo(token, repoOwner, repoName)
  if (repoInfo.size === 0) {
    const err = new Error('repository is empty')
    err.code = 'github_empty_repository_error'
    throw err
  }
  const targetBranch = branch || repoInfo.default_branch
  if (!targetBranch) {
    const err = new Error('repository has no default branch')
    err.code = 'github_no_master_branch_error'
    throw err
  }
  const project = await ProjectCreationHandler.promises.createBlankProject(
    userId,
    projectName || repoName
  )
  const repoDir = SyncEngine.promises.repoDirFor(_reposDir(), project._id)
  try {
    await SyncEngine.promises.cloneRepo(
      repoDir,
      _repoUrl({ owner: repoOwner, name: repoName }),
      targetBranch,
      token
    )
    const warnings = await SyncFileOps.promises.applyImportTree(project._id, userId, repoDir)
    const headSha = await SyncEngine.promises.getHeadSha(repoDir)
    await GithubSyncProjectStates.create({
      project_id: project._id,
      user_id: userId,
      repo: { owner: repoOwner, name: repoName },
      repoDefaultBranch: targetBranch,
      lastSyncedCommitSha: headSha,
      syncState: 'idle',
    })
    return { projectId: project._id.toString(), warnings }
  } catch (err) {
    await ProjectDeleter.promises.deleteProject(project._id, {
      deletedReason: DeletedProjectReasons.GITHUB_IMPORT_FAILURE,
    }).catch(deleteErr =>
      logger.err({ err: deleteErr }, 'failed to delete failed import project')
    )
    await SyncEngine.promises.deleteRepoDir(repoDir).catch(() => {})
    throw err
  }
}

async function createRepoAndLink(userId, projectId, { name, owner, isPrivate }) {
  const existing = await getState(projectId)
  if (existing) {
    const err = new Error('project is already linked to a repository')
    err.code = 'alreadyLinked'
    throw err
  }
  const project = await ProjectGetter.promises.getProject(projectId)
  if (!project || String(project.owner_ref) !== String(userId)) {
    const err = new Error('only the project owner can link to GitHub')
    err.code = 'only_project_owner_can_link_github'
    throw err
  }
  const token = await GitHubCredentialsManager.promises.getAccessToken(userId)
  const creds = await GitHubCredentialsManager.promises.getCredentials(userId)
  const me = await GitHubApiManager.promises.getUser(token)
  const orgLogin = owner && owner !== me.login ? owner : null
  const repo = await GitHubApiManager.promises.createRepo(token, { name, isPrivate, orgLogin })
  const repoRef = { owner: repo.owner.login, name: repo.name }
  const defaultBranch = repo.default_branch || 'main'
  const repoDir = SyncEngine.promises.repoDirFor(_reposDir(), projectId)
  try {
    await SyncEngine.promises.createRepo(repoDir, _repoUrl(repoRef), defaultBranch)
    await DocumentUpdaterHandler.promises.flushProjectToMongo(projectId)
    await ProjectContentIO.promises.materializeProject(projectId, repoDir)
    // After materialize, not before: materializeProject prunes the working tree
    // down to Overleaf's content, which would drop a .gitignore written first.
    // Skip it when the project already ships one of its own.
    if (!(await _exists(`${repoDir}/.gitignore`))) {
      await fs.writeFile(`${repoDir}/.gitignore`, TEX_GITIGNORE)
    }
    await SyncEngine.promises.commitAll(repoDir, 'Import from Overleaf', creds.githubUsername, creds.email)
    await SyncEngine.promises.pushRef(repoDir, 'HEAD', defaultBranch, token)
    const headSha = await SyncEngine.promises.getHeadSha(repoDir)
    await GithubSyncProjectStates.create({
      project_id: projectId,
      user_id: userId,
      repo: repoRef,
      repoDefaultBranch: defaultBranch,
      lastSyncedCommitSha: headSha,
      syncState: 'idle',
    })
    return { repo: repoRef }
  } catch (err) {
    await SyncEngine.promises.deleteRepoDir(repoDir).catch(() => {})
    throw err
  }
}

async function unlinkProject(projectId) {
  const stateDoc = await getState(projectId)
  if (!stateDoc) return
  const claimed = await claimLock(projectId)
  if (!claimed) {
    const err = new Error('cannot unlink while a sync is in progress')
    err.code = 'busy'
    throw err
  }
  await GithubSyncProjectStates.deleteOne({ project_id: projectId })
  const repoDir = SyncEngine.promises.repoDirFor(_reposDir(), projectId)
  await SyncEngine.promises.deleteRepoDir(repoDir).catch(() => {})
}

async function unlinkAllForUser(userId) {
  const states = await GithubSyncProjectStates.find({ user_id: userId })
  for (const stateDoc of states) {
    const repoDir = SyncEngine.promises.repoDirFor(_reposDir(), stateDoc.project_id)
    await SyncEngine.promises.deleteRepoDir(repoDir).catch(() => {})
  }
  await GithubSyncProjectStates.deleteMany({ user_id: userId })
  await GitHubCredentialsManager.promises.deleteCredentials(userId)
}

async function getStatus(projectId) {
  const stateDoc = await getState(projectId)
  if (!stateDoc) return { linked: false }
  const base = {
    linked: true,
    repo: stateDoc.repo,
    branch: stateDoc.repoDefaultBranch,
    syncState: stateDoc.syncState,
    outgoing: Boolean(stateDoc.outgoing),
    lastError: stateDoc.lastError || null,
    conflictBranch:
      stateDoc.lastError?.code === 'conflict' ? stateDoc.lastError.message : null,
  }
  const cache = stateDoc.status
  if (
    stateDoc.lastSyncedCommitSha &&
    cache?.checkedAt &&
    Date.now() - new Date(cache.checkedAt).getTime() < STATUS_CACHE_MS
  ) {
    return { ...base, incoming: cache.incomingCommits || 0 }
  }
  try {
    const token = await GitHubCredentialsManager.promises.getAccessToken(stateDoc.user_id)
    const cmp = await GitHubApiManager.promises.compareCommits(
      token,
      stateDoc.repo.owner,
      stateDoc.repo.name,
      stateDoc.lastSyncedCommitSha,
      stateDoc.repoDefaultBranch
    )
    await GithubSyncProjectStates.updateOne(
      { project_id: projectId },
      { $set: { status: { incomingCommits: cmp.ahead_by, checkedAt: new Date() } } }
    )
    return { ...base, incoming: cmp.ahead_by }
  } catch (err) {
    logger.warn({ err, projectId }, 'github status compare failed')
    return { ...base, incoming: cache?.incomingCommits || 0 }
  }
}

async function markProjectModified(projectId) {
  await GithubSyncProjectStates.updateOne(
    { project_id: projectId, syncState: { $ne: 'syncing' } },
    { $set: { outgoing: true } }
  )
}

async function onProjectInactive(projectId) {
  const stateDoc = await getState(projectId)
  if (!stateDoc) return
  const repoDir = SyncEngine.promises.repoDirFor(_reposDir(), projectId)
  await SyncEngine.promises.deleteRepoDir(repoDir).catch(() => {})
}

async function onUserRemoved(userId) {
  await unlinkAllForUser(userId)
}

const GitHubSyncManager = {
  LOCK_TTL_MS,
  STATUS_CACHE_MS,
  promises: {
    getState,
    pull,
    push,
    continueAfterManualMerge,
    importProject,
    createRepoAndLink,
    unlinkProject,
    unlinkAllForUser,
    getStatus,
    markProjectModified,
    onProjectInactive,
    onUserRemoved,
  },
}

export default GitHubSyncManager
