# Template Gallery Module (`template-gallery`)

A mirror of the overleaf.com template gallery. It fetches the same catalogue,
detail pages, previews and PDFs as overleaf.com, keeps them on the Overleaf
data volume, and serves them from there for faster use. There are no custom or
uploaded templates, no review or publish workflow, and no per-item metadata
editing.

## Activation

The feature gate is off by default.

```env
TEMPLATE_GALLERY_ENABLED=true
# Optional: requests a minute to overleaf.com per outbound route (1-120)
TEMPLATE_GALLERY_FETCH_RPM=30
```

`TEMPLATE_GALLERY_FETCH_RPM` caps how often each outbound route (the direct
connection and each proxy) starts a request to overleaf.com. The sync fetches in
parallel, but starts stay at least `60 / rpm` seconds apart, and the budget is
shared with users opening gallery pages. The default, 30, is half the one
request a second overleaf.com is seen to accept. On a 403/429 the route slows
down and backs off on its own. Raise the value only with a proxy pool behind
you; adding proxies is the better way to sync faster.

Everything else is fixed in `app/src/TemplateGalleryDefaults.mjs`. Admins set
the rest through the admin API under `/admin/templates/api`:

- **Sync settings** (`settings`): `autoSync` (off by default; when on, a sync
  runs every `refetchDays` days) and `refetchDays` (default 7, range 1-365).
  Nothing is fetched from overleaf.com unless a sync is started or auto sync is on.
- **Egress proxies** (`egress`): optional HTTP, HTTPS, SOCKS5 or SOCKS5H proxies
  for requests to overleaf.com, Algolia and S3. With none configured, requests
  go direct. Proxy logins are sealed with the session key and never returned.
- **Session cookie** (`credentials/session`): the overleaf.com session cookie,
  which lets "Open as template" fetch complete projects.

## What the mirror does

- **Sync runs:** started by an admin ("Sync now") or by auto sync. Only the
  leader process runs them. A run walks five phases in order:
  1. `catalogue`: template list from Algolia.
  2. `new`: featured blocks and the first 3 gallery recent pages.
  3. `rescan`: full gallery listing walk, only when asked for.
  4. `details`: detail pages and PDFs of missing or outdated templates, in
     parallel within the request budget above.
  5. `tags`: tag pages.

  The run and its phase are stored in Mongo, so a restart or a new leader
  resumes it. A stop request halts work at the next step. Per-host request
  pacing lives in `transport/HostLimiter.mjs`.
- **Open as template:** source acquisition through overleaf.com session replay
  (tier 1), followed by single-file synthesis from the public main source (tier 3).
- **Garbage collection and integrity:** unreferenced blobs are swept after a
  grace period. Corrupt blobs are dereferenced so they are fetched or acquired again.
- **Admin templates page:** sync status and settings, sync now or stop, refetch
  one item's details or source, running jobs, host limiter, egress proxies,
  storage and the session cookie.

## Database

Collections: `templateGalleryItems`, `templateGalleryTags`,
`templateGalleryListings`, `templateGalleryCrawlerState`,
`templateGalleryJobs`, `templateGalleryLocks`, `templateGalleryConfig`.

Items are mirror documents keyed by overleaf.com token. `state` is `published`
for mirrored items and `unpublished` once the crawler sees the item removed upstream.

Indexes are created at boot by `persistence/Indexes.mjs`. There are no migrations.

## Storage, backup and restore

Everything the gallery keeps on disk lives under `storageDir` (default
`/var/lib/overleaf/data/template-gallery`). The main data volume is the single
backup unit.

### Layout

```
template-gallery/
  store.json                       store identity (uuid, created once)
  blobs/sha256/<2hex>/<64hex>      content-addressed blobs (media, source packages)
  catalog/current.json             pointer to the newest complete snapshot
  catalog/gen-<generation>/        manifest.json + one <collection>.jsonl.gz per collection
  tmp/ scratch/ quarantine/        working areas
```

### What is snapshotted

The rebuildable collections: `templateGalleryItems`, `templateGalleryTags`,
`templateGalleryListings`, `templateGalleryCrawlerState`. Each document is one
canonical EJSON line, gzipped.

Not snapshotted: jobs, locks and `templateGalleryConfig`. The config holds an
encrypted cookie bound to `SESSION_SECRET` and usage counters, so it is not portable.

### When exports happen

- 30 seconds after the last write to a snapshotted collection, at most 10 minutes after the first unsaved write.
- Every 6 hours while there are unsaved writes.
- Once at boot when Items exist but no snapshot does.
- On shutdown, bounded to 20 seconds.

An export writes a new generation, fsyncs it, then swaps `current.json`
atomically. Only one process per cluster exports at a time (Mongo lease `snapshot`).

### Boot restore

On boot, after storage is probed and before indexes are ensured:

| Items in Mongo | Snapshot on volume | Action |
| --- | --- | --- |
| empty | present | restore from the snapshot, offline, no upstream traffic |
| present | absent | backfill: export right away |
| present | present | nothing |
| empty | absent | nothing (fresh install) |

Restore verifies every file before inserting anything. A corrupt snapshot is
logged and ignored. A transient error keeps the module not ready
(`readinessState.error = 'snapshot_restore_failed'`) until the next restart.

### Command line

Run inside the web container from `services/web`:

```bash
node modules/template-gallery/scripts/snapshot.mjs status   # show the current snapshot (no database access)
node modules/template-gallery/scripts/snapshot.mjs export   # write a new generation now
node modules/template-gallery/scripts/snapshot.mjs import   # load the snapshot; refuses unless Items is empty
```

### Restoring after a database loss

1. Restore the data volume from backup (or keep it, if it survived).
2. Start Overleaf with the module enabled and an empty database.
3. Boot restores the catalogue from `catalog/current.json`. No overleaf.com traffic is needed.
