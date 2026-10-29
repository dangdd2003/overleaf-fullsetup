import { vi, describe, it, expect } from 'vitest'

const mocks = vi.hoisted(() => ({
  settings: {
    enableCollaboration: true,
    redis: {
      web: {
        host: process.env.COMMENT_DIGEST_TEST_REDIS_HOST,
        port: 6379,
        db: 13,
      },
    },
    siteUrl: 'https://example.com',
  },
  sendEmail: vi.fn(),
  getUser: vi.fn(),
  getProject: vi.fn(),
  recipients: vi.fn(),
}))
vi.mock('@overleaf/settings', () => ({ default: mocks.settings }))
vi.mock('@overleaf/logger', () => ({ default: { error: vi.fn() } }))
vi.mock('../../../../../app/src/Features/Email/EmailHandler.mjs', () => ({
  default: { promises: { sendEmail: mocks.sendEmail } },
}))
vi.mock('../../../../../app/src/Features/User/UserGetter.mjs', () => ({
  default: { promises: { getUser: mocks.getUser } },
}))
vi.mock('../../../../../app/src/Features/Project/ProjectGetter.mjs', () => ({
  default: { promises: { getProject: mocks.getProject } },
}))
vi.mock('../../../../../app/src/infrastructure/GracefulShutdown.mjs', () => ({
  addRequiredCleanupHandlerBeforeDrainingConnections: vi.fn(),
}))
vi.mock('../../../app/src/CommentNotificationHandler.mjs', () => ({
  resolveRecipients: mocks.recipients,
}))

// Opt in against disposable Redis only; this suite clears DB 13.
describe.skipIf(!process.env.COMMENT_DIGEST_TEST_REDIS_HOST)(
  'real Redis/Bull digest recovery',
  () => {
    it.each([false, true])(
      'drains pending comments after retry exhaustion (follow-up scheduling failure: %s)',
      async (failFollowUp) => {
        vi.resetAllMocks()
        vi.resetModules()
        const batcher = (
          await import('../../../app/src/CommentEmailBatcher.mjs')
        ).default
        const queue = batcher.start()
        await queue.pause(true)
        const client = await queue.client
        await client.flushdb()
        // Exercise Bull's real retry exhaustion without waiting for SMTP backoff.
        queue.defaultJobOptions.attempts = 2
        queue.defaultJobOptions.backoff = { type: 'fixed', delay: 1 }
        const recipient = { _id: 'recipient', email: 'current@example.com' }
        const project = { _id: 'project', name: 'Project' }
        const author = { _id: 'author', first_name: 'Alice' }
        mocks.getUser.mockImplementation(async (id) =>
          id === 'recipient' ? recipient : author
        )
        mocks.getProject.mockResolvedValue(project)
        mocks.recipients.mockResolvedValue([{ user: recipient }])
        const prefix = 'collaboration:comment-digest:{recipient:project}'
        const clockKey = `${prefix}:clock`
        const pendingKey = `${prefix}:pending`
        const sendingKey = `${prefix}:sending`
        const makeDue = async () => {
          const [seconds, micros] = await client.time()
          const now = Number(seconds) * 1000 + Math.floor(Number(micros) / 1000)
          await client.hset(
            clockKey,
            'first',
            now - 901000,
            'last',
            now - 301000
          )
        }
        try {
          mocks.sendEmail.mockRejectedValue(new Error('SMTP unavailable'))
          await batcher.queueCommentNotification(
            recipient,
            project,
            author,
            'thread',
            'old',
            false
          )
          await makeDue()
          const [oldJob] = await queue.getDelayed()
          const exhausted = new Promise((resolve) => {
            const onFailed = (job) => {
              if (job.id === oldJob.id && job.attemptsMade === 2) {
                queue.removeListener('failed', onFailed)
                resolve()
              }
            }
            queue.on('failed', onFailed)
          })
          await oldJob.promote()
          await queue.resume(true)
          await exhausted
          await queue.pause(true)
          expect(mocks.sendEmail).toHaveBeenCalledTimes(2)
          expect(await oldJob.getState()).toBe('failed')
          expect(await client.llen(sendingKey)).toBe(1)
          expect(await queue.getDelayed()).toHaveLength(0)
          expect(await queue.getWaiting()).toHaveLength(0)

          mocks.sendEmail.mockReset().mockResolvedValue()
          await batcher.queueCommentNotification(
            recipient,
            project,
            author,
            'thread',
            'new',
            false
          )
          await makeDue()
          const jobs = await queue.getDelayed()
          expect(jobs).toHaveLength(1)
          const add = vi.spyOn(queue, 'add')
          if (failFollowUp)
            add.mockRejectedValueOnce(new Error('temporary enqueue failure'))
          const failures = []
          queue.on('failed', (job) => failures.push(job.id))
          const drained = new Promise((resolve) => {
            const onCompleted = () => {
              if (mocks.sendEmail.mock.calls.length === 2) {
                queue.removeListener('completed', onCompleted)
                resolve()
              }
            }
            queue.on('completed', onCompleted)
          })
          await jobs[0].promote()
          await queue.resume(true)
          await drained
          await queue.pause(true)
          expect(
            mocks.sendEmail.mock.calls.map(([, opts]) =>
              opts.comments.map((c) => c.content)
            )
          ).toEqual([['old'], ['new']])
          expect(await client.exists(sendingKey)).toBe(0)
          expect(await client.exists(pendingKey)).toBe(0)
          expect(await queue.getDelayed()).toHaveLength(0)
          expect(await queue.getWaiting()).toHaveLength(0)
          expect(add).toHaveBeenCalledWith({
            userId: 'recipient',
            projectId: 'project',
          })
          expect(failures).toEqual(failFollowUp ? [jobs[0].id] : [])
          add.mockRestore()
        } finally {
          await queue.pause(true)
          await client.flushdb()
          await queue.close()
        }
      },
      20000
    )

    it('recovers queued comments after worker restart and SMTP failure, with shared debounce and max delay', async () => {
      vi.resetAllMocks()
      vi.resetModules()
      const {
        default: first,
        APPEND_BATCH,
        CLAIM_BATCH,
      } = await import('../../../app/src/CommentEmailBatcher.mjs')
      const oldQueue = first.start()
      await oldQueue.pause(true)
      const client = await oldQueue.client
      await client.flushdb()
      const recipient = { _id: 'recipient', email: 'current@example.com' }
      const project = { _id: 'project', name: 'Project' }
      const author = { _id: 'author', first_name: 'Alice' }
      mocks.getUser.mockImplementation(async (id) =>
        id === 'recipient' ? recipient : author
      )
      mocks.getProject.mockResolvedValue(project)
      mocks.recipients.mockResolvedValue([{ user: recipient }])
      const prefix = 'collaboration:comment-digest:{recipient:project}'
      const keys = [
        `${prefix}:clock`,
        `${prefix}:pending`,
        `${prefix}:sending`,
        `${prefix}:lease`,
      ]
      let newQueue
      try {
        await first.queueCommentNotification(
          recipient,
          project,
          author,
          'thread',
          'first',
          false
        )
        await first.queueCommentNotification(
          recipient,
          project,
          author,
          'thread',
          'second',
          true
        )
        expect(await client.llen(keys[1])).toBe(2)
        const waiting = await client.eval(
          CLAIM_BATCH,
          4,
          ...keys,
          'probe',
          300000,
          900000,
          120000
        )
        expect(waiting[0]).toBe('waiting')
        expect(Number(waiting[1])).toBeGreaterThan(290000)
        // The max delay wins even if the most recent comment is fresh.
        const clock = await client.time()
        const now =
          Number(clock[0]) * 1000 + Math.floor(Number(clock[1]) / 1000)
        await client.hset(keys[0], 'first', now - 901000)
        const claimed = await client.eval(
          CLAIM_BATCH,
          4,
          ...keys,
          'probe',
          300000,
          900000,
          120000
        )
        expect(claimed[0]).toBe('ready')
        expect(claimed).toHaveLength(3)
        // Simulate a crashed claimant; its frozen batch survives lease expiry.
        await client.del(keys[3])
        await oldQueue.close()
        vi.resetModules()
        const restarted = (
          await import('../../../app/src/CommentEmailBatcher.mjs')
        ).default
        newQueue = restarted.start()
        mocks.sendEmail.mockRejectedValueOnce(new Error('smtp offline'))
        await expect(
          restarted.flushQueue('recipient', 'project')
        ).to.be.rejectedWith('smtp offline')
        const restoredClient = await newQueue.client
        expect(await restoredClient.llen(keys[2])).toBe(2)
        const jobs = await newQueue.getDelayed()
        expect(jobs.length).toBeGreaterThan(0)
        const completed = new Promise((resolve) =>
          newQueue.once('completed', resolve)
        )
        await jobs[0].promote()
        await completed
        expect(mocks.sendEmail).toHaveBeenLastCalledWith(
          'commentDigest',
          expect.objectContaining({
            to: 'current@example.com',
            comments: [
              expect.objectContaining({ content: 'first' }),
              expect.objectContaining({ content: 'second' }),
            ],
          })
        )
        expect(await restoredClient.exists(keys[2])).toBe(0)
        await restoredClient.eval(
          APPEND_BATCH,
          2,
          keys[0],
          keys[1],
          JSON.stringify({ content: 'third' })
        )
        expect(await restoredClient.llen(keys[1])).toBe(1)
      } finally {
        if (newQueue) {
          await (await newQueue.client).flushdb()
          await newQueue.close()
        } else {
          await oldQueue.close()
        }
      }
    }, 20000)
  }
)
