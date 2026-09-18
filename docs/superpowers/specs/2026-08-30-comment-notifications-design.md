# Technical Design: Review Panel, @Mentions, and Comment Notifications in Overleaf CE

- **Date:** 2026-08-30
- **Status:** Approved
- **Target Version:** Overleaf Community Edition (CE)

---

## 1. Executive Summary

This specification outlines the architecture and implementation for enabling the **in-editor Review Panel (threaded comments, `@mentions`, resolve/reopen)** and a **dual-channel notification pipeline (In-App Dashboard alerts + Batched Email Digests)** in Overleaf Community Edition (CE).

### Key Objectives
1. **Frontend Editor:** Activate the existing React Review Panel and CodeMirror 6 comment extensions so users can select text and create/reply to discussion threads.
2. **REST API & Microservice Integration:** Expose comment thread CRUD routes in `services/web` and proxy operations to the `services/chat` microservice.
3. **`@Mention` Support:** Allow collaborators to tag project members via `@<name>`, stored as `@[<userId>]` tokens, with autocompletion.
4. **In-App Dashboard Alerts:** Post persistent, dismissible notification cards to the recipient's `/project` dashboard via `services/notifications` (port 3042).
5. **Batched Email Digests:** Buffer comment notifications into a 5-minute debounce digest window to prevent email flooding, dispatched via `EmailHandler` / SMTP.
6. **Preference Controls:** Default to "Mentions & Replies only", with per-project settings for "All activity" or "Muted".

---

## 2. Architecture & System Flow

```
+-----------------------------------------------------------------------------------+
|                                Browser (Editor)                                   |
|   +--------------------------+          +-------------------------------------+   |
|   | CodeMirror 6 Selection   | -------> | React Review Panel (<ReviewPanel />)|   |
|   | & Comment Anchors        |          | - Add comment / Reply               |   |
|   +--------------------------+          | - @mention auto-complete            |   |
|                                         | - Resolve / Reopen thread           |   |
|                                         +-------------------------------------+   |
+-----------------------------------------------------------------------------------+
                                   | (HTTP REST + WebSockets)
                                   v
+-----------------------------------------------------------------------------------+
|                            services/web (Port 3000)                               |
|                                                                                   |
|  1. Router & Controller (router.mjs, ChatController.mjs)                          |
|     - /project/:projectId/threads                                                 |
|     - /project/:projectId/thread/:threadId/messages                               |
|     - /project/:projectId/thread/:threadId/resolve                                |
|                                                                                   |
|  2. Real-Time Broadcast (EditorRealTimeController.mjs)                           |
|     - Emits 'new-comment-message', 'resolve-thread' to WebSocket room             |
|                                                                                   |
|  3. CommentNotificationHandler.mjs                                                |
|     - Extracts @[userId] mentions                                                 |
|     - Resolves audience (Author excluded, Mentions, Participants, Subscriptions)   |
|     - Checks Project Notification Preferences                                     |
+-----------------------------------------------------------------------------------+
             |                                                  |
             | (Internal HTTP Port 3042)                        | (Internal Queue + SMTP)
             v                                                  v
+-----------------------------+               +-------------------------------------+
| services/notifications      |               | Email Notification Batcher          |
| (Port 3042)                 |               | - 5-min debounce queue              |
|                             |               | - Aggregates multiple comments      |
| - Inserts dashboard banner  |               | - Compiles new_comments_digest.pug  |
| - Keyed & Deduplicated      |               | - Dispatches via nodemailer (SMTP)  |
| - 14-day TTL auto-expiry    |               +-------------------------------------+
+-----------------------------+                                 |
             |                                                  |
             v                                                  v
   Recipient Dashboard                           Recipient Email Inbox
   (Banner on /project)                          (Formatted Email Digest)
```

---

## 3. Frontend Review Panel & Editor Integration

### 3.1 Feature Gating Configuration
In `overleaf/services/web/app/src/Features/Project/ProjectEditorHandler.mjs`:
- Set `ProjectEditorHandler.trackChangesAvailable = true` by default (or configurable via `Settings.enableComments ?? true`).
- In `buildProjectModelView(project, ownerMember, members, invites, isRestrictedUser)`:
  ```javascript
  result.features = _.defaults(ownerMember?.user?.features || {}, {
    ...
    trackChanges: false, // Remains false for comments-only mode
    trackChangesVisible: ProjectEditorHandler.trackChangesAvailable,
    ...
  })
  ```

### 3.2 Editor Component Activation
When `trackChangesVisible: true`, the editor automatically mounts:
1. `<ReviewPanelRoot />`: Collapsible review sidebar on the right of the editor.
2. `<ReviewTooltipMenu />`: Floating popup appearing on text selection in CodeMirror with an "Add Comment" button.
3. Review Panel Rail Tab: Review icon in the left toolbar rail to toggle the sidebar open/closed.

### 3.3 Real-Time WebSocket Synchronization
`ThreadsProvider` (`overleaf/services/web/frontend/js/features/review-panel/context/threads-context.tsx`) connects to WebSocket room events:
- `new-comment-message` -> Appends message to local thread state.
- `resolve-thread` -> Marks thread resolved in local state.
- `reopen-thread` -> Unmarks resolved state.
- `delete-thread` -> Removes thread from local state.

---

## 4. REST API & Backend Thread Routing

### 4.1 Endpoints in `router.mjs`
The following routes are registered in `overleaf/services/web/app/src/router.mjs` under the `chat` feature flag:

| Method | Endpoint | Handler | Permissions / Middleware |
|---|---|---|---|
| `GET` | `/project/:project_id/threads` | `ChatController.getThreads` | `ensureUserCanReadProject` |
| `GET` | `/project/:project_id/thread/:thread_id` | `ChatController.getThread` | `ensureUserCanReadProject` |
| `POST` | `/project/:project_id/thread/:thread_id/messages` | `ChatController.sendComment` | `ensureUserCanWriteProjectCustom` (or comment permissions) |
| `POST` | `/project/:project_id/thread/:thread_id/resolve` | `ChatController.resolveThread` | `ensureUserCanWriteProjectCustom` |
| `POST` | `/project/:project_id/thread/:thread_id/reopen` | `ChatController.reopenThread` | `ensureUserCanWriteProjectCustom` |
| `DELETE` | `/project/:project_id/thread/:thread_id` | `ChatController.deleteThread` | `ensureUserCanWriteProjectCustom` |
| `POST` | `/project/:project_id/thread/:thread_id/messages/:message_id/edit` | `ChatController.editMessage` | `ensureUserIsMessageAuthor` |
| `DELETE` | `/project/:project_id/thread/:thread_id/messages/:message_id` | `ChatController.deleteMessage` | `ensureUserIsMessageAuthor` |

### 4.2 Controller Logic (`ChatController.mjs`)
- Enriches message data with user profiles (`first_name`, `last_name`, `email`) via `UserInfoManager.promises.getPersonalInfo`.
- Broadcasts updates to the project's WebSocket room via `EditorRealTimeController.emitToRoom`.
- Triggers module hook `commentMessageSent` for notification dispatching:
  ```javascript
  await Modules.promises.hooks.fire('commentMessageSent', {
    projectId,
    threadId,
    userId,
    content,
    messageId: message.id,
  })
  ```

---

## 5. `@Mention` Tokenization & Audience Resolution

### 5.1 Tokenization Format
- When a user selects a collaborator from the `@` autocomplete dropdown, the editor inserts:
  `@[<24-hex-userId>]` (e.g. `@[64f1a2b3c4d5e6f7a8b9c0d1]`).
- Backend Regex: `/@\[([a-fA-F0-9]{24})\]/g`.

### 5.2 Audience Resolution Algorithm (`CommentNotificationHandler.mjs`)
For each comment or reply posted in `projectId`:
1. **Exclude Author:** Filter out `message.userId`.
2. **Identify Mentioned Users:** Extract IDs matching `/@\[([a-fA-F0-9]{24})\]/g`. Validate each user ID against project members (`ProjectGetter.getProjectWithoutDocLines`).
3. **Identify Thread Participants:** Query previous messages in `threadId` via `ChatApiHandler.getThread` to collect prior authors.
4. **Identify All-Activity Subscribers:** Identify collaborators who configured `notification_preferences: 'all'` for this project.
5. **Filter by Preferences:**
   - Mentioned user -> Always included (unless project is `off`).
   - Thread participant -> Included if preference is `'replies'` (default) or `'all'`.
   - All-activity subscriber -> Included if preference is `'all'`.
   - User with preference `'off'` -> Excluded from all notifications.

---

## 6. In-App Dashboard Notification Service

### 6.1 Dispatcher Implementation
When comment recipients are resolved, `CommentNotificationHandler` calls `NotificationsHandler.promises.createNotification`:
- **`userId`**: Recipient user ID.
- **`key`**: `project-comment-${projectId}-${threadId}-${recipientUserId}`.
- **`templateKey`**: `notification_project_comment`.
- **`messageOpts`**:
  ```json
  {
    "projectId": "...",
    "projectName": "My Thesis",
    "threadId": "...",
    "userName": "Jane Doe",
    "commentSnippet": "Please review the updated bibliography...",
    "isMention": true
  }
  ```
- **`expires`**: 14 days from creation date (`new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString()`).
- **`forceCreate`**: `true` (updates existing banner with latest reply).

### 6.2 UI Rendering on `/project`
In `frontend/js/features/project-list/components/notifications/groups/common.tsx`:
- Render alert banner:
  - Mention: *"[User] mentioned you in a comment on [Project Name]"*
  - Reply: *"[User] replied to a comment on [Project Name]"*
  - Includes a snippet preview.
  - CTA Button: `Open project` (`href="/project/:projectId"`) and close/dismiss button (`handleDismiss(id)`).

---

## 7. Email Digest Batching Engine

### 7.1 Debounce & Batching Mechanics
- **Key:** `comment_batch:${recipientUserId}:${projectId}`.
- **Debounce Timer (`notificationMinDelay`):** 5 minutes (300,000 ms).
- **Max Delay Ceiling (`notificationMaxDelay`):** 15 minutes (900,000 ms).
- **Storage:** In-memory timer queue (with optional Redis fallback).

### 7.2 Digest Compilation & Email Delivery
When the timer fires:
1. Atomically drain the list of queued comments for that `(userId, projectId)`.
2. Load project details, author details, and recipient email.
3. Render email using Pug template `overleaf/services/web/app/views/emails/new_comments_digest.pug`:
   - Subject: `[Project Name] - New comments from [User]`
   - HTML & Text versions with formatted comment threads, file names, timestamps, and deep links.
4. Send via `EmailHandler.promises.sendEmail({ to, subject, html, text })`.

---

## 8. Configuration & Environment Variables

| Variable | Default | Description |
|---|---|---|
| `OVERLEAF_ENABLE_COMMENTS` | `true` | Enables/disables the in-editor Review Panel in Community Edition |
| `COMMENT_MENTION_DELAY_MS` | `300000` (5 mins) | Debounce batch delay before sending email digests |
| `OVERLEAF_EMAIL_FROM_ADDRESS` | `overleaf@example.com` | From address for comment notification emails |
| `OVERLEAF_EMAIL_SMTP_HOST` | `127.0.0.1` | SMTP server host |
| `OVERLEAF_EMAIL_SMTP_PORT` | `587` | SMTP server port |

---

## 9. Error Handling & Resilience
1. **Notifications Service Unreachable:** If `services/notifications` is down, `NotificationsHandler` logs a warning and the web request completes without failing the comment creation.
2. **Email Delivery Failure:** If SMTP delivery fails (e.g. host unreachable or bad auth), the error is logged and does not block the real-time editor or user interactions.
3. **Invalid Mentions:** If a user manually crafts a malformed `@[invalid]` token, it is ignored safely without throwing exceptions.

---

## 10. Testing Plan
- **Unit Tests:**
  - `CommentNotificationHandler.test.mjs`: Test `@mention` extraction regex, audience filtering, and preference evaluation.
  - `ChatController.test.mjs`: Test REST endpoints for threads, resolve, reopen, and hook firing.
- **Integration Tests:**
  - Mock SMTP server & `MockNotificationsApi` to verify that posting a comment correctly records a notification in MongoDB and schedules an email digest.
  - Verify that multiple comments in the 5-minute window are consolidated into a single email digest.
