import ProjectGetter from '../Project/ProjectGetter.mjs'
import ProjectCreationHandler from '../Project/ProjectCreationHandler.mjs'
import ProjectHelper from '../Project/ProjectHelper.mjs'
import EditorController from '../Editor/EditorController.mjs'
import McpErrors from './McpErrors.mjs'

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

function compactProject(p, userId) {
  return {
    id: p._id.toString(),
    name: p.name,
    lastUpdated: p.lastUpdated,
    compiler: p.compiler,
    archived: safeIsArchived(p, userId),
    trashed: safeIsTrashed(p, userId),
  }
}

function normalisePath(p) {
  return '/' + String(p || '').replace(/^\/+/, '').replace(/\/+$/, '')
}

async function listProjects(req, res) {
  const q = (req.query?.query || '').toString().toLowerCase()
  const status = (req.query?.status || 'active').toString().toLowerCase()
  const all = await ProjectGetter.promises.findAllUsersProjects(req.mcpUserId, {
    name: 1,
    lastUpdated: 1,
    compiler: 1,
    archived: 1,
    trashed: 1,
  })
  let projects = [
    ...(all.owned || []),
    ...(all.readAndWrite || []),
    ...(all.readOnly || []),
  ].map(p => compactProject(p, req.mcpUserId))

  if (q) {
    projects = projects.filter(p => (p.name || '').toLowerCase().includes(q))
  }

  if (status === 'active') {
    projects = projects.filter(p => !p.trashed && !p.archived)
  } else if (status === 'trashed') {
    projects = projects.filter(p => p.trashed)
  } else if (status === 'archived') {
    projects = projects.filter(p => p.archived)
  } else if (status === 'all') {
    // Return all projects
  } else {
    return McpErrors.send(
      res,
      McpErrors.CODES.VALIDATION,
      `invalid status: "${status}"; must be active, trashed, archived, or all`
    )
  }

  res.json({ projects })
}

async function createProject(req, res) {
  const { name, initialFiles } = req.body || {}
  if (!name || typeof name !== 'string') {
    return McpErrors.send(res, McpErrors.CODES.VALIDATION, 'name is required')
  }
  if (initialFiles != null && !Array.isArray(initialFiles)) {
    return McpErrors.send(
      res,
      McpErrors.CODES.VALIDATION,
      'initialFiles must be an array'
    )
  }
  if (initialFiles) {
    for (const f of initialFiles) {
      if (!f || !f.path || typeof f.path !== 'string') {
        return McpErrors.send(
          res,
          McpErrors.CODES.VALIDATION,
          'each initial file needs a path'
        )
      }
      const norm = normalisePath(f.path)
      if (norm.split('/').some(seg => seg === '..' || seg === '.')) {
        return McpErrors.send(
          res,
          McpErrors.CODES.VALIDATION,
          'invalid path in initialFiles'
        )
      }
    }
  }
  const project = await ProjectCreationHandler.promises.createBlankProject(
    req.mcpUserId,
    name
  )
  for (const f of initialFiles || []) {
    await EditorController.promises.upsertDocWithPath(
      project._id,
      normalisePath(f.path),
      String(f.content || '').split('\n'),
      'mcp',
      req.mcpUserId
    )
  }
  res.json({ project: compactProject(project, req.mcpUserId) })
}

async function getProject(req, res) {
  const project = await ProjectGetter.promises.getProject(req.params.projectId, {
    name: 1,
    lastUpdated: 1,
    compiler: 1,
    rootDoc_id: 1,
    spellCheckLanguage: 1,
    archived: 1,
    trashed: 1,
  })
  if (!project) {
    return McpErrors.send(res, McpErrors.CODES.NOT_FOUND)
  }
  res.json({
    project: {
      ...compactProject(project, req.mcpUserId),
      rootDocId: project.rootDoc_id ? project.rootDoc_id.toString() : null,
      spellCheckLanguage: project.spellCheckLanguage,
    },
  })
}

async function updateSettings(req, res) {
  const { compiler, rootDocId, spellCheckLanguage } = req.body || {}
  if (compiler == null && rootDocId == null && spellCheckLanguage == null) {
    return McpErrors.send(
      res,
      McpErrors.CODES.VALIDATION,
      'no supported settings provided'
    )
  }
  const projectId = req.params.projectId
  if (compiler != null) {
    await EditorController.promises.setCompiler(projectId, compiler)
  }
  if (rootDocId != null) {
    await EditorController.promises.setRootDoc(projectId, rootDocId)
  }
  if (spellCheckLanguage != null) {
    await EditorController.promises.setSpellCheckLanguage(
      projectId,
      spellCheckLanguage
    )
  }
  res.json({ status: 'ok' })
}

export default { listProjects, createProject, getProject, updateSettings }
