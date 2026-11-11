import ProjectGetter from '../../../../app/src/Features/Project/ProjectGetter.mjs'
import ChatApiHandler from '../../../../app/src/Features/Chat/ChatApiHandler.mjs'
import UserGetter from '../../../../app/src/Features/User/UserGetter.mjs'
import NotificationsHandler from '../../../../app/src/Features/Notifications/NotificationsHandler.mjs'
import CommentEmailBatcher from './CommentEmailBatcher.mjs'
import { getUserProjectPreferences } from './NotificationPreferencesController.mjs'
import logger from '@overleaf/logger'
import { promiseMapWithLimit } from '@overleaf/promise-utils'

const MENTION_REGEX = /@\[([a-fA-F0-9]{24})\]/g
// Bounds the per-member preference lookups and per-recipient notification writes
const PREFERENCE_LOOKUP_CONCURRENCY = 10
const NOTIFICATION_CONCURRENCY = 10

export function extractMentions(content) {
  if (!content || typeof content !== 'string') return []
  const matches = []
  let match
  MENTION_REGEX.lastIndex = 0
  while ((match = MENTION_REGEX.exec(content)) !== null) {
    matches.push(match[1])
  }
  return [...new Set(matches)]
}

export async function resolveRecipients(
  projectId,
  threadId,
  authorId,
  content
) {
  const mentionedIds = extractMentions(content)
  const project = await ProjectGetter.promises.getProject(projectId)
  if (!project) return []

  const projectMemberIds = new Set(
    [
      project.owner_ref?.toString(),
      ...(project.collaberator_refs || []).map(r => r?.toString()),
      ...(project.readOnly_refs || []).map(r => r?.toString()),
      ...(project.reviewer_refs || []).map(r => r?.toString()),
    ].filter(Boolean)
  )

  const validMentionedIds = new Set(
    mentionedIds.filter(
      id => projectMemberIds.has(id) && id !== authorId?.toString()
    )
  )

  const participantIds = new Set()
  try {
    const thread = await ChatApiHandler.promises.getThread(projectId, threadId)
    if (thread && Array.isArray(thread.messages)) {
      thread.messages.forEach(msg => {
        const uid = msg.user_id?.toString()
        if (uid && uid !== authorId?.toString() && projectMemberIds.has(uid)) {
          participantIds.add(uid)
        }
      })
    }
  } catch (err) {
    logger.warn(
      { err, projectId, threadId },
      'failed to fetch thread participants'
    )
  }

  const allTargetIds = new Set([...validMentionedIds, ...participantIds])
  // Include project members as candidates so preferences like commentOnOwnProject
  // (for owner) or commentOnInvitedProject (for subscribers) are evaluated on new threads
  for (const memberId of projectMemberIds) {
    if (memberId && memberId !== authorId?.toString()) {
      allTargetIds.add(memberId)
    }
  }
  const targetIds = [...allTargetIds]
  const users = await UserGetter.promises.getUsers(targetIds, {
    _id: 1,
    email: 1,
    first_name: 1,
    last_name: 1,
    suspended: 1,
  })
  const usersById = new Map(users.map(user => [user._id.toString(), user]))

  const candidates = await promiseMapWithLimit(
    PREFERENCE_LOOKUP_CONCURRENCY,
    targetIds,
    async userId => {
      const user = usersById.get(userId)
      if (!user) return null
      const preferences = await getUserProjectPreferences(userId, projectId)
      return { userId, user, preferences }
    }
  )

  const recipients = []

  for (const candidate of candidates) {
    if (!candidate) continue
    const { userId, user, preferences } = candidate
    if (preferences && preferences.muteAllNotifications) continue

    const isMention = validMentionedIds.has(userId)

    if (!isMention && preferences) {
      const isOwner = project.owner_ref?.toString() === userId
      const isParticipant = participantIds.has(userId)

      if (isParticipant && !preferences.repliesOnParticipatingThread) {
        continue
      }
      if (isOwner && !preferences.commentOnOwnProject && !isParticipant) {
        continue
      }
      if (!isOwner && !preferences.commentOnInvitedProject && !isParticipant) {
        continue
      }
    }

    recipients.push({ user, isMention })
  }

  return recipients
}

export async function dispatchInAppNotification(
  recipient,
  project,
  author,
  threadId,
  content,
  isMention
) {
  const text = typeof content === 'string' ? content : content || ''
  const snippet = text.length > 120 ? text.slice(0, 117) + '...' : text
  const authorName = author?.first_name
    ? `${author.first_name} ${author.last_name || ''}`.trim()
    : 'A collaborator'

  const recipientId = recipient?._id?.toString() || recipient?.toString() || ''
  const projectId = project?._id?.toString() || project?.toString() || ''

  const messageOpts = {
    projectId,
    projectName: project?.name || '',
    threadId: threadId?.toString() || threadId,
    userName: authorName,
    commentSnippet: snippet,
    isMention: !!isMention,
  }

  const key = `project-comment-${projectId}-${threadId}-${recipientId}`
  const expiryDate = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString()

  try {
    await NotificationsHandler.promises.createNotification(
      recipientId,
      key,
      'notification_project_comment',
      messageOpts,
      expiryDate,
      true
    )
  } catch (err) {
    logger.warn(
      { err, recipientId },
      'failed to create in-app comment notification'
    )
  }
}

export async function handleCommentMessageSent({
  projectId,
  threadId,
  userId,
  content,
}) {
  const author = await UserGetter.promises.getUser(userId)
  const project = await ProjectGetter.promises.getProject(projectId)
  if (!author || !project) return

  const recipients = await resolveRecipients(
    projectId,
    threadId,
    userId,
    content
  )

  await promiseMapWithLimit(
    NOTIFICATION_CONCURRENCY,
    recipients,
    async ({ user: recipient, isMention }) => {
      // 1. In-app dashboard notification
      await dispatchInAppNotification(
        recipient,
        project,
        author,
        threadId,
        content,
        isMention
      )

      // 2. Batched email digest (debounced & deferred via Queue)
      try {
        await CommentEmailBatcher.queueCommentNotification(
          recipient,
          project,
          author,
          threadId,
          content,
          isMention
        )
      } catch (err) {
        // The comment is already persisted. An unavailable email queue must not
        // fail its response or prevent other recipients' in-app notifications.
        logger.warn(
          { err, projectId, threadId, recipientId: recipient._id.toString() },
          'failed to queue comment email notification'
        )
      }
    }
  )
}

export default {
  extractMentions,
  resolveRecipients,
  dispatchInAppNotification,
  handleCommentMessageSent,
}
