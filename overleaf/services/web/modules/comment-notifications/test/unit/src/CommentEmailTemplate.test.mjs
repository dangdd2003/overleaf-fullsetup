import { vi, describe, it, expect, beforeEach } from 'vitest'

const { mockEmailBuilder, mockSettings } = vi.hoisted(() => {
  return {
    mockEmailBuilder: {
      templates: {},
      NoCTAEmailTemplate: vi.fn(content => content),
      ctaTemplate: vi.fn(content => content),
    },
    mockSettings: {
      siteUrl: 'http://localhost',
      appName: 'Overleaf',
    },
  }
})

vi.mock('../../../../../app/src/Features/Email/EmailBuilder.mjs', () => ({
  default: mockEmailBuilder,
}))
vi.mock('@overleaf/settings', () => ({ default: mockSettings }))

describe('CommentEmailTemplate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Clear any previously registered template
    delete mockEmailBuilder.templates.commentDigest
  })

  it('registers commentDigest template in EmailBuilder.templates', async () => {
    await import('../../../app/src/CommentEmailTemplate.mjs')
    expect(mockEmailBuilder.templates.commentDigest).toBeDefined()
  })

  it('calls NoCTAEmailTemplate with subject, greeting, and message', async () => {
    await import('../../../app/src/CommentEmailTemplate.mjs')
    expect(mockEmailBuilder.NoCTAEmailTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.any(Function),
        greeting: expect.any(Function),
        message: expect.any(Function),
      })
    )
  })

  it('subject includes project name and mention flag', async () => {
    await import('../../../app/src/CommentEmailTemplate.mjs')
    const content = mockEmailBuilder.NoCTAEmailTemplate.mock.calls[0][0]

    const mentionSubject = content.subject({
      projectName: 'My Paper',
      hasMention: true,
    })
    expect(mentionSubject).toContain('My Paper')
    expect(mentionSubject).toContain('mentioned')

    const replySubject = content.subject({
      projectName: 'My Paper',
      hasMention: false,
    })
    expect(replySubject).toContain('My Paper')
    expect(replySubject).toContain('comment')
  })

  it('greeting uses recipientName', async () => {
    await import('../../../app/src/CommentEmailTemplate.mjs')
    const content = mockEmailBuilder.NoCTAEmailTemplate.mock.calls[0][0]
    expect(content.greeting({ recipientName: 'Bob' })).toContain('Bob')
  })

  it('message lists each comment with author name and content', async () => {
    await import('../../../app/src/CommentEmailTemplate.mjs')
    const content = mockEmailBuilder.NoCTAEmailTemplate.mock.calls[0][0]
    const opts = {
      projectName: 'Paper',
      projectUrl: 'http://localhost/project/p1',
      comments: [
        { authorName: 'Jane', content: 'Great work!', isMention: false },
        { authorName: 'Bob', content: 'Fix this', isMention: true },
      ],
    }
    const lines = content.message(opts)
    expect(lines.length).toBeGreaterThanOrEqual(1)
    const joined = lines.join(' ')
    expect(joined).toContain('Jane')
    expect(joined).toContain('Great work!')
    expect(joined).toContain('Bob')
    expect(joined).toContain('Fix this')
  })

  it('escapes HTML in project name, author name, and comment content', async () => {
    await import('../../../app/src/CommentEmailTemplate.mjs')
    const content = mockEmailBuilder.NoCTAEmailTemplate.mock.calls[0][0]
    const opts = {
      projectName: '<script>alert(1)</script>',
      projectUrl: 'http://localhost/project/p1',
      comments: [
        {
          authorName: '<img src=x onerror=alert(1)>',
          content: 'Hello <b>world</b> <script>',
          isMention: false,
        },
      ],
    }
    const lines = content.message(opts)
    const joined = lines.join(' ')
    expect(joined).not.toContain('<script>')
    expect(joined).toContain('&lt;script&gt;')
    expect(joined).not.toContain('<img src=x')
    expect(joined).toContain('&lt;img src=x')
    expect(joined).not.toContain('<b>world</b>')
    expect(joined).toContain('&lt;b&gt;world&lt;/b&gt;')
  })
})
