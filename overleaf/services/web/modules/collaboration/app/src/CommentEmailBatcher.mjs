import EmailHandler from '../../../../app/src/Features/Email/EmailHandler.mjs'
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'

const DEBOUNCE_MS = parseInt(
  process.env.COMMENT_MENTION_DELAY_MS || '300000',
  10
) // 5 minutes default
const MAX_DELAY_MS = 15 * 60 * 1000 // 15 minutes ceiling

const queues = new Map()

function getQueueKey(userId, projectId) {
  return `${userId}:${projectId}`
}

function queueCommentNotification(
  recipient,
  project,
  author,
  threadId,
  content,
  isMention
) {
  const recipientId = recipient?._id?.toString() || recipient?.toString() || ''
  const projectId = project?._id?.toString() || project?.toString() || ''
  const key = getQueueKey(recipientId, projectId)
  const now = Date.now()

  let entry = queues.get(key)
  if (!entry) {
    entry = {
      recipient,
      project,
      comments: [],
      firstQueuedAt: now,
      timer: null,
    }
    queues.set(key, entry)
  }

  const authorName = author?.first_name
    ? `${author.first_name} ${author.last_name || ''}`.trim()
    : 'A collaborator'

  entry.comments.push({
    authorName,
    content,
    isMention: !!isMention,
    timestamp: now,
  })

  if (entry.timer) {
    clearTimeout(entry.timer)
  }

  const elapsed = now - entry.firstQueuedAt
  const remainingUntilMax = Math.max(0, MAX_DELAY_MS - elapsed)
  const delay = Math.min(DEBOUNCE_MS, remainingUntilMax)

  entry.timer = setTimeout(() => {
    flushQueue(recipientId, projectId).catch(err => {
      logger.error(
        { err, userId: recipientId, projectId },
        'failed to flush comment email digest'
      )
    })
  }, delay)
}

async function flushQueue(userId, projectId) {
  const key = getQueueKey(userId, projectId)
  const entry = queues.get(key)
  if (!entry || entry.comments.length === 0) {
    queues.delete(key)
    return
  }

  queues.delete(key)
  if (entry.timer) {
    clearTimeout(entry.timer)
  }

  const { recipient, project, comments } = entry
  if (!recipient.email) return

  const hasMention = comments.some(c => c.isMention)
  const projectUrl = `${Settings.siteUrl}/project/${project._id}`
  const recipientName = recipient.first_name || 'there'

  EmailHandler.sendDeferredEmail(
    'commentDigest',
    {
      to: recipient.email,
      recipientName,
      projectName: project.name,
      projectUrl,
      comments,
      hasMention,
    },
    0
  )
}

export default {
  queueCommentNotification,
  flushQueue,
  _queues: queues,
  _getQueueKey: getQueueKey,
  _DEBOUNCE_MS: DEBOUNCE_MS,
  _MAX_DELAY_MS: MAX_DELAY_MS,
}
