# Google Drive Deploy Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the missing MongoDB indexes for the Google Drive sync collections, and make the Drive OAuth redirect and webhook URLs derive correctly from `OVERLEAF_SITE_URL` in the server-ce image.

**Architecture:** Two independent changes. The first adds an east migration (plus the collection registrations it depends on) so the two Google Drive collections get their indexes at container boot, like every other Overleaf collection. The second adds a `googleDrive` block to the server-ce settings override file so the derived URLs are computed from the `siteUrl` that file already binds, instead of inheriting the `PUBLIC_URL`-derived values from `settings.defaults.js`.

**Tech Stack:** Node.js ESM, MongoDB 6.x driver, `east` migration runner, `@overleaf/settings` (defaults + override merge), Docker for a disposable verification Mongo.

**Spec:** None. This was classified as a bounded change during brainstorming, so no spec document was written. The agreed design is reproduced in full in the Context section below — read it before starting.

## Global Constraints

- Migration filename format is `YYYYMMDDHHMMSS_<description>.mjs`, enforced by `.eastrc` (`migrationNumberFormat: "dateTime"`). Use exactly `20260907120000_create_googleDrive_indexes.mjs` — it must sort after the current newest, `20260619120000_create_libraryReferences_match_indexes.mjs`.
- Migration `tags` must be exactly `['server-ce', 'server-pro', 'saas']`. `server-ce/init_scripts/900_run_web_migrations.sh` runs `east migrate -t server-ce`; a migration tagged only `['saas']` is silently skipped on this deployment.
- Do not modify `overleaf/services/web/config/settings.defaults.js`. It is upstream code; the whole point of Task 2 is to fix the derivation in the server-ce override file instead of forking upstream.
- Do not touch `OVERLEAF_URL`, `PUBLIC_URL`, or any of the `Features/OAuth2/*.mjs` files. Removing that env var is being handled in a separate worktree; this branch must not conflict with it.
- Never run `git commit` or any other git command without explicit approval from the repo owner. This is a standing project rule (`CLAUDE.md`).
- Commit messages: short, clean, no `Co-Authored-By` trailer, matching the style of recent commits (e.g. `feat(mcp): add Overleaf MCP server with OAuth2 auth`).

---

## Context

### The two defects

**1. No indexes on the Google Drive collections.**

`overleaf/services/web/app/src/infrastructure/mongodb.mjs:128-173` declares Mongoose schemas for both collections with `index: true` / `unique: true`. None of those indexes are ever created:

- `app/src/infrastructure/Mongoose.mjs:7` sets `mongoose.set('autoIndex', false)` globally.
- The feature code never uses those Mongoose models. Every read and write in `Features/GoogleDriveSync/` goes through the native driver handles (`db.googleDriveUserCredentials`, `db.googleDriveProjectStates`). The two `Mongoose.model()` exports at `mongodb.mjs:175-183` are dead code.
- The project's real index mechanism is `overleaf/tools/migrations/*.mjs`. `grep -l googleDrive` across all 180 files returns nothing.

Result: both collections are created implicitly on first write with only the default `_id` index.

**2. `OVERLEAF_SITE_URL` does not reach the derived Drive URLs.**

`services/web/config/settings.defaults.js:337` binds its local `siteUrl` from `process.env.PUBLIC_URL`, falling back to `http://127.0.0.1:3000`. Lines 1164-1173 derive `googleDrive.redirectUri` and `googleDrive.webhookUrl` from that local variable.

`server-ce/config/settings.js:200` binds its own `siteUrl` from `OVERLEAF_SITE_URL`, but never defines a `googleDrive` key. `libraries/settings/Settings.js:39` merges via `merge(overrides, defaults)`, so the defaults' already-computed `googleDrive` values survive untouched. `PUBLIC_URL` is not set anywhere in `server-ce`.

Verified by executing the loader with `OVERLEAF_SITE_URL=https://overleaf.dangdd.tech`:

```
redirectUri: http://127.0.0.1:3000/oauth/google-drive/callback
webhookUrl : ""
```

Google Drive account linking would redirect users to `127.0.0.1`, and push notifications would be silently disabled.

### Access patterns behind the index choices

Derived by reading the query sites, not by copying the schema declarations:

| Collection | Index | Justified by |
|---|---|---|
| `googleDriveUserCredentials` | `{user_id: 1}` unique | `GoogleDriveOAuthManager.mjs:283,348,424,482`, `GoogleDriveWatchManager.mjs:61,147`. Unique also makes the link upsert at `GoogleDriveOAuthManager.mjs:311` race-safe — concurrent upserts can only be deduplicated by a unique index. |
| | `{watchChannelId: 1}` | `GoogleDriveWebhookController.mjs:70`, once per Google push notification. |
| `googleDriveProjectStates` | `{projectId: 1}` unique | `GoogleDriveController.mjs:296,357`, `GoogleDriveOutboundWorker.mjs:180,194,203,224`, `GoogleDriveSyncManager.mjs:167,176,201,375,400,437`. |
| | `{userId: 1}` | `GoogleDriveSyncManager.mjs:1814,1955` (`find({userId})` list-by-user). |
| | `{outboundDirtyAt: 1}` | `GoogleDriveOutboundWorker.mjs:260`, the flush poll running every `outboundFlushSeconds` (default 600). **Not declared in the Mongoose schema** — this one was missed by the original implementation. |

`GoogleDrivePollingWorker.mjs:36` and `GoogleDriveChannelRenewalWorker.mjs:33` both do `find({})` full scans. That is intentional ("visit every linked user"), and no index helps. Do not add one.

### Why the index work is urgent

Both collections are currently empty — nothing is created until a user links a Drive account. Creating a unique index on a collection that already contains duplicates **fails**. Doing this before the feature is enabled in production is free; doing it afterwards may not be.

### Environment constraints discovered during planning

- **Docker is blocked by the tool sandbox.** `docker ps` returns `permission denied ... unix:///var/run/docker.sock` under the default sandbox and succeeds with `dangerouslyDisableSandbox: true`. Every `docker` step below needs that flag.
- **The worktree has no `node_modules`.** `yarn install` cannot reach the registry from this environment. The main checkout at `/home/dangdd/projects/overleaf-fullsetup/overleaf/node_modules` has everything needed (`east`, `mongodb`, `@overleaf/settings`). Task 1 Step 1 symlinks it in. The symlink is gitignored and must not be committed.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `overleaf/tools/migrations/lib/mongodb.mjs` | Modify (after line 28) | Registers driver handles for the migration runner. Needs the two Google Drive entries; without them `db.googleDriveUserCredentials` is `undefined` and the migration throws. |
| `overleaf/tools/migrations/20260907120000_create_googleDrive_indexes.mjs` | Create | The migration itself: five indexes across two collections, plus rollback. |
| `overleaf/server-ce/config/settings.js` | Modify (between lines 235 and 237) | Adds the `googleDrive` block deriving `redirectUri` and `webhookUrl` from `siteUrl`. |

Two tasks. Task 1 covers the first two files — they are inseparable, since the migration cannot run without the registration and the registration is pointless without the migration. Task 2 covers the third file and is independently reviewable.

---

### Task 1: Google Drive index migration

**Files:**
- Modify: `overleaf/tools/migrations/lib/mongodb.mjs:28-29`
- Create: `overleaf/tools/migrations/20260907120000_create_googleDrive_indexes.mjs`
- Test: no committed test file. Verification is a live run against a disposable Mongo, driving the migration's exported `migrate` / `rollback` directly. The repo has no unit-test harness for migrations, and adding one is out of scope.

**Interfaces:**
- Consumes: `Helpers.addIndexesToCollection(collection, indexes)` and `Helpers.dropIndexesFromCollection(collection, indexes)` from `overleaf/tools/migrations/lib/helpers.mjs`. `addIndexesToCollection` calls `collection.createIndex(index.key, index)`, passing the whole descriptor as options — so `unique: true` on the descriptor is honoured, and it sets `background: true` itself. Do not set `background` manually.
- Produces: a default export `{ tags, migrate, rollback }`. `migrate` and `rollback` each take a single `client` argument and destructure `const { db } = client`, where `db` is the collection map exported by `lib/mongodb.mjs`.

- [ ] **Step 1: Link in node_modules so the migration can be executed**

The worktree has no installed dependencies and the registry is unreachable. Point at the main checkout's:

```bash
ln -s /home/dangdd/projects/overleaf-fullsetup/overleaf/node_modules \
      /home/dangdd/projects/overleaf-fullsetup/.claude/worktrees/google-drive-deploy-fixes/overleaf/node_modules
```

Confirm it resolves:

```bash
ls -L /home/dangdd/projects/overleaf-fullsetup/.claude/worktrees/google-drive-deploy-fixes/overleaf/node_modules/.bin/east
```

Expected: the path prints. This symlink is throwaway — never `git add` it.

- [ ] **Step 2: Start a disposable MongoDB**

Run with `dangerouslyDisableSandbox: true` — the sandbox blocks the Docker socket.

Port 27019 is used to avoid colliding with any running dev server. The replica set matches how Overleaf runs Mongo elsewhere in this repo (`docker-compose.yaml` uses `--replSet overleaf`, and `overleaf/develop/dev.env` connects with `directConnection=true`).

```bash
docker run -d --name gdrive-index-verify -p 27019:27017 mongo:latest --replSet gdtest
sleep 3
docker exec gdrive-index-verify mongosh --quiet --eval \
  'rs.initiate({_id:"gdtest",members:[{_id:0,host:"127.0.0.1:27017"}]})'
```

Expected: the `rs.initiate` output contains `ok: 1`.

- [ ] **Step 3: Write the failing verification**

Create the harness at `$TMPDIR/verify-gdrive-indexes.sh`. It asserts the exact index name set on both collections. Writing to `$TMPDIR` keeps it out of the repo.

```bash
cat > "$TMPDIR/verify-gdrive-indexes.sh" <<'EOF'
#!/bin/bash
set -uo pipefail

EXPECTED_CREDS='_id_,user_id_1,watchChannelId_1'
EXPECTED_STATES='_id_,outboundDirtyAt_1,projectId_1,userId_1'

read_indexes() {
  docker exec gdrive-index-verify mongosh sharelatex --quiet --eval \
    "db.getCollection('$1').getIndexes().map(i => i.name).sort().join(',')"
}

read_unique() {
  docker exec gdrive-index-verify mongosh sharelatex --quiet --eval \
    "JSON.stringify(db.getCollection('$1').getIndexes().filter(i => i.unique).map(i => i.name).sort())"
}

CREDS=$(read_indexes googleDriveUserCredentials)
STATES=$(read_indexes googleDriveProjectStates)
CREDS_UNIQUE=$(read_unique googleDriveUserCredentials)
STATES_UNIQUE=$(read_unique googleDriveProjectStates)

FAIL=0
[ "$CREDS" = "$EXPECTED_CREDS" ] || { echo "FAIL creds indexes: got [$CREDS] want [$EXPECTED_CREDS]"; FAIL=1; }
[ "$STATES" = "$EXPECTED_STATES" ] || { echo "FAIL states indexes: got [$STATES] want [$EXPECTED_STATES]"; FAIL=1; }
[ "$CREDS_UNIQUE" = '["user_id_1"]' ] || { echo "FAIL creds unique: got $CREDS_UNIQUE want [\"user_id_1\"]"; FAIL=1; }
[ "$STATES_UNIQUE" = '["projectId_1"]' ] || { echo "FAIL states unique: got $STATES_UNIQUE want [\"projectId_1\"]"; FAIL=1; }

[ "$FAIL" = 0 ] && echo "PASS: all five indexes present with correct unique flags"
exit $FAIL
EOF
chmod +x "$TMPDIR/verify-gdrive-indexes.sh"
```

- [ ] **Step 4: Run the verification to confirm it fails**

Run with `dangerouslyDisableSandbox: true` (it shells out to `docker exec`).

```bash
"$TMPDIR/verify-gdrive-indexes.sh"
```

Expected: FAIL. Both collections are absent, so `getIndexes()` returns an empty list and the joined string is empty — you should see `FAIL creds indexes: got [] want [_id_,user_id_1,watchChannelId_1]` and the three sibling failures. Exit code 1.

If it prints PASS here, stop — you are pointed at the wrong database.

- [ ] **Step 5: Register the two collections in the migrations db map**

In `overleaf/tools/migrations/lib/mongodb.mjs`, insert immediately after line 28 (`globalMetrics: internalDb.collection('globalMetrics'),`) and before line 29 (`grouppolicies:`). Alphabetical order puts `googleDrive*` after `globalMetrics` (`l` < `o`).

```js
  googleDriveProjectStates: internalDb.collection('googleDriveProjectStates'),
  googleDriveUserCredentials: internalDb.collection(
    'googleDriveUserCredentials'
  ),
```

The second entry is wrapped because the single-line form exceeds the print width; this matches how `services/web/app/src/infrastructure/mongodb.mjs:54-56` writes the same entry.

- [ ] **Step 6: Write the migration**

Create `overleaf/tools/migrations/20260907120000_create_googleDrive_indexes.mjs` with exactly this content. The shape follows `20190912145001_create_contacts_indexes.mjs`, which is the closest existing example that creates a unique index.

```js
/* eslint-disable no-unused-vars */

import Helpers from './lib/helpers.mjs'

const tags = ['server-ce', 'server-pro', 'saas']

const userCredentialsIndexes = [
  {
    unique: true,
    key: {
      user_id: 1,
    },
    name: 'user_id_1',
  },
  {
    key: {
      watchChannelId: 1,
    },
    name: 'watchChannelId_1',
  },
]

const projectStatesIndexes = [
  {
    unique: true,
    key: {
      projectId: 1,
    },
    name: 'projectId_1',
  },
  {
    key: {
      userId: 1,
    },
    name: 'userId_1',
  },
  {
    key: {
      outboundDirtyAt: 1,
    },
    name: 'outboundDirtyAt_1',
  },
]

const migrate = async client => {
  const { db } = client

  await Helpers.addIndexesToCollection(
    db.googleDriveUserCredentials,
    userCredentialsIndexes
  )
  await Helpers.addIndexesToCollection(
    db.googleDriveProjectStates,
    projectStatesIndexes
  )
}

const rollback = async client => {
  const { db } = client

  try {
    await Helpers.dropIndexesFromCollection(
      db.googleDriveUserCredentials,
      userCredentialsIndexes
    )
    await Helpers.dropIndexesFromCollection(
      db.googleDriveProjectStates,
      projectStatesIndexes
    )
  } catch (err) {
    console.error('Something went wrong rolling back the migrations', err)
  }
}

export default {
  tags,
  migrate,
  rollback,
}
```

- [ ] **Step 7: Run the migration against the disposable Mongo**

Drive the exported `migrate` directly rather than through the `east` CLI. This tests exactly the code being added, runs in a second, and avoids executing the other 180 migrations.

`MONGO_CONNECTION_STRING` is read by `overleaf/tools/migrations/config/settings.defaults.js:15-18`, which is what `lib/mongodb.mjs` uses to build its client.

```bash
cd /home/dangdd/projects/overleaf-fullsetup/.claude/worktrees/google-drive-deploy-fixes/overleaf/tools/migrations

MONGO_CONNECTION_STRING="mongodb://127.0.0.1:27019/sharelatex?directConnection=true" \
MONGO_SOCKET_TIMEOUT=0 \
node --input-type=module -e "
import { db } from './lib/mongodb.mjs'
import migration from './20260907120000_create_googleDrive_indexes.mjs'
await migration.migrate({ db })
console.log('migrate() completed')
process.exit(0)
"
```

Expected: `migrate() completed`, no stack trace.

If this throws `Cannot read properties of undefined (reading 'createIndex')`, Step 5 was not applied correctly — the collection is missing from the db map.

- [ ] **Step 8: Run the verification to confirm it passes**

Run with `dangerouslyDisableSandbox: true`.

```bash
"$TMPDIR/verify-gdrive-indexes.sh"
```

Expected: `PASS: all five indexes present with correct unique flags`, exit code 0.

- [ ] **Step 9: Verify the unique constraint actually bites**

The whole point of `unique: true` is rejecting a duplicate. Prove it rather than trusting the index metadata. Run with `dangerouslyDisableSandbox: true`.

```bash
docker exec gdrive-index-verify mongosh sharelatex --quiet --eval '
  const uid = ObjectId();
  db.googleDriveUserCredentials.insertOne({ user_id: uid, googleEmail: "a@example.com" });
  try {
    db.googleDriveUserCredentials.insertOne({ user_id: uid, googleEmail: "b@example.com" });
    print("FAIL: duplicate user_id was accepted");
  } catch (e) {
    print(e.code === 11000 ? "PASS: duplicate rejected with E11000" : "FAIL: unexpected error " + e.code);
  }
  db.googleDriveUserCredentials.deleteMany({ user_id: uid });
'
```

Expected: `PASS: duplicate rejected with E11000`.

- [ ] **Step 10: Verify rollback**

```bash
cd /home/dangdd/projects/overleaf-fullsetup/.claude/worktrees/google-drive-deploy-fixes/overleaf/tools/migrations

MONGO_CONNECTION_STRING="mongodb://127.0.0.1:27019/sharelatex?directConnection=true" \
MONGO_SOCKET_TIMEOUT=0 \
node --input-type=module -e "
import { db } from './lib/mongodb.mjs'
import migration from './20260907120000_create_googleDrive_indexes.mjs'
await migration.rollback({ db })
console.log('rollback() completed')
process.exit(0)
"

"$TMPDIR/verify-gdrive-indexes.sh"
```

Expected: `rollback() completed`, then the verification FAILS again, reporting only `_id_` remaining on both collections. That failure is the success condition for this step.

Then re-apply so the database is left in the migrated state (repeat Step 7) and confirm PASS (repeat Step 8). This also proves the migration is idempotent-safe to re-run after a rollback.

- [ ] **Step 11: Lint the changed files**

```bash
cd /home/dangdd/projects/overleaf-fullsetup/.claude/worktrees/google-drive-deploy-fixes/overleaf
./node_modules/.bin/eslint --no-eslintrc --config .eslintrc.json \
  tools/migrations/20260907120000_create_googleDrive_indexes.mjs \
  tools/migrations/lib/mongodb.mjs 2>&1 | tail -20
```

Expected: no errors. If eslint config resolution fails from the symlinked `node_modules`, skip this step and note it in the handoff — it is a convenience check, not a correctness gate.

- [ ] **Step 12: Tear down the disposable Mongo**

Run with `dangerouslyDisableSandbox: true`.

```bash
docker rm -f gdrive-index-verify
```

Expected: the container name prints. Confirm it is gone with `docker ps -a --filter name=gdrive-index-verify`.

- [ ] **Step 13: Request approval to commit**

Do **not** run git commands yet. Show the owner:

```bash
cd /home/dangdd/projects/overleaf-fullsetup/.claude/worktrees/google-drive-deploy-fixes
git status --short
git diff --stat
```

Confirm `git status --short` lists only the two intended files and does **not** list `overleaf/node_modules`. Then propose this exact command and wait for an explicit yes:

```bash
git add overleaf/tools/migrations/lib/mongodb.mjs \
        overleaf/tools/migrations/20260907120000_create_googleDrive_indexes.mjs
git commit -m "feat(google-drive): add indexes for sync collections"
```

---

### Task 2: Derive Drive URLs from OVERLEAF_SITE_URL in server-ce

**Files:**
- Modify: `overleaf/server-ce/config/settings.js`, inserting between line 235 (the closing `},` of the `security` block) and line 237 (`csp: {`)
- Test: no committed test file. Verification loads the real settings module through `@overleaf/settings` and asserts the merged output.

**Interfaces:**
- Consumes: the `siteUrl` variable declared at `server-ce/config/settings.js:15` (`let redisConfig, siteUrl`) and assigned at line 200 (`siteUrl: (siteUrl = process.env.OVERLEAF_SITE_URL || 'http://localhost')`).
- Consumes: the `overleaf/node_modules` symlink created in Task 1 Step 1. Node resolves `@overleaf/settings` by walking up from `overleaf/services/web`, and the worktree has no installed dependencies of its own. If Task 2 is executed standalone, run Task 1 Step 1 first.
- Produces: `Settings.googleDrive.redirectUri` and `Settings.googleDrive.webhookUrl`, both strings, consumed by `services/web/app/src/Features/GoogleDriveSync/GoogleDriveOAuthManager.mjs:211,245,257`.

**Placement constraint — read this before editing.** The block *must* go after line 200. Object literals evaluate top to bottom, and `siteUrl` only receives its value in the line-200 assignment expression. Placing the block earlier (next to `enableGitBridge` on line 74, for instance) yields `undefined/oauth/google-drive/callback`. The chosen slot after the `security` block is the nearest sensible grouping that satisfies this.

- [ ] **Step 1: Write the failing test**

Create `$TMPDIR/verify-gdrive-urls.sh`. It loads the settings exactly the way the server-ce container does — defaults from `services/web/config/settings.defaults.js` (found via CWD), overrides from `OVERLEAF_CONFIG` — and checks three things: both URLs derive from the site URL, the explicit env overrides still win, and the merge did not clobber the sibling keys from the defaults.

```bash
cat > "$TMPDIR/verify-gdrive-urls.sh" <<'EOF'
#!/bin/bash
set -uo pipefail

WT=/home/dangdd/projects/overleaf-fullsetup/.claude/worktrees/google-drive-deploy-fixes
cd "$WT/overleaf/services/web" || exit 1

run() {
  env -i PATH="$PATH" HOME="$HOME" \
    OVERLEAF_CONFIG="$WT/overleaf/server-ce/config/settings.js" \
    OVERLEAF_SITE_URL=https://overleaf.dangdd.tech \
    ENABLE_GOOGLE_DRIVE_SYNC=true \
    GOOGLE_DRIVE_CLIENT_ID=testid \
    GOOGLE_DRIVE_CLIENT_SECRET=testsecret \
    "$@" \
    node -e "
      const s = require('@overleaf/settings')
      console.log(JSON.stringify({
        redirectUri: s.googleDrive.redirectUri,
        webhookUrl: s.googleDrive.webhookUrl,
        clientId: s.googleDrive.clientId,
        maxRps: s.googleDrive.maxRps,
      }))
    " 2>/dev/null | tail -1
}

FAIL=0
check() {
  if [ "$2" = "$3" ]; then echo "  ok: $1"; else echo "  FAIL: $1 -> got [$2] want [$3]"; FAIL=1; fi
}

echo "case 1: derived from OVERLEAF_SITE_URL"
OUT=$(run)
check redirectUri "$(echo "$OUT" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).redirectUri')" \
  "https://overleaf.dangdd.tech/oauth/google-drive/callback"
check webhookUrl "$(echo "$OUT" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).webhookUrl')" \
  "https://overleaf.dangdd.tech/google-drive/webhook"
check clientId "$(echo "$OUT" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).clientId')" "testid"
check maxRps "$(echo "$OUT" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).maxRps')" "8"

echo "case 2: explicit env overrides still win"
OUT=$(run GOOGLE_DRIVE_REDIRECT_URI=https://custom.example.com/oauth/google-drive/callback \
          GOOGLE_DRIVE_WEBHOOK_URL=https://custom.example.com/google-drive/webhook)
check redirectUri "$(echo "$OUT" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).redirectUri')" \
  "https://custom.example.com/oauth/google-drive/callback"
check webhookUrl "$(echo "$OUT" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).webhookUrl')" \
  "https://custom.example.com/google-drive/webhook"

[ "$FAIL" = 0 ] && echo "PASS: all URL derivations correct"
exit $FAIL
EOF
chmod +x "$TMPDIR/verify-gdrive-urls.sh"
```

The `maxRps` and `clientId` checks are the regression guard for the merge: `libraries/settings/merge.js` recurses into plain objects, so a partial `googleDrive` override should deep-merge and leave the defaults' other keys intact. If those two checks ever fail, the merge is shallow and the block needs to restate every key.

- [ ] **Step 2: Run the test to verify it fails**

```bash
"$TMPDIR/verify-gdrive-urls.sh"
```

Expected: FAIL on case 1, reporting `redirectUri -> got [http://127.0.0.1:3000/oauth/google-drive/callback]` and `webhookUrl -> got []`. Case 2 should already pass, because the env overrides are honoured by the defaults file. Exit code 1.

- [ ] **Step 3: Add the googleDrive block**

In `overleaf/server-ce/config/settings.js`, insert between the closing `},` of the `security` block (line 235) and the blank line before `csp: {` (line 237):

```js
  // Google Drive sync derives its OAuth redirect and webhook URLs from the
  // site URL. settings.defaults.js derives them from PUBLIC_URL, which
  // server-ce never sets, so they are re-derived here from the siteUrl
  // assigned above. Explicit environment variables still take precedence.
  googleDrive: {
    redirectUri:
      process.env.GOOGLE_DRIVE_REDIRECT_URI ||
      `${siteUrl}/oauth/google-drive/callback`,
    webhookUrl:
      process.env.GOOGLE_DRIVE_WEBHOOK_URL !== undefined
        ? process.env.GOOGLE_DRIVE_WEBHOOK_URL
        : siteUrl.startsWith('https://')
          ? `${siteUrl}/google-drive/webhook`
          : '',
  },
```

Two deliberate details, both mirroring `settings.defaults.js:1161-1173`:

- The webhook uses `!== undefined` rather than `||`, so setting `GOOGLE_DRIVE_WEBHOOK_URL=""` is an explicit "disable push notifications" rather than falling through to the derived value.
- The webhook is only derived for `https://` site URLs. Google refuses to register a push channel against a plaintext endpoint.

Unlike the defaults file, no `?.` is needed on `siteUrl` — line 200 guarantees a string via its `|| 'http://localhost'` fallback.

- [ ] **Step 4: Run the test to verify it passes**

```bash
"$TMPDIR/verify-gdrive-urls.sh"
```

Expected: `PASS: all URL derivations correct`, exit code 0. All six checks report `ok:`.

- [ ] **Step 5: Check the http-only path**

Confirm the webhook stays empty on a plaintext site URL, which is the behaviour a local or reverse-proxy-less deployment depends on.

```bash
cd /home/dangdd/projects/overleaf-fullsetup/.claude/worktrees/google-drive-deploy-fixes/overleaf/services/web

OVERLEAF_CONFIG=../../server-ce/config/settings.js \
OVERLEAF_SITE_URL=http://localhost \
node -e "
  const s = require('@overleaf/settings')
  console.log('redirectUri:', s.googleDrive.redirectUri)
  console.log('webhookUrl :', JSON.stringify(s.googleDrive.webhookUrl))
" 2>/dev/null | tail -2
```

Expected:

```
redirectUri: http://localhost/oauth/google-drive/callback
webhookUrl : ""
```

- [ ] **Step 6: Request approval to commit**

Do **not** run git commands yet. Show the owner:

```bash
cd /home/dangdd/projects/overleaf-fullsetup/.claude/worktrees/google-drive-deploy-fixes
git diff overleaf/server-ce/config/settings.js
```

Then propose this exact command and wait for an explicit yes:

```bash
git add overleaf/server-ce/config/settings.js
git commit -m "fix(google-drive): derive redirect and webhook URLs from site URL"
```

---

## Done Criteria

- Five indexes exist on the two Google Drive collections after the migration runs, with `unique` on `user_id_1` and `projectId_1` only, and a duplicate `user_id` insert is rejected with E11000.
- The migration is tagged `['server-ce', 'server-pro', 'saas']` so `900_run_web_migrations.sh` picks it up on this deployment.
- `Settings.googleDrive.redirectUri` and `.webhookUrl` derive from `OVERLEAF_SITE_URL` in the server-ce image, with `GOOGLE_DRIVE_REDIRECT_URI` / `GOOGLE_DRIVE_WEBHOOK_URL` still working as overrides, and `clientId` / `maxRps` unaffected by the merge.
- `overleaf/node_modules` symlink is not committed.
- No changes to `settings.defaults.js`, `OVERLEAF_URL`, `PUBLIC_URL`, or any `Features/OAuth2/*.mjs` file.

## Follow-Up, Not In Scope

Deliberately excluded from this branch:

1. **`OVERLEAF_URL` consolidation** — handled in the separate `env-flag-naming` worktree, which removes the variable entirely. Touching it here would conflict.
2. **nginx `/.well-known/oauth-protected-resource`** — `server-ce/nginx/mcp.conf.template` only proxies `location /mcp`, but `services/mcp/src/oauth.js:34` advertises the metadata at the site root. Most MCP clients fall back to `/.well-known/oauth-authorization-server`, which `web` serves, so this is a latent risk rather than a live break.
3. **Dead Mongoose models** — `mongodb.mjs:128-183` in `services/web` defines two schemas and models that nothing uses. Removing them (or documenting why they stay) is cleanup, not a fix.
4. **`mcp` service missing from `overleaf/develop/docker-compose.yml`** — blocks exercising MCP on the dev server.

## Deployment Note

After this branch merges and a new image is built, `GOOGLE_DRIVE_REDIRECT_URI` and `GOOGLE_DRIVE_WEBHOOK_URL` become optional in `variable.env` — `OVERLEAF_SITE_URL` alone will produce the right values. They can stay set without harm; explicit values still win.

The migration runs automatically at container boot via `900_run_web_migrations.sh`, before any user can link an account, so both collections will be empty and the unique index creation cannot fail on existing duplicates.
