import { expressify } from '@overleaf/promise-utils'
import Modules from '../../../../app/src/infrastructure/Modules.mjs'
import ChatApiHandler from '../../../../app/src/Features/Chat/ChatApiHandler.mjs'
import EditorRealTimeController from '../../../../app/src/Features/Editor/EditorRealTimeController.mjs'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'
import UserInfoManager from '../../../../app/src/Features/User/UserInfoManager.mjs'
import UserInfoController from '../../../../app/src/Features/User/UserInfoController.mjs'
import ChatManager from '../../../../app/src/Features/Chat/ChatManager.mjs'

async function getThreads(req, res) {
  const { project_id: projectId } = req.params
  const threads = await ChatApiHandler.promises.getThreads(projectId)
  await ChatManager.promises.injectUserInfoIntoThreads(threads)
  res.json(threads)
}

async function getThread(req, res) {
  const { project_id: projectId, thread_id: threadId } = req.params
  const thread = await ChatApiHandler.promises.getThread(projectId, threadId)
  if (!thread) {
    return res.sendStatus(404)
  }
  await ChatManager.promises.injectUserInfoIntoThreads({ [threadId]: thread })
  res.json(thread)
}

async function sendComment(req, res) {
  const { project_id: projectId, thread_id: threadId } = req.params
  const { content, client_id: clientId } = req.body
  const userId = SessionManager.getLoggedInUserId(req.session)
  if (userId == null) {
    throw new Error('no logged-in user')
  }

  const message = await ChatApiHandler.promises.sendComment(
    projectId,
    threadId,
    userId,
    content
  )

  const user = await UserInfoManager.promises.getPersonalInfo(message.user_id)
  message.user = UserInfoController.formatPersonalInfo(user)
  message.clientId = clientId

  // Emits socket 'new-comment' with (threadId, comment) to match frontend threads-context.tsx
  EditorRealTimeController.emitToRoom(
    projectId,
    'new-comment',
    threadId,
    message
  )

  await Modules.promises.hooks.fire('commentMessageSent', {
    projectId,
    threadId,
    userId,
    content,
    messageId: message.id || message._id,
  })

  res.json(message)
}

async function resolveThread(req, res) {
  const { project_id: projectId, thread_id: threadId } = req.params
  const userId = SessionManager.getLoggedInUserId(req.session)
  await ChatApiHandler.promises.resolveThread(projectId, threadId, userId)

  const user = await UserInfoManager.promises.getPersonalInfo(userId)
  const formattedUser = user
    ? UserInfoController.formatPersonalInfo(user)
    : { id: userId }

  // Emits socket 'resolve-thread' with (threadId, user) to match frontend threads-context.tsx
  EditorRealTimeController.emitToRoom(
    projectId,
    'resolve-thread',
    threadId,
    formattedUser
  )
  res.sendStatus(204)
}

async function reopenThread(req, res) {
  const { project_id: projectId, thread_id: threadId } = req.params
  await ChatApiHandler.promises.reopenThread(projectId, threadId)

  // Emits socket 'reopen-thread' with (threadId) to match frontend threads-context.tsx
  EditorRealTimeController.emitToRoom(projectId, 'reopen-thread', threadId)
  res.sendStatus(204)
}

async function deleteThread(req, res) {
  const { project_id: projectId, thread_id: threadId } = req.params
  await ChatApiHandler.promises.deleteThread(projectId, threadId)

  // Emits socket 'delete-thread' with (threadId) to match frontend threads-context.tsx
  EditorRealTimeController.emitToRoom(projectId, 'delete-thread', threadId)
  res.sendStatus(204)
}

async function editCommentMessage(req, res) {
  const {
    project_id: projectId,
    thread_id: threadId,
    message_id: messageId,
  } = req.params
  const { content } = req.body
  const userId = SessionManager.getLoggedInUserId(req.session)
  if (userId == null) {
    throw new Error('no logged-in user')
  }

  await ChatApiHandler.promises.editMessage(
    projectId,
    threadId,
    messageId,
    userId,
    content
  )

  // Emits socket 'edit-message' with (threadId, commentId, content) to match frontend threads-context.tsx
  EditorRealTimeController.emitToRoom(
    projectId,
    'edit-message',
    threadId,
    messageId,
    content
  )
  res.sendStatus(204)
}

async function deleteCommentMessage(req, res) {
  const {
    project_id: projectId,
    thread_id: threadId,
    message_id: messageId,
  } = req.params
  const userId = SessionManager.getLoggedInUserId(req.session)
  if (userId == null) {
    throw new Error('no logged-in user')
  }

  await ChatApiHandler.promises.deleteMessage(projectId, threadId, messageId)

  // Emits socket 'delete-message' with (threadId, commentId) to match frontend threads-context.tsx
  EditorRealTimeController.emitToRoom(
    projectId,
    'delete-message',
    threadId,
    messageId
  )
  res.sendStatus(204)
}

async function deleteOwnCommentMessage(req, res) {
  const {
    project_id: projectId,
    thread_id: threadId,
    message_id: messageId,
  } = req.params
  const userId = SessionManager.getLoggedInUserId(req.session)
  if (userId == null) {
    throw new Error('no logged-in user')
  }

  await ChatApiHandler.promises.deleteUserMessage(
    projectId,
    threadId,
    userId,
    messageId
  )

  // Emits socket 'delete-message' with (threadId, commentId) to match frontend threads-context.tsx
  EditorRealTimeController.emitToRoom(
    projectId,
    'delete-message',
    threadId,
    messageId
  )
  res.sendStatus(204)
}

export default {
  getThreads: expressify(getThreads),
  getThread: expressify(getThread),
  sendComment: expressify(sendComment),
  resolveThread: expressify(resolveThread),
  reopenThread: expressify(reopenThread),
  deleteThread: expressify(deleteThread),
  editCommentMessage: expressify(editCommentMessage),
  deleteCommentMessage: expressify(deleteCommentMessage),
  deleteOwnCommentMessage: expressify(deleteOwnCommentMessage),
}
