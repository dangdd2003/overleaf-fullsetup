import crypto from 'node:crypto'
import Queue from 'bull'
import EmailHandler from '../../../../app/src/Features/Email/EmailHandler.mjs'
import UserGetter from '../../../../app/src/Features/User/UserGetter.mjs'
import ProjectGetter from '../../../../app/src/Features/Project/ProjectGetter.mjs'
import { addRequiredCleanupHandlerBeforeDrainingConnections } from '../../../../app/src/infrastructure/GracefulShutdown.mjs'
import { resolveRecipients } from './CommentNotificationHandler.mjs'
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'

const DEBOUNCE_MS = 5 * 60 * 1000
const MAX_DELAY_MS = 15 * 60 * 1000
const LEASE_MS = 2 * 60 * 1000
let queue

// Redis owns both the debounce clock and the batches. Each accepted comment
// already has a durable Bull wake-up job before it is appended to the batch.
export const APPEND_BATCH = `
local clock = redis.call('TIME')
local now = clock[1] * 1000 + math.floor(clock[2] / 1000)
redis.call('HSETNX', KEYS[1], 'first', now)
redis.call('HSET', KEYS[1], 'last', now)
return redis.call('RPUSH', KEYS[2], ARGV[1])
`

export const CLAIM_BATCH = `
if redis.call('EXISTS', KEYS[4]) == 1 then return {'busy'} end
if redis.call('EXISTS', KEYS[3]) == 0 then
  local first = tonumber(redis.call('HGET', KEYS[1], 'first'))
  if not first then return {'empty'} end
  local last = tonumber(redis.call('HGET', KEYS[1], 'last'))
  local clock = redis.call('TIME')
  local now = clock[1] * 1000 + math.floor(clock[2] / 1000)
  local remaining = math.min(last + tonumber(ARGV[2]), first + tonumber(ARGV[3])) - now
  if remaining > 0 then return {'waiting', tostring(remaining)} end
  redis.call('RENAME', KEYS[2], KEYS[3])
  redis.call('DEL', KEYS[1])
end
redis.call('SET', KEYS[4], ARGV[1], 'PX', ARGV[4])
local result = redis.call('LRANGE', KEYS[3], 0, -1)
table.insert(result, 1, 'ready')
return result
`

const RELEASE_LEASE = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if ARGV[2] == 'complete' then redis.call('DEL', KEYS[2]) end
redis.call('DEL', KEYS[1])
if ARGV[2] == 'complete' then return redis.call('LLEN', KEYS[3]) end
return 0
`
const RENEW_LEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`

function batchKeys(userId, projectId) {
  const prefix = `collaboration:comment-digest:{${userId}:${projectId}}`
  return [
    `${prefix}:clock`,
    `${prefix}:pending`,
    `${prefix}:sending`,
    `${prefix}:lease`,
  ]
}

function start() {
  if (!Settings.enableCollaboration || queue) return queue
  // Upstream's deferred-email queues are SaaS-only. This module owns its CE
  // worker and uses the instance's existing Redis connection settings.
  queue = new Queue('collaboration-comment-digests', {
    redis: Settings.redis.queues || Settings.redis.web,
    defaultJobOptions: {
      attempts: 11,
      backoff: { type: 'exponential', delay: 3000 },
      removeOnComplete: true,
      removeOnFail: 10000,
    },
  })
  queue.on('error', (err) =>
    logger.error({ err }, 'comment digest queue error')
  )
  queue.process((job) => flushQueue(job.data.userId, job.data.projectId))
  addRequiredCleanupHandlerBeforeDrainingConnections('comment digests', () =>
    queue.close()
  )
  return queue
}

async function queueCommentNotification(
  recipient,
  project,
  author,
  threadId,
  content,
  isMention
) {
  const digestQueue = start()
  if (!digestQueue) return
  const userId = recipient._id.toString()
  const projectId = project._id.toString()
  await digestQueue.add({ userId, projectId }, { delay: DEBOUNCE_MS })
  const client = await digestQueue.client
  const [clockKey, pendingKey] = batchKeys(userId, projectId)
  await client.eval(
    APPEND_BATCH,
    2,
    clockKey,
    pendingKey,
    JSON.stringify({
      authorId: author._id.toString(),
      threadId,
      content,
      isMention: !!isMention,
      timestamp: Date.now(),
    })
  )
}

async function flushQueue(userId, projectId) {
  const digestQueue = start()
  if (!digestQueue) return
  const client = await digestQueue.client
  const keys = batchKeys(userId, projectId)
  const token = crypto.randomUUID()
  const [status, ...values] = await client.eval(
    CLAIM_BATCH,
    4,
    ...keys,
    token,
    DEBOUNCE_MS,
    MAX_DELAY_MS,
    LEASE_MS
  )
  if (status === 'empty') return
  if (status === 'busy') throw new Error('comment digest batch is leased')
  if (status === 'waiting') {
    await digestQueue.add({ userId, projectId }, { delay: Number(values[0]) })
    return
  }
  const renewal = setInterval(() => {
    client.eval(RENEW_LEASE, 1, keys[3], token, LEASE_MS).catch((err) => {
      logger.error({ err }, 'failed to renew comment digest lease')
    })
  }, LEASE_MS / 3)
  renewal.unref()
  let complete = false
  try {
    const [recipient, project] = await Promise.all([
      UserGetter.promises.getUser(userId),
      ProjectGetter.promises.getProject(projectId),
    ])
    if (recipient?.email && !recipient.suspended && project) {
      const comments = []
      for (const raw of values) {
        const comment = JSON.parse(raw)
        // Re-evaluate membership, mute/preferences, and current thread state
        // at delivery time; an address captured at enqueue is never used.
        const eligible = await resolveRecipients(
          projectId,
          comment.threadId,
          comment.authorId,
          comment.content
        )
        if (!eligible.some((entry) => entry.user._id.toString() === userId))
          continue
        const author = await UserGetter.promises.getUser(comment.authorId)
        comments.push({
          ...comment,
          authorName: author?.first_name
            ? `${author.first_name} ${author.last_name || ''}`.trim()
            : 'A collaborator',
        })
      }
      if (comments.length) {
        await EmailHandler.promises.sendEmail('commentDigest', {
          to: recipient.email,
          recipientName: recipient.first_name || 'there',
          projectName: project.name,
          projectUrl: `${Settings.siteUrl}/project/${project._id}`,
          comments,
          hasMention: comments.some((comment) => comment.isMention),
        })
      }
    }
    complete = true
  } finally {
    clearInterval(renewal)
    // Failed deliveries retain their frozen batch and Bull retries it. SMTP
    // acceptance followed by a crash can still duplicate mail (at least once).
    const pending = await client.eval(
      RELEASE_LEASE,
      3,
      keys[3],
      keys[2],
      keys[1],
      token,
      complete ? 'complete' : 'retry'
    )
    // This wake-up may have been the only remaining job, and it can have
    // delivered a retained batch whose earlier jobs exhausted their retries.
    // Keep pending comments runnable before acknowledging this job. The next
    // claim applies their shared debounce/max-delay deadline as usual. If job
    // creation fails, Bull retries this job against the still-pending batch.
    if (complete && pending > 0) {
      await digestQueue.add({ userId, projectId })
    }
  }
}

export default { start, queueCommentNotification, flushQueue }
