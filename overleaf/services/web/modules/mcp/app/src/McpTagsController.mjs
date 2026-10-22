import TagsHandler from '../../../../app/src/Features/Tags/TagsHandler.mjs'
import ProjectGetter from '../../../../app/src/Features/Project/ProjectGetter.mjs'
import McpErrors from './McpErrors.mjs'
import {
  accessibleProjects,
  invalid,
  isTrueParam,
} from './McpRequestParams.mjs'

const NAME_COLLATOR = new Intl.Collator(undefined, { sensitivity: 'base' })

// The editor's own colour picker only produces #RRGGBB values.
const COLOR_REGEX = /^#[a-fA-F0-9]{6}$/
const OBJECT_ID_REGEX = /^[0-9a-f]{24}$/i
// The upstream TagsHandler rejects longer names with a plain Error (a 502), so
// the limit is checked here first and reported as a validation error.
const MAX_TAG_NAME_LENGTH = 50
const PROJECT_IDS_PROBLEM =
  'projectIds must be a non-empty array of project id strings'

/** The compact tag shape every tag tool returns. */
function tagSummary(tag, { includeProjects = false } = {}) {
  const projectIds = (tag.project_ids || []).map(String)
  return {
    id: String(tag._id),
    name: tag.name,
    color: tag.color || null,
    projectCount: projectIds.length,
    ...(includeProjects ? { projectIds } : {}),
  }
}

/**
 * Check a tag name from the request body.
 * Returns `{ name }` when acceptable, otherwise `{ problem }`.
 */
function parseName(value) {
  if (typeof value !== 'string') return { problem: 'name must be a string' }
  const name = value.trim()
  if (!name) return { problem: 'name must not be empty' }
  if (name.length > MAX_TAG_NAME_LENGTH) {
    return {
      problem: `name must be at most ${MAX_TAG_NAME_LENGTH} characters`,
    }
  }
  return { name }
}

function colorProblem(color) {
  if (typeof color === 'string' && COLOR_REGEX.test(color)) return null
  return 'color must be a hex colour such as #3366CC'
}

/** Distinct, non-empty project ids from the body, or null when malformed. */
function parseProjectIds(value) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(id => typeof id !== 'string' || !id)
  ) {
    return null
  }
  return [...new Set(value)]
}

/** The caller's tag with this id, or null. Tags are per user, never shared. */
async function findTag(userId, tagId) {
  if (!OBJECT_ID_REGEX.test(tagId)) return { tags: [], tag: null }
  const tags = await TagsHandler.promises.getAllTags(userId)
  return { tags, tag: tags.find(t => String(t._id) === tagId) || null }
}

function tagNotFound(res) {
  return McpErrors.send(res, McpErrors.CODES.NOT_FOUND, 'tag not found', {
    hint: 'Use list_tags to get the id of an existing tag.',
  })
}

async function listTags(req, res) {
  const includeProjects = isTrueParam(req.query?.includeProjects)
  const tags = await TagsHandler.promises.getAllTags(req.mcpUserId)
  const summaries = tags
    .map(tag => tagSummary(tag, { includeProjects }))
    .sort((a, b) => NAME_COLLATOR.compare(a.name, b.name))
  res.json({ tags: summaries, total: summaries.length })
}

async function createTag(req, res) {
  const { name, problem } = parseName(req.body?.name)
  if (problem) return invalid(res, problem)
  const { color } = req.body || {}
  if (color != null) {
    const colorIssue = colorProblem(color)
    if (colorIssue) return invalid(res, colorIssue)
  }

  const userId = req.mcpUserId
  const existing = (await TagsHandler.promises.getAllTags(userId)).find(
    t => t.name === name
  )
  if (existing) {
    return res.json({ tag: tagSummary(existing), created: false })
  }
  let tag
  try {
    tag = await TagsHandler.promises.createTag(userId, name, color)
  } catch (err) {
    // Two concurrent creates of the same name: the unique index lets one win.
    if (err?.code === 11000) {
      return McpErrors.send(
        res,
        McpErrors.CODES.CONFLICT,
        `a tag named "${name}" was just created`,
        { hint: 'Call create_tag again to get the existing tag.' }
      )
    }
    throw err
  }
  res.json({ tag: tagSummary(tag), created: true })
}

async function updateTag(req, res) {
  const { name: rawName, color } = req.body || {}
  if (rawName == null && color == null) {
    return invalid(res, 'supply name, color or both', {
      hint: 'Pass only the fields to change.',
    })
  }
  let name
  if (rawName != null) {
    const parsed = parseName(rawName)
    if (parsed.problem) return invalid(res, parsed.problem)
    name = parsed.name
  }
  if (color != null) {
    const colorIssue = colorProblem(color)
    if (colorIssue) return invalid(res, colorIssue)
  }

  const userId = req.mcpUserId
  const { tags, tag } = await findTag(userId, req.params.tagId)
  if (!tag) return tagNotFound(res)
  if (name != null && tags.some(t => t.name === name && t !== tag)) {
    return McpErrors.send(
      res,
      McpErrors.CODES.CONFLICT,
      `another tag is already named "${name}"`,
      { hint: 'Pick a different name, or use add_projects_to_tag on the existing tag.' }
    )
  }

  const before = tagSummary(tag)
  try {
    await TagsHandler.promises.editTag(
      userId,
      tag._id,
      name ?? tag.name,
      color ?? tag.color
    )
  } catch (err) {
    // A concurrent rename onto the same name loses to the unique index.
    if (err?.code === 11000) {
      return McpErrors.send(
        res,
        McpErrors.CODES.CONFLICT,
        `another tag is already named "${name}"`
      )
    }
    throw err
  }
  res.json({
    tag: { ...before, name: name ?? before.name, color: color ?? before.color },
    before: { name: before.name, color: before.color },
  })
}

async function deleteTag(req, res) {
  const { tag } = await findTag(req.mcpUserId, req.params.tagId)
  if (!tag) return tagNotFound(res)
  await TagsHandler.promises.deleteTag(req.mcpUserId, tag._id)
  res.json({
    tagId: String(tag._id),
    name: tag.name,
    deleted: true,
    projectsUntagged: (tag.project_ids || []).length,
  })
}

/** Ids of every project the caller can open, owned or shared. */
async function accessibleProjectIds(userId) {
  const all = await ProjectGetter.promises.findAllUsersProjects(userId, {
    _id: 1,
  })
  const ids = new Set()
  for (const { project } of accessibleProjects(all)) {
    ids.add(String(project._id))
  }
  return ids
}

async function addProjects(req, res) {
  const projectIds = parseProjectIds(req.body?.projectIds)
  if (!projectIds) {
    return invalid(res, PROJECT_IDS_PROBLEM)
  }
  const userId = req.mcpUserId
  const [{ tag }, accessible] = await Promise.all([
    findTag(userId, req.params.tagId),
    accessibleProjectIds(userId),
  ])
  if (!tag) return tagNotFound(res)

  const unknown = projectIds.filter(id => !accessible.has(id))
  if (unknown.length > 0) {
    return McpErrors.send(
      res,
      McpErrors.CODES.NOT_FOUND,
      `${unknown.length} project(s) not found or not accessible; nothing was tagged`,
      {
        hint: 'Use list_projects to get valid project ids.',
        details: { unknown },
      }
    )
  }

  const tagged = new Set((tag.project_ids || []).map(String))
  const added = projectIds.filter(id => !tagged.has(id))
  const alreadyTagged = projectIds.filter(id => tagged.has(id))
  if (added.length > 0) {
    await TagsHandler.promises.addProjectsToTag(userId, tag._id, added)
  }
  res.json({
    tag: { ...tagSummary(tag), projectCount: tagged.size + added.length },
    added,
    alreadyTagged,
  })
}

async function removeProjects(req, res) {
  const projectIds = parseProjectIds(req.body?.projectIds)
  if (!projectIds) {
    return invalid(res, PROJECT_IDS_PROBLEM)
  }
  const userId = req.mcpUserId
  const { tag } = await findTag(userId, req.params.tagId)
  if (!tag) return tagNotFound(res)

  // No access check: a project the caller can no longer open must still be
  // removable from their tag.
  const tagged = new Set((tag.project_ids || []).map(String))
  const removed = projectIds.filter(id => tagged.has(id))
  const notTagged = projectIds.filter(id => !tagged.has(id))
  if (removed.length > 0) {
    await TagsHandler.promises.removeProjectsFromTag(userId, tag._id, removed)
  }
  res.json({
    tag: { ...tagSummary(tag), projectCount: tagged.size - removed.length },
    removed,
    notTagged,
  })
}

export default {
  listTags,
  createTag,
  updateTag,
  deleteTag,
  addProjects,
  removeProjects,
}
