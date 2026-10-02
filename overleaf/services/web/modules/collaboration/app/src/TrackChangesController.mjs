import { expressify } from '@overleaf/promise-utils'
import { ObjectId } from '../../../../app/src/infrastructure/mongodb.mjs'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'
import DocumentUpdaterHandler from '../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs'
import DocstoreManager from '../../../../app/src/Features/Docstore/DocstoreManager.mjs'
import EditorRealTimeController from '../../../../app/src/Features/Editor/EditorRealTimeController.mjs'
import UserGetter from '../../../../app/src/Features/User/UserGetter.mjs'
import {
  z,
  zz,
  parseReq,
} from '../../../../app/src/infrastructure/Validation.mjs'
import TrackChangesStateHandler from './TrackChangesStateHandler.mjs'

const projectParams = z.object({ project_id: zz.objectId() })

const setStateSchema = z.object({
  params: projectParams,
  body: z.object({
    on: z.boolean().optional(),
    on_for: z.record(zz.objectId(), z.boolean().nullish()).optional(),
    on_for_guests: z.boolean().optional(),
  }),
})

const acceptChangesSchema = z.object({
  params: projectParams.extend({ doc_id: zz.objectId() }),
  body: z.object({
    change_ids: z.array(z.string().min(1)).min(1),
  }),
})

const projectOnlySchema = z.object({ params: projectParams })

async function setTrackChangesState(req, res) {
  const { params, body } = parseReq(req, setStateSchema)
  const userId = SessionManager.getLoggedInUserId(req.session)
  await TrackChangesStateHandler.setTrackChangesState(
    params.project_id,
    userId,
    body
  )
  res.sendStatus(204)
}

async function acceptChanges(req, res) {
  const { params, body } = parseReq(req, acceptChangesSchema)
  const { project_id: projectId, doc_id: docId } = params
  const userId = SessionManager.getLoggedInUserId(req.session)
  await DocumentUpdaterHandler.promises.acceptChanges(
    projectId,
    docId,
    body.change_ids,
    userId
  )
  EditorRealTimeController.emitToRoom(
    projectId,
    'accept-changes',
    docId,
    body.change_ids
  )
  res.sendStatus(204)
}

// Ranges for every doc in the project, used by the review panel overview.
// Flushing first means docstore also reflects docs only open in Redis.
async function getAllRanges(req, res) {
  const { params } = parseReq(req, projectOnlySchema)
  const projectId = params.project_id
  await DocumentUpdaterHandler.promises.flushProjectToMongo(projectId)
  const docs = await DocstoreManager.promises.getAllRanges(projectId)
  res.json(docs.map(doc => ({ id: doc._id, ranges: doc.ranges || {} })))
}

// Authors of tracked changes, so the review panel can name users who are no
// longer project members.
async function getAllChangesUsers(req, res) {
  const { params } = parseReq(req, projectOnlySchema)
  const projectId = params.project_id
  await DocumentUpdaterHandler.promises.flushProjectToMongo(projectId)
  const userIds =
    await DocstoreManager.promises.getTrackedChangesUserIds(projectId)
  const ids = userIds
    .filter(id => typeof id === 'string' && ObjectId.isValid(id))
    .map(id => new ObjectId(id))
  const users = await UserGetter.promises.getUsers(
    { _id: { $in: ids } },
    { email: 1, first_name: 1, last_name: 1 }
  )
  res.json(
    users.map(user => ({
      id: user._id.toString(),
      email: user.email,
      first_name: user.first_name,
      last_name: user.last_name,
    }))
  )
}

export default {
  setTrackChangesState: expressify(setTrackChangesState),
  acceptChanges: expressify(acceptChanges),
  getAllRanges: expressify(getAllRanges),
  getAllChangesUsers: expressify(getAllChangesUsers),
}
