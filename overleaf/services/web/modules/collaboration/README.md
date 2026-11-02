# Collaboration & Review Module (`collaboration`)

Adds threaded comments and tracked edits to Overleaf CE. The module is disabled by default.

## Features

- Add comments to a project, reply in threads, edit or delete your own comments, and resolve or reopen threads.
- Mention collaborators by username and receive comment notifications.
- Enable track changes, submit per-user suggestions, and accept or reject proposed edits.
- Set project notification preferences and receive batched comment email digests using the instance's existing email setup.
- Assign the Reviewer role, which can review and suggest edits without directly changing project text.

## Activation

Set this in `variable.env`:

```env
COLLABORATION_ENABLED=true
```

No additional environment variables are required. Email digests require Overleaf email delivery to be configured. When disabled, the module registers no collaboration routes and does not enable the review controls.

## Upstream CE comparison

Upstream CE includes basic project collaboration and in-project chat, but not comment threads or real-time track changes. Overleaf's [Server Pro comparison](https://docs.overleaf.com/on-premises/welcome/server-pro-vs.-community-edition) and [roles and permissions guide](https://docs.overleaf.com/on-premises/user-and-project-management/roles-and-permissions) list comments and tracked changes as Server Pro features. This module adds those review features to CE behind `COLLABORATION_ENABLED`; it is an independent extension, not Server Pro.

## Developer design

- **App flow:** The module entry registers routes and the comment hook only when enabled. Comment routes check project access, then use the existing chat service; track-change routes use DocumentUpdater and docstore. Project socket events update open editors. The comment hook resolves members and preferences, then sends in-app notifications and queues email digests.
- **MongoDB:** The module adds one collection, `notificationsPreferences`, for per-user, per-project notification switches. Existing `rooms` and `messages` store chat thread state and comments; `projects` stores reviewer membership and the `track_changes` map; `docs` stores document content and suggestion/comment ranges. In-app alerts use the existing `notifications` collection through the Notifications service.
- **Role boundary:** Adds project privilege `review`, stored in `projects.reviewer_refs` (and `pendingReviewer_refs` for invitations). Reviewers can read, comment, and suggest edits; they cannot directly edit project text or accept/reject suggestions. Owners and read/write collaborators can manage content and review suggestions. Reviewers can resolve or delete their own threads.
- **Other persistence:** Digest batches and Bull jobs live in Redis; delivery uses the instance's normal email setup. No separate service or collaboration-owned document store is added.
