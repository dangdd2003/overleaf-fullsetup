# Review Panel, @Mentions & Comment Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable the in-editor Review Panel (threaded comments, `@mentions`, resolve/reopen) and implement a dual-channel notification pipeline (In-App Dashboard alerts + Batched Email Digests) in Overleaf Community Edition (CE).

**Architecture:** 
1. Enable `trackChangesAvailable: true` in `ProjectEditorHandler.mjs` so the built-in React Review Panel & CodeMirror comment extensions mount in the editor.
2. Expose comment thread REST endpoints in `webRouter` (`router.mjs`) and proxy operations via `ChatController.mjs` to `services/chat`.
3. Build `CommentNotificationHandler.mjs` to parse `@[userId]` mentions, resolve recipient audiences based on project preferences, and dispatch in-app banners via `NotificationsHandler` (`services/notifications`).
4. Build `CommentEmailBatcher.mjs` and `new_comments_digest.pug` to aggregate comment notifications within a 5-minute debounce window and deliver email digests via `EmailHandler` / SMTP.

**Tech Stack:** Node.js (ESM), Express, MongoDB, Redis, WebSockets / Socket.io, React, CodeMirror 6, Pug, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-30-comment-notifications-design.md`

## Global Constraints
- Target platform is Overleaf Community Edition (CE).
- Mention token format is `@[<24_char_hex_user_id>]`.
- In-app notifications use `templateKey: 'notification_project_comment'`.
- Email batching uses a 5-minute debounce window (`notificationMinDelay: 300000` ms) and 15-minute max ceiling.
- Git actions are reserved for the user (do not commit without explicit instruction).

---

### Task 1: Enable Review Panel & Comments in Frontend Editor

**Files:**
- Modify: `overleaf/services/web/app/src/Features/Project/ProjectEditorHandler.mjs:5-60`
- Test: `overleaf/services/web/test/unit/src/Project/ProjectEditorHandler.test.mjs`

**Interfaces:**
- Produces: `features.trackChangesVisible: true` in `ProjectEditorHandler.buildProjectModelView()`.

- [ ] **Step 1: Write unit test verifying `trackChangesVisible` is true by default**

In `overleaf/services/web/test/unit/src/Project/ProjectEditorHandler.test.mjs`:
```javascript
it('should set trackChangesVisible to true by default', function () {
  const result = ProjectEditorHandler.buildProjectModelView(
    project,
    ownerMember,
    members,
    invites,
    false
  )
  expect(result.features.trackChangesVisible).to.equal(true)
  expect(result.features.trackChanges).to.equal(false)
})
```

- [ ] **Step 2: Update `ProjectEditorHandler.mjs` to enable `trackChangesAvailable`**

In `overleaf/services/web/app/src/Features/Project/ProjectEditorHandler.mjs`:
Change line 6:
```javascript
export default ProjectEditorHandler = {
  trackChangesAvailable: true,
```
Ensure `trackChangesVisible` receives `ProjectEditorHandler.trackChangesAvailable` in `buildProjectModelView`.

- [ ] **Step 3: Verify frontend editor components mount**

Confirm that `features.trackChangesVisible` propagates to `ReviewPanelProviders.tsx` and mounts `<ReviewPanelRoot />` and `<ReviewTooltipMenu />`.

---

### Task 2: Expose Thread & Comment REST Endpoints in Web API

**Files:**
- Modify: `overleaf/services/web/app/src/Features/Chat/ChatController.mjs`
- Modify: `overleaf/services/web/app/src/router.mjs`
- Test: `overleaf/services/web/test/unit/src/Chat/ChatController.test.mjs`

**Interfaces:**
- Consumes: `ChatApiHandler.promises` (`getThreads`, `getThread`, `sendComment`, `resolveThread`, `reopenThread`, `deleteThread`, `editMessage`, `deleteMessage`)
- Produces:
  - `ChatController.getThreads`
  - `ChatController.getThread`
  - `ChatController.sendComment`
  - `ChatController.resolveThread`
  - `ChatController.reopenThread`
  - `ChatController.deleteThread`
  - `ChatController.editCommentMessage`
  - `ChatController.deleteCommentMessage`
  - WebSocket events: `'new-comment-message'`, `'resolve-thread'`, `'reopen-thread'`, `'delete-thread'`
  - Hook: `Modules.promises.hooks.fire('commentMessageSent', { projectId, threadId, userId, content, messageId })`

- [ ] **Step 1: Write unit tests for ChatController comment thread methods**

In `overleaf/services/web/test/unit/src/Chat/ChatController.test.mjs`:
```javascript
describe('sendComment', function () {
  it('should call ChatApiHandler.sendComment, emit real-time event, and fire hook', async function (ctx) {
    const req = {
      params: { project_id: 'proj-123', thread_id: 'thread-456' },
      body: { content: 'Please review this equation @[mock-user-2]', client_id: 'client-1' },
      session: { user: { _id: 'mock-user-1' } }
    }
    const res = { sendStatus: sinon.stub(), json: sinon.stub() }
    ctx.ChatApiHandler.promises.sendComment = sinon.stub().resolves({ id: 'msg-1', content: req.body.content, user_id: 'mock-user-1' })
    ctx.UserInfoManager.promises.getPersonalInfo = sinon.stub().resolves({ first_name: 'John', last_name: 'Doe' })

    await ChatController.sendComment(req, res)

    ctx.ChatApiHandler.promises.sendComment.calledWith('proj-123', 'thread-456', 'mock-user-1', req.body.content).should.equal(true)
    ctx.EditorRealTimeController.emitToRoom.calledWith('proj-123', 'new-comment-message').should.equal(true)
    ctx.Modules.promises.hooks.fire.calledWith('commentMessageSent').should.equal(true)
    res.json.called.should.equal(true)
  })
})
```

- [ ] **Step 2: Implement thread methods in `ChatController.mjs`**

Add the following methods to `overleaf/services/web/app/src/Features/Chat/ChatController.mjs`:
```javascript
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
  EditorRealTimeController.emitToRoom(projectId, 'new-comment-message', {
    threadId,
    message,
  })

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
  EditorRealTimeController.emitToRoom(projectId, 'resolve-thread', {
    threadId,
    userId,
  })
  res.sendStatus(204)
}

async function reopenThread(req, res) {
  const { project_id: projectId, thread_id: threadId } = req.params
  await ChatApiHandler.promises.reopenThread(projectId, threadId)
  EditorRealTimeController.emitToRoom(projectId, 'reopen-thread', {
    threadId,
  })
  res.sendStatus(204)
}

async function deleteThread(req, res) {
  const { project_id: projectId, thread_id: threadId } = req.params
  await ChatApiHandler.promises.deleteThread(projectId, threadId)
  EditorRealTimeController.emitToRoom(projectId, 'delete-thread', {
    threadId,
  })
  res.sendStatus(204)
}
```

- [ ] **Step 3: Register REST routes in `overleaf/services/web/app/src/router.mjs`**

Under `if (Features.hasFeature('chat'))` in `router.mjs`, register:
```javascript
webRouter.get(
  '/project/:project_id/threads',
  AuthorizationMiddleware.blockRestrictedUserFromProject,
  AuthorizationMiddleware.ensureUserCanReadProject,
  PermissionsController.requirePermission('chat'),
  ChatController.getThreads
)
webRouter.get(
  '/project/:project_id/thread/:thread_id',
  AuthorizationMiddleware.blockRestrictedUserFromProject,
  AuthorizationMiddleware.ensureUserCanReadProject,
  PermissionsController.requirePermission('chat'),
  ChatController.getThread
)
webRouter.post(
  '/project/:project_id/thread/:thread_id/messages',
  AuthorizationMiddleware.blockRestrictedUserFromProject,
  AuthorizationMiddleware.ensureUserCanWriteProjectCustom(
    PermissionsController.requirePermission('comment')
  ),
  RateLimiterMiddleware.rateLimit(rateLimiters.sendChatMessage),
  ChatController.sendComment
)
webRouter.post(
  '/project/:project_id/thread/:thread_id/resolve',
  AuthorizationMiddleware.blockRestrictedUserFromProject,
  AuthorizationMiddleware.ensureUserCanWriteProjectCustom(
    PermissionsController.requirePermission('comment')
  ),
  ChatController.resolveThread
)
webRouter.post(
  '/project/:project_id/thread/:thread_id/reopen',
  AuthorizationMiddleware.blockRestrictedUserFromProject,
  AuthorizationMiddleware.ensureUserCanWriteProjectCustom(
    PermissionsController.requirePermission('comment')
  ),
  ChatController.reopenThread
)
webRouter.delete(
  '/project/:project_id/thread/:thread_id',
  AuthorizationMiddleware.blockRestrictedUserFromProject,
  AuthorizationMiddleware.ensureUserCanWriteProjectCustom(
    PermissionsController.requirePermission('comment')
  ),
  ChatController.deleteThread
)
```

---

### Task 3: Implement Mention Parsing & Audience Resolution

**Files:**
- Create: `overleaf/services/web/app/src/Features/Comments/CommentNotificationHandler.mjs`
- Test: `overleaf/services/web/test/unit/src/Comments/CommentNotificationHandler.test.mjs`

**Interfaces:**
- Produces:
  - `CommentNotificationHandler.extractMentions(content: string): string[]`
  - `CommentNotificationHandler.resolveRecipients(projectId: string, threadId: string, authorId: string, content: string): Promise<Array<{ user: object, isMention: boolean }>>`

- [ ] **Step 1: Write unit tests for `CommentNotificationHandler`**

In `overleaf/services/web/test/unit/src/Comments/CommentNotificationHandler.test.mjs`:
```javascript
import { expect } from 'chai'
import CommentNotificationHandler from '../../../../app/src/Features/Comments/CommentNotificationHandler.mjs'

describe('CommentNotificationHandler', function () {
  describe('extractMentions', function () {
    it('should extract valid 24-char hex user IDs from content', function () {
      const content = 'Hello @[507f1f77bcf86cd799439011] and @[507f191e810c19729de860ea], please check this'
      const ids = CommentNotificationHandler.extractMentions(content)
      expect(ids).to.deep.equal([
        '507f1f77bcf86cd799439011',
        '507f191e810c19729de860ea',
      ])
    })

    it('should return empty array when no mentions exist', function () {
      const content = 'No mentions here @all or test@example.com'
      const ids = CommentNotificationHandler.extractMentions(content)
      expect(ids).to.deep.equal([])
    })
  })
})
```

- [ ] **Step 2: Implement `CommentNotificationHandler.mjs`**

In `overleaf/services/web/app/src/Features/Comments/CommentNotificationHandler.mjs`:
```javascript
import ProjectGetter from '../Project/ProjectGetter.mjs'
import ChatApiHandler from '../Chat/ChatApiHandler.mjs'
import UserGetter from '../User/UserGetter.mjs'
import logger from '@overleaf/logger'

const MENTION_REGEX = /@\[([a-fA-F0-9]{24})\]/g

function extractMentions(content) {
  if (!content || typeof content !== 'string') return []
  const matches = []
  let match
  while ((match = MENTION_REGEX.exec(content)) !== null) {
    matches.push(match[1])
  }
  return [...new Set(matches)]
}

async function resolveRecipients(projectId, threadId, authorId, content) {
  const mentionedIds = extractMentions(content)
  const project = await ProjectGetter.promises.getProjectWithoutDocLines(projectId)
  if (!project) return []

  const projectMemberIds = new Set([
    project.owner_ref?.toString(),
    ...(project.members || []).map(m => m.user_ref?.toString() || m._id?.toString()),
  ].filter(Boolean))

  const validMentionedIds = new Set(
    mentionedIds.filter(id => projectMemberIds.has(id) && id !== authorId.toString())
  )

  let participantIds = new Set()
  try {
    const thread = await ChatApiHandler.promises.getThread(projectId, threadId)
    if (thread && Array.isArray(thread.messages)) {
      thread.messages.forEach(msg => {
        const uid = msg.user_id?.toString()
        if (uid && uid !== authorId.toString() && projectMemberIds.has(uid)) {
          participantIds.add(uid)
        }
      })
    }
  } catch (err) {
    logger.warn({ err, projectId, threadId }, 'failed to fetch thread participants')
  }

  const allTargetIds = new Set([...validMentionedIds, ...participantIds])
  const recipients = []

  for (const userId of allTargetIds) {
    const user = await UserGetter.promises.getUser(userId)
    if (!user) continue

    const pref = user.project_preferences?.[projectId]?.notifications || 'replies'
    if (pref === 'off') continue

    const isMention = validMentionedIds.has(userId)
    recipients.push({ user, isMention })
  }

  return recipients
}

export default {
  extractMentions,
  resolveRecipients,
}
```

---

### Task 4: Implement In-App Dashboard Notification Dispatching

**Files:**
- Modify: `overleaf/services/web/app/src/Features/Comments/CommentNotificationHandler.mjs`
- Modify: `overleaf/services/web/frontend/js/features/project-list/components/notifications/groups/common.tsx`
- Test: `overleaf/services/web/test/unit/src/Comments/CommentNotificationHandler.test.mjs`

**Interfaces:**
- Produces:
  - `CommentNotificationHandler.dispatchInAppNotification(recipient, project, author, threadId, content, isMention)`
  - Renders `notification_project_comment` banner on `/project`

- [ ] **Step 1: Implement `dispatchInAppNotification` in `CommentNotificationHandler.mjs`**

In `overleaf/services/web/app/src/Features/Comments/CommentNotificationHandler.mjs`:
```javascript
import NotificationsHandler from '../Notifications/NotificationsHandler.mjs'

async function dispatchInAppNotification(recipient, project, author, threadId, content, isMention) {
  const snippet = content.length > 120 ? content.slice(0, 117) + '...' : content
  const authorName = author.first_name ? `${author.first_name} ${author.last_name || ''}`.trim() : 'A collaborator'

  const messageOpts = {
    projectId: project._id.toString(),
    projectName: project.name,
    threadId,
    userName: authorName,
    commentSnippet: snippet,
    isMention,
  }

  const key = `project-comment-${project._id}-${threadId}-${recipient._id}`
  const expiryDate = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString()

  try {
    await NotificationsHandler.promises.createNotification(
      recipient._id.toString(),
      key,
      'notification_project_comment',
      messageOpts,
      expiryDate,
      true
    )
  } catch (err) {
    logger.warn({ err, recipientId: recipient._id }, 'failed to create in-app comment notification')
  }
}
```

- [ ] **Step 2: Update `Common.tsx` to render `notification_project_comment` banner**

In `overleaf/services/web/frontend/js/features/project-list/components/notifications/groups/common.tsx`:
Handle `templateKey === 'notification_project_comment'`:
```tsx
) : templateKey === 'notification_project_comment' ? (
  <Notification
    type="info"
    onDismiss={() => id && handleDismiss(id)}
    title={
      notification.messageOpts.isMention
        ? `${notification.messageOpts.userName} mentioned you on ${notification.messageOpts.projectName}`
        : `${notification.messageOpts.userName} replied to a comment on ${notification.messageOpts.projectName}`
    }
    content={<p className="mb-0 italic">"{notification.messageOpts.commentSnippet}"</p>}
    action={
      <OLButton
        variant="secondary"
        href={`/project/${notification.messageOpts.projectId}`}
      >
        {t('open_project')}
      </OLButton>
    }
  />
)
```

---

### Task 5: Implement Email Digest Batching Engine & Pug Template

**Files:**
- Create: `overleaf/services/web/app/views/emails/new_comments_digest.pug`
- Create: `overleaf/services/web/app/src/Features/Comments/CommentEmailBatcher.mjs`
- Modify: `overleaf/services/web/app/src/Features/Comments/CommentNotificationHandler.mjs`
- Test: `overleaf/services/web/test/unit/src/Comments/CommentEmailBatcher.test.mjs`

**Interfaces:**
- Produces:
  - `CommentEmailBatcher.queueCommentNotification(recipient, project, author, threadId, content, isMention)`
  - `CommentEmailBatcher.flushQueue(recipientId, projectId)`

- [ ] **Step 1: Create Pug Email Template `new_comments_digest.pug`**

In `overleaf/services/web/app/views/emails/new_comments_digest.pug`:
```pug
extends layout

block content
  p Hello #{recipientName},
  p You have new comment activity on project 
    strong #{projectName}:

  div(style="margin: 20px 0; border-left: 3px solid #388e3c; padding-left: 12px;")
    each comment in comments
      p(style="margin-bottom: 4px;")
        strong #{comment.authorName} 
        span(style="color: #666; font-size: 12px;") (#{comment.formattedTime}):
      p(style="margin-top: 0; margin-bottom: 12px; font-style: italic;") "#{comment.content}"

  p
    a.btn(href=projectUrl, style="display: inline-block; padding: 10px 20px; background-color: #388e3c; color: #ffffff; text-decoration: none; border-radius: 4px;") View in Overleaf

  p
    small If you want to change your notification preferences for this project, you can update them in the project settings.
```

- [ ] **Step 2: Implement `CommentEmailBatcher.mjs`**

In `overleaf/services/web/app/src/Features/Comments/CommentEmailBatcher.mjs`:
```javascript
import EmailHandler from '../Email/EmailHandler.mjs'
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'

const DEBOUNCE_MS = parseInt(process.env.COMMENT_MENTION_DELAY_MS || '300000', 10) // 5 minutes default
const MAX_DELAY_MS = 15 * 60 * 1000 // 15 minutes ceiling

const queues = new Map()

function getQueueKey(userId, projectId) {
  return `${userId}:${projectId}`
}

function queueCommentNotification(recipient, project, author, threadId, content, isMention) {
  const key = getQueueKey(recipient._id, project._id)
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

  const authorName = author.first_name ? `${author.first_name} ${author.last_name || ''}`.trim() : 'A collaborator'
  entry.comments.push({
    authorName,
    content,
    isMention,
    timestamp: now,
    formattedTime: new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  })

  if (entry.timer) {
    clearTimeout(entry.timer)
  }

  const elapsed = now - entry.firstQueuedAt
  const remainingUntilMax = Math.max(0, MAX_DELAY_MS - elapsed)
  const delay = Math.min(DEBOUNCE_MS, remainingUntilMax)

  entry.timer = setTimeout(() => {
    flushQueue(recipient._id, project._id).catch(err => {
      logger.error({ err, userId: recipient._id, projectId: project._id }, 'failed to flush comment email digest')
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
  const subject = hasMention
    ? `[${project.name}] You were mentioned in a comment`
    : `[${project.name}] New comments on your project`

  const projectUrl = `${Settings.siteUrl}/project/${project._id}`
  const recipientName = recipient.first_name || 'there'

  await EmailHandler.promises.sendEmail({
    to: recipient.email,
    subject,
    template: 'new_comments_digest',
    values: {
      recipientName,
      projectName: project.name,
      projectUrl,
      comments,
    },
  })
}

export default {
  queueCommentNotification,
  flushQueue,
}
```

---

### Task 6: Wire Hooks & End-to-End Integration

**Files:**
- Modify: `overleaf/services/web/app/src/Features/Comments/CommentNotificationHandler.mjs`
- Modify: `overleaf/services/web/app/src/infrastructure/Modules.mjs` (or hook listeners in `web`)
- Test: `overleaf/services/web/test/unit/src/Comments/CommentNotificationHandler.test.mjs`

- [ ] **Step 1: Connect `commentMessageSent` hook listener**

In `CommentNotificationHandler.mjs`:
```javascript
import CommentEmailBatcher from './CommentEmailBatcher.mjs'
import UserGetter from '../User/UserGetter.mjs'
import ProjectGetter from '../Project/ProjectGetter.mjs'

async function handleCommentMessageSent({ projectId, threadId, userId, content }) {
  const author = await UserGetter.promises.getUser(userId)
  const project = await ProjectGetter.promises.getProjectWithoutDocLines(projectId)
  if (!author || !project) return

  const recipients = await resolveRecipients(projectId, threadId, userId, content)

  for (const { user: recipient, isMention } of recipients) {
    // 1. In-app dashboard notification
    await dispatchInAppNotification(recipient, project, author, threadId, content, isMention)

    // 2. Batched email digest
    CommentEmailBatcher.queueCommentNotification(recipient, project, author, threadId, content, isMention)
  }
}
```
Register the listener with `Modules.hooks.on('commentMessageSent', handleCommentMessageSent)`.

- [ ] **Step 2: Run verification tests**

Verify that `ChatController.sendComment` triggers `handleCommentMessageSent`, correctly dispatches to `NotificationsHandler`, and enqueues to `CommentEmailBatcher`.
