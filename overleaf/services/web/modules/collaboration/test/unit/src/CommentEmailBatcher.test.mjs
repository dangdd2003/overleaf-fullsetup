import { vi, describe, it, expect, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => {
  const client = { eval: vi.fn() }
  return {
    client,
    queue: {
      client,
      add: vi.fn(),
      on: vi.fn(),
      process: vi.fn(),
      close: vi.fn(),
    },
    settings: {
      enableCollaboration: true,
      redis: { web: { host: 'redis' } },
      siteUrl: 'https://example.com',
    },
    sendEmail: vi.fn(),
    getUser: vi.fn(),
    getProject: vi.fn(),
    recipients: vi.fn(),
    cleanup: vi.fn(),
    Queue: vi.fn(),
  }
})
vi.mock('bull', () => ({
  default: class {
    constructor(...args) {
      mocks.Queue(...args)
      return mocks.queue
    }
  },
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
  addRequiredCleanupHandlerBeforeDrainingConnections: mocks.cleanup,
}))
vi.mock('../../../app/src/CommentNotificationHandler.mjs', () => ({
  resolveRecipients: mocks.recipients,
}))

const comment = {
  authorId: 'author',
  threadId: 'thread',
  content: 'hello',
  isMention: false,
}
const recipient = {
  _id: 'recipient',
  email: 'new@example.com',
  first_name: 'Jane',
}
const project = { _id: 'project', name: 'Project' }
let batcher
beforeEach(async () => {
  vi.resetAllMocks()
  vi.resetModules()
  mocks.settings.enableCollaboration = true
  mocks.getUser.mockImplementation(async (id) =>
    id === 'recipient' ? recipient : { _id: 'author', first_name: 'Alice' }
  )
  mocks.getProject.mockResolvedValue(project)
  mocks.recipients.mockResolvedValue([{ user: recipient }])
  mocks.client.eval.mockResolvedValue(['ready', JSON.stringify(comment)])
  batcher = (await import('../../../app/src/CommentEmailBatcher.mjs')).default
})

describe('durable comment digest worker', () => {
  it('creates no queue or worker while disabled', async () => {
    mocks.settings.enableCollaboration = false
    batcher.start()
    await batcher.queueCommentNotification(
      recipient,
      project,
      { _id: 'author' },
      'thread',
      'hello',
      false
    )
    expect(mocks.Queue).not.toHaveBeenCalled()
    expect(mocks.client.eval).not.toHaveBeenCalled()
  })

  it('durably schedules a wake-up before accepting batch contents', async () => {
    await batcher.queueCommentNotification(
      recipient,
      project,
      { _id: 'author' },
      'thread',
      'hello',
      false
    )
    expect(mocks.queue.add).toHaveBeenCalledWith(
      { userId: 'recipient', projectId: 'project' },
      { delay: 300000 }
    )
    expect(mocks.queue.add.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.client.eval.mock.invocationCallOrder[0]
    )
    expect(mocks.client.eval).toHaveBeenCalledWith(
      expect.stringContaining('HSETNX'),
      2,
      expect.stringContaining(':clock'),
      expect.stringContaining(':pending'),
      expect.stringContaining('hello')
    )
    expect(mocks.cleanup).toHaveBeenCalledOnce()
  })

  it('does not accept batch contents if durable job creation fails', async () => {
    mocks.queue.add.mockRejectedValueOnce(new Error('redis offline'))
    await expect(
      batcher.queueCommentNotification(
        recipient,
        project,
        { _id: 'author' },
        'thread',
        'hello',
        false
      )
    ).to.be.rejectedWith('redis offline')
    expect(mocks.client.eval).not.toHaveBeenCalled()
  })

  it('uses the shared debounce deadline supplied by Redis', async () => {
    mocks.client.eval.mockResolvedValueOnce(['waiting', '12345'])
    await batcher.flushQueue('recipient', 'project')
    expect(mocks.queue.add).toHaveBeenCalledWith(
      { userId: 'recipient', projectId: 'project' },
      { delay: 12345 }
    )
    expect(mocks.sendEmail).not.toHaveBeenCalled()
  })

  it('recovers persisted batches in a new module instance and uses current address', async () => {
    batcher.start()
    vi.resetModules()
    const restarted = (await import('../../../app/src/CommentEmailBatcher.mjs'))
      .default
    await restarted.flushQueue('recipient', 'project')
    expect(mocks.sendEmail).toHaveBeenCalledWith(
      'commentDigest',
      expect.objectContaining({
        to: 'new@example.com',
        comments: [
          expect.objectContaining({ content: 'hello', authorName: 'Alice' }),
        ],
      })
    )
    expect(mocks.client.eval).toHaveBeenLastCalledWith(
      expect.any(String),
      3,
      expect.stringContaining(':lease'),
      expect.stringContaining(':sending'),
      expect.stringContaining(':pending'),
      expect.any(String),
      'complete'
    )
  })

  it('retains the frozen batch on SMTP failure for Bull retry', async () => {
    mocks.sendEmail.mockRejectedValueOnce(new Error('smtp offline'))
    await expect(batcher.flushQueue('recipient', 'project')).to.be.rejectedWith(
      'smtp offline'
    )
    expect(mocks.client.eval).toHaveBeenLastCalledWith(
      expect.any(String),
      3,
      expect.stringContaining(':lease'),
      expect.stringContaining(':sending'),
      expect.stringContaining(':pending'),
      expect.any(String),
      'retry'
    )
    await batcher.flushQueue('recipient', 'project')
    expect(mocks.sendEmail).toHaveBeenCalledTimes(2)
  })

  it('schedules pending comments after delivering a retained frozen batch', async () => {
    mocks.client.eval
      .mockResolvedValueOnce(['ready', JSON.stringify(comment)])
      .mockResolvedValueOnce(1)
    await batcher.flushQueue('recipient', 'project')
    expect(mocks.sendEmail).toHaveBeenCalledOnce()
    expect(mocks.queue.add).toHaveBeenCalledWith({
      userId: 'recipient', projectId: 'project',
    })
  })

  it('fails the wake-up for Bull retry if scheduling the pending batch fails', async () => {
    mocks.client.eval
      .mockResolvedValueOnce(['ready', JSON.stringify(comment)])
      .mockResolvedValueOnce(1)
    mocks.queue.add.mockRejectedValueOnce(new Error('queue unavailable'))
    await expect(batcher.flushQueue('recipient', 'project')).to.be.rejectedWith(
      'queue unavailable'
    )
  })

  it('does not schedule another job when no pending batch remains', async () => {
    mocks.client.eval
      .mockResolvedValueOnce(['ready', JSON.stringify(comment)])
      .mockResolvedValueOnce(0)
    await batcher.flushQueue('recipient', 'project')
    expect(mocks.queue.add).not.toHaveBeenCalled()
  })

  it.each(['removed', 'muted'])(
    'discards delivery for a currently %s recipient',
    async () => {
      mocks.recipients.mockResolvedValue([])
      await batcher.flushQueue('recipient', 'project')
      expect(mocks.sendEmail).not.toHaveBeenCalled()
    }
  )

  it('discards delivery to a deleted or suspended account', async () => {
    mocks.getUser.mockResolvedValue(null)
    await batcher.flushQueue('recipient', 'project')
    expect(mocks.sendEmail).not.toHaveBeenCalled()
  })

  it('does not concurrently send a batch leased by another process', async () => {
    mocks.client.eval.mockResolvedValueOnce(['busy'])
    await expect(batcher.flushQueue('recipient', 'project')).to.be.rejectedWith(
      'leased'
    )
    expect(mocks.sendEmail).not.toHaveBeenCalled()
  })
})
