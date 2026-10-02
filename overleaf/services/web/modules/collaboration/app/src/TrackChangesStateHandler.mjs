import { Project } from '../../../../app/src/models/Project.mjs'
import ProjectGetter from '../../../../app/src/Features/Project/ProjectGetter.mjs'
import CollaboratorsGetter from '../../../../app/src/Features/Collaborators/CollaboratorsGetter.mjs'
import CollaboratorsHandler from '../../../../app/src/Features/Collaborators/CollaboratorsHandler.mjs'
import PrivilegeLevels from '../../../../app/src/Features/Authorization/PrivilegeLevels.mjs'
import EditorRealTimeController from '../../../../app/src/Features/Editor/EditorRealTimeController.mjs'
import Errors from '../../../../app/src/Features/Errors/Errors.js'

export const GUESTS_KEY = '__guests__'

const TRACKABLE_LEVELS = [
  PrivilegeLevels.OWNER,
  PrivilegeLevels.READ_AND_WRITE,
  PrivilegeLevels.REVIEW,
]

/**
 * Compute the next explicit track_changes state ({ [userId]: true }).
 *
 * - `on` (legacy, all members) and `on_for_guests` are owner-only, except
 *   that an anonymous link editor may set the guests flag for themselves.
 * - In `on_for`, non-owners may only change their own entry; unchanged
 *   entries for other users are accepted so the client can echo the map.
 * - Reviewers are always tracked: their edits must become suggestions.
 * - Entries for users who are not members are dropped.
 *
 * @param {object} opts
 * @param {Record<string, boolean>} opts.currentState explicit current state
 * @param {{ id: string, privilegeLevel: string }[]} opts.members
 * @param {string | null} opts.actorId logged-in user id, null if anonymous
 * @param {boolean} opts.actorIsOwner
 * @param {{ on?: boolean, on_for?: Record<string, boolean | null | undefined>, on_for_guests?: boolean }} opts.body
 * @returns {Record<string, boolean>}
 */
export function computeTrackChangesState({
  currentState,
  members,
  actorId,
  actorIsOwner,
  body,
}) {
  const levels = new Map(members.map(m => [m.id.toString(), m.privilegeLevel]))
  const isTrackable = id => TRACKABLE_LEVELS.includes(levels.get(id))
  const isOn = (state, id) => state[id] === true

  const next = {}
  for (const [id, value] of Object.entries(currentState)) {
    if (value === true && (id === GUESTS_KEY || isTrackable(id))) {
      next[id] = true
    }
  }

  if (body.on != null) {
    if (!actorIsOwner) {
      throw new Errors.ForbiddenError('only the owner can set tracking for all')
    }
    for (const id of levels.keys()) {
      if (!isTrackable(id)) continue
      if (body.on) next[id] = true
      else delete next[id]
    }
  }

  if (body.on_for != null) {
    for (const [id, value] of Object.entries(body.on_for)) {
      if (!isTrackable(id)) continue
      const wanted = value === true
      if (wanted === isOn(next, id)) continue
      if (!actorIsOwner && id !== actorId) {
        throw new Errors.ForbiddenError(
          'only the owner can change tracking for other collaborators'
        )
      }
      if (wanted) next[id] = true
      else delete next[id]
    }
  }

  if (body.on_for_guests != null) {
    if (!actorIsOwner && actorId != null) {
      throw new Errors.ForbiddenError(
        'only the owner can change tracking for link-sharing guests'
      )
    }
    if (body.on_for_guests) next[GUESTS_KEY] = true
    else delete next[GUESTS_KEY]
  }

  for (const [id, level] of levels) {
    if (level === PrivilegeLevels.REVIEW) next[id] = true
  }

  return next
}

/**
 * Apply a track-changes toggle request, persist it and broadcast it to
 * everyone in the project.
 *
 * @param {string} projectId
 * @param {string | null} actorId
 * @param {object} body
 * @returns {Promise<Record<string, boolean>>}
 */
export async function setTrackChangesState(projectId, actorId, body) {
  const project = await ProjectGetter.promises.getProject(projectId, {
    owner_ref: 1,
    track_changes: 1,
  })
  if (!project) {
    throw new Errors.NotFoundError('project not found')
  }
  const [currentState, members] = await Promise.all([
    CollaboratorsHandler.promises.convertTrackChangesToExplicitFormat(
      projectId,
      project.track_changes
    ),
    CollaboratorsGetter.promises.getMemberIdsWithPrivilegeLevels(projectId),
  ])

  const newState = computeTrackChangesState({
    currentState,
    members,
    actorId: actorId?.toString() ?? null,
    actorIsOwner:
      actorId != null && project.owner_ref.toString() === actorId.toString(),
    body,
  })

  await Project.updateOne(
    { _id: projectId },
    { $set: { track_changes: newState } }
  ).exec()

  EditorRealTimeController.emitToRoom(
    projectId,
    'toggle-track-changes',
    newState
  )

  return newState
}

export default {
  computeTrackChangesState,
  setTrackChangesState,
}
