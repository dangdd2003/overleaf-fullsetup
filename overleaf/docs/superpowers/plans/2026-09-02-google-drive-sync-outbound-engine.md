# Google Drive Sync — Foundation & Outbound Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore automatic Overleaf → Google Drive synchronization by replacing the removed full-rescan listener with a per-file dirty set fed by Overleaf's entity hooks and drained by a batched background worker, on top of a hardened rate-limit foundation.

**Architecture:** Overleaf already fires `fileModified` / `entityDeleted` hooks on every file mutation, but nothing listens to them. A new `GoogleDriveHookHandler` records the exact changed path into a `pendingChanges` map on the project's sync state. A new `GoogleDriveOutboundWorker` wakes every 10 minutes, selects projects whose dirty set has settled, and pushes only those paths using the manager's existing `handleOutbound*` functions. No full-tree rescan ever runs on a timer. Underneath, the existing retry wrapper gains rate-limit classification, a shared token bucket, and per-project backoff.

**Tech Stack:** Node.js ESM, Express, MongoDB (native driver + Mongoose schemas), Vitest with `vi.doMock` + dynamic import, `@overleaf/settings`, `@overleaf/logger`, `@overleaf/o-error`, `@overleaf/fetch-utils`.

**Spec:** `overleaf/docs/superpowers/specs/2026-09-02-google-drive-sync-dropbox-parity-design.md` — this plan implements **phases 1 and 2** of spec §13 (§4, §8, §9, §10 in full; §5–§7 are deferred to later plans).

## Global Constraints

- **Working directory for every command is `overleaf/services/web`.** All paths in this plan are relative to it unless stated otherwise.
- **Test command is `npx vitest run <path>`.** The yarn/npm registry is blocked in this environment; `yarn test:unit` will fail. `npx` resolves the already-installed vitest 4.1.5.
- **Feature must remain disabled by default.** `ENABLE_GOOGLE_DRIVE_SYNC` defaults to `false`. Every new worker and hook handler returns immediately when `Features.hasFeature('google-drive-sync')` is false.
- **Never commit.** This repository reserves all git operations for the user. Steps that would normally commit instead say "stop and report" — the user commits.
- **New settings keys live under `Settings.googleDrive`** in `config/settings.defaults.js`, read via `process.env` with the existing `intFromEnv` helper for numbers.
- **Mongo field names cannot contain `.` or `$`.** File paths used as `pendingChanges` keys MUST be encoded with `encodePathKey`.
- **All new schema fields are optional with defaults**, so existing documents keep working without migration.
- **ESM only.** Use `import` / `export`, `.mjs` extensions, and `export default X` plus named exports, matching every existing file in `Features/GoogleDriveSync/`.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `app/src/Features/GoogleDriveSync/GoogleDriveRateLimiter.mjs` | Token-bucket limiter shared by all Drive API calls. One concern: pacing. |
| `app/src/Features/GoogleDriveSync/GoogleDriveHookHandler.mjs` | Translates Overleaf entity hooks into `pendingChanges` entries. No Drive I/O. |
| `app/src/Features/GoogleDriveSync/GoogleDriveOutboundWorker.mjs` | Timer + flush loop. Drains `pendingChanges` via the manager's existing push functions. |
| `test/unit/src/Features/GoogleDriveSync/GoogleDriveRateLimiter.test.mjs` | Tests for the limiter. |
| `test/unit/src/Features/GoogleDriveSync/GoogleDriveHookHandler.test.mjs` | Tests for the hook handler. |
| `test/unit/src/Features/GoogleDriveSync/GoogleDriveOutboundWorker.test.mjs` | Tests for the worker. |

**Modified:**

| File | Change |
|---|---|
| `app/src/infrastructure/mongodb.mjs` | Schema additions to `GoogleDriveProjectStatesSchema`. |
| `config/settings.defaults.js` | Four new `googleDrive` keys. |
| `app/src/Features/GoogleDriveSync/GoogleDriveClient.mjs` | Extend `_requestWithRetry`; wire in the rate limiter. |
| `app/src/Features/GoogleDriveSync/GoogleDriveSyncManager.mjs` | Add `encodePathKey` / `decodePathKey`, backoff helpers; make cooldown configurable; populate `entityId` / `entityType` in `fileMap`. |
| `app/src/Features/GoogleDriveSync/GoogleDriveController.mjs` | Read cooldown from settings; clear `pendingChanges` after manual sync. |
| `app/src/Features/GoogleDriveSync/index.mjs` | Attach hooks, start the outbound worker; rewrite the stale comment. |
| `develop/dev.env` | New env vars for the dev server. |

**Task dependency order:** 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8. Task 3 depends on Task 2's limiter. Tasks 5 and 6 depend on Task 4's `encodePathKey`. Task 7 depends on 5 and 6.

---

## Task 1: Schema and settings foundation

Adds the persistent fields and configuration everything else reads. No behaviour changes yet.

**Files:**
- Modify: `app/src/infrastructure/mongodb.mjs:148-165` (`GoogleDriveProjectStatesSchema`)
- Modify: `config/settings.defaults.js:1149-1159` (`googleDrive` block)
- Modify: `develop/dev.env`

**Interfaces:**
- Consumes: nothing.
- Produces: `Settings.googleDrive.outboundFlushSeconds: number`, `Settings.googleDrive.outboundDebounceSeconds: number`, `Settings.googleDrive.maxRps: number`, `Settings.googleDrive.manualSyncCooldownSeconds: number`. Schema fields `pendingChanges`, `outboundDirtyAt`, `lastOutboundError`, `backoffUntil`, `consecutiveFailures`, `syncSuspended`, `suspendReason`.

- [ ] **Step 1: Add the new fields to the project-state schema**

In `app/src/infrastructure/mongodb.mjs`, inside `GoogleDriveProjectStatesSchema`, add these fields after the existing `lockExpiresAt` line and before the closing `}` of the definition object:

```javascript
    pendingChanges: { type: Map, of: Schema.Types.Mixed, default: {} },
    outboundDirtyAt: Date,
    lastOutboundError: String,
    backoffUntil: Date,
    consecutiveFailures: { type: Number, default: 0 },
    syncSuspended: { type: Boolean, default: false },
    suspendReason: String,
```

- [ ] **Step 2: Add the settings keys**

In `config/settings.defaults.js`, replace the existing `googleDrive` object with:

```javascript
  googleDrive: {
    clientId: process.env.GOOGLE_DRIVE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_DRIVE_CLIENT_SECRET || '',
    redirectUri:
      process.env.GOOGLE_DRIVE_REDIRECT_URI ||
      `${siteUrl}/auth/google-drive/callback`,
    folderName: process.env.GOOGLE_DRIVE_FOLDER_NAME || 'Overleaf',
    pollIntervalSeconds: intFromEnv('GOOGLE_DRIVE_POLL_INTERVAL_SECONDS', 300),
    outboundFlushSeconds: intFromEnv(
      'GOOGLE_DRIVE_OUTBOUND_FLUSH_SECONDS',
      600
    ),
    outboundDebounceSeconds: intFromEnv(
      'GOOGLE_DRIVE_OUTBOUND_DEBOUNCE_SECONDS',
      15
    ),
    maxRps: intFromEnv('GOOGLE_DRIVE_MAX_RPS', 8),
    manualSyncCooldownSeconds: intFromEnv(
      'GOOGLE_DRIVE_MANUAL_SYNC_COOLDOWN_SECONDS',
      60
    ),
  },
```

Note the poll interval default changes from `60` to `300` per spec §3.4.

- [ ] **Step 3: Add the dev-server env vars**

In `develop/dev.env`, replace the line `GOOGLE_DRIVE_POLL_INTERVAL_SECONDS=60` with:

```
GOOGLE_DRIVE_POLL_INTERVAL_SECONDS=300
GOOGLE_DRIVE_OUTBOUND_FLUSH_SECONDS=120
GOOGLE_DRIVE_OUTBOUND_DEBOUNCE_SECONDS=10
GOOGLE_DRIVE_MAX_RPS=8
GOOGLE_DRIVE_MANUAL_SYNC_COOLDOWN_SECONDS=60
```

The flush interval is deliberately 120s in dev rather than the 600s production default, so outbound sync is observable during manual testing without waiting ten minutes.

- [ ] **Step 4: Verify nothing broke**

Run: `npx vitest run test/unit/src/infrastructure/`
Expected: PASS. These are schema/settings additions with no logic, so existing infrastructure tests must be unaffected.

- [ ] **Step 5: Stop and report**

Do not commit. Report the three modified files to the user and wait.

---

## Task 2: Token-bucket rate limiter

A standalone, dependency-free limiter. Built before the client changes so Task 3 can consume it.

**Files:**
- Create: `app/src/Features/GoogleDriveSync/GoogleDriveRateLimiter.mjs`
- Test: `test/unit/src/Features/GoogleDriveSync/GoogleDriveRateLimiter.test.mjs`

**Interfaces:**
- Consumes: `Settings.googleDrive.maxRps` from Task 1.
- Produces: `GoogleDriveRateLimiter.acquire(): Promise<void>` — resolves when a token is available. `GoogleDriveRateLimiter.reset(): void` — refills the bucket, for tests only.

- [ ] **Step 1: Write the failing test**

Create `test/unit/src/Features/GoogleDriveSync/GoogleDriveRateLimiter.test.mjs`:

```javascript
import { describe, it, beforeEach, vi, expect } from 'vitest'

const modulePath =
  '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveRateLimiter.mjs'

describe('GoogleDriveRateLimiter', () => {
  let GoogleDriveRateLimiter

  const Settings = {
    googleDrive: { maxRps: 4 },
  }

  vi.doMock('@overleaf/settings', () => ({ default: Settings }))

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.useRealTimers()
    Settings.googleDrive.maxRps = 4
    const mod = await import(modulePath)
    GoogleDriveRateLimiter = mod.default
    GoogleDriveRateLimiter.reset()
  })

  it('resolves immediately while burst capacity remains', async () => {
    // burst is 2 * maxRps = 8, so the first 8 acquires must not wait
    const start = Date.now()
    for (let i = 0; i < 8; i++) {
      await GoogleDriveRateLimiter.acquire()
    }
    expect(Date.now() - start).toBeLessThan(50)
  })

  it('delays once the burst is exhausted', async () => {
    for (let i = 0; i < 8; i++) {
      await GoogleDriveRateLimiter.acquire()
    }
    const start = Date.now()
    await GoogleDriveRateLimiter.acquire()
    // at 4 rps a token takes 250ms to refill; allow scheduler slack
    expect(Date.now() - start).toBeGreaterThanOrEqual(200)
  })

  it('refills over time so later calls are free again', async () => {
    for (let i = 0; i < 8; i++) {
      await GoogleDriveRateLimiter.acquire()
    }
    await new Promise(resolve => setTimeout(resolve, 600))
    const start = Date.now()
    await GoogleDriveRateLimiter.acquire()
    expect(Date.now() - start).toBeLessThan(50)
  })

  it('never blocks when maxRps is zero or negative', async () => {
    Settings.googleDrive.maxRps = 0
    GoogleDriveRateLimiter.reset()
    const start = Date.now()
    for (let i = 0; i < 50; i++) {
      await GoogleDriveRateLimiter.acquire()
    }
    expect(Date.now() - start).toBeLessThan(50)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/src/Features/GoogleDriveSync/GoogleDriveRateLimiter.test.mjs`
Expected: FAIL — `Cannot find module .../GoogleDriveRateLimiter.mjs`.

- [ ] **Step 3: Write the implementation**

Create `app/src/Features/GoogleDriveSync/GoogleDriveRateLimiter.mjs`:

```javascript
import Settings from '@overleaf/settings'

/**
 * Process-wide token bucket pacing all Google Drive API requests.
 *
 * Every worker (polling, outbound flush) and every user-triggered sync shares
 * this bucket, so no combination of triggers can exceed the configured rate.
 * Note this is per-process: a multi-instance deployment gets
 * `maxRps * instanceCount` in aggregate, so operators should divide the
 * configured value by their replica count.
 */

let tokens = null
let lastRefillMs = Date.now()

function _maxRps() {
  const configured = Settings.googleDrive?.maxRps
  return typeof configured === 'number' ? configured : 8
}

function _burst() {
  return _maxRps() * 2
}

function _refill() {
  const now = Date.now()
  const elapsedSeconds = (now - lastRefillMs) / 1000
  lastRefillMs = now
  if (tokens === null) {
    tokens = _burst()
    return
  }
  tokens = Math.min(_burst(), tokens + elapsedSeconds * _maxRps())
}

const GoogleDriveRateLimiter = {
  /**
   * Resolves once a request token is available. Callers await this
   * immediately before issuing a Drive API request.
   *
   * @returns {Promise<void>}
   */
  async acquire() {
    const rps = _maxRps()
    if (!rps || rps <= 0) {
      // Limiting disabled.
      return
    }

    // Loop rather than a single wait: several callers can be parked at once,
    // and the first to wake may take the only token that refilled.
    for (;;) {
      _refill()
      if (tokens >= 1) {
        tokens -= 1
        return
      }
      const deficit = 1 - tokens
      const waitMs = Math.ceil((deficit / rps) * 1000)
      await new Promise(resolve => setTimeout(resolve, Math.max(1, waitMs)))
    }
  },

  /**
   * Refills the bucket. Intended for tests.
   */
  reset() {
    tokens = _burst()
    lastRefillMs = Date.now()
  },
}

export default GoogleDriveRateLimiter
export { GoogleDriveRateLimiter }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/src/Features/GoogleDriveSync/GoogleDriveRateLimiter.test.mjs`
Expected: PASS, 4 tests.

- [ ] **Step 5: Stop and report**

Do not commit. Report the two new files and wait.

---

## Task 3: Rate-limit classification in the Drive client

Extends the **existing** `_requestWithRetry` — do not write a new one. All twelve Drive call sites already route through it, so changing it in place covers everything.

**Files:**
- Modify: `app/src/Features/GoogleDriveSync/GoogleDriveClient.mjs:12-16` (retry config), `:112-172` (`_requestWithRetry`)
- Test: `test/unit/src/Features/GoogleDriveSync/GoogleDriveClient.test.mjs` (add a describe block)

**Interfaces:**
- Consumes: `GoogleDriveRateLimiter.acquire()` from Task 2.
- Produces: `_requestWithRetry` now throws errors carrying `err.rateLimited === true` when retries are exhausted on a rate-limit condition. `GoogleDriveSyncManager` (Task 4) reads this flag.

- [ ] **Step 1: Write the failing tests**

Append this describe block inside the top-level `describe('GoogleDriveClient', ...)` in `test/unit/src/Features/GoogleDriveSync/GoogleDriveClient.test.mjs`. Match the existing file's mock setup — read the top of that file first and reuse its `fetchJson` mock and `beforeEach` import pattern rather than inventing new ones.

```javascript
  describe('rate limit handling', () => {
    function driveError(status, reason) {
      const err = new Error(`drive ${status}`)
      err.info = { status }
      err.body = reason
        ? { error: { errors: [{ reason }], status: reason } }
        : undefined
      return err
    }

    it('retries a 403 userRateLimitExceeded and eventually succeeds', async () => {
      let calls = 0
      fetchJson.mockImplementation(async () => {
        calls++
        if (calls < 3) throw driveError(403, 'userRateLimitExceeded')
        return { files: [] }
      })

      const result = await GoogleDriveClient.listFiles('user-1', 'folder-1')

      expect(calls).toBe(3)
      expect(result).toBeDefined()
    })

    it('does not retry a 403 insufficientPermissions', async () => {
      let calls = 0
      fetchJson.mockImplementation(async () => {
        calls++
        throw driveError(403, 'insufficientPermissions')
      })

      await expect(
        GoogleDriveClient.listFiles('user-1', 'folder-1')
      ).rejects.toThrow()
      expect(calls).toBe(1)
    })

    it('tags the error with rateLimited when retries are exhausted', async () => {
      fetchJson.mockImplementation(async () => {
        throw driveError(429)
      })

      let caught
      try {
        await GoogleDriveClient.listFiles('user-1', 'folder-1')
      } catch (err) {
        caught = err
      }

      expect(caught).toBeDefined()
      expect(caught.rateLimited).toBe(true)
    })

    it('does not tag non-rate-limit failures as rateLimited', async () => {
      fetchJson.mockImplementation(async () => {
        throw driveError(500)
      })

      let caught
      try {
        await GoogleDriveClient.listFiles('user-1', 'folder-1')
      } catch (err) {
        caught = err
      }

      expect(caught).toBeDefined()
      expect(caught.rateLimited).toBeUndefined()
    })
  })
```

These tests take real wall-clock time because the retry sleeps. Reduce that by setting `Settings.googleDrive.retryInitialDelayMs = 1` in the block's `beforeEach` if the existing test file exposes `Settings`; otherwise accept a few seconds of runtime.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/src/Features/GoogleDriveSync/GoogleDriveClient.test.mjs -t "rate limit handling"`
Expected: FAIL — the 403 tests fail because 403 is not currently retryable, and the `rateLimited` tests fail because the flag does not exist.

- [ ] **Step 3: Implement the changes**

In `app/src/Features/GoogleDriveSync/GoogleDriveClient.mjs`:

First add the import at the top, after the `GoogleDriveOAuthManager` import:

```javascript
import GoogleDriveRateLimiter from './GoogleDriveRateLimiter.mjs'
```

Then replace the `DEFAULT_RETRY_CONFIG` block with:

```javascript
const DEFAULT_RETRY_CONFIG = {
  maxRetries: 5,
  initialDelayMs: 100,
  backoffFactor: 2,
  maxDelayMs: 32000,
}

// 403 reasons that mean "slow down" rather than "you may not do this".
// Anything else with a 403 is permanent, and retrying it only burns quota.
const RATE_LIMIT_403_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'sharingRateLimitExceeded',
])

/**
 * Extracts Google's machine-readable error reason from a failed request.
 *
 * @param {any} err
 * @returns {string|null}
 */
function _driveErrorReason(err) {
  const body = err.body ?? err.response?.body ?? err.info?.body
  return body?.error?.errors?.[0]?.reason ?? body?.error?.status ?? null
}

/**
 * True when the failure is Google asking us to back off.
 *
 * @param {number|null} status
 * @param {any} err
 * @returns {boolean}
 */
function _isRateLimitError(status, err) {
  if (status === 429) return true
  if (status === 403) {
    return RATE_LIMIT_403_REASONS.has(_driveErrorReason(err))
  }
  return false
}
```

Then, inside `_requestWithRetry`, make four changes:

1. Read the new option and acquire a token before each attempt. Replace the opening of the function body:

```javascript
  const maxRetries = options.maxRetries ?? DEFAULT_RETRY_CONFIG.maxRetries
  const initialDelayMs =
    options.initialDelayMs ?? DEFAULT_RETRY_CONFIG.initialDelayMs
  const backoffFactor =
    options.backoffFactor ?? DEFAULT_RETRY_CONFIG.backoffFactor
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_RETRY_CONFIG.maxDelayMs

  let attempt = 0
  let delay = initialDelayMs

  while (true) {
    try {
      await GoogleDriveRateLimiter.acquire()
      return await fn()
    } catch (err) {
```

2. Add rate-limit detection to the retryable check:

```javascript
      const rateLimited = _isRateLimitError(status, err)

      const isRetryable =
        rateLimited ||
        (status >= 500 && status <= 599) ||
        err.code === 'ECONNRESET' ||
        err.code === 'ETIMEDOUT' ||
        err.code === 'EAI_AGAIN'

      if (!isRetryable || attempt > maxRetries) {
        if (rateLimited) {
          err.rateLimited = true
        }
        throw err
      }
```

Note `status === 429` is now covered by `rateLimited`, so the standalone `status === 429 ||` term is removed.

3. Clamp the backoff. Replace the final line of the loop:

```javascript
      delay = Math.min(delay * backoffFactor, maxDelayMs)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/src/Features/GoogleDriveSync/GoogleDriveClient.test.mjs`
Expected: PASS — the new block plus every pre-existing test in the file. If a pre-existing test now fails on timing, it is because the retry count rose from 3 to 5; fix the test's expectation, not the implementation.

- [ ] **Step 5: Stop and report**

Do not commit. Report and wait.

---

## Task 4: Path-key encoding, backoff helpers, configurable cooldown

Shared utilities the hook handler and worker both need, plus the settings-driven cooldown from spec §8.4.

**Files:**
- Modify: `app/src/Features/GoogleDriveSync/GoogleDriveSyncManager.mjs` — add helpers near `normalizePath` (~line 120), change `enforceManualSyncCooldown` (~line 380), extend the export lists (~line 1920)
- Modify: `app/src/Features/GoogleDriveSync/GoogleDriveController.mjs:159-163` (cooldown call site)
- Test: `test/unit/src/Features/GoogleDriveSync/GoogleDriveSyncManager.test.mjs` (add describe blocks)

**Interfaces:**
- Consumes: `Settings.googleDrive.manualSyncCooldownSeconds` from Task 1; `err.rateLimited` from Task 3.
- Produces, all exported from `GoogleDriveSyncManager`:
  - `encodePathKey(path: string): string`
  - `decodePathKey(key: string): string`
  - `recordSyncFailure(projectId, err): Promise<void>` — sets `backoffUntil`, increments `consecutiveFailures`, sets `syncStatus: 'error'` and `lastOutboundError`
  - `clearSyncFailure(projectId): Promise<void>` — resets `consecutiveFailures` to 0, unsets `backoffUntil`
  - `enforceManualSyncCooldown(projectId, cooldownMs?)` — unchanged signature; `cooldownMs` now defaults from settings

- [ ] **Step 1: Write the failing tests**

Add these describe blocks to `test/unit/src/Features/GoogleDriveSync/GoogleDriveSyncManager.test.mjs`, following the file's existing mock setup:

```javascript
  describe('encodePathKey / decodePathKey', () => {
    it('escapes dots and dollars, which Mongo forbids in field names', () => {
      const key = GoogleDriveSyncManager.encodePathKey('figures/plot.v2.png')
      expect(key).not.toContain('.')
      expect(key).not.toContain('$')
    })

    it('round-trips every path shape we expect', () => {
      const paths = [
        'main.tex',
        'figures/plot.png',
        'a/b/c/deep.file.name.tex',
        'weird$name.tex',
        'spaces in name.bib',
        'unicode-éà.tex',
      ]
      for (const p of paths) {
        const key = GoogleDriveSyncManager.encodePathKey(p)
        expect(GoogleDriveSyncManager.decodePathKey(key)).toBe(p)
      }
    })

    it('produces distinct keys for distinct paths', () => {
      const a = GoogleDriveSyncManager.encodePathKey('a.b')
      const b = GoogleDriveSyncManager.encodePathKey('a/b')
      expect(a).not.toBe(b)
    })
  })

  describe('recordSyncFailure', () => {
    it('sets an exponential backoff window and increments the failure count', async () => {
      db.googleDriveProjectStates.findOne.mockResolvedValue({
        projectId,
        consecutiveFailures: 2,
      })

      const err = new Error('quota')
      err.rateLimited = true
      await GoogleDriveSyncManager.recordSyncFailure(projectId, err)

      const update = db.googleDriveProjectStates.updateOne.mock.calls[0][1]
      expect(update.$set.consecutiveFailures).toBe(3)
      expect(update.$set.syncStatus).toBe('error')
      expect(update.$set.lastOutboundError).toContain('quota')
      // base 5 min, doubled twice for the 2 prior failures => 20 min
      const backoffMs = update.$set.backoffUntil.getTime() - Date.now()
      expect(backoffMs).toBeGreaterThan(19 * 60 * 1000)
      expect(backoffMs).toBeLessThan(21 * 60 * 1000)
    })

    it('caps the backoff at one hour', async () => {
      db.googleDriveProjectStates.findOne.mockResolvedValue({
        projectId,
        consecutiveFailures: 20,
      })

      await GoogleDriveSyncManager.recordSyncFailure(projectId, new Error('x'))

      const update = db.googleDriveProjectStates.updateOne.mock.calls[0][1]
      const backoffMs = update.$set.backoffUntil.getTime() - Date.now()
      expect(backoffMs).toBeLessThanOrEqual(60 * 60 * 1000 + 1000)
    })
  })

  describe('clearSyncFailure', () => {
    it('resets the failure count and removes the backoff', async () => {
      await GoogleDriveSyncManager.clearSyncFailure(projectId)

      const update = db.googleDriveProjectStates.updateOne.mock.calls[0][1]
      expect(update.$set.consecutiveFailures).toBe(0)
      expect(update.$unset).toHaveProperty('backoffUntil')
    })
  })

  describe('enforceManualSyncCooldown', () => {
    it('defaults the cooldown from settings', async () => {
      Settings.googleDrive.manualSyncCooldownSeconds = 30
      db.googleDriveProjectStates.findOneAndUpdate.mockResolvedValue({
        projectId,
      })

      await GoogleDriveSyncManager.enforceManualSyncCooldown(projectId)

      const query = db.googleDriveProjectStates.findOneAndUpdate.mock.calls[0][0]
      const cutoff = query.$or[2].lastManualSyncAt.$lt
      const windowMs = Date.now() - cutoff.getTime()
      expect(windowMs).toBeGreaterThan(29000)
      expect(windowMs).toBeLessThan(31000)
    })
  })
```

If the existing test file does not already define `projectId`, `db`, or `Settings` in an accessible scope, add them following the patterns already in that file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/src/Features/GoogleDriveSync/GoogleDriveSyncManager.test.mjs -t "encodePathKey"`
Expected: FAIL — `GoogleDriveSyncManager.encodePathKey is not a function`.

- [ ] **Step 3: Implement the helpers**

In `app/src/Features/GoogleDriveSync/GoogleDriveSyncManager.mjs`, add after `normalizePath`:

```javascript
/**
 * Encodes a relative file path for use as a MongoDB field name.
 *
 * Mongo forbids `.` and `$` in field names, and file paths contain both, so
 * `pendingChanges` is keyed by this encoding rather than the raw path.
 * Percent-encoding `%` first keeps the transform reversible.
 *
 * @param {string} filePath
 * @returns {string}
 */
function encodePathKey(filePath) {
  return normalizePath(filePath)
    .replace(/%/g, '%25')
    .replace(/\./g, '%2E')
    .replace(/\$/g, '%24')
}

/**
 * Inverse of encodePathKey.
 *
 * @param {string} key
 * @returns {string}
 */
function decodePathKey(key) {
  return String(key)
    .replace(/%2E/g, '.')
    .replace(/%24/g, '$')
    .replace(/%25/g, '%')
}

const BACKOFF_BASE_MS = 5 * 60 * 1000
const BACKOFF_MAX_MS = 60 * 60 * 1000

/**
 * Records a sync failure for a project and puts it into an exponential
 * backoff window that every worker honours.
 *
 * @param {string|ObjectId} projectId
 * @param {Error} err
 * @returns {Promise<void>}
 */
async function recordSyncFailure(projectId, err) {
  const projectObjectId = _toObjectId(projectId)
  const existing = await db.googleDriveProjectStates.findOne({
    projectId: projectObjectId,
  })
  const failures = (existing?.consecutiveFailures || 0) + 1
  const backoffMs = Math.min(
    BACKOFF_BASE_MS * Math.pow(2, failures - 1),
    BACKOFF_MAX_MS
  )

  await db.googleDriveProjectStates.updateOne(
    { projectId: projectObjectId },
    {
      $set: {
        consecutiveFailures: failures,
        backoffUntil: new Date(Date.now() + backoffMs),
        syncStatus: 'error',
        lastOutboundError: err?.message || String(err),
      },
    }
  )

  logger.warn(
    { projectId, failures, backoffMs, err },
    'GoogleDriveSync: project entering backoff after sync failure'
  )
}

/**
 * Clears a project's failure state after a successful sync.
 *
 * @param {string|ObjectId} projectId
 * @returns {Promise<void>}
 */
async function clearSyncFailure(projectId) {
  await db.googleDriveProjectStates.updateOne(
    { projectId: _toObjectId(projectId) },
    {
      $set: { consecutiveFailures: 0 },
      $unset: { backoffUntil: '', lastOutboundError: '' },
    }
  )
}
```

- [ ] **Step 4: Make the cooldown configurable**

Change the `enforceManualSyncCooldown` signature line from:

```javascript
async function enforceManualSyncCooldown(projectId, cooldownMs = 60000) {
```

to:

```javascript
async function enforceManualSyncCooldown(projectId, cooldownMs) {
  if (cooldownMs == null) {
    cooldownMs =
      (Settings.googleDrive?.manualSyncCooldownSeconds ?? 60) * 1000
  }
```

Leave the rest of the function unchanged.

- [ ] **Step 5: Export the new functions**

Add `encodePathKey`, `decodePathKey`, `recordSyncFailure`, and `clearSyncFailure` to **both** the `GoogleDriveSyncManager` object literal and the trailing named `export { ... }` block. Both lists must be updated — the module exports the same names twice.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/unit/src/Features/GoogleDriveSync/GoogleDriveSyncManager.test.mjs`
Expected: PASS, including all pre-existing tests in the file.

- [ ] **Step 7: Stop and report**

Do not commit. Report and wait.

---

## Task 5: Hook handler

Consumes Overleaf's entity hooks and records dirty paths. Deliberately does no Drive I/O — this code runs on the user's edit path and must stay cheap.

**Files:**
- Create: `app/src/Features/GoogleDriveSync/GoogleDriveHookHandler.mjs`
- Test: `test/unit/src/Features/GoogleDriveSync/GoogleDriveHookHandler.test.mjs`

**Interfaces:**
- Consumes: `encodePathKey`, `isIgnoredFile`, `normalizePath` from `GoogleDriveSyncManager` (Task 4); `Features.hasFeature`; `db.googleDriveProjectStates`; `ProjectEntityHandler.promises.getDocPathByProjectIdAndDocId`.
- Produces:
  - `GoogleDriveHookHandler.onFileModified(projectId, entityId, filePath, source): Promise<void>`
  - `GoogleDriveHookHandler.onEntityDeleted(projectId, filePath, entityType, source): Promise<void>`
  - `GoogleDriveHookHandler.onDocModified(projectId, docId, ranges, lastUpdatedAt): Promise<void>`

**Three hooks, not two.** Argument order matches the real fire sites exactly:

| Hook | Fire site | Signature |
|---|---|---|
| `fileModified` | `ProjectEntityUpdateHandler.mjs:369, :632, :1427` | `(projectId, entityId, path, source)` |
| `entityDeleted` | `ProjectEntityUpdateHandler.mjs:845` | `(projectId, path, entityType, source)` |
| `docModified` | `Features/Documents/DocumentController.mjs:97` | `(projectId, docId, ranges, lastUpdatedAt)` |

`docModified` is an **upstream Overleaf hook that already exists** — do not add it. It fires from the private-API endpoint document-updater calls on every doc flush.

It is required because all three `fileModified` fire sites are file-oriented (each operates on a `fileRef`); editing a `.tex` doc never reaches `ProjectEntityUpdateHandler` at all. Without `docModified`, ordinary doc edits would never sync.

Because `docModified` carries no `source`, the loop guard cannot apply to it. That is closed in Task 6 by a content-hash check before pushing docs. Verify all three fire sites with `grep -n "hooks.fire" app/src/Features/Project/ProjectEntityUpdateHandler.mjs app/src/Features/Documents/DocumentController.mjs` before implementing.

- [ ] **Step 1: Write the failing test**

Create `test/unit/src/Features/GoogleDriveSync/GoogleDriveHookHandler.test.mjs`:

```javascript
import { describe, it, beforeEach, vi, expect } from 'vitest'

const modulePath =
  '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveHookHandler.mjs'

describe('GoogleDriveHookHandler', () => {
  let GoogleDriveHookHandler

  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }

  const Features = { hasFeature: vi.fn() }

  const db = {
    googleDriveProjectStates: {
      findOne: vi.fn(),
      updateOne: vi.fn(),
    },
  }

  const GoogleDriveSyncManager = {
    isIgnoredFile: vi.fn(),
    normalizePath: vi.fn(p => String(p).replace(/^\/+/, '')),
    encodePathKey: vi.fn(p => String(p).replace(/\./g, '%2E')),
  }

  const ProjectEntityHandler = {
    promises: { getDocPathByProjectIdAndDocId: vi.fn() },
  }

  vi.doMock('@overleaf/logger', () => ({ default: logger }))
  vi.doMock('../../../../../app/src/infrastructure/Features.mjs', () => ({
    default: Features,
  }))
  vi.doMock('../../../../../app/src/infrastructure/mongodb.mjs', () => ({
    db,
  }))
  vi.doMock(
    '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveSyncManager.mjs',
    () => ({ default: GoogleDriveSyncManager, ...GoogleDriveSyncManager })
  )
  vi.doMock(
    '../../../../../app/src/Features/Project/ProjectEntityHandler.mjs',
    () => ({ default: ProjectEntityHandler })
  )

  const projectId = 'project-1'
  const entityId = 'entity-1'

  beforeEach(async () => {
    vi.clearAllMocks()
    Features.hasFeature.mockReturnValue(true)
    GoogleDriveSyncManager.isIgnoredFile.mockReturnValue(false)
    db.googleDriveProjectStates.findOne.mockResolvedValue({ projectId })
    db.googleDriveProjectStates.updateOne.mockResolvedValue({})
    ProjectEntityHandler.promises.getDocPathByProjectIdAndDocId.mockResolvedValue(
      '/main.tex'
    )

    const mod = await import(modulePath)
    GoogleDriveHookHandler = mod.default
  })

  describe('onFileModified', () => {
    it('queues an upsert for the changed path', async () => {
      await GoogleDriveHookHandler.onFileModified(
        projectId,
        entityId,
        '/main.tex',
        'editor'
      )

      expect(db.googleDriveProjectStates.updateOne).toHaveBeenCalledTimes(1)
      const [query, update] =
        db.googleDriveProjectStates.updateOne.mock.calls[0]
      expect(query.projectId).toBeDefined()
      expect(update.$set['pendingChanges.main%2Etex'].op).toBe('upsert')
      expect(update.$set['pendingChanges.main%2Etex'].entityId).toBe(entityId)
      expect(update.$set.outboundDirtyAt).toBeInstanceOf(Date)
    })

    it('does nothing when the feature is disabled', async () => {
      Features.hasFeature.mockReturnValue(false)

      await GoogleDriveHookHandler.onFileModified(
        projectId,
        entityId,
        '/main.tex',
        'editor'
      )

      expect(db.googleDriveProjectStates.findOne).not.toHaveBeenCalled()
      expect(db.googleDriveProjectStates.updateOne).not.toHaveBeenCalled()
    })

    it('ignores changes that originated from Google Drive', async () => {
      await GoogleDriveHookHandler.onFileModified(
        projectId,
        entityId,
        '/main.tex',
        'google-drive'
      )

      expect(db.googleDriveProjectStates.updateOne).not.toHaveBeenCalled()
    })

    it('ignores LaTeX build artefacts', async () => {
      GoogleDriveSyncManager.isIgnoredFile.mockReturnValue(true)

      await GoogleDriveHookHandler.onFileModified(
        projectId,
        entityId,
        '/main.aux',
        'editor'
      )

      expect(db.googleDriveProjectStates.updateOne).not.toHaveBeenCalled()
    })

    it('does nothing when the project is not linked to Drive', async () => {
      db.googleDriveProjectStates.findOne.mockResolvedValue(null)

      await GoogleDriveHookHandler.onFileModified(
        projectId,
        entityId,
        '/main.tex',
        'editor'
      )

      expect(db.googleDriveProjectStates.updateOne).not.toHaveBeenCalled()
    })

    it('never throws, so a sync bookkeeping error cannot fail the edit', async () => {
      db.googleDriveProjectStates.updateOne.mockRejectedValue(
        new Error('mongo down')
      )

      await expect(
        GoogleDriveHookHandler.onFileModified(
          projectId,
          entityId,
          '/main.tex',
          'editor'
        )
      ).resolves.toBeUndefined()
      expect(logger.error).toHaveBeenCalled()
    })
  })

  describe('onEntityDeleted', () => {
    it('queues a delete for the removed path', async () => {
      await GoogleDriveHookHandler.onEntityDeleted(
        projectId,
        '/figures/old.png',
        'file',
        'editor'
      )

      const [, update] = db.googleDriveProjectStates.updateOne.mock.calls[0]
      const entry = update.$set['pendingChanges.figures/old%2Epng']
      expect(entry.op).toBe('delete')
      expect(entry.entityType).toBe('file')
    })

    it('ignores deletes that originated from Google Drive', async () => {
      await GoogleDriveHookHandler.onEntityDeleted(
        projectId,
        '/figures/old.png',
        'file',
        'google-drive'
      )

      expect(db.googleDriveProjectStates.updateOne).not.toHaveBeenCalled()
    })
  })

  describe('onDocModified', () => {
    it('resolves the doc path and queues a doc upsert', async () => {
      ProjectEntityHandler.promises.getDocPathByProjectIdAndDocId.mockResolvedValue(
        '/chapters/intro.tex'
      )

      await GoogleDriveHookHandler.onDocModified(projectId, 'doc-9', null, null)

      const [, update] = db.googleDriveProjectStates.updateOne.mock.calls[0]
      const entry = update.$set['pendingChanges.chapters/intro%2Etex']
      expect(entry.op).toBe('upsert')
      expect(entry.entityType).toBe('doc')
      expect(entry.entityId).toBe('doc-9')
    })

    it('checks the project is linked before resolving the path', async () => {
      // Path resolution loads the whole project; skip it for unlinked projects.
      db.googleDriveProjectStates.findOne.mockResolvedValue(null)

      await GoogleDriveHookHandler.onDocModified(projectId, 'doc-9', null, null)

      expect(
        ProjectEntityHandler.promises.getDocPathByProjectIdAndDocId
      ).not.toHaveBeenCalled()
      expect(db.googleDriveProjectStates.updateOne).not.toHaveBeenCalled()
    })

    it('does nothing when the feature is disabled', async () => {
      Features.hasFeature.mockReturnValue(false)

      await GoogleDriveHookHandler.onDocModified(projectId, 'doc-9', null, null)

      expect(db.googleDriveProjectStates.findOne).not.toHaveBeenCalled()
    })

    it('ignores a doc whose path resolves to a build artefact', async () => {
      ProjectEntityHandler.promises.getDocPathByProjectIdAndDocId.mockResolvedValue(
        '/main.aux'
      )
      GoogleDriveSyncManager.isIgnoredFile.mockReturnValue(true)

      await GoogleDriveHookHandler.onDocModified(projectId, 'doc-9', null, null)

      expect(db.googleDriveProjectStates.updateOne).not.toHaveBeenCalled()
    })

    it('never throws when the path cannot be resolved', async () => {
      ProjectEntityHandler.promises.getDocPathByProjectIdAndDocId.mockRejectedValue(
        new Error('doc not in project')
      )

      await expect(
        GoogleDriveHookHandler.onDocModified(projectId, 'doc-9', null, null)
      ).resolves.toBeUndefined()
      expect(logger.error).toHaveBeenCalled()
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/src/Features/GoogleDriveSync/GoogleDriveHookHandler.test.mjs`
Expected: FAIL — `Cannot find module .../GoogleDriveHookHandler.mjs`.

- [ ] **Step 3: Write the implementation**

Create `app/src/Features/GoogleDriveSync/GoogleDriveHookHandler.mjs`:

```javascript
import logger from '@overleaf/logger'
import Features from '../../infrastructure/Features.mjs'
import { db, ObjectId } from '../../infrastructure/mongodb.mjs'
import GoogleDriveSyncManager from './GoogleDriveSyncManager.mjs'
import ProjectEntityHandler from '../Project/ProjectEntityHandler.mjs'

/**
 * Consumes Overleaf's entity-mutation hooks and records which paths need
 * pushing to Google Drive.
 *
 * This runs synchronously on the user's edit path, so it does no Drive I/O
 * and at most one indexed Mongo read plus one write. The actual upload happens
 * later, in GoogleDriveOutboundWorker.
 *
 * Three hooks are needed, because they cover disjoint ground:
 *
 *   - fileModified  - binary files added, replaced or uploaded
 *   - entityDeleted - any deletion
 *   - docModified   - doc *content* edits
 *
 * The third is easy to overlook and essential. Every fileModified fire site in
 * ProjectEntityUpdateHandler operates on a fileRef; editing main.tex in the
 * editor never reaches ProjectEntityUpdateHandler at all - the content flows
 * browser -> real-time -> document-updater -> Redis, and only reaches web when
 * document-updater flushes it back through the private API, which is where
 * docModified fires. Without it, ordinary doc edits would never sync.
 */

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

/**
 * Records a single pending change, or returns early if this change should not
 * be synced at all.
 *
 * @param {string|ObjectId} projectId
 * @param {string} rawPath
 * @param {object} entry
 * @param {string} source
 * @returns {Promise<void>}
 */
async function _queueChange(projectId, rawPath, entry, source) {
  if (!Features.hasFeature('google-drive-sync')) {
    return
  }

  // Loop guard: without this, applying an inbound Drive change would
  // immediately queue an outbound push of the very same content.
  if (source === 'google-drive') {
    return
  }

  if (!projectId || !rawPath) {
    return
  }

  const cleanPath = GoogleDriveSyncManager.normalizePath(rawPath)
  if (!cleanPath || GoogleDriveSyncManager.isIgnoredFile(cleanPath)) {
    return
  }

  const projectObjectId = _toObjectId(projectId)
  const state = await db.googleDriveProjectStates.findOne(
    { projectId: projectObjectId },
    { projection: { _id: 1 } }
  )
  if (!state) {
    // Project isn't linked to Drive; nothing to track.
    return
  }

  const key = GoogleDriveSyncManager.encodePathKey(cleanPath)
  const now = new Date()

  await db.googleDriveProjectStates.updateOne(
    { projectId: projectObjectId },
    {
      $set: {
        [`pendingChanges.${key}`]: { ...entry, queuedAt: now, attempts: 0 },
        outboundDirtyAt: now,
      },
    }
  )
}

const GoogleDriveHookHandler = {
  /**
   * Hook: a doc or file was added, replaced, or upserted in Overleaf.
   *
   * @param {string|ObjectId} projectId
   * @param {string|ObjectId} entityId
   * @param {string} filePath
   * @param {string} source
   * @returns {Promise<void>}
   */
  async onFileModified(projectId, entityId, filePath, source) {
    try {
      await _queueChange(
        projectId,
        filePath,
        { op: 'upsert', entityId, entityType: 'file' },
        source
      )
    } catch (err) {
      // Never let sync bookkeeping fail the user's edit.
      logger.error(
        { err, projectId, filePath },
        'GoogleDriveSync: failed to queue outbound change'
      )
    }
  },

  /**
   * Hook: an entity was deleted from Overleaf.
   *
   * @param {string|ObjectId} projectId
   * @param {string} filePath
   * @param {string} entityType
   * @param {string} source
   * @returns {Promise<void>}
   */
  async onEntityDeleted(projectId, filePath, entityType, source) {
    try {
      await _queueChange(
        projectId,
        filePath,
        { op: 'delete', entityId: null, entityType },
        source
      )
    } catch (err) {
      logger.error(
        { err, projectId, filePath },
        'GoogleDriveSync: failed to queue outbound delete'
      )
    }
  },

  /**
   * Hook: document-updater flushed a doc's content back to web.
   *
   * Unlike the other two hooks this carries no `source`, so the loop guard
   * cannot apply: an inbound Drive apply eventually flushes and lands here
   * too. GoogleDriveOutboundWorker closes that loop by comparing the doc's
   * content hash against fileMap before pushing, and skipping when equal.
   *
   * @param {string|ObjectId} projectId
   * @param {string|ObjectId} docId
   * @param {object} ranges unused
   * @param {Date} lastUpdatedAt unused
   * @returns {Promise<void>}
   */
  async onDocModified(projectId, docId, ranges, lastUpdatedAt) {
    try {
      if (!Features.hasFeature('google-drive-sync') || !projectId || !docId) {
        return
      }

      // Check the project is linked *before* resolving the path: path
      // resolution loads the entire project document, which is far too
      // expensive to do on every doc flush for projects that aren't synced.
      const state = await db.googleDriveProjectStates.findOne(
        { projectId: _toObjectId(projectId) },
        { projection: { _id: 1 } }
      )
      if (!state) {
        return
      }

      const docPath =
        await ProjectEntityHandler.promises.getDocPathByProjectIdAndDocId(
          projectId,
          docId
        )

      await _queueChange(
        projectId,
        docPath,
        { op: 'upsert', entityId: docId, entityType: 'doc' },
        // No source available; the worker's content-hash check is the guard.
        'docupdater'
      )
    } catch (err) {
      logger.error(
        { err, projectId, docId },
        'GoogleDriveSync: failed to queue outbound doc change'
      )
    }
  },
}

export default GoogleDriveHookHandler
export { GoogleDriveHookHandler }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/src/Features/GoogleDriveSync/GoogleDriveHookHandler.test.mjs`
Expected: PASS, 13 tests.

- [ ] **Step 5: Stop and report**

Do not commit. Report and wait.

---

## Task 6: Outbound batch worker

Drains the dirty set. This is the task that actually restores automatic outbound sync.

**Files:**
- Create: `app/src/Features/GoogleDriveSync/GoogleDriveOutboundWorker.mjs`
- Test: `test/unit/src/Features/GoogleDriveSync/GoogleDriveOutboundWorker.test.mjs`

**Interfaces:**
- Consumes: `Settings.googleDrive.outboundFlushSeconds` / `.outboundDebounceSeconds` (Task 1); `decodePathKey`, `recordSyncFailure`, `clearSyncFailure`, `acquireProjectLock`, `releaseProjectLock`, `handleOutboundDocUpdate`, `handleOutboundFileUpdate`, `handleOutboundDelete` from `GoogleDriveSyncManager` (Task 4 + existing).
- Produces: `GoogleDriveOutboundWorker.flushAll(): Promise<void>`, `.flushProject(state): Promise<void>`, `.start(): void`, `.stop(): void`.

Existing manager signatures this worker calls — do not change them:
- `handleOutboundDocUpdate(projectId, docId, rawPath, rev)`
- `handleOutboundFileUpdate(projectId, fileId, rawPath, hash)`
- `handleOutboundDelete(projectId, rawPath)`

Each already looks up its own project state, resolves parent folders, uploads, and updates `fileMap`. The worker's job is only sequencing, locking, and queue bookkeeping.

- [ ] **Step 1: Write the failing test**

Create `test/unit/src/Features/GoogleDriveSync/GoogleDriveOutboundWorker.test.mjs`:

```javascript
import { describe, it, beforeEach, vi, expect } from 'vitest'

const modulePath =
  '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveOutboundWorker.mjs'

describe('GoogleDriveOutboundWorker', () => {
  let GoogleDriveOutboundWorker

  const Settings = {
    googleDrive: { outboundFlushSeconds: 600, outboundDebounceSeconds: 15 },
  }

  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }

  const Features = { hasFeature: vi.fn() }

  const db = {
    googleDriveProjectStates: {
      find: vi.fn(),
      updateOne: vi.fn(),
    },
  }

  const GoogleDriveSyncManager = {
    decodePathKey: vi.fn(k => String(k).replace(/%2E/g, '.')),
    acquireProjectLock: vi.fn(),
    releaseProjectLock: vi.fn(),
    recordSyncFailure: vi.fn(),
    clearSyncFailure: vi.fn(),
    handleOutboundDocUpdate: vi.fn(),
    handleOutboundFileUpdate: vi.fn(),
    handleOutboundDelete: vi.fn(),
  }

  const DocstoreManager = { promises: { getDoc: vi.fn() } }

  vi.doMock(
    '../../../../../app/src/Features/Docstore/DocstoreManager.mjs',
    () => ({ default: DocstoreManager })
  )
  vi.doMock('@overleaf/settings', () => ({ default: Settings }))
  vi.doMock('@overleaf/logger', () => ({ default: logger }))
  vi.doMock('../../../../../app/src/infrastructure/Features.mjs', () => ({
    default: Features,
  }))
  vi.doMock('../../../../../app/src/infrastructure/mongodb.mjs', () => ({
    db,
  }))
  vi.doMock(
    '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveSyncManager.mjs',
    () => ({ default: GoogleDriveSyncManager, ...GoogleDriveSyncManager })
  )

  const projectId = 'project-1'

  function mockCursor(docs) {
    return {
      async *[Symbol.asyncIterator]() {
        yield* docs
      },
    }
  }

  function stateWith(pendingChanges, overrides = {}) {
    return {
      projectId,
      userId: 'user-1',
      driveFolderId: 'folder-1',
      pendingChanges,
      outboundDirtyAt: new Date(Date.now() - 60000),
      ...overrides,
    }
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    Features.hasFeature.mockReturnValue(true)
    GoogleDriveSyncManager.acquireProjectLock.mockResolvedValue(true)
    GoogleDriveSyncManager.handleOutboundDocUpdate.mockResolvedValue({
      success: true,
    })
    GoogleDriveSyncManager.handleOutboundFileUpdate.mockResolvedValue({
      success: true,
    })
    GoogleDriveSyncManager.handleOutboundDelete.mockResolvedValue({
      success: true,
    })
    db.googleDriveProjectStates.updateOne.mockResolvedValue({})

    const mod = await import(modulePath)
    GoogleDriveOutboundWorker = mod.default
    GoogleDriveOutboundWorker.stop()
  })

  describe('flushProject', () => {
    it('pushes each pending path and removes it from the queue', async () => {
      const state = stateWith({
        'main%2Etex': { op: 'upsert', entityType: 'doc', entityId: 'doc-1' },
        'fig%2Epng': { op: 'upsert', entityType: 'file', entityId: 'file-1' },
      })

      await GoogleDriveOutboundWorker.flushProject(state)

      expect(
        GoogleDriveSyncManager.handleOutboundDocUpdate
      ).toHaveBeenCalledWith(projectId, 'doc-1', 'main.tex', undefined)
      expect(
        GoogleDriveSyncManager.handleOutboundFileUpdate
      ).toHaveBeenCalledWith(projectId, 'file-1', 'fig.png', undefined)

      const unsetKeys = db.googleDriveProjectStates.updateOne.mock.calls
        .flatMap(([, update]) => Object.keys(update.$unset || {}))
      expect(unsetKeys).toContain('pendingChanges.main%2Etex')
      expect(unsetKeys).toContain('pendingChanges.fig%2Epng')
    })

    it('never performs a full project rescan', async () => {
      const state = stateWith({
        'main%2Etex': { op: 'upsert', entityType: 'doc', entityId: 'doc-1' },
      })

      await GoogleDriveOutboundWorker.flushProject(state)

      expect(GoogleDriveSyncManager.syncProject).toBeUndefined()
    })

    it('skips a doc whose content already matches what Drive holds', async () => {
      // md5 of 'hello' — the loop guard for docModified, which carries no
      // source and so re-queues content we just pulled in from Drive.
      const md5 = '5d41402abc4b2a76b9719d911017c592'
      DocstoreManager.promises.getDoc.mockResolvedValue({ lines: ['hello'] })
      const state = stateWith(
        { 'main%2Etex': { op: 'upsert', entityType: 'doc', entityId: 'doc-1' } },
        { fileMap: { 'main.tex': { md5Checksum: md5 } } }
      )

      await GoogleDriveOutboundWorker.flushProject(state)

      expect(
        GoogleDriveSyncManager.handleOutboundDocUpdate
      ).not.toHaveBeenCalled()
      const unsetKeys = db.googleDriveProjectStates.updateOne.mock.calls
        .flatMap(([, update]) => Object.keys(update.$unset || {}))
      expect(unsetKeys).toContain('pendingChanges.main%2Etex')
    })

    it('pushes a doc whose content has actually changed', async () => {
      DocstoreManager.promises.getDoc.mockResolvedValue({ lines: ['goodbye'] })
      const state = stateWith(
        { 'main%2Etex': { op: 'upsert', entityType: 'doc', entityId: 'doc-1' } },
        { fileMap: { 'main.tex': { md5Checksum: 'stale-checksum' } } }
      )

      await GoogleDriveOutboundWorker.flushProject(state)

      expect(GoogleDriveSyncManager.handleOutboundDocUpdate).toHaveBeenCalled()
    })

    it('routes deletes to handleOutboundDelete', async () => {
      const state = stateWith({
        'old%2Epng': { op: 'delete', entityType: 'file' },
      })

      await GoogleDriveOutboundWorker.flushProject(state)

      expect(GoogleDriveSyncManager.handleOutboundDelete).toHaveBeenCalledWith(
        projectId,
        'old.png'
      )
    })

    it('keeps a failed entry queued and increments its attempt count', async () => {
      GoogleDriveSyncManager.handleOutboundDocUpdate.mockRejectedValue(
        new Error('drive exploded')
      )
      const state = stateWith({
        'main%2Etex': {
          op: 'upsert',
          entityType: 'doc',
          entityId: 'doc-1',
          attempts: 1,
        },
      })

      await GoogleDriveOutboundWorker.flushProject(state)

      const attemptUpdate = db.googleDriveProjectStates.updateOne.mock.calls
        .map(([, update]) => update.$set)
        .find(set => set && set['pendingChanges.main%2Etex.attempts'] != null)
      expect(attemptUpdate['pendingChanges.main%2Etex.attempts']).toBe(2)

      const unsetKeys = db.googleDriveProjectStates.updateOne.mock.calls
        .flatMap(([, update]) => Object.keys(update.$unset || {}))
      expect(unsetKeys).not.toContain('pendingChanges.main%2Etex')
    })

    it('drops an entry that has exhausted its attempts', async () => {
      GoogleDriveSyncManager.handleOutboundDocUpdate.mockRejectedValue(
        new Error('permanently broken')
      )
      const state = stateWith({
        'main%2Etex': {
          op: 'upsert',
          entityType: 'doc',
          entityId: 'doc-1',
          attempts: 5,
        },
      })

      await GoogleDriveOutboundWorker.flushProject(state)

      const unsetKeys = db.googleDriveProjectStates.updateOne.mock.calls
        .flatMap(([, update]) => Object.keys(update.$unset || {}))
      expect(unsetKeys).toContain('pendingChanges.main%2Etex')
      expect(logger.error).toHaveBeenCalled()
    })

    it('records a backoff when Drive reports rate limiting', async () => {
      const err = new Error('quota')
      err.rateLimited = true
      GoogleDriveSyncManager.handleOutboundDocUpdate.mockRejectedValue(err)
      const state = stateWith({
        'main%2Etex': { op: 'upsert', entityType: 'doc', entityId: 'doc-1' },
      })

      await GoogleDriveOutboundWorker.flushProject(state)

      expect(GoogleDriveSyncManager.recordSyncFailure).toHaveBeenCalledWith(
        projectId,
        err
      )
    })

    it('clears the failure state when the queue drains cleanly', async () => {
      const state = stateWith({
        'main%2Etex': { op: 'upsert', entityType: 'doc', entityId: 'doc-1' },
      })

      await GoogleDriveOutboundWorker.flushProject(state)

      expect(GoogleDriveSyncManager.clearSyncFailure).toHaveBeenCalledWith(
        projectId
      )
    })

    it('skips the project entirely when the lock is held', async () => {
      GoogleDriveSyncManager.acquireProjectLock.mockResolvedValue(false)
      const state = stateWith({
        'main%2Etex': { op: 'upsert', entityType: 'doc', entityId: 'doc-1' },
      })

      await GoogleDriveOutboundWorker.flushProject(state)

      expect(
        GoogleDriveSyncManager.handleOutboundDocUpdate
      ).not.toHaveBeenCalled()
      expect(GoogleDriveSyncManager.releaseProjectLock).not.toHaveBeenCalled()
    })

    it('always releases the lock it acquired', async () => {
      GoogleDriveSyncManager.handleOutboundDocUpdate.mockRejectedValue(
        new Error('boom')
      )
      const state = stateWith({
        'main%2Etex': { op: 'upsert', entityType: 'doc', entityId: 'doc-1' },
      })

      await GoogleDriveOutboundWorker.flushProject(state)

      expect(GoogleDriveSyncManager.releaseProjectLock).toHaveBeenCalledWith(
        projectId
      )
    })
  })

  describe('flushAll', () => {
    it('selects only settled, non-suspended, non-backed-off projects', async () => {
      db.googleDriveProjectStates.find.mockReturnValue(mockCursor([]))

      await GoogleDriveOutboundWorker.flushAll()

      const query = db.googleDriveProjectStates.find.mock.calls[0][0]
      expect(query.outboundDirtyAt.$lt).toBeInstanceOf(Date)
      expect(query.syncSuspended).toEqual({ $ne: true })
      expect(query.$or).toEqual(
        expect.arrayContaining([
          { backoffUntil: { $exists: false } },
          { backoffUntil: null },
          expect.objectContaining({ backoffUntil: expect.anything() }),
        ])
      )
    })

    it('applies the debounce window from settings', async () => {
      Settings.googleDrive.outboundDebounceSeconds = 30
      db.googleDriveProjectStates.find.mockReturnValue(mockCursor([]))

      await GoogleDriveOutboundWorker.flushAll()

      const query = db.googleDriveProjectStates.find.mock.calls[0][0]
      const windowMs = Date.now() - query.outboundDirtyAt.$lt.getTime()
      expect(windowMs).toBeGreaterThan(29000)
      expect(windowMs).toBeLessThan(31000)
    })

    it('does nothing when the feature is disabled', async () => {
      Features.hasFeature.mockReturnValue(false)

      await GoogleDriveOutboundWorker.flushAll()

      expect(db.googleDriveProjectStates.find).not.toHaveBeenCalled()
    })

    it('continues past a project that throws', async () => {
      const bad = stateWith({
        'a%2Etex': { op: 'upsert', entityType: 'doc', entityId: 'doc-a' },
      })
      const good = stateWith(
        { 'b%2Etex': { op: 'upsert', entityType: 'doc', entityId: 'doc-b' } },
        { projectId: 'project-2' }
      )
      db.googleDriveProjectStates.find.mockReturnValue(mockCursor([bad, good]))
      GoogleDriveSyncManager.acquireProjectLock
        .mockRejectedValueOnce(new Error('lock blew up'))
        .mockResolvedValue(true)

      await GoogleDriveOutboundWorker.flushAll()

      expect(logger.error).toHaveBeenCalled()
      expect(
        GoogleDriveSyncManager.handleOutboundDocUpdate
      ).toHaveBeenCalledWith('project-2', 'doc-b', 'b.tex', undefined)
    })
  })

  describe('start / stop', () => {
    it('does not start a timer when the feature is disabled', () => {
      Features.hasFeature.mockReturnValue(false)
      GoogleDriveOutboundWorker.start()
      expect(logger.info).not.toHaveBeenCalled()
    })

    it('starts only once', () => {
      GoogleDriveOutboundWorker.start()
      GoogleDriveOutboundWorker.start()
      expect(logger.info).toHaveBeenCalledTimes(1)
      GoogleDriveOutboundWorker.stop()
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/src/Features/GoogleDriveSync/GoogleDriveOutboundWorker.test.mjs`
Expected: FAIL — `Cannot find module .../GoogleDriveOutboundWorker.mjs`.

- [ ] **Step 3: Write the implementation**

Create `app/src/Features/GoogleDriveSync/GoogleDriveOutboundWorker.mjs`:

```javascript
import crypto from 'node:crypto'
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import Features from '../../infrastructure/Features.mjs'
import { db } from '../../infrastructure/mongodb.mjs'
import GoogleDriveSyncManager from './GoogleDriveSyncManager.mjs'
import DocstoreManager from '../Docstore/DocstoreManager.mjs'

/**
 * Batched outbound synchronization: Overleaf -> Google Drive.
 *
 * GoogleDriveHookHandler records which paths changed; this worker pushes only
 * those paths on a relaxed timer. It deliberately never calls syncProject:
 * that re-lists and re-checksums the entire project, which is affordable as a
 * user-triggered action but not on a timer.
 */

const OUTBOUND_MAX_ATTEMPTS = 5

let flushTimer = null
let isFlushing = false

/**
 * True when the doc's current content already matches what we last uploaded
 * to Drive, making a push pointless.
 *
 * This is the loop guard for the docModified hook, which carries no `source`:
 * an inbound Drive apply writes through document-updater, which flushes and
 * fires docModified, queueing a push of the exact bytes Drive already holds.
 * The hash must be computed identically to handleOutboundDocUpdate's upload
 * buffer (`lines.join('\n')` as utf8) or nothing will ever match.
 *
 * @param {string} projectId
 * @param {string} filePath
 * @param {object} entry
 * @param {object} state
 * @returns {Promise<boolean>}
 */
async function _docIsUnchanged(projectId, filePath, entry, state) {
  const mapped = state.fileMap?.[filePath]
  if (!mapped?.md5Checksum) {
    return false
  }

  const { lines } = await DocstoreManager.promises.getDoc(
    projectId,
    entry.entityId
  )
  const content = Array.isArray(lines) ? lines.join('\n') : lines || ''
  const hash = crypto
    .createHash('md5')
    .update(Buffer.from(content, 'utf8'))
    .digest('hex')

  return hash === mapped.md5Checksum
}

/**
 * Pushes one queued change. Returns nothing; throws on failure so the caller
 * can decide whether to retain or drop the entry.
 *
 * @param {string} projectId
 * @param {string} filePath
 * @param {object} entry
 * @param {object} state
 * @returns {Promise<void>}
 */
async function _applyChange(projectId, filePath, entry, state) {
  if (entry.op === 'delete') {
    await GoogleDriveSyncManager.handleOutboundDelete(projectId, filePath)
    return
  }

  if (entry.entityType === 'doc') {
    if (await _docIsUnchanged(projectId, filePath, entry, state)) {
      logger.debug(
        { projectId, filePath },
        'GoogleDriveOutboundWorker: doc unchanged since last push, skipping'
      )
      return
    }
    await GoogleDriveSyncManager.handleOutboundDocUpdate(
      projectId,
      entry.entityId,
      filePath,
      entry.rev
    )
    return
  }

  await GoogleDriveSyncManager.handleOutboundFileUpdate(
    projectId,
    entry.entityId,
    filePath,
    entry.hash
  )
}

const GoogleDriveOutboundWorker = {
  /**
   * Flushes one project's pending changes.
   *
   * @param {object} state a googleDriveProjectStates document
   * @returns {Promise<void>}
   */
  async flushProject(state) {
    const projectId = state.projectId
    const pending = state.pendingChanges || {}
    const keys = Object.keys(pending)
    if (keys.length === 0) {
      return
    }

    const lockAcquired =
      await GoogleDriveSyncManager.acquireProjectLock(projectId)
    if (!lockAcquired) {
      // A manual sync or inbound apply is already working on this project.
      logger.debug(
        { projectId },
        'GoogleDriveOutboundWorker: project locked, skipping this cycle'
      )
      return
    }

    let allSucceeded = true

    try {
      // Oldest first, so a delete queued before a re-add is applied in order.
      const ordered = keys.sort((a, b) => {
        const at = new Date(pending[a]?.queuedAt || 0).getTime()
        const bt = new Date(pending[b]?.queuedAt || 0).getTime()
        return at - bt
      })

      for (const key of ordered) {
        const entry = pending[key]
        const filePath = GoogleDriveSyncManager.decodePathKey(key)

        try {
          await _applyChange(projectId, filePath, entry, state)
          await db.googleDriveProjectStates.updateOne(
            { projectId },
            { $unset: { [`pendingChanges.${key}`]: '' } }
          )
        } catch (err) {
          allSucceeded = false
          const attempts = (entry.attempts || 0) + 1

          if (attempts >= OUTBOUND_MAX_ATTEMPTS) {
            // One permanently broken file must not wedge the project forever.
            logger.error(
              { err, projectId, filePath, attempts },
              'GoogleDriveOutboundWorker: dropping change after max attempts'
            )
            await db.googleDriveProjectStates.updateOne(
              { projectId },
              { $unset: { [`pendingChanges.${key}`]: '' } }
            )
          } else {
            logger.warn(
              { err, projectId, filePath, attempts },
              'GoogleDriveOutboundWorker: change failed, will retry'
            )
            await db.googleDriveProjectStates.updateOne(
              { projectId },
              {
                $set: {
                  [`pendingChanges.${key}.attempts`]: attempts,
                  lastOutboundError: err?.message || String(err),
                },
              }
            )
          }

          if (err?.rateLimited) {
            // Stop working this project; the whole account is being throttled.
            await GoogleDriveSyncManager.recordSyncFailure(projectId, err)
            return
          }
        }
      }

      if (allSucceeded) {
        await GoogleDriveSyncManager.clearSyncFailure(projectId)
        await db.googleDriveProjectStates.updateOne(
          { projectId },
          {
            $set: { syncStatus: 'idle', lastSyncedAt: new Date() },
            $unset: { outboundDirtyAt: '' },
          }
        )
      }
    } finally {
      await GoogleDriveSyncManager.releaseProjectLock(projectId)
    }
  },

  /**
   * Selects and flushes every project whose dirty set has settled.
   *
   * @returns {Promise<void>}
   */
  async flushAll() {
    if (!Features.hasFeature('google-drive-sync')) {
      return
    }

    if (isFlushing) {
      logger.debug(
        'GoogleDriveOutboundWorker: flush already in progress, skipping cycle'
      )
      return
    }

    isFlushing = true
    try {
      const debounceSeconds =
        Settings.googleDrive?.outboundDebounceSeconds ?? 15
      const settledBefore = new Date(Date.now() - debounceSeconds * 1000)
      const now = new Date()

      const cursor = db.googleDriveProjectStates.find({
        outboundDirtyAt: { $lt: settledBefore },
        syncSuspended: { $ne: true },
        $or: [
          { backoffUntil: { $exists: false } },
          { backoffUntil: null },
          { backoffUntil: { $lt: now } },
        ],
      })

      for await (const state of cursor) {
        try {
          await GoogleDriveOutboundWorker.flushProject(state)
        } catch (err) {
          logger.error(
            { err, projectId: state.projectId },
            'GoogleDriveOutboundWorker: error flushing project'
          )
        }
      }
    } catch (err) {
      logger.error(
        { err },
        'GoogleDriveOutboundWorker: unexpected error during flushAll'
      )
    } finally {
      isFlushing = false
    }
  },

  /**
   * Starts the recurring flush timer.
   */
  start() {
    if (flushTimer) {
      return
    }
    if (!Features.hasFeature('google-drive-sync')) {
      return
    }

    const flushSeconds = Settings.googleDrive?.outboundFlushSeconds || 600

    logger.info(
      { flushSeconds },
      'GoogleDriveOutboundWorker: starting outbound flush worker'
    )

    flushTimer = setInterval(() => {
      GoogleDriveOutboundWorker.flushAll().catch(err => {
        logger.error(
          { err },
          'GoogleDriveOutboundWorker: error during interval execution'
        )
      })
    }, flushSeconds * 1000)
    flushTimer.unref()
  },

  /**
   * Stops the recurring flush timer.
   */
  stop() {
    if (flushTimer) {
      clearInterval(flushTimer)
      flushTimer = null
      logger.info('GoogleDriveOutboundWorker: stopped outbound flush worker')
    }
  },
}

export default GoogleDriveOutboundWorker
export { GoogleDriveOutboundWorker }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/src/Features/GoogleDriveSync/GoogleDriveOutboundWorker.test.mjs`
Expected: PASS, 17 tests.

- [ ] **Step 5: Stop and report**

Do not commit. Report and wait.

---

## Task 7: Wire it together

Attaches the hooks and starts the worker. Until this task, nothing built so far actually runs.

**Files:**
- Modify: `app/src/Features/GoogleDriveSync/index.mjs` (whole file)
- Modify: `app/src/Features/GoogleDriveSync/GoogleDriveController.mjs:159-176` (`syncProjectNow`)
- Test: `test/unit/src/Features/GoogleDriveSync/index.test.mjs` (rewrite), `test/unit/src/Features/GoogleDriveSync/GoogleDriveController.test.mjs` (add cases)

**Interfaces:**
- Consumes: everything from Tasks 5 and 6, plus `Modules.hooks.attach` from `app/src/infrastructure/Modules.mjs`.
- Produces: `GoogleDriveSync.start()` — called from `app.mjs`, unchanged signature.

- [ ] **Step 1: Write the failing test for index.mjs**

Replace the body of `test/unit/src/Features/GoogleDriveSync/index.test.mjs` with:

```javascript
import { describe, it, beforeEach, vi, expect } from 'vitest'

const modulePath =
  '../../../../../app/src/Features/GoogleDriveSync/index.mjs'

describe('GoogleDriveSync index', () => {
  let GoogleDriveSync

  const Features = { hasFeature: vi.fn() }
  const GoogleDrivePollingWorker = { start: vi.fn(), stop: vi.fn() }
  const GoogleDriveOutboundWorker = { start: vi.fn(), stop: vi.fn() }
  const GoogleDriveHookHandler = {
    onFileModified: vi.fn(),
    onEntityDeleted: vi.fn(),
    onDocModified: vi.fn(),
  }
  const Modules = { hooks: { attach: vi.fn() } }

  vi.doMock('../../../../../app/src/infrastructure/Features.mjs', () => ({
    default: Features,
  }))
  vi.doMock('../../../../../app/src/infrastructure/Modules.mjs', () => ({
    default: Modules,
  }))
  vi.doMock(
    '../../../../../app/src/Features/GoogleDriveSync/GoogleDrivePollingWorker.mjs',
    () => ({ default: GoogleDrivePollingWorker })
  )
  vi.doMock(
    '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveOutboundWorker.mjs',
    () => ({ default: GoogleDriveOutboundWorker })
  )
  vi.doMock(
    '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveHookHandler.mjs',
    () => ({ default: GoogleDriveHookHandler })
  )

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import(modulePath)
    GoogleDriveSync = mod.default
  })

  it('starts both workers and attaches all three hooks when enabled', () => {
    Features.hasFeature.mockReturnValue(true)

    GoogleDriveSync.start()

    expect(GoogleDrivePollingWorker.start).toHaveBeenCalled()
    expect(GoogleDriveOutboundWorker.start).toHaveBeenCalled()
    expect(Modules.hooks.attach).toHaveBeenCalledWith(
      'fileModified',
      GoogleDriveHookHandler.onFileModified
    )
    expect(Modules.hooks.attach).toHaveBeenCalledWith(
      'entityDeleted',
      GoogleDriveHookHandler.onEntityDeleted
    )
    // Without this one, doc content edits never sync at all.
    expect(Modules.hooks.attach).toHaveBeenCalledWith(
      'docModified',
      GoogleDriveHookHandler.onDocModified
    )
  })

  it('does nothing at all when the feature is disabled', () => {
    Features.hasFeature.mockReturnValue(false)

    GoogleDriveSync.start()

    expect(GoogleDrivePollingWorker.start).not.toHaveBeenCalled()
    expect(GoogleDriveOutboundWorker.start).not.toHaveBeenCalled()
    expect(Modules.hooks.attach).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unit/src/Features/GoogleDriveSync/index.test.mjs`
Expected: FAIL — the outbound worker and hook attachment do not exist yet.

- [ ] **Step 3: Rewrite index.mjs**

Replace the whole of `app/src/Features/GoogleDriveSync/index.mjs`:

```javascript
import Features from '../../infrastructure/Features.mjs'
import Modules from '../../infrastructure/Modules.mjs'
import GoogleDrivePollingWorker from './GoogleDrivePollingWorker.mjs'
import GoogleDriveOutboundWorker from './GoogleDriveOutboundWorker.mjs'
import GoogleDriveHookHandler from './GoogleDriveHookHandler.mjs'

/**
 * Starts the Google Drive background jobs and attaches the entity hooks.
 *
 * Called once from app.mjs at boot, alongside the other background workers.
 * Route mounting (GoogleDriveRouter) deliberately has no side effects, so
 * importing the router does not start timers.
 *
 * Sync is asymmetric, mirroring Overleaf Cloud's Dropbox integration:
 *
 *   - Inbound (Drive -> Overleaf) runs on the polling worker's delta feed.
 *   - Outbound (Overleaf -> Drive) is queued per-file by the hook handler and
 *     flushed in batches by the outbound worker.
 *
 * Outbound is deliberately not immediate. An earlier implementation scheduled
 * a full syncProject a debounced 8s after every local edit; syncProject
 * re-lists and re-checksums every file in the project, so a single-file edit
 * cost a full pass over the whole tree, repeatedly, and ran into Drive API
 * rate limits. The hook handler now records only the paths that actually
 * changed, and the outbound worker pushes just those.
 */
function start() {
  if (!Features.hasFeature('google-drive-sync')) {
    return
  }

  Modules.hooks.attach('fileModified', GoogleDriveHookHandler.onFileModified)
  Modules.hooks.attach('entityDeleted', GoogleDriveHookHandler.onEntityDeleted)
  // docModified is an upstream Overleaf hook fired when document-updater
  // flushes a doc back to web. It is the only signal for doc *content* edits;
  // fileModified covers binary files only.
  Modules.hooks.attach('docModified', GoogleDriveHookHandler.onDocModified)

  GoogleDrivePollingWorker.start()
  GoogleDriveOutboundWorker.start()
}

export default { start }
export { start }
```

- [ ] **Step 4: Run the index test to verify it passes**

Run: `npx vitest run test/unit/src/Features/GoogleDriveSync/index.test.mjs`
Expected: PASS, 2 tests.

- [ ] **Step 5: Write the failing controller test**

Add to `test/unit/src/Features/GoogleDriveSync/GoogleDriveController.test.mjs`, inside the existing `describe('syncProjectNow', ...)` block:

```javascript
    it('clears the pending queue after a successful full sync', async () => {
      GoogleDriveSyncManager.enforceManualSyncCooldown.mockResolvedValue({
        allowed: true,
      })
      GoogleDriveSyncManager.syncProject.mockResolvedValue({ success: true })

      await GoogleDriveController.syncProjectNow(req, res)

      expect(db.googleDriveProjectStates.updateOne).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: expect.anything() }),
        expect.objectContaining({
          $set: { pendingChanges: {} },
          $unset: { outboundDirtyAt: '' },
        })
      )
    })

    it('leaves the pending queue alone when the sync fails', async () => {
      GoogleDriveSyncManager.enforceManualSyncCooldown.mockResolvedValue({
        allowed: true,
      })
      GoogleDriveSyncManager.syncProject.mockRejectedValue(new Error('nope'))

      await GoogleDriveController.syncProjectNow(req, res)

      expect(db.googleDriveProjectStates.updateOne).not.toHaveBeenCalled()
    })
```

This requires the controller test file to mock `db`; add a `db` mock following the pattern in `GoogleDriveHookHandler.test.mjs` if one is not already present.

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run test/unit/src/Features/GoogleDriveSync/GoogleDriveController.test.mjs -t "pending queue"`
Expected: FAIL — the controller does not touch `pendingChanges`.

- [ ] **Step 7: Update the controller**

In `app/src/Features/GoogleDriveSync/GoogleDriveController.mjs`, add the import:

```javascript
import { db, ObjectId } from '../../infrastructure/mongodb.mjs'
```

Then in `syncProjectNow`, replace the line `const result = await GoogleDriveSyncManager.syncProject(projectId, userId)` and the return that follows it with:

```javascript
      const result = await GoogleDriveSyncManager.syncProject(projectId, userId)

      // A full reconcile subsumes every queued path, so the outbound worker
      // has nothing left to do for this project.
      await db.googleDriveProjectStates.updateOne(
        { projectId: ObjectId.isValid(projectId) ? new ObjectId(projectId) : projectId },
        { $set: { pendingChanges: {} }, $unset: { outboundDirtyAt: '' } }
      )

      return res.json({ success: true, result })
```

Note the cooldown default now comes from settings automatically (Task 4), so the existing `enforceManualSyncCooldown(projectId)` call needs no change.

- [ ] **Step 8: Run the controller tests**

Run: `npx vitest run test/unit/src/Features/GoogleDriveSync/GoogleDriveController.test.mjs`
Expected: PASS, including all pre-existing tests.

- [ ] **Step 9: Stop and report**

Do not commit. Report and wait.

---

## Task 8: Full suite verification

**Files:** none modified — this is a verification gate.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: a verified, green module.

- [ ] **Step 1: Run the whole Google Drive suite**

Run: `npx vitest run test/unit/src/Features/GoogleDriveSync/`
Expected: PASS, every file. Report the exact counts.

- [ ] **Step 2: Run the touched neighbours**

Run: `npx vitest run test/unit/src/infrastructure/ test/unit/src/Project/`
Expected: PASS. `ProjectEntityUpdateHandler` fires the hooks this plan consumes; its tests must be unaffected because the handler side is unchanged.

- [ ] **Step 3: Lint the new and changed files**

Run: `npx eslint app/src/Features/GoogleDriveSync/ test/unit/src/Features/GoogleDriveSync/`
Expected: no errors. Fix any that appear — do not disable rules.

- [ ] **Step 4: Confirm clean disablement**

Read back `index.mjs`, `GoogleDriveOutboundWorker.start`, and `GoogleDriveHookHandler._queueChange`. Confirm by inspection that with `ENABLE_GOOGLE_DRIVE_SYNC` unset, each returns before doing any work, and that the hook handler performs zero database calls. State the three call sites you checked.

- [ ] **Step 5: Report honestly and stop**

Report to the user:
- exact test counts per file, and the full output of any failure
- the complete list of files created and modified
- anything you could not verify

Do not commit. The user handles all git operations.

---

## Deferred to later plans

These spec sections are **not** implemented here and must not be attempted:

- §3 — inbound push notifications (`GoogleDriveWatchManager`, renewal worker, webhook route, polling-worker fallback ratio). Spec phase 3.
- §5 — conflict copies, and the outbound divergence check that defers to them. Spec phase 4. **Until phase 4 lands, the outbound worker overwrites the Drive copy on every push.** That is the same behaviour the module has today via manual sync, so this plan introduces no regression, but it is the known gap.
- §6 — rename/move by Drive file ID, and the `entityId` / `entityType` backfill in `fileMap`. Spec phase 4.
- §7 — duplicate project-name handling. Spec phase 4.
- §9.1 — `googleDriveUserCredentials` watch fields. Spec phase 3.
- `GOOGLE_DRIVE_WEBHOOK_URL`, `GOOGLE_DRIVE_WEBHOOK_SECRET`, `GOOGLE_DRIVE_CHANNEL_RENEW_INTERVAL_SECONDS`, `GOOGLE_DRIVE_WATCHED_USER_POLL_RATIO`. Spec phase 3.

## Verification notes for the implementer

**Three hooks, and the third is the important one.** `fileModified` fires only from file-oriented call sites in `ProjectEntityUpdateHandler` — all three fire sites operate on a `fileRef`. Doc *content* edits never pass through `ProjectEntityUpdateHandler` at all. They are covered by `docModified`, an upstream hook fired from `DocumentController.setDocument`, the private-API endpoint document-updater calls on every flush. Attaching only the first two would produce a module that syncs uploaded images and deletions but silently never syncs `main.tex` — which would look like it worked in a smoke test and fail the actual use case.

**The doc content-hash check is not an optimisation.** `docModified` carries no `source`, so the `'google-drive'` loop guard cannot apply to it: applying an inbound Drive change writes through document-updater, which flushes and fires `docModified`, re-queueing the same bytes. `_docIsUnchanged` is what breaks that cycle. Its hash must stay byte-identical to `handleOutboundDocUpdate`'s upload buffer — both use `lines.join('\n')` encoded as utf8. If those two ever diverge, docs will either loop forever or never sync.

**Manual verification after Task 8**, on the dev server with `GOOGLE_DRIVE_OUTBOUND_FLUSH_SECONDS=120`:
1. Link an account, sync a project, confirm the Drive folder appears.
2. Edit `main.tex` in the editor, wait ~2.5 min, confirm the change reaches Drive. *This is the case the hooks were missing.*
3. Upload an image, wait, confirm it appears in Drive.
4. Delete a file, wait, confirm it disappears from Drive.
5. Edit the same doc twice within the debounce window and confirm exactly one upload occurs.
6. Leave the project idle for two cycles and confirm no Drive API calls are made.
