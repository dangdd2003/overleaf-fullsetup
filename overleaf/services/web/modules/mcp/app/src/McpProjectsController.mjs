import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import Errors from '../../../../app/src/Features/Errors/Errors.js'
import ProjectGetter from '../../../../app/src/Features/Project/ProjectGetter.mjs'
import ProjectCreationHandler from '../../../../app/src/Features/Project/ProjectCreationHandler.mjs'
import ProjectDuplicator from '../../../../app/src/Features/Project/ProjectDuplicator.mjs'
import ProjectDeleter from '../../../../app/src/Features/Project/ProjectDeleter.mjs'
import ProjectDetailsHandler from '../../../../app/src/Features/Project/ProjectDetailsHandler.mjs'
import ProjectEntityHandler from '../../../../app/src/Features/Project/ProjectEntityHandler.mjs'
import ProjectEntityUpdateHandler from '../../../../app/src/Features/Project/ProjectEntityUpdateHandler.mjs'
import ProjectHelper from '../../../../app/src/Features/Project/ProjectHelper.mjs'
import SafePath from '../../../../app/src/Features/Project/SafePath.mjs'
import ProjectAuditLogHandler from '../../../../app/src/Features/Project/ProjectAuditLogHandler.mjs'
import { DeletedProjectReasons } from '../../../../app/src/Features/Project/DeletedProjectReasons.mjs'
import EditorController from '../../../../app/src/Features/Editor/EditorController.mjs'
import AuthorizationManager from '../../../../app/src/Features/Authorization/AuthorizationManager.mjs'
import UserGetter from '../../../../app/src/Features/User/UserGetter.mjs'
import McpErrors from './McpErrors.mjs'
import {
  accessibleProjects,
  hasDotSegment,
  invalid,
  parseIntParam,
} from './McpRequestParams.mjs'

const NAME_COLLATOR = new Intl.Collator(undefined, { sensitivity: 'base' })

const LIST_STATUSES = ['active', 'archived', 'trashed', 'all']
const LIST_OWNERSHIPS = ['all', 'owned', 'shared']
const LIST_SORTS = ['lastUpdated', 'name']
const LIST_ORDERS = ['asc', 'desc']
const DEFAULT_LIST_LIMIT = 50

const CREATE_TEMPLATES = ['blank', 'example', 'empty']
// Each initial file is written in turn, so a create call takes a bounded number.
const MAX_INITIAL_FILES = 100
const PROJECT_STATUSES = ['active', 'archived', 'trashed']
const SETTING_FIELDS = [
  'name',
  'compiler',
  'imageName',
  'spellCheckLanguage',
  'rootDocPath',
  'rootDocId',
]

const LIST_FIELDS = {
  name: 1,
  lastUpdated: 1,
  compiler: 1,
  owner_ref: 1,
  archived: 1,
  trashed: 1,
}
const DETAIL_FIELDS = {
  name: 1,
  lastUpdated: 1,
  compiler: 1,
  imageName: 1,
  spellCheckLanguage: 1,
  rootDoc_id: 1,
  owner_ref: 1,
  archived: 1,
  trashed: 1,
}

function safeIsTrashed(project, userId) {
  if (!project || !userId) return false
  try {
    return ProjectHelper.isTrashed(project, userId)
  } catch {
    const uStr = userId.toString()
    return (project.trashed || []).some(id => id?.toString() === uStr)
  }
}

function safeIsArchived(project, userId) {
  if (!project || !userId) return false
  try {
    return ProjectHelper.isArchived(project, userId)
  } catch {
    const uStr = userId.toString()
    return (project.archived || []).some(id => id?.toString() === uStr)
  }
}

/** The one status a project has for this user: archived, trashed or active. */
function statusOf(project, userId) {
  if (safeIsArchived(project, userId)) return 'archived'
  if (safeIsTrashed(project, userId)) return 'trashed'
  return 'active'
}

function normalisePath(p) {
  return '/' + String(p || '').replace(/^\/+/, '').replace(/\/+$/, '')
}

function isRootDocPath(docPath) {
  return ProjectEntityUpdateHandler.isPathValidForRootDoc(docPath)
}

/** Null when the name is acceptable, otherwise the reason it is not. */
async function nameProblem(name) {
  try {
    await ProjectDetailsHandler.promises.validateProjectName(name)
    return null
  } catch (err) {
    if (err instanceof Errors.InvalidNameError) return err.message
    throw err
  }
}

/** The stored image name is prefixed with the image hosting root; the API speaks bare names. */
function bareImageName(stored) {
  if (!stored) return null
  const root = Settings.imageRoot ? Settings.imageRoot + '/' : ''
  return root && stored.startsWith(root) ? stored.slice(root.length) : stored
}

function imageOptions() {
  return (Settings.allowedImageNames || []).map(image => ({
    value: image.imageName,
    description: image.imageDesc || image.imageName,
  }))
}

/** Languages the server can spell-check. The empty value turns spell check off. */
function spellCheckOptions() {
  const languages = (Settings.languages || []).filter(
    language => language.server !== false
  )
  return [
    { value: '', name: 'Spell check off' },
    ...languages.map(language => ({
      value: language.code,
      name: language.name,
    })),
  ]
}

/** Display name for each owner on a page of projects, keyed by user id. */
async function ownersById(ownerRefs) {
  const refs = new Map()
  for (const ref of ownerRefs) {
    if (ref) refs.set(ref.toString(), ref)
  }
  const owners = new Map()
  if (refs.size === 0) return owners
  const users = await UserGetter.promises.getUsers(
    { _id: { $in: [...refs.values()] } },
    { first_name: 1, last_name: 1, email: 1 }
  )
  for (const user of users) {
    const name =
      [user.first_name, user.last_name].filter(Boolean).join(' ') ||
      user.email ||
      undefined
    owners.set(user._id.toString(), { id: user._id.toString(), name })
  }
  return owners
}

/**
 * The compact project shape every tool returns. `owner` is pre-resolved by
 * the caller so this stays synchronous.
 */
function compactProject(project, { accessLevel, owner, userId, status }) {
  return {
    id: project._id.toString(),
    name: project.name,
    lastUpdated: project.lastUpdated,
    accessLevel,
    owner,
    compiler: project.compiler || Settings.defaultLatexCompiler,
    archived: status != null ? status === 'archived' : safeIsArchived(project, userId),
    trashed: status != null ? status === 'trashed' : safeIsTrashed(project, userId),
  }
}

/** Documents and files of a project, as normalised paths. */
async function loadTree(projectId) {
  const { docs, files } = await ProjectEntityHandler.promises.getAllEntities(
    projectId
  )
  return {
    docs: docs.map(d => ({ id: d.doc._id.toString(), path: normalisePath(d.path) })),
    files: files.map(f => ({
      id: f.file._id.toString(),
      path: normalisePath(f.path),
    })),
  }
}

function findDocById(tree, id) {
  if (!id) return undefined
  return tree.docs.find(d => d.id === id.toString())
}

function rootDocCandidates(tree) {
  return tree.docs.filter(d => isRootDocPath(d.path)).map(d => d.path)
}

/** The settings a model edits, as the API reports them. */
function settingsOf(project, tree) {
  const rootDoc = findDocById(tree, project.rootDoc_id)
  return {
    name: project.name,
    compiler: project.compiler || Settings.defaultLatexCompiler,
    imageName: bareImageName(project.imageName),
    spellCheckLanguage: project.spellCheckLanguage || '',
    rootDocPath: rootDoc ? rootDoc.path : null,
    rootDocId: rootDoc ? rootDoc.id : null,
  }
}

function compareProjects(sortBy, order) {
  const defaultOrder = sortBy === 'name' ? 'asc' : 'desc'
  const direction = (order || defaultOrder) === 'asc' ? 1 : -1
  return (a, b) => {
    if (sortBy === 'name') {
      return (
        direction *
        NAME_COLLATOR.compare(a.project.name || '', b.project.name || '')
      )
    }
    return direction * (a.time - b.time)
  }
}

async function listProjects(req, res) {
  const query = (req.query?.query || '').toString().trim().toLowerCase()
  const status = (req.query?.status || 'active').toString().toLowerCase()
  const ownership = (req.query?.ownership || 'all').toString().toLowerCase()
  const sortBy = (req.query?.sortBy || 'lastUpdated').toString()
  const order = req.query?.order ? req.query.order.toString().toLowerCase() : undefined
  const limit = parseIntParam(req.query?.limit, DEFAULT_LIST_LIMIT, { min: 1 })

  if (!LIST_STATUSES.includes(status)) {
    return invalid(res, `invalid status: "${status}"`, { allowed: LIST_STATUSES })
  }
  if (!LIST_OWNERSHIPS.includes(ownership)) {
    return invalid(res, `invalid ownership: "${ownership}"`, {
      allowed: LIST_OWNERSHIPS,
    })
  }
  if (!LIST_SORTS.includes(sortBy)) {
    return invalid(res, `invalid sortBy: "${sortBy}"`, { allowed: LIST_SORTS })
  }
  if (order && !LIST_ORDERS.includes(order)) {
    return invalid(res, `invalid order: "${order}"`, { allowed: LIST_ORDERS })
  }
  if (limit === null) {
    return invalid(res, 'limit must be a whole number of at least 1')
  }

  const userId = req.mcpUserId
  const all = await ProjectGetter.promises.findAllUsersProjects(userId, LIST_FIELDS)

  // findAllUsersProjects already removes duplicates; the first bucket wins
  // so a project the caller owns is never reported as shared.
  const seen = new Set()
  let rows = []
  for (const { project, accessLevel, owned } of accessibleProjects(all)) {
    const id = project._id.toString()
    if (seen.has(id)) continue
    seen.add(id)
    rows.push({
      project,
      accessLevel,
      owned,
      time: new Date(project.lastUpdated || 0).getTime(),
      status: statusOf(project, userId),
    })
  }

  if (ownership !== 'all') {
    rows = rows.filter(row => row.owned === (ownership === 'owned'))
  }
  if (query) {
    rows = rows.filter(row => (row.project.name || '').toLowerCase().includes(query))
  }
  if (status !== 'all') {
    rows = rows.filter(row => row.status === status)
  }
  rows.sort(compareProjects(sortBy, order))

  const total = rows.length
  const page = rows.slice(0, limit)
  const owners = await ownersById(page.map(row => row.project.owner_ref))
  const projects = page.map(({ project, accessLevel, status: rowStatus }) =>
    compactProject(project, {
      accessLevel,
      owner: owners.get(project.owner_ref?.toString()) || {
        id: project.owner_ref?.toString(),
      },
      userId,
      status: rowStatus,
    })
  )

  res.json({
    projects,
    total,
    returned: projects.length,
    truncated: total > projects.length,
  })
}

/**
 * Delete a project that failed part-way through creation. Returns false when
 * the delete itself fails, so the caller can report the project id instead.
 */
async function discardHalfCreatedProject(projectId, userId, ipAddress) {
  try {
    await ProjectDeleter.promises.deleteProject(projectId, {
      deleterUser: { _id: userId },
      ipAddress,
      deletedReason: DeletedProjectReasons.USER,
    })
    return true
  } catch (err) {
    logger.error(
      { err, projectId, mcpUserId: userId },
      'failed to remove half-created mcp project'
    )
    return false
  }
}

async function createProject(req, res) {
  const { name, template = 'blank', mainTex, initialFiles } = req.body || {}
  if (!name || typeof name !== 'string') {
    return McpErrors.send(res, McpErrors.CODES.VALIDATION, 'name is required')
  }
  if (!CREATE_TEMPLATES.includes(template)) {
    return invalid(res, `invalid template: "${template}"`, {
      allowed: CREATE_TEMPLATES,
    })
  }
  if (mainTex != null && typeof mainTex !== 'string') {
    return invalid(res, 'mainTex must be a string')
  }
  if (initialFiles != null && !Array.isArray(initialFiles)) {
    return invalid(res, 'initialFiles must be an array')
  }
  if (initialFiles && initialFiles.length > MAX_INITIAL_FILES) {
    return invalid(
      res,
      `at most ${MAX_INITIAL_FILES} initial files can be created at once`
    )
  }
  for (const f of initialFiles || []) {
    if (!f || !f.path || typeof f.path !== 'string') {
      return invalid(res, 'each initial file needs a path')
    }
    const norm = normalisePath(f.path)
    if (hasDotSegment(norm)) {
      return invalid(res, 'invalid path in initialFiles')
    }
    // Checked before the project exists: a name rejected later would leave an
    // empty project behind, and a retry would then create a duplicate.
    if (!SafePath.isCleanPath(norm)) {
      return invalid(res, `invalid path in initialFiles: ${norm}`)
    }
  }

  const projectName = name.trim()
  const problem = await nameProblem(projectName)
  if (problem) return invalid(res, problem)

  const userId = req.mcpUserId
  let project
  if (template === 'example') {
    project = await ProjectCreationHandler.promises.createExampleProject(
      userId,
      projectName
    )
  } else if (template === 'empty') {
    project = await ProjectCreationHandler.promises.createBlankProject(
      userId,
      projectName
    )
  } else {
    project = await ProjectCreationHandler.promises.createBasicProject(
      userId,
      projectName
    )
  }

  const filesCreated = []
  let rootDoc
  try {
    // mainTex is applied last, so it replaces a main.tex given in initialFiles
    // or created by the template.
    const files = [...(initialFiles || [])]
    if (mainTex != null) files.push({ path: 'main.tex', content: mainTex })
    for (const f of files) {
      const path = normalisePath(f.path)
      await EditorController.promises.upsertDocWithPath(
        project._id,
        path,
        String(f.content ?? '').split('\n'),
        'mcp',
        userId
      )
      filesCreated.push(path)
    }

    // An empty project has no root document; adopt main.tex when it exists.
    const tree = await loadTree(project._id)
    rootDoc = findDocById(tree, project.rootDoc_id)
    if (!rootDoc) {
      const mainTexDoc = tree.docs.find(d => d.path === '/main.tex')
      if (mainTexDoc) {
        await EditorController.promises.setRootDoc(project._id, mainTexDoc.id)
        rootDoc = mainTexDoc
      }
    }
  } catch (err) {
    // Remove the partial project rather than leave it behind: the client gets
    // a plain failure, and a retry does not create a second project.
    const removed = await discardHalfCreatedProject(
      project._id,
      userId,
      req.ip
    )
    if (!removed) {
      return McpErrors.send(
        res,
        McpErrors.CODES.UPSTREAM,
        'the project was created but could not be completed or removed',
        {
          hint: 'Delete the project with delete_project using details.projectId.',
          details: { projectId: project._id.toString() },
        }
      )
    }
    throw err
  }

  res.json({
    project: compactProject(project, {
      accessLevel: 'owner',
      owner: { id: userId.toString() },
      userId,
    }),
    rootDocPath: rootDoc ? rootDoc.path : null,
    filesCreated,
  })
}

async function getProject(req, res) {
  const projectId = req.params.projectId
  const userId = req.mcpUserId
  const project = await ProjectGetter.promises.getProject(projectId, DETAIL_FIELDS)
  if (!project) {
    return McpErrors.send(res, McpErrors.CODES.NOT_FOUND)
  }

  const tree = await loadTree(projectId)
  const [owners, accessLevel, canWrite, canAdmin] = await Promise.all([
    ownersById([project.owner_ref]),
    AuthorizationManager.promises.getPrivilegeLevelForProject(userId, projectId, null),
    AuthorizationManager.promises.canUserWriteProjectSettings(userId, projectId, null),
    AuthorizationManager.promises.canUserAdminProject(userId, projectId, null),
  ])

  res.json({
    project: {
      ...compactProject(project, {
        accessLevel: accessLevel || 'none',
        owner: owners.get(project.owner_ref?.toString()) || {
          id: project.owner_ref?.toString(),
        },
        userId,
      }),
      canWrite: Boolean(canWrite),
      canAdmin: Boolean(canAdmin),
    },
    settings: settingsOf(project, tree),
    allowedValues: {
      compiler: [...Settings.safeCompilers],
      imageName: imageOptions(),
      spellCheckLanguage: spellCheckOptions(),
    },
    files: {
      documents: tree.docs.length,
      files: tree.files.length,
      rootDocCandidates: rootDocCandidates(tree),
    },
  })
}

async function updateSettings(req, res) {
  const body = req.body || {}
  const projectId = req.params.projectId
  const userId = req.mcpUserId

  const requested = SETTING_FIELDS.filter(field => body[field] != null)
  if (requested.length === 0) {
    return invalid(res, 'no supported settings provided', {
      allowed: SETTING_FIELDS,
      hint: 'Supply at least one setting; values not supplied are left unchanged.',
    })
  }
  for (const field of requested) {
    if (typeof body[field] !== 'string') {
      return invalid(res, `${field} must be a string`)
    }
  }
  if (body.rootDocPath != null && body.rootDocId != null) {
    return invalid(res, 'supply rootDocPath or rootDocId, not both')
  }

  const project = await ProjectGetter.promises.getProject(projectId, DETAIL_FIELDS)
  if (!project) {
    return McpErrors.send(res, McpErrors.CODES.NOT_FOUND)
  }
  const tree = await loadTree(projectId)
  const before = settingsOf(project, tree)

  // Validate everything before writing anything, so a rejected request
  // leaves the project untouched.
  const after = {}

  if (body.name != null) {
    const canRename = await AuthorizationManager.promises.canUserRenameProject(
      userId,
      projectId,
      null
    )
    if (!canRename) {
      return McpErrors.send(
        res,
        McpErrors.CODES.FORBIDDEN,
        'only the project owner can rename the project',
        { hint: 'Change the other settings, or ask the project owner to rename it.' }
      )
    }
    const name = body.name.trim()
    const problem = await nameProblem(name)
    if (problem) return invalid(res, problem)
    after.name = name
  }

  if (body.compiler != null) {
    const compiler = body.compiler.toLowerCase()
    if (!Settings.safeCompilers.includes(compiler)) {
      return invalid(res, `unsupported compiler "${body.compiler}"`, {
        allowed: [...Settings.safeCompilers],
      })
    }
    after.compiler = compiler
  }

  if (body.imageName != null) {
    const options = imageOptions().map(option => option.value)
    if (options.length === 0) {
      return invalid(
        res,
        'this server does not offer selectable TeX Live images, so imageName cannot be changed',
        { allowed: [] }
      )
    }
    const match = options.find(
      value => value.toLowerCase() === body.imageName.toLowerCase()
    )
    if (!match) {
      return invalid(res, `unsupported imageName "${body.imageName}"`, {
        allowed: options,
      })
    }
    after.imageName = match
  }

  if (body.spellCheckLanguage != null) {
    const options = spellCheckOptions().map(option => option.value)
    if (!options.includes(body.spellCheckLanguage)) {
      return invalid(res, `unsupported spellCheckLanguage "${body.spellCheckLanguage}"`, {
        allowed: options,
        hint: 'Use the empty string to turn spell check off.',
      })
    }
    after.spellCheckLanguage = body.spellCheckLanguage
  }

  if (body.rootDocPath != null || body.rootDocId != null) {
    const doc =
      body.rootDocId != null
        ? tree.docs.find(d => d.id === body.rootDocId)
        : tree.docs.find(d => d.path === normalisePath(body.rootDocPath))
    const candidates = rootDocCandidates(tree)
    if (!doc) {
      return McpErrors.send(
        res,
        McpErrors.CODES.NOT_FOUND,
        'no document in the project matches that root document',
        {
          hint: 'Use one of the rootDocCandidates paths, or list_files to find the exact path.',
          details: { rootDocCandidates: candidates },
        }
      )
    }
    if (!isRootDocPath(doc.path)) {
      return invalid(res, `${doc.path} cannot be a root document`, {
        hint: 'Choose a LaTeX document such as /main.tex.',
        allowed: candidates,
      })
    }
    after.rootDocId = doc.id
    after.rootDocPath = doc.path
  }

  if (after.name !== undefined) {
    await EditorController.promises.renameProject(projectId, after.name)
  }
  if (after.compiler !== undefined) {
    await EditorController.promises.setCompiler(projectId, after.compiler)
  }
  if (after.imageName !== undefined) {
    await EditorController.promises.setImageName(projectId, after.imageName)
  }
  if (after.spellCheckLanguage !== undefined) {
    await EditorController.promises.setSpellCheckLanguage(
      projectId,
      after.spellCheckLanguage
    )
  }
  if (after.rootDocId !== undefined) {
    await EditorController.promises.setRootDoc(projectId, after.rootDocId)
  }

  // rootDocId is an input alias for rootDocPath, so only the path is reported.
  const changes = Object.keys(after)
    .filter(field => field !== 'rootDocId')
    .map(field => ({
      field,
      before: before[field],
      after: after[field],
      changed: before[field] !== after[field],
    }))

  res.json({
    changes,
    settings: { ...before, ...after },
  })
}

async function setStatus(req, res) {
  const { status } = req.body || {}
  if (!PROJECT_STATUSES.includes(status)) {
    return invalid(res, `invalid status: "${status}"`, {
      allowed: PROJECT_STATUSES,
    })
  }
  const projectId = req.params.projectId
  const userId = req.mcpUserId
  const project = await ProjectGetter.promises.getProject(projectId, {
    archived: 1,
    trashed: 1,
  })
  if (!project) {
    return McpErrors.send(res, McpErrors.CODES.NOT_FOUND)
  }

  const previousStatus = statusOf(project, userId)
  if (previousStatus !== status) {
    if (status === 'archived') {
      await ProjectDeleter.promises.archiveProject(projectId, userId)
      auditLog(projectId, 'project-archived', userId, req.ip)
    } else if (status === 'trashed') {
      await ProjectDeleter.promises.trashProject(projectId, userId)
      auditLog(projectId, 'project-trashed', userId, req.ip)
    } else {
      if (previousStatus === 'archived') {
        await ProjectDeleter.promises.unarchiveProject(projectId, userId)
        auditLog(projectId, 'project-unarchived', userId, req.ip)
      }
      if (previousStatus === 'trashed') {
        await ProjectDeleter.promises.untrashProject(projectId, userId)
        auditLog(projectId, 'project-untrashed', userId, req.ip)
      }
    }
  }

  res.json({ projectId, previousStatus, status })
}

async function copyProject(req, res) {
  res.setTimeout(5 * 60 * 1000) // allow extra time for the copy to complete
  const projectId = req.params.projectId
  const userId = req.mcpUserId
  const { name } = req.body || {}

  const original = await ProjectGetter.promises.getProject(projectId, { name: 1 })
  if (!original) {
    return McpErrors.send(res, McpErrors.CODES.NOT_FOUND)
  }

  let copyName
  if (name != null) {
    if (typeof name !== 'string') return invalid(res, 'name must be a string')
    copyName = name.trim()
    const problem = await nameProblem(copyName)
    if (problem) return invalid(res, problem)
  } else {
    copyName = await ProjectDetailsHandler.promises.generateUniqueName(
      userId,
      `${original.name} (Copy)`
    )
  }

  const copy = await ProjectDuplicator.promises.duplicate(
    { _id: userId },
    projectId,
    copyName,
    [],
    { isDebugCopy: false, cloneHistory: false, cloneRanges: false }
  )
  auditLog(projectId, 'project-cloned', userId, req.ip)

  res.json({
    project: compactProject(copy, {
      accessLevel: 'owner',
      owner: { id: userId.toString() },
      userId,
    }),
    sourceProjectId: projectId,
  })
}

async function deleteProject(req, res) {
  const projectId = req.params.projectId
  const userId = req.mcpUserId
  const canAdmin = await AuthorizationManager.promises.canUserAdminProject(
    userId,
    projectId,
    null
  )
  if (!canAdmin) {
    return McpErrors.send(
      res,
      McpErrors.CODES.FORBIDDEN,
      'only the project owner can delete the project',
      {
        hint: 'Use set_project_status with status "trashed" to hide the project instead.',
      }
    )
  }

  await ProjectDeleter.promises.deleteProject(projectId, {
    deleterUser: { _id: userId },
    ipAddress: req.ip,
    deletedReason: DeletedProjectReasons.USER,
  })
  auditLog(projectId, 'project-deleted', userId, req.ip)

  res.json({ projectId, deleted: true })
}

function auditLog(projectId, event, userId, ipAddress) {
  ProjectAuditLogHandler.addEntryIfManagedInBackground(
    projectId,
    event,
    userId,
    ipAddress
  )
}

export default {
  listProjects,
  createProject,
  getProject,
  updateSettings,
  setStatus,
  copyProject,
  deleteProject,
}
