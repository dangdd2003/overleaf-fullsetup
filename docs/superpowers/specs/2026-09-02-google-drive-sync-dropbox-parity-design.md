# Design Specification: Google Drive Sync — Dropbox Parity

**Date**: 2026-09-02
**Status**: Approved / Ready for Implementation Planning
**Target**: Overleaf Community Edition (Server CE)
**Supersedes parts of**: `2026-08-30-google-drive-sync-design.md` (sections 4.2–4.4)

---

## 1. Overview & Goals

The Google Drive Sync module currently ships with a symmetric, coarse-grained
sync model: a 60-second poller handles inbound changes, and outbound sync is
manual-only because the original per-edit debounced listener performed a full
project rescan and was removed to avoid Drive API rate limits.

This specification rebuilds the sync engine to match the behavioural model of
Overleaf Cloud's official Dropbox integration, which is **asymmetric**: inbound
changes propagate in seconds via provider push notifications, while outbound
changes are batched on a relaxed timer. It also adds the four data-integrity
behaviours Dropbox provides that the module currently lacks.

### 1.1 Target Behavioural Model

| Direction | Trigger | Latency |
|---|---|---|
| Drive → Overleaf | `changes.watch` push notification → webhook → targeted `pollUserChanges` | seconds (push); ≤ 5 min (poll fallback) |
| Overleaf → Drive | `fileModified` / `entityDeleted` hooks → per-file dirty set → batch worker | ~10 min (configurable) |
| Manual | "Sync this project now" → full `syncProject` | immediate (cooldown-gated) |

### 1.2 Non-Goals

- Real-time (sub-second) outbound push. Overleaf documents mutate continuously
  via operational transformation; pushing per keystroke would exhaust Drive API
  quota. Batching is a deliberate design choice, matching Dropbox.
- Three-way merge. Files crossing the Overleaf/Drive boundary are treated as
  opaque blobs; divergence produces a conflict copy, never a merge.
- Changing the feature's default state. `ENABLE_GOOGLE_DRIVE_SYNC` remains
  `false` by default and clean disablement semantics are unchanged.

### 1.3 Constraints

- Community Edition has no Third-Party Data Store (TPDS) worker
  (`settings.apis.thirdPartyDataStore.url` is unset, and `TpdsUpdateSender`
  early-returns). The module must own its outbound queue rather than delegating.
- Many CE deployments have no publicly reachable HTTPS endpoint, so push
  notifications must be optional with a polling fallback.

---

## 2. System Architecture

Existing files are retained. Five new files are added under
`services/web/app/src/Features/GoogleDriveSync/`.

```
                        +--------------------------+
   Google Drive  --push->| GoogleDriveWebhook       |  POST /google-drive/webhook
                        | Controller               |  (publicApiRouter, CSRF-exempt)
                        +------------+-------------+
                                     | debounced, deduped
                                     v
   +-----------------------+   +-----------------------------+
   | GoogleDrivePolling    |-->| GoogleDriveSyncManager      |
   | Worker (fallback net) |   |  .pollUserChanges()         |  INBOUND
   +-----------------------+   |  .syncProject()             |
                               |  .handleOutbound*()         |  OUTBOUND
   +-----------------------+   +--------------^--------------+
   | GoogleDriveChannel    |                  |
   | RenewalWorker         |   +--------------+--------------+
   +-----------+-----------+   | GoogleDriveOutboundWorker   |
               |               +--------------^--------------+
               v                              | reads pendingChanges
   +-----------------------+   +--------------+--------------+
   | GoogleDriveWatch      |   | GoogleDriveHookHandler      |
   | Manager               |   +--------------^--------------+
   +-----------------------+                  | Modules.hooks.attach
                                              |
                            ProjectEntityUpdateHandler fires
                            'fileModified' / 'entityDeleted'
```

### 2.1 New Components

| File | Responsibility |
|---|---|
| `GoogleDriveHookHandler.mjs` | Consumes `fileModified` / `entityDeleted`; records changed paths into a per-project dirty set. No Drive I/O. |
| `GoogleDriveOutboundWorker.mjs` | Timer; flushes dirty projects by pushing only the recorded paths. |
| `GoogleDriveWatchManager.mjs` | Creates, renews and stops Drive `changes.watch` channels. |
| `GoogleDriveChannelRenewalWorker.mjs` | Timer; keeps watch channels alive and backfills missing ones. |
| `GoogleDriveWebhookController.mjs` | Validates and handles Google's push notifications. |

### 2.2 Modified Components

| File | Change |
|---|---|
| `index.mjs` | `start()` attaches hook listeners via `Modules.hooks.attach` and starts all four workers. |
| `GoogleDriveRouter.mjs` | Accepts `publicApiRouter`; mounts the webhook route with CSRF disabled, and the conflict-dismiss route (§5.3). |
| `router.mjs` | `GoogleDriveRouter.apply(webRouter, publicApiRouter)`. |
| `GoogleDrivePollingWorker.mjs` | Becomes the fallback net; skips/de-prioritises users with a live watch channel. |
| `GoogleDriveClient.mjs` | All API calls routed through `requestWithRetry` + a global rate limiter; gains `watchChannels` / `stopChannel`. |
| `GoogleDriveSyncManager.mjs` | Conflict detection, rename-by-ID, duplicate-name resolution; `fileMap` entries populate `entityId` / `entityType`. |
| `GoogleDriveOAuthManager.mjs` | Creates a watch channel on link; stops it on unlink. |
| `mongodb.mjs` | Schema additions (§7). |
| `settings.defaults.js` | New configuration keys (§8). |

---

## 3. Inbound Sync — Push Notifications with Polling Fallback

### 3.1 Watch Channel Lifecycle

`GoogleDriveWatchManager` owns the channel lifecycle. A channel is only created
when `Settings.googleDrive.webhookUrl` is a non-empty string.

**`ensureChannel(userId)`**

1. Load credentials. Return `{ skipped: 'no-webhook-url' }` if no webhook URL is
   configured, or `{ skipped: 'unlinked' }` if the user has no credentials.
2. If `watchExpiresAt` is more than `CHANNEL_RENEW_THRESHOLD_MS` (24h) in the
   future, return `{ reused: true }`.
3. Generate `channelId = crypto.randomUUID()` and
   `channelToken = HMAC-SHA256(userId, Settings.googleDrive.webhookSecret)`.
   The token is what proves a notification is genuinely for this user; it is
   never derived from anything an attacker can guess.
4. Call Drive `changes.watch` with `pageToken` = the user's current
   `startPageToken`, `id = channelId`, `type = 'web_hook'`,
   `address = <webhookUrl>`, `token = channelToken`.
5. Persist `watchChannelId`, `watchResourceId` (from the response), the
   `watchChannelToken`, and `watchExpiresAt` (from the response `expiration`,
   epoch millis) onto `googleDriveUserCredentials`.
6. If a previous channel existed, call `stopChannel` for it first so Google does
   not keep delivering to a stale channel.

**`stopChannel(userId)`** — calls Drive `channels.stop` with the stored
`watchChannelId` + `watchResourceId`, then clears all four watch fields. Called
on unlink and before replacing a channel. Failures are logged, not fatal: the
channel expires on its own.

`Settings.googleDrive.webhookSecret` defaults to a value derived from the
existing token-encryption secret used by `GoogleDriveOAuthManager`, so
operators need not configure a second secret.

### 3.2 Renewal Worker

`GoogleDriveChannelRenewalWorker` runs on a `setInterval` of
`GOOGLE_DRIVE_CHANNEL_RENEW_INTERVAL_SECONDS` (default 3600), with the same
`unref()` + re-entrancy guard pattern as the existing polling worker. Each cycle:

1. Return immediately if the feature is disabled or no webhook URL is set.
2. Iterate all `googleDriveUserCredentials`; call `ensureChannel(userId)` for
   each. This both renews channels expiring within 24h and backfills channels
   for users linked before push was configured.
3. Errors are logged per user and never abort the cycle.

It also runs once at boot so a restart re-establishes channels promptly.

### 3.3 Webhook Endpoint

Route: `POST /google-drive/webhook`, mounted on `publicApiRouter` (no session,
no authentication — Google will not present credentials) and registered with
`webRouter.csrf.disableDefaultCsrfProtection('/google-drive/webhook', 'POST')`.
Mounted only when the feature is enabled **and** a webhook URL is configured.

Handling in `GoogleDriveWebhookController.handleNotification`:

1. Read `X-Goog-Channel-Id`, `X-Goog-Channel-Token`, `X-Goog-Resource-State`.
2. Look up credentials by `watchChannelId`. If none, respond `200` and drop —
   a stale channel must not produce retries.
3. Compare `X-Goog-Channel-Token` against the stored `watchChannelToken` using
   `crypto.timingSafeEqual`. Mismatch ⇒ log a warning, respond `200`, drop.
4. If `X-Goog-Resource-State === 'sync'` (Google's handshake ping), respond
   `200` and do nothing.
5. Otherwise schedule a debounced poll for that user and respond `200`
   immediately. Google treats a slow or failing endpoint as a reason to
   throttle or drop the channel, so no Drive work happens on the request path.

**Debounce:** an in-process `Map<userId, timeout>`. A notification schedules
`pollUserChanges(userId)` after `GOOGLE_DRIVE_WEBHOOK_DEBOUNCE_MS` (2000).
Further notifications for the same user within that window reset the timer, so
a burst of file saves collapses into one delta fetch. The map entry is deleted
when the poll starts. `pollUserChanges` is already re-entrancy-safe via project
locks; a `Set<userId>` of in-flight polls prevents overlapping runs for one user
and instead marks the user for one immediate re-poll on completion.

### 3.4 Polling Fallback

`GoogleDrivePollingWorker` is retained unchanged in structure. Two changes:

- Default interval raised from 60s to `GOOGLE_DRIVE_POLL_INTERVAL_SECONDS`
  (default 300). With push enabled it is a safety net, not the primary path.
- Per-user selection: a user whose `watchExpiresAt` is in the future is polled
  only every Nth cycle (`GOOGLE_DRIVE_WATCHED_USER_POLL_RATIO`, default 10) to
  catch notifications Google dropped. Users with no live channel — including
  every user in a deployment without a webhook URL — are polled every cycle,
  preserving today's behaviour exactly.

### 3.5 Delta Fetch

Unchanged. `pollUserChanges` continues to page `changes.list` from the stored
`startPageToken` and persist `newStartPageToken`. Push notifications only change
*when* it runs, never *how*.

---

## 4. Outbound Sync — Per-File Dirty Set and Batch Worker

### 4.1 Hook Consumer

Three hooks feed the dirty set. `index.mjs start()` attaches:

```js
Modules.hooks.attach('fileModified', GoogleDriveHookHandler.onFileModified)
Modules.hooks.attach('entityDeleted', GoogleDriveHookHandler.onEntityDeleted)
Modules.hooks.attach('docModified', GoogleDriveHookHandler.onDocModified)
```

| Hook | Fired from | Signature | Covers |
|---|---|---|---|
| `fileModified` | `ProjectEntityUpdateHandler` — `addFile`, `upsertFile`, file replace | `(projectId, entityId, path, source)` | binary files added / replaced / uploaded |
| `entityDeleted` | `ProjectEntityUpdateHandler.deleteEntity` | `(projectId, path, entityType, source)` | any deletion |
| `docModified` | `DocumentController.setDocument` | `(projectId, docId, ranges, lastUpdatedAt)` | **doc content edits** |

`fileModified` and `entityDeleted` are the two fires this worktree added to
`ProjectEntityUpdateHandler`. `docModified` is an **upstream Overleaf hook that
already exists**, fired from the private-API endpoint
`POST /project/:Project_id/doc/:doc_id` that document-updater calls on every
doc flush.

The third hook is not optional. `fileModified` fires only from file-oriented
call sites — every one of its three fire sites operates on a `fileRef`. Editing
`main.tex` in the editor never touches `ProjectEntityUpdateHandler` at all: the
content goes browser → real-time → document-updater → Redis, and reaches web
only when document-updater flushes it back. Without `docModified`, ordinary doc
edits — the primary use case — would never be queued for outbound sync.

Two consequences of `docModified`'s different shape:

- **No path argument.** The handler resolves it with
  `ProjectEntityHandler.promises.getDocPathByProjectIdAndDocId(projectId, docId)`.
- **No `source` argument**, so the `source === 'google-drive'` loop guard cannot
  apply. An inbound Drive apply writes through `EditorController` →
  document-updater, which later flushes and fires `docModified`, queueing an
  outbound push of content Drive already has. This is closed by a **content-hash
  equality check** in the outbound worker: before pushing a doc, hash its current
  content and skip the push when it equals `fileMap[path].md5Checksum`. The check
  is purely local — no Drive API call — and makes outbound pushes idempotent,
  which also protects against duplicate queue entries from any other source.

Each handler returns early — doing no database work at all — when any of the
following holds:

1. `Features.hasFeature('google-drive-sync')` is false.
2. `source === 'google-drive'`. **This is the loop guard**: without it, applying
   an inbound Drive change would immediately queue an outbound push of the same
   content.
3. `isIgnoredFile(path)` — LaTeX build artefacts.
4. No `googleDriveProjectStates` document exists for the project (project not
   linked). This lookup is the only cost on the hot edit path; it is a single
   indexed `findOne` on `projectId`.

Otherwise the handler performs one `updateOne`:

```js
{
  $set: {
    [`pendingChanges.${encodedPath}`]: {
      op: 'upsert' | 'delete',
      entityId,
      entityType,   // 'doc' | 'file'
      queuedAt: new Date(),
    },
    outboundDirtyAt: new Date(),
  }
}
```

Paths contain `.` and may contain `$`, which are illegal in Mongo field names,
so `encodedPath` percent-encodes both. A shared `encodePathKey` /
`decodePathKey` pair lives in `GoogleDriveSyncManager` alongside
`normalizePath`. Last write wins per path: an upsert following a delete of the
same path collapses to a single upsert, which is correct.

Hook failures are caught and logged. A sync bookkeeping error must never fail
the user's edit.

### 4.2 Batch Worker

`GoogleDriveOutboundWorker` runs on a `setInterval` of
`GOOGLE_DRIVE_OUTBOUND_FLUSH_SECONDS` (default 600), same `unref()` and
re-entrancy guard as the other workers.

Each cycle selects projects where:

- `pendingChanges` is non-empty, and
- `outboundDirtyAt` is older than `GOOGLE_DRIVE_OUTBOUND_DEBOUNCE_SECONDS`
  (default 15) — so a project still being actively edited settles first, and
- `backoffUntil` is unset or in the past, and
- `syncSuspended` is not true.

For each selected project:

1. Acquire the existing Mongo project lock (`acquireProjectLock`). If it cannot
   be acquired, skip this project this cycle — a manual sync or inbound apply is
   already running.
2. Snapshot `pendingChanges` and iterate its entries in `queuedAt` order.
3. Detect rename pairs first (§6.2), consuming both entries.
4. For each remaining entry, call the **already-implemented** manager function:
   - `op === 'upsert'`, `entityType === 'doc'` → `handleOutboundDocUpdate`
   - `op === 'upsert'`, `entityType === 'file'` → `handleOutboundFileUpdate`
   - `op === 'delete'` → `handleOutboundDelete`

   For docs, first hash the current content (`md5(lines.join('\n'))`) and drop
   the entry without pushing when it equals `fileMap[path].md5Checksum` — the
   content already matches what Drive holds. This is what makes `docModified`
   safe to attach without a `source` loop guard (§4.1).
5. **Divergence check before every upsert**: when `fileMap[path]` already has a
   `driveFileId`, issue a `files.get` with `fields=md5Checksum,trashed` and
   compare against `fileMap[path].md5Checksum`. If it differs, Drive has changed
   underneath us. Leave the entry in `pendingChanges` and skip the push; the
   next inbound poll resolves it through the conflict path (§5). This keeps
   conflict-copy creation in exactly one place. The check costs one cheap
   metadata request per changed file per flush, which the batching interval
   makes affordable; files with no existing mapping are new and skip the check.
6. `$unset` each entry from `pendingChanges` only on success. Entries that
   failed remain queued and are retried next cycle; their failure is recorded in
   `lastOutboundError`. A per-entry `attempts` counter is incremented, and after
   `OUTBOUND_MAX_ATTEMPTS` (5) the entry is dropped with an error log so one
   permanently broken file cannot wedge a project forever.
7. Release the lock. Set `lastSyncedAt` when the set drained cleanly.

Removing entries individually rather than clearing the whole map avoids losing
edits that arrived while the flush was in flight.

### 4.3 Manual Sync

`POST /project/:id/google-drive/sync` is unchanged in shape: cooldown check,
then full `syncProject`. On success it clears `pendingChanges` and
`outboundDirtyAt`, since the full reconcile subsumes every queued path.
`syncProject` remains the self-healing full-tree pass — it is now only reached
on explicit user action, never on a timer.

---

## 5. Conflict Copies

Conflict copies are created in exactly one place: the inbound path, written
into Overleaf. The outbound worker defers to it (§4.2 step 5).

### 5.1 Detection

When inbound wants to apply a Drive change to `path`, with
`mapped = fileMap[path]`:

- `driveChanged = driveFile.md5Checksum !== mapped.md5Checksum`
- `overleafChanged = <hash of current Overleaf content> !== mapped.md5Checksum`

For docs, the Overleaf-side hash is the MD5 of the doc's lines joined with
`\n`. This matches `handleOutboundDocUpdate` exactly, which builds its upload
buffer as `Buffer.from(lines.join('\n'), 'utf8')` — so the hash compared here is
the hash of the identical bytes Drive received, and an untouched doc can never
look conflicted. Any future change to the upload encoding must change both
sites together. For binary files the Overleaf-side hash is the stored file hash. Both sides true ⇒ conflict. If `mapped` is absent the
file is new on the Drive side and there is nothing to conflict with.

### 5.2 Resolution

1. Do **not** overwrite the Overleaf doc or file. The live editor version wins
   in place.
2. Write the Drive bytes to `generateConflictPath(path)` — already implemented,
   producing `name (Google Drive Conflict YYYY-MM-DD-HHmm).ext` — via the usual
   `upsertDocWithPath` / `upsertFileWithPath` with `source: 'google-drive'`.
3. Push `{ path, conflictPath, detectedAt }` onto `state.conflicts`, capped at
   the 20 most recent entries.
4. Leave `fileMap[path]` pointing at the Overleaf version, so the next outbound
   flush pushes Overleaf's copy to Drive and the two sides reconverge.

The conflict copy itself is a new file in Overleaf, so the hooks queue it for
outbound push and it appears in Drive too — matching Dropbox, where the conflict
copy is visible on both sides.

### 5.3 Surfacing

`getProjectStatus` returns `conflicts`. `google-drive-modal.tsx` renders a
warning banner listing the conflict paths when the array is non-empty, with a
dismiss action backed by a new route
`POST /project/:Project_id/google-drive/conflicts/dismiss`, mounted on
`webRouter` behind `requireLogin` +
`AuthorizationMiddleware.ensureUserCanWriteProjectContent` alongside the
existing per-project routes. It clears `state.conflicts` and returns the
updated status. New locale strings are added under the existing
`google_drive_*` namespace.

---

## 6. Rename and Move Without History Loss

Drive assigns stable file IDs that survive renames and moves — unlike Dropbox,
whose delta feed reports a rename as delete-then-add and forces Overleaf to
destroy and recreate the entity (losing comments and tracked changes). The
module can and should exploit this.

### 6.1 Inbound

Prerequisite: `fileMap` entries must carry `entityId` and `entityType`. The
schema already allows them; several code paths currently omit them. Every write
to `fileMap` is audited to populate both. A one-off backfill is unnecessary — a
missing `entityId` simply falls back to the delete+add path.

`pollUserChanges` builds a reverse index `driveFileId → { path, entityId,
entityType }` from all of the user's project states, which it already partially
constructs as `projectByFileId`. For each change:

- If `file.id` is **known** and its resolved path differs from the mapped path:
  - Same parent folder, different name ⇒ `EditorController.promises.renameEntity(projectId, entityId, entityType, newName, userId, 'google-drive')`
  - Different parent folder ⇒ `EditorController.promises.moveEntity(projectId, entityId, newFolderId, entityType, userId, 'google-drive')`, resolving `newFolderId` through the existing `resolveDriveFolderHierarchy`
  - Both ⇒ move, then rename
  - Then rekey `fileMap`: delete the old path key, insert under the new one with the same `driveFileId` / `entityId`.
- If `file.id` is unknown, the existing delete+add behaviour applies unchanged.

A rename must not be mistaken for a content change: after the rekey, the
`md5Checksum` comparison runs against the *new* path's mapping, so an unchanged
file produces no further work.

### 6.2 Outbound

An Overleaf rename or move surfaces to the dirty set as a `delete(oldPath)`
plus an `upsert(newPath)` carrying the **same `entityId`**. The outbound worker
scans the snapshot for such pairs before processing individual entries, and for
each pair issues a single Drive `files.update` changing `name` and/or
`addParents` / `removeParents`, then rekeys `fileMap`. Both entries are consumed
together. Unpaired entries fall through to normal upsert/delete handling.

---

## 7. Duplicate Project-Name Handling

### 7.1 Overleaf → Drive Folder Names

`getOrCreateProjectFolder` currently resolves purely by name. It gains
collision handling:

1. Resolve by the stored `state.driveFolderId` first when present. A project
   whose folder is already known never re-resolves by name, so a user renaming
   the folder in Drive does not orphan the mapping.
2. When creating a new folder, list non-trashed folder children of the root. If
   `project.name` is free, use it.
3. If taken by a folder already bound to a **different** project, try
   `"<name> 1"`, `"<name> 2"`, … up to `MAX_NAME_SUFFIX` (100).
4. Persist the chosen name in `state.folderName`.
5. If no free name is found, set `syncSuspended = true` with
   `suspendReason = 'duplicate-folder-name'` rather than guessing.

### 7.2 Drive Folder → New Overleaf Project

`_createProjectFromDriveFolder` gains the mirror-image logic. The name check
must include archived and trashed projects — a Dropbox-documented pitfall,
since a trashed project still owns its name and will collide when restored.
`ProjectGetter` is queried without the active-only filter. On collision the new
project is named `"<name> (1)"`, `"<name> (2)"`, …; if unresolvable, the Drive
folder is recorded as suspended and skipped, not silently merged into an
existing project.

### 7.3 Suspension Surfacing

`getProjectStatus` returns `syncSuspended` and `suspendReason`. The modal
renders a distinct "Sync suspended" state with the reason and no "Sync now"
button, since retrying cannot help until the user renames something.

---

## 8. Rate-Limit Hardening

### 8.1 Retry Wrapper

`GoogleDriveClient` already has `_requestWithRetry(fn, options)` and all twelve
Drive API call sites already route through it. It currently retries `429`, all
`5xx`, and `ECONNRESET` / `ETIMEDOUT` / `EAI_AGAIN`, honours `Retry-After`, and
applies 20% jitter with a default of 3 retries. This is an **extension** of that
function, not a new one:

- Retries on HTTP `429`, and additionally on `403` whose error reason is
  `rateLimitExceeded`, `userRateLimitExceeded`, or `sharingRateLimitExceeded`.
  A `403` for `insufficientPermissions`, `appNotAuthorizedToFile`, or similar is
  **not** retried — it is a permanent failure and retrying wastes quota. The
  reason is read from the Google error body's `error.errors[0].reason`, falling
  back to `error.status`.
- Existing `5xx` and transient-network retry behaviour is unchanged.
- Backoff cap raised: delay is clamped to 32000 ms, and the default retry count
  raised from 3 to `DRIVE_MAX_RETRY_ATTEMPTS` (5). `Retry-After` handling is
  unchanged.
- Throws a tagged `OError` carrying `rateLimited: true` when retries are
  exhausted on a rate-limit error, so callers can distinguish quota exhaustion
  from a genuine failure.

### 8.2 Global Rate Limiter

A per-process token bucket in `GoogleDriveClient`, refilled at
`GOOGLE_DRIVE_MAX_RPS` (default 8) with a burst of `2 * rps`. Every request
awaits a token. All four workers, the webhook-triggered polls, and manual syncs
share the bucket, so no combination of triggers can exceed the configured rate.
This is a single-process limiter; multi-instance CE deployments should divide
the configured rate by their instance count.

### 8.3 Per-Project Backoff

When `requestWithRetry` exhausts retries with `rateLimited: true` for a project,
the manager sets `backoffUntil = now + BACKOFF_BASE * 2^consecutiveFailures`
(base 5 min, capped at 1 hour), increments `consecutiveFailures`, and sets
`syncStatus = 'error'` with `lastError`. Every worker skips projects whose
`backoffUntil` is in the future. A successful sync resets `consecutiveFailures`
to 0 and clears `backoffUntil`.

### 8.4 Manual Cooldown

`enforceManualSyncCooldown`'s hard-coded 60000ms becomes
`Settings.googleDrive.manualSyncCooldownSeconds`
(`GOOGLE_DRIVE_MANUAL_SYNC_COOLDOWN_SECONDS`, default 60). Behaviour is
otherwise unchanged, including the existing `429` + `retryAfterSeconds`
response.

---

## 9. Data Model Changes

### 9.1 `googleDriveUserCredentials` — additions

```javascript
{
  watchChannelId:    String,  // UUID we generated for changes.watch
  watchResourceId:   String,  // Google's resource id, required by channels.stop
  watchChannelToken: String,  // HMAC we verify inbound notifications against
  watchExpiresAt:    Date,    // channel expiry; drives renewal
}
```

Index: `watchChannelId` (sparse) — the webhook resolves the user by it on every
notification.

### 9.2 `googleDriveProjectStates` — additions

```javascript
{
  pendingChanges: {           // key: percent-encoded relative path
    type: Map,
    of: {
      op:         String,     // 'upsert' | 'delete'
      entityId:   ObjectId,
      entityType: String,     // 'doc' | 'file'
      queuedAt:   Date,
      attempts:   Number,     // default 0
    },
    default: {},
  },
  outboundDirtyAt:     Date,
  lastOutboundError:   String,
  backoffUntil:        Date,
  consecutiveFailures: { type: Number, default: 0 },
  conflicts: [{             // capped at 20 most recent
    path:         String,
    conflictPath: String,
    detectedAt:   Date,
  }],
  syncSuspended: { type: Boolean, default: false },
  suspendReason: String,
}
```

Index: `{ outboundDirtyAt: 1 }` sparse — the outbound worker's selection query.

`fileMap` entry shape is unchanged but `entityId` and `entityType` must now
always be populated.

All additions are optional with safe defaults, so existing documents from the
current implementation continue to work without migration.

---

## 10. Configuration

| Variable | Type | Default | Purpose |
|---|---|---|---|
| `GOOGLE_DRIVE_WEBHOOK_URL` | string | `""` | Public HTTPS address for push notifications. Empty disables push entirely; polling-only. |
| `GOOGLE_DRIVE_WEBHOOK_SECRET` | string | derived from token-encryption secret | HMAC key for channel tokens. |
| `GOOGLE_DRIVE_OUTBOUND_FLUSH_SECONDS` | number | `600` | Batch flush interval. |
| `GOOGLE_DRIVE_OUTBOUND_DEBOUNCE_SECONDS` | number | `15` | Settle time after the last edit before flushing a project. |
| `GOOGLE_DRIVE_POLL_INTERVAL_SECONDS` | number | `300` | Fallback poll interval (**was 60**). |
| `GOOGLE_DRIVE_WATCHED_USER_POLL_RATIO` | number | `10` | Poll a push-watched user once every N cycles. |
| `GOOGLE_DRIVE_CHANNEL_RENEW_INTERVAL_SECONDS` | number | `3600` | Channel renewal worker interval. |
| `GOOGLE_DRIVE_MAX_RPS` | number | `8` | Global Drive API rate cap for this process. |
| `GOOGLE_DRIVE_MANUAL_SYNC_COOLDOWN_SECONDS` | number | `60` | Manual "Sync now" cooldown. |

Existing keys (`ENABLE_GOOGLE_DRIVE_SYNC`, `GOOGLE_DRIVE_CLIENT_ID`,
`GOOGLE_DRIVE_CLIENT_SECRET`, `GOOGLE_DRIVE_REDIRECT_URI`,
`GOOGLE_DRIVE_FOLDER_NAME`) are unchanged.

### 10.1 Clean Disablement

When `ENABLE_GOOGLE_DRIVE_SYNC` is false or unset:

- `Features.hasFeature('google-drive-sync')` returns false.
- All four workers return immediately from `start()`.
- Every route, including the webhook, is unmounted.
- Hook handlers return before any database access, so the feature adds nothing
  measurable to the edit path.
- Frontend meta `ol-googleDriveSyncEnabled` is false; all UI omitted.

When the feature is enabled but `GOOGLE_DRIVE_WEBHOOK_URL` is empty:

- The webhook route is not mounted and the renewal worker does not start.
- No `changes.watch` calls are made.
- The polling worker runs every cycle for every user — today's behaviour, at the
  new default interval.

---

## 11. Failure Modes

| Failure | Behaviour |
|---|---|
| Webhook URL unreachable from Google | `changes.watch` fails; `ensureChannel` logs and returns. Polling covers inbound. Renewal worker retries hourly. |
| Channel expires unnoticed | Polling fallback catches changes within one cycle; renewal worker recreates the channel. |
| Forged webhook request | Channel-token HMAC comparison fails; request dropped with a `200` and a warning log. |
| Outbound push fails for one file | Entry stays in `pendingChanges` with an incremented `attempts`; retried next cycle; dropped after 5 attempts with an error log. |
| Drive quota exhausted | `requestWithRetry` backs off, then the project enters `backoffUntil`; workers skip it; status shows an error. |
| Project lock held | Worker skips the project for that cycle; no data loss, `pendingChanges` persists. |
| Process restart mid-flush | `pendingChanges` is durable in Mongo; the next cycle resumes. Watch channels are re-established at boot. |
| Both sides edited between syncs | Conflict copy (§5); neither version is lost. |

---

## 12. Testing Strategy

Backend unit tests (vitest), one file per new component plus additions to
existing suites:

- `GoogleDriveHookHandler.test.mjs` — early-return for feature-off, unlinked
  project, ignored path, and `source === 'google-drive'` (loop guard);
  correct `pendingChanges` upsert; path key encoding; upsert-after-delete
  collapse; hook errors swallowed.
- `GoogleDriveOutboundWorker.test.mjs` — debounce window respected; only dirty
  paths pushed (no full-tree call); per-entry removal on success and retention
  on failure; `attempts` cap; lock contention skip; rename-pair detection;
  divergence check deferring to inbound; backoff skip.
- `GoogleDriveWatchManager.test.mjs` — channel create/reuse/replace/stop; token
  derivation; no-op without a webhook URL; expiry persistence.
- `GoogleDriveChannelRenewalWorker.test.mjs` — renews near-expiry channels,
  backfills missing ones, survives per-user errors.
- `GoogleDriveWebhookController.test.mjs` — `sync` ping ignored; unknown channel
  dropped; bad token rejected; valid notification schedules a debounced poll;
  always responds `200` fast.
- `GoogleDriveSyncManager.test.mjs` (additions) — conflict detection matrix
  (neither/one/both sides changed); conflict path written and recorded;
  rename-by-ID and move-by-ID instead of delete+add; unknown file ID falls back;
  duplicate folder-name suffixing; collision against a trashed project;
  suspension when unresolvable.
- `GoogleDriveClient.test.mjs` (additions) — `requestWithRetry` retries the
  right statuses and not the wrong ones; honours `Retry-After`; token bucket
  limits throughput; `watchChannels` / `stopChannel` payloads.
- `GoogleDriveRouter.test.mjs` (additions) — webhook mounted only with feature
  on *and* webhook URL set; CSRF disabled for it; conflict-dismiss route mounted
  with the correct authorization middleware.
- `GoogleDrivePollingWorker.test.mjs` (additions) — watched users polled at the
  reduced ratio; unwatched users every cycle.

Frontend tests:

- `google-drive-modal.test.tsx` (additions) — conflict banner renders and
  dismisses; suspended state renders without a "Sync now" button.

Acceptance tests are deferred to manual verification against the dev server.

---

## 13. Implementation Sequencing

The work is one coherent feature but splits into independently shippable
phases, each leaving the module in a working state. The implementation plan
should follow this order:

1. **Data model + rate-limit foundation** — schema additions, `requestWithRetry`,
   the token bucket, configurable manual cooldown, per-project backoff. Nothing
   observable changes; everything after this depends on it.
2. **Outbound dirty set + batch worker** — the hook consumer and
   `GoogleDriveOutboundWorker`. This alone restores automatic outbound sync,
   which the module currently lacks entirely, and is the highest-value phase.
3. **Inbound push notifications** — `GoogleDriveWatchManager`, the renewal
   worker, the webhook route, and the polling worker's fallback behaviour.
4. **Data-integrity behaviours** — conflict copies, rename/move by Drive file
   ID, duplicate-name resolution, and the associated UI states.

Phases 2 and 3 are independent of each other and could be built in parallel;
phase 4 depends on `fileMap` carrying `entityId` / `entityType`, which phase 2
introduces.
