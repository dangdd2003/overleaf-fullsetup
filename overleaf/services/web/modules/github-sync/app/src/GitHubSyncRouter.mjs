import AuthenticationController from '../../../../app/src/Features/Authentication/AuthenticationController.mjs'
import AuthorizationManager from '../../../../app/src/Features/Authorization/AuthorizationManager.mjs'
import GitHubSyncManager from './GitHubSyncManager.mjs'

async function _requireWriteAccess(req, res) {
  const canWrite = await AuthorizationManager.promises.canUserWriteProjectContent(
    req.user._id,
    req.params.projectId,
    null
  )
  if (!canWrite) {
    res.status(403).json({ code: 'forbidden', message: 'No write access' })
    return false
  }
  return true
}

async function _requireLinkedOwner(req, res) {
  const stateDoc = await GitHubSyncManager.promises.getState(req.params.projectId)
  if (!stateDoc) {
    res.status(404).json({ code: 'notLinked', message: 'project is not linked to GitHub' })
    return null
  }
  // Being the linked owner is not enough on its own: the link outlives changes
  // to project membership, so re-check write access on every sync.
  if (!(await _requireWriteAccess(req, res))) return null
  if (String(stateDoc.user_id) !== String(req.user._id)) {
    res.status(403).json({
      code: 'only_project_owner_can_link_github',
      message: 'Only the linked owner can sync this project',
    })
    return null
  }
  return stateDoc
}

async function status(req, res) {
  const canRead = await AuthorizationManager.promises.canUserReadProject(
    req.user._id,
    req.params.projectId,
    null
  )
  if (!canRead) {
    return res.status(403).json({ code: 'forbidden', message: 'No read access' })
  }
  res.json(await GitHubSyncManager.promises.getStatus(req.params.projectId))
}

async function pull(req, res) {
  const stateDoc = await _requireLinkedOwner(req, res)
  if (!stateDoc) return
  try {
    res.json(await GitHubSyncManager.promises.pull(req.params.projectId))
  } catch (err) {
    res.status(err.code === 'busy' ? 409 : err.status || 400).json({
      code: err.code || 'error',
      message: err.message,
    })
  }
}

async function push(req, res) {
  const stateDoc = await _requireLinkedOwner(req, res)
  if (!stateDoc) return
  try {
    res.json(await GitHubSyncManager.promises.push(req.params.projectId, req.body?.message))
  } catch (err) {
    res.status(err.code === 'busy' ? 409 : err.status || 400).json({
      code: err.code || 'error',
      message: err.message,
    })
  }
}

async function unlinkProject(req, res) {
  const stateDoc = await _requireLinkedOwner(req, res)
  if (!stateDoc) return
  await GitHubSyncManager.promises.unlinkProject(req.params.projectId)
  res.json({ ok: true })
}

async function continueMerge(req, res) {
  const stateDoc = await _requireLinkedOwner(req, res)
  if (!stateDoc) return
  try {
    res.json(await GitHubSyncManager.promises.continueAfterManualMerge(req.params.projectId))
  } catch (err) {
    res.status(err.status || 400).json({ code: err.code || 'error', message: err.message })
  }
}

async function createRepo(req, res) {
  const { name, owner, isPrivate } = req.body
  if (!name) {
    return res.status(400).json({ code: 'invalidParameters', message: 'name is required' })
  }
  const existing = await GitHubSyncManager.promises.getState(req.params.projectId)
  if (existing) {
    return res.status(409).json({ code: 'alreadyLinked', message: 'already linked' })
  }
  // createRepo does not go through _requireLinkedOwner (there is no link yet),
  // so it needs its own write-access check.
  if (!(await _requireWriteAccess(req, res))) return
  try {
    const result = await GitHubSyncManager.promises.createRepoAndLink(
      req.user._id,
      req.params.projectId,
      { name, owner, isPrivate }
    )
    res.json(result)
  } catch (err) {
    const status = err.code === 'only_project_owner_can_link_github' ? 403 : err.status || 400
    res.status(status).json({ code: err.code || 'error', message: err.message })
  }
}

const GitHubSyncRouter = {
  apply(webRouter) {
    const requireLogin = AuthenticationController.requireLogin()
    const base = '/project/:projectId/github'
    webRouter.get(`${base}/status`, requireLogin, status)
    webRouter.post(`${base}/pull`, requireLogin, pull)
    webRouter.post(`${base}/push`, requireLogin, push)
    webRouter.post(`${base}/unlink`, requireLogin, unlinkProject)
    webRouter.post(`${base}/continue-merge`, requireLogin, continueMerge)
    webRouter.post(`${base}/create-repo`, requireLogin, createRepo)
  },
}

export default GitHubSyncRouter
export { GitHubSyncRouter }
