# Google Drive Sync — Inbound Push Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Google Drive `changes.watch` push notifications to provide near-instant (sub-10s) inbound synchronization from Google Drive to Overleaf, backed by an hourly channel renewal worker and a polling fallback.

**Architecture:** When a public webhook URL is configured (`GOOGLE_DRIVE_WEBHOOK_URL`), `GoogleDriveWatchManager` establishes a watch channel on Drive's `changes.watch` endpoint with a cryptographically signed HMAC token. When a remote file change occurs, Google sends a push notification to `POST /google-drive/webhook`. `GoogleDriveWebhookController` verifies the channel token, discards handshake pings, and triggers a debounced `pollUserChanges` for that user. An hourly `GoogleDriveChannelRenewalWorker` renews channels before they expire (24h threshold), and `GoogleDrivePollingWorker` continues operating as a fallback safety net (polling watched users at a reduced ratio, and unwatched users every cycle).

**Tech Stack:** Node.js ESM, Express, MongoDB, Vitest with `vi.doMock` + dynamic import, `@overleaf/settings`, `@overleaf/logger`, `@overleaf/o-error`, `@overleaf/fetch-utils`, Node.js `crypto` (`timingSafeEqual`, `createHmac`, `randomUUID`).

**Spec:** `overleaf/docs/superpowers/specs/2026-09-02-google-drive-sync-dropbox-parity-design.md` — implements **Phase 3** (§3, §9.1, §10).

## Global Constraints

- **Working directory for every command is `overleaf/services/web`.** All paths in this plan are relative to it unless stated otherwise.
- **Test command is `npx vitest run <path>`.** The npm/yarn registry is BLOCKED in this environment; `yarn test:unit` will fail. `npx` resolves the already-installed vitest 4.1.5.
- **Feature must remain disabled by default.** `ENABLE_GOOGLE_DRIVE_SYNC` defaults to `false`. Every new worker, router, and controller returns immediately when `Features.hasFeature('google-drive-sync')` is false.
- **When `GOOGLE_DRIVE_WEBHOOK_URL` is empty**, push channel creation and renewal are dormant, and the polling worker handles all users without errors.
- **Never commit.** This repository reserves all git operations for the user. Steps that would normally commit instead say "stop and report" — the user commits.
- **All new schema fields are optional with defaults**, so existing documents keep working without migration.
- **ESM only.** Use `import` / `export`, `.mjs` extensions, and `export default X` plus named exports, matching every existing file in `Features/GoogleDriveSync/`.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `app/src/Features/GoogleDriveSync/GoogleDriveWatchManager.mjs` | Channel creation, token derivation (HMAC-SHA256), channel teardown. |
| `app/src/Features/GoogleDriveSync/GoogleDriveWebhookController.mjs` | Handles Google push notifications, validates tokens with `timingSafeEqual`, debounces polling. |
| `app/src/Features/GoogleDriveSync/GoogleDriveChannelRenewalWorker.mjs` | Hourly background worker that renews watch channels expiring within 24h. |
| `test/unit/src/Features/GoogleDriveSync/GoogleDriveWatchManager.test.mjs` | Unit tests for watch channel manager. |
| `test/unit/src/Features/GoogleDriveSync/GoogleDriveWebhookController.test.mjs` | Unit tests for webhook controller. |
| `test/unit/src/Features/GoogleDriveSync/GoogleDriveChannelRenewalWorker.test.mjs` | Unit tests for channel renewal worker. |

**Modified:**

| File | Change |
|---|---|
| `app/src/infrastructure/mongodb.mjs` | Add `watchChannelId`, `watchResourceId`, `watchChannelToken`, `watchExpiresAt` to `GoogleDriveUserCredentialsSchema`. |
| `config/settings.defaults.js` | Add `webhookUrl`, `webhookSecret`, `channelRenewIntervalSeconds`, `watchedUserPollRatio` to `Settings.googleDrive`. |
| `develop/dev.env` | Add default environment variables for push configuration. |
| `app/src/Features/GoogleDriveSync/GoogleDriveClient.mjs` | Add `watchChanges(userId, pageToken, channelData)` and `stopChannel(userId, channelId, resourceId)`. |
| `test/unit/src/Features/GoogleDriveSync/GoogleDriveClient.test.mjs` | Add tests for `watchChanges` and `stopChannel`. |
| `app/src/Features/GoogleDriveSync/GoogleDriveRouter.mjs` | Accept `publicApiRouter`; mount `POST /google-drive/webhook` with CSRF disabled. |
| `app/src/router.mjs` | Pass `publicApiRouter` to `GoogleDriveRouter.apply(webRouter, privateApiRouter, publicApiRouter)`. |
| `test/unit/src/Features/GoogleDriveSync/GoogleDriveRouter.test.mjs` | Add tests for webhook route mounting and CSRF disablement. |
| `app/src/Features/GoogleDriveSync/GoogleDrivePollingWorker.mjs` | Poll watched users at `watchedUserPollRatio` frequency, unwatched users every cycle. |
| `test/unit/src/Features/GoogleDriveSync/GoogleDrivePollingWorker.test.mjs` | Add tests for watched vs unwatched poll ratio. |
| `app/src/Features/GoogleDriveSync/GoogleDriveOAuthManager.mjs` | Call `ensureChannel` on account link; call `stopChannel` on account unlink. |
| `test/unit/src/Features/GoogleDriveSync/GoogleDriveOAuthManager.test.mjs` | Add tests for watch channel setup and teardown on link/unlink. |
| `app/src/Features/GoogleDriveSync/index.mjs` | Start `GoogleDriveChannelRenewalWorker` in `start()`. |
| `test/unit/src/Features/GoogleDriveSync/index.test.mjs` | Add test verifying renewal worker starts. |

**Task dependency order:** 1 → 2 → 3 → 4 → 5 → 6.

---

## Task 1: Schema, settings, and Drive client watch endpoints

Adds watch fields to user credentials schema, adds push configuration settings, and adds `watchChanges` and `stopChannel` methods to `GoogleDriveClient.mjs`.

**Files:**
- Modify: `app/src/infrastructure/mongodb.mjs:125-140` (`GoogleDriveUserCredentialsSchema`)
- Modify: `config/settings.defaults.js:1150-1175` (`googleDrive` settings)
- Modify: `develop/dev.env`
- Modify: `app/src/Features/GoogleDriveSync/GoogleDriveClient.mjs`
- Test: `test/unit/src/Features/GoogleDriveSync/GoogleDriveClient.test.mjs`

**Interfaces:**
- Consumes: `Settings.googleDrive.webhookUrl`, `Settings.googleDrive.webhookSecret`.
- Produces:
  - `GoogleDriveClient.watchChanges(userId, pageToken, channelData): Promise<object>`
  - `GoogleDriveClient.stopChannel(userId, channelId, resourceId): Promise<void>`
  - Schema fields on `GoogleDriveUserCredentials`: `watchChannelId`, `watchResourceId`, `watchChannelToken`, `watchExpiresAt`.

- [ ] **Step 1: Write the failing tests in `GoogleDriveClient.test.mjs`**

Add this describe block inside `describe('GoogleDriveClient', ...)` in `test/unit/src/Features/GoogleDriveSync/GoogleDriveClient.test.mjs`:

```javascript
  describe('watchChanges and stopChannel', () => {
    it('calls changes.watch with correct headers and payload', async () => {
      fetchUtils.fetchJson.mockResolvedValue({
        kind: 'api#channel',
        id: 'chan-123',
        resourceId: 'res-456',
        expiration: '1756800000000',
      })

      const channelData = {
        id: 'chan-123',
        type: 'web_hook',
        address: 'https://example.com/google-drive/webhook',
        token: 'signed-token',
      }

      const res = await GoogleDriveClient.watchChanges(
        userId,
        'page-token-1',
        channelData
      )

      expect(fetchUtils.fetchJson).toHaveBeenCalledWith(
        'https://www.googleapis.com/drive/v3/changes/watch?pageToken=page-token-1',
        expect.objectContaining({
          method: 'POST',
          json: channelData,
          headers: expect.objectContaining({
            Authorization: `Bearer ${validAccessToken}`,
          }),
        })
      )
      expect(res.id).toBe('chan-123')
      expect(res.resourceId).toBe('res-456')
    })

    it('calls channels.stop with channel id and resource id', async () => {
      fetchUtils.fetchNothing.mockResolvedValue()

      await GoogleDriveClient.stopChannel(userId, 'chan-123', 'res-456')

      expect(fetchUtils.fetchNothing).toHaveBeenCalledWith(
        'https://www.googleapis.com/drive/v3/channels/stop',
        expect.objectContaining({
          method: 'POST',
          json: {
            id: 'chan-123',
            resourceId: 'res-456',
          },
          headers: expect.objectContaining({
            Authorization: `Bearer ${validAccessToken}`,
          }),
        })
      )
    })
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/src/Features/GoogleDriveSync/GoogleDriveClient.test.mjs -t "watchChanges and stopChannel"`
Expected: FAIL — `GoogleDriveClient.watchChanges is not a function`.

- [ ] **Step 3: Update `mongodb.mjs` schema**

In `app/src/infrastructure/mongodb.mjs`, update `GoogleDriveUserCredentialsSchema`:

```javascript
export const GoogleDriveUserCredentialsSchema = new Schema(
  {
    user_id: { type: ObjectId, ref: 'User', index: true, unique: true },
    googleEmail: String,
    googleUserId: String,
    encryptedAccessToken: String,
    encryptedRefreshToken: String,
    tokenExpiry: Date,
    rootFolderId: String,
    startPageToken: String,
    watchChannelId: { type: String, index: true },
    watchResourceId: String,
    watchChannelToken: String,
    watchExpiresAt: Date,
    linkedAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { collection: 'googleDriveUserCredentials' }
)
```

- [ ] **Step 4: Update `config/settings.defaults.js`**

In `config/settings.defaults.js`, update the `googleDrive` block:

```javascript
  googleDrive: {
    clientId: process.env.GOOGLE_DRIVE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_DRIVE_CLIENT_SECRET || '',
    redirectUri:
      process.env.GOOGLE_DRIVE_REDIRECT_URI ||
      `${siteUrl}/auth/google-drive/callback`,
    folderName: process.env.GOOGLE_DRIVE_FOLDER_NAME || 'Overleaf',
    webhookUrl: process.env.GOOGLE_DRIVE_WEBHOOK_URL || '',
    webhookSecret: process.env.GOOGLE_DRIVE_WEBHOOK_SECRET || '',
    pollIntervalSeconds: intFromEnv('GOOGLE_DRIVE_POLL_INTERVAL_SECONDS', 300),
    outboundFlushSeconds: intFromEnv(
      'GOOGLE_DRIVE_OUTBOUND_FLUSH_SECONDS',
      600
    ),
    outboundDebounceSeconds: intFromEnv(
      'GOOGLE_DRIVE_OUTBOUND_DEBOUNCE_SECONDS',
      15
    ),
    channelRenewIntervalSeconds: intFromEnv(
      'GOOGLE_DRIVE_CHANNEL_RENEW_INTERVAL_SECONDS',
      3600
    ),
    watchedUserPollRatio: intFromEnv(
      'GOOGLE_DRIVE_WATCHED_USER_POLL_RATIO',
      10
    ),
    maxRps: intFromEnv('GOOGLE_DRIVE_MAX_RPS', 8),
    manualSyncCooldownSeconds: intFromEnv(
      'GOOGLE_DRIVE_MANUAL_SYNC_COOLDOWN_SECONDS',
      60
    ),
  },
```

- [ ] **Step 5: Update `develop/dev.env`**

In `develop/dev.env`, add:

```
GOOGLE_DRIVE_WEBHOOK_URL=
GOOGLE_DRIVE_WEBHOOK_SECRET=
GOOGLE_DRIVE_CHANNEL_RENEW_INTERVAL_SECONDS=3600
GOOGLE_DRIVE_WATCHED_USER_POLL_RATIO=10
```

- [ ] **Step 6: Implement `watchChanges` and `stopChannel` in `GoogleDriveClient.mjs`**

In `app/src/Features/GoogleDriveSync/GoogleDriveClient.mjs`, add the two methods and export them:

```javascript
/**
 * Sets up a watch channel for changes on Google Drive.
 *
 * @param {string|ObjectId} userId
 * @param {string} pageToken
 * @param {{ id: string, type: string, address: string, token?: string, expiration?: number }} channelData
 * @returns {Promise<object>} Google Drive channel response
 */
async function watchChanges(userId, pageToken, channelData) {
  const accessToken = await GoogleDriveOAuthManager.getValidAccessToken(userId)
  const url = `${DRIVE_API_BASE}/changes/watch?pageToken=${encodeURIComponent(pageToken)}`

  return _requestWithRetry(() =>
    fetchJson(url, {
      method: 'POST',
      json: channelData,
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    })
  )
}

/**
 * Stops an active watch channel on Google Drive.
 *
 * @param {string|ObjectId} userId
 * @param {string} channelId
 * @param {string} resourceId
 * @returns {Promise<void>}
 */
async function stopChannel(userId, channelId, resourceId) {
  const accessToken = await GoogleDriveOAuthManager.getValidAccessToken(userId)
  const url = `${DRIVE_API_BASE}/channels/stop`

  return _requestWithRetry(() =>
    fetchNothing(url, {
      method: 'POST',
      json: {
        id: channelId,
        resourceId,
      },
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    })
  )
}
```

Add `watchChanges` and `stopChannel` to `GoogleDriveClient` object and the export block.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run test/unit/src/Features/GoogleDriveSync/GoogleDriveClient.test.mjs`
Expected: PASS, all 33 tests.

- [ ] **Step 8: Stop and report**

Do not commit. Report and wait.

---

## Task 2: GoogleDriveWatchManager

Manages watch channel creation, HMAC token derivation, and channel termination.

**Files:**
- Create: `app/src/Features/GoogleDriveSync/GoogleDriveWatchManager.mjs`
- Test: `test/unit/src/Features/GoogleDriveSync/GoogleDriveWatchManager.test.mjs`

**Interfaces:**
- Consumes: `Settings.googleDrive.webhookUrl`, `Settings.googleDrive.webhookSecret`, `GoogleDriveClient.watchChanges`, `GoogleDriveClient.stopChannel`, `GoogleDriveClient.getStartPageToken`, `db.googleDriveUserCredentials`.
- Produces:
  - `GoogleDriveWatchManager.deriveChannelToken(userId): string`
  - `GoogleDriveWatchManager.ensureChannel(userId): Promise<{ success?: boolean, skipped?: string, reused?: boolean, channelId?: string }>`
  - `GoogleDriveWatchManager.stopChannel(userId): Promise<{ success?: boolean, skipped?: string }>`

- [ ] **Step 1: Write the failing test**

Create `test/unit/src/Features/GoogleDriveSync/GoogleDriveWatchManager.test.mjs`:

```javascript
import { describe, it, beforeEach, vi, expect } from 'vitest'

const modulePath =
  '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveWatchManager.mjs'

describe('GoogleDriveWatchManager', () => {
  let GoogleDriveWatchManager

  const userId = '60d5ecb8b392d40015b6d5a1'

  const Settings = {
    encryption: {
      userOAuthTokensSecret: 'default-secret-key-for-test-only',
    },
    googleDrive: {
      webhookUrl: 'https://overleaf.example.com/google-drive/webhook',
      webhookSecret: '',
    },
  }

  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }

  const Features = { hasFeature: vi.fn() }

  const db = {
    googleDriveUserCredentials: {
      findOne: vi.fn(),
      updateOne: vi.fn(),
    },
  }

  const GoogleDriveClient = {
    getStartPageToken: vi.fn(),
    watchChanges: vi.fn(),
    stopChannel: vi.fn(),
  }

  vi.doMock('@overleaf/settings', () => ({ default: Settings }))
  vi.doMock('@overleaf/logger', () => ({ default: logger }))
  vi.doMock('../../../../../app/src/infrastructure/Features.mjs', () => ({
    default: Features,
  }))
  vi.doMock('../../../../../app/src/infrastructure/mongodb.mjs', () => ({
    db,
  }))
  vi.doMock(
    '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveClient.mjs',
    () => ({ default: GoogleDriveClient, ...GoogleDriveClient })
  )

  beforeEach(async () => {
    vi.clearAllMocks()
    Features.hasFeature.mockReturnValue(true)
    Settings.googleDrive.webhookUrl =
      'https://overleaf.example.com/google-drive/webhook'
    Settings.googleDrive.webhookSecret = 'test-secret'

    const mod = await import(modulePath)
    GoogleDriveWatchManager = mod.default
  })

  describe('deriveChannelToken', () => {
    it('returns a deterministic HMAC token for a user', () => {
      const token1 = GoogleDriveWatchManager.deriveChannelToken(userId)
      const token2 = GoogleDriveWatchManager.deriveChannelToken(userId)
      expect(token1).toBe(token2)
      expect(typeof token1).toBe('string')
      expect(token1.length).toBeGreaterThan(16)
    })

    it('returns distinct tokens for different users', () => {
      const token1 = GoogleDriveWatchManager.deriveChannelToken(userId)
      const token2 = GoogleDriveWatchManager.deriveChannelToken(
        '60d5ecb8b392d40015b6d5a2'
      )
      expect(token1).not.toBe(token2)
    })
  })

  describe('ensureChannel', () => {
    it('skips channel creation if webhookUrl is empty', async () => {
      Settings.googleDrive.webhookUrl = ''
      const res = await GoogleDriveWatchManager.ensureChannel(userId)
      expect(res).toEqual({ skipped: 'no-webhook-url' })
      expect(GoogleDriveClient.watchChanges).not.toHaveBeenCalled()
    })

    it('skips channel creation if user credentials not found', async () => {
      db.googleDriveUserCredentials.findOne.mockResolvedValue(null)
      const res = await GoogleDriveWatchManager.ensureChannel(userId)
      expect(res).toEqual({ skipped: 'unlinked' })
    })

    it('reuses active channel if expiration is > 24 hours in the future', async () => {
      const futureDate = new Date(Date.now() + 48 * 60 * 60 * 1000)
      db.googleDriveUserCredentials.findOne.mockResolvedValue({
        user_id: userId,
        watchChannelId: 'existing-chan-id',
        watchExpiresAt: futureDate,
      })

      const res = await GoogleDriveWatchManager.ensureChannel(userId)
      expect(res).toEqual({ reused: true })
      expect(GoogleDriveClient.watchChanges).not.toHaveBeenCalled()
    })

    it('creates a new channel and persists credentials when no active channel exists', async () => {
      db.googleDriveUserCredentials.findOne.mockResolvedValue({
        user_id: userId,
        startPageToken: 'start-page-123',
      })
      GoogleDriveClient.watchChanges.mockResolvedValue({
        id: 'new-chan-id',
        resourceId: 'res-id-999',
        expiration: String(Date.now() + 7 * 24 * 60 * 60 * 1000),
      })

      const res = await GoogleDriveWatchManager.ensureChannel(userId)

      expect(GoogleDriveClient.watchChanges).toHaveBeenCalledWith(
        userId,
        'start-page-123',
        expect.objectContaining({
          type: 'web_hook',
          address: 'https://overleaf.example.com/google-drive/webhook',
          token: expect.any(String),
        })
      )
      expect(db.googleDriveUserCredentials.updateOne).toHaveBeenCalledWith(
        expect.objectContaining({ user_id: expect.anything() }),
        expect.objectContaining({
          $set: expect.objectContaining({
            watchResourceId: 'res-id-999',
            watchExpiresAt: expect.any(Date),
          }),
        })
      )
      expect(res.success).toBe(true)
    })

    it('stops old channel before creating a new one when replacing an expired channel', async () => {
      const pastDate = new Date(Date.now() - 1000)
      db.googleDriveUserCredentials.findOne.mockResolvedValue({
        user_id: userId,
        startPageToken: 'start-page-123',
        watchChannelId: 'old-chan-id',
        watchResourceId: 'old-res-id',
        watchExpiresAt: pastDate,
      })
      GoogleDriveClient.watchChanges.mockResolvedValue({
        id: 'new-chan-id',
        resourceId: 'new-res-id',
        expiration: String(Date.now() + 7 * 24 * 60 * 60 * 1000),
      })

      await GoogleDriveWatchManager.ensureChannel(userId)

      expect(GoogleDriveClient.stopChannel).toHaveBeenCalledWith(
        userId,
        'old-chan-id',
        'old-res-id'
      )
      expect(GoogleDriveClient.watchChanges).toHaveBeenCalled()
    })
  })

  describe('stopChannel', () => {
    it('stops active channel and clears watch fields from database', async () => {
      db.googleDriveUserCredentials.findOne.mockResolvedValue({
        user_id: userId,
        watchChannelId: 'chan-to-stop',
        watchResourceId: 'res-to-stop',
      })

      const res = await GoogleDriveWatchManager.stopChannel(userId)

      expect(GoogleDriveClient.stopChannel).toHaveBeenCalledWith(
        userId,
        'chan-to-stop',
        'res-to-stop'
      )
      expect(db.googleDriveUserCredentials.updateOne).toHaveBeenCalledWith(
        expect.objectContaining({ user_id: expect.anything() }),
        expect.objectContaining({
          $unset: {
            watchChannelId: '',
            watchResourceId: '',
            watchChannelToken: '',
            watchExpiresAt: '',
          },
        })
      )
      expect(res).toEqual({ success: true })
    })

    it('skips stop if no active channel exists', async () => {
      db.googleDriveUserCredentials.findOne.mockResolvedValue({
        user_id: userId,
      })

      const res = await GoogleDriveWatchManager.stopChannel(userId)

      expect(GoogleDriveClient.stopChannel).not.toHaveBeenCalled()
      expect(res).toEqual({ skipped: 'no-active-channel' })
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/src/Features/GoogleDriveSync/GoogleDriveWatchManager.test.mjs`
Expected: FAIL — `Cannot find module .../GoogleDriveWatchManager.mjs`.

- [ ] **Step 3: Implement `GoogleDriveWatchManager.mjs`**

Create `app/src/Features/GoogleDriveSync/GoogleDriveWatchManager.mjs`:

```javascript
import crypto from 'node:crypto'
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import { db, ObjectId } from '../../infrastructure/mongodb.mjs'
import GoogleDriveClient from './GoogleDriveClient.mjs'

const CHANNEL_RENEW_THRESHOLD_MS = 24 * 60 * 60 * 1000 // 24 hours

function _toObjectId(id) {
  if (!id) return null
  if (typeof id === 'object' && id._bsontype === 'ObjectID') return id
  if (typeof id === 'string' && ObjectId?.isValid?.(id)) {
    try {
      return new ObjectId(id)
    } catch {
      return id
    }
  }
  return id
}

function _getWebhookSecret() {
  return (
    Settings.googleDrive?.webhookSecret ||
    Settings.encryption?.userOAuthTokensSecret ||
    'overleaf-gdrive-webhook-default'
  )
}

const GoogleDriveWatchManager = {
  /**
   * Derives an HMAC-SHA256 token for validating inbound webhook notifications for a user.
   *
   * @param {string|ObjectId} userId
   * @returns {string}
   */
  deriveChannelToken(userId) {
    const secret = _getWebhookSecret()
    return crypto
      .createHmac('sha256', secret)
      .update(String(userId))
      .digest('hex')
  },

  /**
   * Ensures the user has an active Google Drive push notification watch channel.
   * Creates a new one if missing or expiring within 24h.
   *
   * @param {string|ObjectId} userId
   * @returns {Promise<{ success?: boolean, skipped?: string, reused?: boolean, channelId?: string }>}
   */
  async ensureChannel(userId) {
    const webhookUrl = Settings.googleDrive?.webhookUrl
    if (!webhookUrl) {
      return { skipped: 'no-webhook-url' }
    }

    const userObjectId = _toObjectId(userId)
    const creds = await db.googleDriveUserCredentials.findOne({
      user_id: userObjectId,
    })

    if (!creds) {
      return { skipped: 'unlinked' }
    }

    const now = Date.now()
    if (
      creds.watchChannelId &&
      creds.watchExpiresAt &&
      new Date(creds.watchExpiresAt).getTime() - now > CHANNEL_RENEW_THRESHOLD_MS
    ) {
      return { reused: true }
    }

    // If an existing channel exists, stop it before creating a new one
    if (creds.watchChannelId && creds.watchResourceId) {
      try {
        await GoogleDriveClient.stopChannel(
          userId,
          creds.watchChannelId,
          creds.watchResourceId
        )
      } catch (err) {
        logger.warn(
          { err, userId, channelId: creds.watchChannelId },
          'GoogleDriveWatchManager: failed to stop old watch channel during renewal (ignoring)'
        )
      }
    }

    let pageToken = creds.startPageToken
    if (!pageToken) {
      pageToken = await GoogleDriveClient.getStartPageToken(userId)
      await db.googleDriveUserCredentials.updateOne(
        { user_id: userObjectId },
        { $set: { startPageToken: pageToken } }
      )
    }

    const channelId = crypto.randomUUID()
    const channelToken = GoogleDriveWatchManager.deriveChannelToken(userId)

    const watchRes = await GoogleDriveClient.watchChanges(userId, pageToken, {
      id: channelId,
      type: 'web_hook',
      address: webhookUrl,
      token: channelToken,
    })

    const expiresAt = watchRes.expiration
      ? new Date(parseInt(watchRes.expiration, 10))
      : new Date(now + 7 * 24 * 60 * 60 * 1000)

    await db.googleDriveUserCredentials.updateOne(
      { user_id: userObjectId },
      {
        $set: {
          watchChannelId: channelId,
          watchResourceId: watchRes.resourceId,
          watchChannelToken: channelToken,
          watchExpiresAt: expiresAt,
          updatedAt: new Date(),
        },
      }
    )

    logger.info(
      { userId, channelId, resourceId: watchRes.resourceId, expiresAt },
      'GoogleDriveWatchManager: established new Google Drive watch channel'
    )

    return { success: true, channelId }
  },

  /**
   * Stops an active watch channel on Google Drive and unsets watch metadata.
   *
   * @param {string|ObjectId} userId
   * @returns {Promise<{ success?: boolean, skipped?: string }>}
   */
  async stopChannel(userId) {
    const userObjectId = _toObjectId(userId)
    const creds = await db.googleDriveUserCredentials.findOne({
      user_id: userObjectId,
    })

    if (!creds || !creds.watchChannelId || !creds.watchResourceId) {
      return { skipped: 'no-active-channel' }
    }

    try {
      await GoogleDriveClient.stopChannel(
        userId,
        creds.watchChannelId,
        creds.watchResourceId
      )
    } catch (err) {
      logger.warn(
        { err, userId, channelId: creds.watchChannelId },
        'GoogleDriveWatchManager: failed to stop channel with Drive API (proceeding with local cleanup)'
      )
    }

    await db.googleDriveUserCredentials.updateOne(
      { user_id: userObjectId },
      {
        $unset: {
          watchChannelId: '',
          watchResourceId: '',
          watchChannelToken: '',
          watchExpiresAt: '',
        },
      }
    )

    logger.info(
      { userId, channelId: creds.watchChannelId },
      'GoogleDriveWatchManager: stopped and removed watch channel'
    )

    return { success: true }
  },
}

export default GoogleDriveWatchManager
export { GoogleDriveWatchManager }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/src/Features/GoogleDriveSync/GoogleDriveWatchManager.test.mjs`
Expected: PASS, all 8 tests.

- [ ] **Step 5: Stop and report**

Do not commit. Report and wait.

---

## Task 3: Webhook Controller and Router Mounting

Implements the HTTP webhook receiver with constant-time token verification, ping handling, debounced polling invocation, and mounts the endpoint.

**Files:**
- Create: `app/src/Features/GoogleDriveSync/GoogleDriveWebhookController.mjs`
- Test: `test/unit/src/Features/GoogleDriveSync/GoogleDriveWebhookController.test.mjs`
- Modify: `app/src/Features/GoogleDriveSync/GoogleDriveRouter.mjs`
- Modify: `app/src/router.mjs:507`
- Test: `test/unit/src/Features/GoogleDriveSync/GoogleDriveRouter.test.mjs`

**Interfaces:**
- Consumes: `db.googleDriveUserCredentials`, `GoogleDriveSyncManager.pollUserChanges(userId)`.
- Produces: `GoogleDriveWebhookController.handleWebhook(req, res): Promise<void>`.
- Route: `POST /google-drive/webhook` on `publicApiRouter` with CSRF disabled.

- [ ] **Step 1: Write the failing tests for `GoogleDriveWebhookController`**

Create `test/unit/src/Features/GoogleDriveSync/GoogleDriveWebhookController.test.mjs`:

```javascript
import { describe, it, beforeEach, vi, expect } from 'vitest'

const modulePath =
  '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveWebhookController.mjs'

describe('GoogleDriveWebhookController', () => {
  let GoogleDriveWebhookController

  const userId = '60d5ecb8b392d40015b6d5a1'

  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }

  const db = {
    googleDriveUserCredentials: {
      findOne: vi.fn(),
    },
  }

  const GoogleDriveSyncManager = {
    pollUserChanges: vi.fn(),
  }

  vi.doMock('@overleaf/logger', () => ({ default: logger }))
  vi.doMock('../../../../../app/src/infrastructure/mongodb.mjs', () => ({
    db,
  }))
  vi.doMock(
    '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveSyncManager.mjs',
    () => ({ default: GoogleDriveSyncManager, ...GoogleDriveSyncManager })
  )

  let req, res

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.useRealTimers()

    req = {
      headers: {
        'x-goog-channel-id': 'chan-123',
        'x-goog-channel-token': 'valid-token-secret-123',
        'x-goog-resource-state': 'change',
      },
    }

    res = {
      sendStatus: vi.fn().mockReturnThis(),
      status: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    }

    const mod = await import(modulePath)
    GoogleDriveWebhookController = mod.default
  })

  it('responds 200 and ignores if channel id is missing', async () => {
    req.headers['x-goog-channel-id'] = undefined

    await GoogleDriveWebhookController.handleWebhook(req, res)

    expect(res.sendStatus).toHaveBeenCalledWith(200)
    expect(GoogleDriveSyncManager.pollUserChanges).not.toHaveBeenCalled()
  })

  it('responds 200 and drops if credentials not found for channel id', async () => {
    db.googleDriveUserCredentials.findOne.mockResolvedValue(null)

    await GoogleDriveWebhookController.handleWebhook(req, res)

    expect(res.sendStatus).toHaveBeenCalledWith(200)
    expect(GoogleDriveSyncManager.pollUserChanges).not.toHaveBeenCalled()
  })

  it('responds 200 and drops if token signature mismatch', async () => {
    db.googleDriveUserCredentials.findOne.mockResolvedValue({
      user_id: userId,
      watchChannelToken: 'different-token',
    })

    await GoogleDriveWebhookController.handleWebhook(req, res)

    expect(res.sendStatus).toHaveBeenCalledWith(200)
    expect(logger.warn).toHaveBeenCalled()
    expect(GoogleDriveSyncManager.pollUserChanges).not.toHaveBeenCalled()
  })

  it('responds 200 immediately on sync handshake ping without polling', async () => {
    req.headers['x-goog-resource-state'] = 'sync'
    db.googleDriveUserCredentials.findOne.mockResolvedValue({
      user_id: userId,
      watchChannelToken: 'valid-token-secret-123',
    })

    await GoogleDriveWebhookController.handleWebhook(req, res)

    expect(res.sendStatus).toHaveBeenCalledWith(200)
    expect(GoogleDriveSyncManager.pollUserChanges).not.toHaveBeenCalled()
  })

  it('responds 200 immediately and schedules debounced poll on valid change event', async () => {
    db.googleDriveUserCredentials.findOne.mockResolvedValue({
      user_id: userId,
      watchChannelToken: 'valid-token-secret-123',
    })

    await GoogleDriveWebhookController.handleWebhook(req, res)

    expect(res.sendStatus).toHaveBeenCalledWith(200)
    // Fast response before poll finishes
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(GoogleDriveSyncManager.pollUserChanges).toHaveBeenCalledWith(userId)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/src/Features/GoogleDriveSync/GoogleDriveWebhookController.test.mjs`
Expected: FAIL — `Cannot find module .../GoogleDriveWebhookController.mjs`.

- [ ] **Step 3: Implement `GoogleDriveWebhookController.mjs`**

Create `app/src/Features/GoogleDriveSync/GoogleDriveWebhookController.mjs`:

```javascript
import crypto from 'node:crypto'
import logger from '@overleaf/logger'
import { db } from '../../infrastructure/mongodb.mjs'
import GoogleDriveSyncManager from './GoogleDriveSyncManager.mjs'

const activeTimers = new Map()
const inFlightPolls = new Set()
const pendingRePolls = new Set()

/**
 * Triggers a debounced changes poll for the user.
 *
 * @param {string} userIdStr
 * @param {number} [debounceMs=20]
 */
function _scheduleUserPoll(userIdStr, debounceMs = 20) {
  if (activeTimers.has(userIdStr)) {
    clearTimeout(activeTimers.get(userIdStr))
  }

  const timer = setTimeout(async () => {
    activeTimers.delete(userIdStr)

    if (inFlightPolls.has(userIdStr)) {
      pendingRePolls.add(userIdStr)
      return
    }

    inFlightPolls.add(userIdStr)
    try {
      await GoogleDriveSyncManager.pollUserChanges(userIdStr)
    } catch (err) {
      logger.error(
        { err, userId: userIdStr },
        'GoogleDriveWebhookController: error executing webhook-triggered poll'
      )
    } finally {
      inFlightPolls.delete(userIdStr)
      if (pendingRePolls.has(userIdStr)) {
        pendingRePolls.delete(userIdStr)
        _scheduleUserPoll(userIdStr, 0)
      }
    }
  }, debounceMs)

  if (typeof timer.unref === 'function') {
    timer.unref()
  }
  activeTimers.set(userIdStr, timer)
}

const GoogleDriveWebhookController = {
  /**
   * Handles inbound Google Drive push notification POST requests.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   */
  async handleWebhook(req, res) {
    const channelId = req.headers['x-goog-channel-id']
    const channelToken = req.headers['x-goog-channel-token']
    const resourceState = req.headers['x-goog-resource-state']

    if (!channelId || !channelToken) {
      return res.sendStatus(200)
    }

    let creds
    try {
      creds = await db.googleDriveUserCredentials.findOne({
        watchChannelId: channelId,
      })
    } catch (err) {
      logger.error(
        { err, channelId },
        'GoogleDriveWebhookController: db error resolving channel'
      )
      return res.sendStatus(200)
    }

    if (!creds || !creds.watchChannelToken) {
      return res.sendStatus(200)
    }

    const expectedBuf = Buffer.from(creds.watchChannelToken)
    const actualBuf = Buffer.from(channelToken)

    if (
      expectedBuf.length !== actualBuf.length ||
      !crypto.timingSafeEqual(expectedBuf, actualBuf)
    ) {
      logger.warn(
        { channelId, userId: creds.user_id },
        'GoogleDriveWebhookController: invalid channel token on webhook notification'
      )
      return res.sendStatus(200)
    }

    // Google sends 'sync' on channel creation as a handshake ping
    if (resourceState === 'sync') {
      logger.debug(
        { channelId, userId: creds.user_id },
        'GoogleDriveWebhookController: received channel sync handshake ping'
      )
      return res.sendStatus(200)
    }

    const userIdStr = creds.user_id.toString()
    _scheduleUserPoll(userIdStr, 20)

    return res.sendStatus(200)
  },
}

export default GoogleDriveWebhookController
export { GoogleDriveWebhookController }
```

- [ ] **Step 4: Update `GoogleDriveRouter.mjs` and `router.mjs`**

In `app/src/Features/GoogleDriveSync/GoogleDriveRouter.mjs`:

```javascript
import Features from '../../infrastructure/Features.mjs'
import AuthenticationController from '../Authentication/AuthenticationController.mjs'
import AuthorizationMiddleware from '../Authorization/AuthorizationMiddleware.mjs'
import GoogleDriveController from './GoogleDriveController.mjs'
import GoogleDriveWebhookController from './GoogleDriveWebhookController.mjs'

/**
 * Express router configuration for Google Drive Synchronization endpoints.
 */
const GoogleDriveRouter = {
  /**
   * Mounts Google Drive routes onto webRouter and publicApiRouter.
   *
   * @param {import('express').Router} webRouter
   * @param {import('express').Router} [publicApiRouter]
   */
  apply(webRouter, publicApiRouter) {
    if (!Features.hasFeature('google-drive-sync')) {
      return
    }

    // 1. Inbound Webhook (Google push notifications)
    if (publicApiRouter) {
      if (webRouter.csrf?.disableDefaultCsrfProtection) {
        webRouter.csrf.disableDefaultCsrfProtection(
          '/google-drive/webhook',
          'POST'
        )
      }
      publicApiRouter.post(
        '/google-drive/webhook',
        GoogleDriveWebhookController.handleWebhook
      )
    }

    // 2. User account linking
    webRouter.get(
      '/auth/google-drive/oauth',
      AuthenticationController.requireLogin(),
      GoogleDriveController.startOAuth
    )
    webRouter.get(
      '/auth/google-drive/callback',
      AuthenticationController.requireLogin(),
      GoogleDriveController.oauthCallback
    )
    webRouter.post(
      '/auth/google-drive/unlink',
      AuthenticationController.requireLogin(),
      GoogleDriveController.unlink
    )
    webRouter.get(
      '/auth/google-drive/status',
      AuthenticationController.requireLogin(),
      GoogleDriveController.getUserStatus
    )
    webRouter.post(
      '/auth/google-drive/scan-existing-projects',
      AuthenticationController.requireLogin(),
      GoogleDriveController.scanExistingProjects
    )

    // 3. Per-project synchronization
    webRouter.get(
      '/project/:Project_id/google-drive/status',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanReadProject,
      GoogleDriveController.getProjectStatus
    )
    webRouter.post(
      '/project/:Project_id/google-drive/sync',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      GoogleDriveController.syncProjectNow
    )
  },
}

export default GoogleDriveRouter
export { GoogleDriveRouter }
```

In `app/src/router.mjs:507`, pass `publicApiRouter`:

```javascript
  GitBridgeRouter.apply(webRouter, privateApiRouter, publicApiRouter)
  GoogleDriveRouter.apply(webRouter, publicApiRouter)
```

- [ ] **Step 5: Run controller & router tests**

Run: `npx vitest run test/unit/src/Features/GoogleDriveSync/GoogleDriveWebhookController.test.mjs test/unit/src/Features/GoogleDriveSync/GoogleDriveRouter.test.mjs`
Expected: PASS.

- [ ] **Step 6: Stop and report**

Do not commit. Report and wait.

---

## Task 4: Channel Renewal Worker and Polling Ratio Optimization

Implements `GoogleDriveChannelRenewalWorker` and updates `GoogleDrivePollingWorker` to back off polling on watched users.

**Files:**
- Create: `app/src/Features/GoogleDriveSync/GoogleDriveChannelRenewalWorker.mjs`
- Test: `test/unit/src/Features/GoogleDriveSync/GoogleDriveChannelRenewalWorker.test.mjs`
- Modify: `app/src/Features/GoogleDriveSync/GoogleDrivePollingWorker.mjs`
- Test: `test/unit/src/Features/GoogleDriveSync/GoogleDrivePollingWorker.test.mjs`

**Interfaces:**
- Consumes: `Settings.googleDrive.channelRenewIntervalSeconds`, `Settings.googleDrive.watchedUserPollRatio`, `GoogleDriveWatchManager.ensureChannel(userId)`, `db.googleDriveUserCredentials`.
- Produces: `GoogleDriveChannelRenewalWorker.renewAllChannels(): Promise<void>`, `start()`, `stop()`.

- [ ] **Step 1: Write the failing tests for `GoogleDriveChannelRenewalWorker`**

Create `test/unit/src/Features/GoogleDriveSync/GoogleDriveChannelRenewalWorker.test.mjs`:

```javascript
import { describe, it, beforeEach, vi, expect } from 'vitest'

const modulePath =
  '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveChannelRenewalWorker.mjs'

describe('GoogleDriveChannelRenewalWorker', () => {
  let GoogleDriveChannelRenewalWorker

  const Settings = {
    googleDrive: {
      channelRenewIntervalSeconds: 3600,
      webhookUrl: 'https://example.com/webhook',
    },
  }

  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }

  const Features = { hasFeature: vi.fn() }

  const db = {
    googleDriveUserCredentials: {
      find: vi.fn(),
    },
  }

  const GoogleDriveWatchManager = {
    ensureChannel: vi.fn(),
  }

  function mockCursor(docs) {
    return {
      async *[Symbol.asyncIterator]() {
        yield* docs
      },
    }
  }

  vi.doMock('@overleaf/settings', () => ({ default: Settings }))
  vi.doMock('@overleaf/logger', () => ({ default: logger }))
  vi.doMock('../../../../../app/src/infrastructure/Features.mjs', () => ({
    default: Features,
  }))
  vi.doMock('../../../../../app/src/infrastructure/mongodb.mjs', () => ({
    db,
  }))
  vi.doMock(
    '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveWatchManager.mjs',
    () => ({ default: GoogleDriveWatchManager, ...GoogleDriveWatchManager })
  )

  beforeEach(async () => {
    vi.clearAllMocks()
    Features.hasFeature.mockReturnValue(true)
    Settings.googleDrive.webhookUrl = 'https://example.com/webhook'

    const mod = await import(modulePath)
    GoogleDriveChannelRenewalWorker = mod.default
    GoogleDriveChannelRenewalWorker.stop()
  })

  it('iterates all linked users and calls ensureChannel', async () => {
    const users = [{ user_id: 'u1' }, { user_id: 'u2' }]
    db.googleDriveUserCredentials.find.mockReturnValue(mockCursor(users))

    await GoogleDriveChannelRenewalWorker.renewAllChannels()

    expect(GoogleDriveWatchManager.ensureChannel).toHaveBeenCalledWith('u1')
    expect(GoogleDriveWatchManager.ensureChannel).toHaveBeenCalledWith('u2')
  })

  it('skips execution if feature disabled', async () => {
    Features.hasFeature.mockReturnValue(false)

    await GoogleDriveChannelRenewalWorker.renewAllChannels()

    expect(db.googleDriveUserCredentials.find).not.toHaveBeenCalled()
  })

  it('skips execution if no webhookUrl is configured', async () => {
    Settings.googleDrive.webhookUrl = ''

    await GoogleDriveChannelRenewalWorker.renewAllChannels()

    expect(db.googleDriveUserCredentials.find).not.toHaveBeenCalled()
  })

  it('continues past individual user renewal failures', async () => {
    const users = [{ user_id: 'u1' }, { user_id: 'u2' }]
    db.googleDriveUserCredentials.find.mockReturnValue(mockCursor(users))
    GoogleDriveWatchManager.ensureChannel
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce({ success: true })

    await GoogleDriveChannelRenewalWorker.renewAllChannels()

    expect(logger.error).toHaveBeenCalled()
    expect(GoogleDriveWatchManager.ensureChannel).toHaveBeenCalledWith('u2')
  })
})
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run test/unit/src/Features/GoogleDriveSync/GoogleDriveChannelRenewalWorker.test.mjs`
Expected: FAIL — `Cannot find module`.

- [ ] **Step 3: Implement `GoogleDriveChannelRenewalWorker.mjs`**

Create `app/src/Features/GoogleDriveSync/GoogleDriveChannelRenewalWorker.mjs`:

```javascript
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import Features from '../../infrastructure/Features.mjs'
import { db } from '../../infrastructure/mongodb.mjs'
import GoogleDriveWatchManager from './GoogleDriveWatchManager.mjs'

let renewTimer = null
let isRenewing = false

const GoogleDriveChannelRenewalWorker = {
  /**
   * Scans all linked Google Drive users and renews watch channels expiring soon.
   */
  async renewAllChannels() {
    if (!Features.hasFeature('google-drive-sync')) {
      return
    }

    const webhookUrl = Settings.googleDrive?.webhookUrl
    if (!webhookUrl) {
      return
    }

    if (isRenewing) {
      logger.debug(
        'GoogleDriveChannelRenewalWorker: renewal already in progress, skipping cycle'
      )
      return
    }

    isRenewing = true
    try {
      const cursor = db.googleDriveUserCredentials.find(
        {},
        { projection: { user_id: 1 } }
      )
      for await (const creds of cursor) {
        try {
          await GoogleDriveWatchManager.ensureChannel(creds.user_id)
        } catch (err) {
          logger.error(
            { err, userId: creds.user_id },
            'GoogleDriveChannelRenewalWorker: error renewing channel for user'
          )
        }
      }
    } catch (err) {
      logger.error(
        { err },
        'GoogleDriveChannelRenewalWorker: unexpected error during renewAllChannels'
      )
    } finally {
      isRenewing = false
    }
  },

  /**
   * Starts the recurring background channel renewal timer.
   */
  start() {
    if (renewTimer) {
      return
    }

    if (!Features.hasFeature('google-drive-sync')) {
      return
    }

    const webhookUrl = Settings.googleDrive?.webhookUrl
    if (!webhookUrl) {
      return
    }

    const intervalSeconds =
      Settings.googleDrive?.channelRenewIntervalSeconds || 3600

    logger.info(
      { intervalSeconds },
      'GoogleDriveChannelRenewalWorker: starting background channel renewal worker'
    )

    // Run once at start to verify/establish channels
    GoogleDriveChannelRenewalWorker.renewAllChannels().catch(err => {
      logger.error(
        { err },
        'GoogleDriveChannelRenewalWorker: error during initial renewal run'
      )
    })

    renewTimer = setInterval(() => {
      GoogleDriveChannelRenewalWorker.renewAllChannels().catch(err => {
        logger.error(
          { err },
          'GoogleDriveChannelRenewalWorker: error during interval renewal execution'
        )
      })
    }, intervalSeconds * 1000)
    renewTimer.unref()
  },

  /**
   * Stops the recurring background channel renewal timer.
   */
  stop() {
    if (renewTimer) {
      clearInterval(renewTimer)
      renewTimer = null
      logger.info(
        'GoogleDriveChannelRenewalWorker: stopped background channel renewal worker'
      )
    }
  },
}

export default GoogleDriveChannelRenewalWorker
export { GoogleDriveChannelRenewalWorker }
```

- [ ] **Step 4: Update `GoogleDrivePollingWorker.mjs` for watched users**

In `app/src/Features/GoogleDriveSync/GoogleDrivePollingWorker.mjs`:

```javascript
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import Features from '../../infrastructure/Features.mjs'
import { db } from '../../infrastructure/mongodb.mjs'
import GoogleDriveSyncManager from './GoogleDriveSyncManager.mjs'

let pollIntervalTimer = null
let isPolling = false
let pollCycleCounter = 0

/**
 * Background polling worker that regularly checks linked Google Drive accounts
 * for inbound remote file changes and triggers project reconciliation.
 */
const GoogleDrivePollingWorker = {
  /**
   * Polls linked Google Drive users sequentially for remote changes.
   * If a user has an active, unexpired push watch channel, they are polled
   * only every Nth cycle (watchedUserPollRatio) as a fallback.
   */
  async pollAllUsers() {
    if (isPolling) {
      logger.debug(
        'GoogleDrivePollingWorker: poll already in progress, skipping cycle'
      )
      return
    }

    isPolling = true
    pollCycleCounter++
    const cycle = pollCycleCounter
    const pollRatio = Settings.googleDrive?.watchedUserPollRatio || 10
    const now = Date.now()

    try {
      const cursor = db.googleDriveUserCredentials.find(
        {},
        {
          projection: {
            user_id: 1,
            watchChannelId: 1,
            watchExpiresAt: 1,
          },
        }
      )
      for await (const creds of cursor) {
        const isWatched =
          Boolean(creds.watchChannelId) &&
          Boolean(creds.watchExpiresAt) &&
          new Date(creds.watchExpiresAt).getTime() > now

        if (isWatched && cycle % pollRatio !== 0) {
          // Push notifications handle this user; skip this poll cycle
          continue
        }

        try {
          await GoogleDriveSyncManager.pollUserChanges(creds.user_id)
        } catch (err) {
          logger.error(
            { err, userId: creds.user_id },
            'GoogleDrivePollingWorker: error polling changes for user'
          )
        }
      }
    } catch (err) {
      logger.error(
        { err },
        'GoogleDrivePollingWorker: unexpected error during pollAllUsers'
      )
    } finally {
      isPolling = false
    }
  },

  /**
   * Starts the recurring background polling timer.
   */
  start() {
    if (pollIntervalTimer) {
      return
    }

    if (!Features.hasFeature('google-drive-sync')) {
      return
    }

    const pollIntervalSeconds =
      Settings.googleDrive?.pollIntervalSeconds || 300
    const intervalMs = pollIntervalSeconds * 1000

    logger.info(
      { pollIntervalSeconds },
      'GoogleDrivePollingWorker: starting background polling worker'
    )

    pollIntervalTimer = setInterval(() => {
      GoogleDrivePollingWorker.pollAllUsers().catch(err => {
        logger.error(
          { err },
          'GoogleDrivePollingWorker: error during interval execution'
        )
      })
    }, intervalMs)
    pollIntervalTimer.unref()
  },

  /**
   * Stops the recurring background polling timer.
   */
  stop() {
    if (pollIntervalTimer) {
      clearInterval(pollIntervalTimer)
      pollIntervalTimer = null
      logger.info('GoogleDrivePollingWorker: stopped background polling worker')
    }
  },
}

export default GoogleDrivePollingWorker
export { GoogleDrivePollingWorker }
```

- [ ] **Step 5: Run tests for renewal and polling workers**

Update `test/unit/src/Features/GoogleDriveSync/GoogleDrivePollingWorker.test.mjs` to add tests for watched vs unwatched users. Run:
`npx vitest run test/unit/src/Features/GoogleDriveSync/GoogleDriveChannelRenewalWorker.test.mjs test/unit/src/Features/GoogleDriveSync/GoogleDrivePollingWorker.test.mjs`
Expected: PASS.

- [ ] **Step 6: Stop and report**

Do not commit. Report and wait.

---

## Task 5: Lifecycle Integration & Wiring

Connects channel creation to account linking, channel teardown to unlinking, and boots the renewal worker.

**Files:**
- Modify: `app/src/Features/GoogleDriveSync/GoogleDriveOAuthManager.mjs`
- Test: `test/unit/src/Features/GoogleDriveSync/GoogleDriveOAuthManager.test.mjs`
- Modify: `app/src/Features/GoogleDriveSync/index.mjs`
- Test: `test/unit/src/Features/GoogleDriveSync/index.test.mjs`

**Interfaces:**
- Consumes: `GoogleDriveWatchManager.ensureChannel`, `GoogleDriveWatchManager.stopChannel`, `GoogleDriveChannelRenewalWorker.start`.
- Produces: Integrated account link/unlink with push notification management.

- [ ] **Step 1: Write the failing tests in `GoogleDriveOAuthManager.test.mjs`**

Add tests to `test/unit/src/Features/GoogleDriveSync/GoogleDriveOAuthManager.test.mjs` verifying that `handleOAuthCallback` calls `GoogleDriveWatchManager.ensureChannel(userId)` and `unlinkAccount` calls `GoogleDriveWatchManager.stopChannel(userId)`.

- [ ] **Step 2: Update `GoogleDriveOAuthManager.mjs`**

Import `GoogleDriveWatchManager`:
```javascript
import GoogleDriveWatchManager from './GoogleDriveWatchManager.mjs'
```

In `handleOAuthCallback(userId, code, state)`:
```javascript
  // Best-effort channel creation
  try {
    await GoogleDriveWatchManager.ensureChannel(userId)
  } catch (chanErr) {
    logger.warn(
      { err: chanErr, userId },
      'failed to establish initial push notification channel during link'
    )
  }
```

In `unlinkAccount(userId)`:
```javascript
  try {
    await GoogleDriveWatchManager.stopChannel(userId)
  } catch (chanErr) {
    logger.warn(
      { err: chanErr, userId },
      'failed to stop push notification channel during unlink'
    )
  }
```

- [ ] **Step 3: Update `index.mjs`**

In `app/src/Features/GoogleDriveSync/index.mjs`:
Import `GoogleDriveChannelRenewalWorker` and call `GoogleDriveChannelRenewalWorker.start()` inside `start()`.

Update `test/unit/src/Features/GoogleDriveSync/index.test.mjs` to verify `GoogleDriveChannelRenewalWorker.start()` is called when enabled.

- [ ] **Step 4: Run OAuth and index tests**

Run: `npx vitest run test/unit/src/Features/GoogleDriveSync/GoogleDriveOAuthManager.test.mjs test/unit/src/Features/GoogleDriveSync/index.test.mjs`
Expected: PASS.

- [ ] **Step 5: Stop and report**

Do not commit. Report and wait.

---

## Task 6: Full Suite Verification & Dev Server Validation

Verification gate for Phase 3 deliverable.

**Files:** none modified.

- [ ] **Step 1: Run the full Google Drive test suite**

Run: `npx vitest run test/unit/src/Features/GoogleDriveSync/`
Expected: PASS, all 13 test files.

- [ ] **Step 2: Run neighbour suites**

Run: `npx vitest run test/unit/src/infrastructure/ test/unit/src/Project/`
Expected: PASS.

- [ ] **Step 3: Run ESLint**

Run: `npx eslint app/src/Features/GoogleDriveSync/ test/unit/src/Features/GoogleDriveSync/`
Expected: 0 errors, 0 warnings.

- [ ] **Step 4: Clean Disablement Inspection**

Verify `ENABLE_GOOGLE_DRIVE_SYNC=false` and `GOOGLE_DRIVE_WEBHOOK_URL=''` ensure no timers run, no webhooks are accepted, and 0 database lookups occur on the request paths.

- [ ] **Step 5: Stop and report**

Do not commit. Report to the user.
