export type SyncDetailStatus =
  | 'ok'
  | 'syncing'
  | 'queued'
  | 'failed'
  | 'removed'

export type SyncSourceStatus = 'ok' | 'pending' | 'failed' | 'backoff'

export type SyncFilter = 'all' | SyncDetailStatus

// Derived on the server by CatalogueService.toSyncBlock. The same block is
// returned by the list, the item page and the refetch endpoints.
export type SyncSource = 'full' | 'git' | 'single-file' | 'none'

export interface SyncBlock {
  crawledAt: string | null
  hydratedAt: string | null
  detailStatus: SyncDetailStatus
  sourceStatus: SyncSourceStatus
  source: SyncSource
  acquisitionTier: number | null
  failures: number
  lastError: string | null
  nextAttemptAt: string | null
  removedAt: string | null
}

export interface ItemRow {
  id: string
  slug: string
  title: string
  upstreamUrl: string
  galleryUrl: string
  sync: SyncBlock
}

export interface ItemTag {
  name: string
  title: string
}

export interface ItemDetail {
  id: string
  slug: string
  title: string
  author: string | null
  tags: ItemTag[]
  upstreamUrl: string
  galleryUrl: string
  licenseLabel: string | null
  sync: SyncBlock
}

export interface ListItemsParams {
  q?: string
  sync?: SyncFilter
  page?: number
  pageSize?: number
}

export interface ListItemsResponse {
  items: ItemRow[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

export interface ItemDetailResponse {
  item: ItemDetail
}

// Hydrate (details) answers synchronously with the new sync block. On failure,
// reason says why; retryAt is when another sync attempt becomes eligible.
export interface DetailsRefetchResult {
  status: 'ok' | 'failed'
  reason?: string | null
  retryAt?: string | null
  sync: SyncBlock
}

// Source acquisition answers synchronously. 'backoff' means the item is
// waiting to retry, so nothing was fetched.
export interface SourceRefetchResult {
  status: 'ok' | 'failed' | 'backoff'
  reason?: string | null
  retryAt?: string | null
  sync: SyncBlock
}

export interface SyncSettings {
  autoSync: boolean
  refetchDays: number
}

export interface Credential {
  configured: boolean
  updatedAt: string | null
  invalid: boolean
}

export interface SyncOverview {
  autoSync: boolean
  refetchDays: number
  nextAutoRunAt: string | null
  listUpdatedAt: string | null
}

export interface StorageUsage {
  usedBytes: number
  files: number
  freeBytes: number | null
  totalBytes: number | null
}

export interface StatusFull {
  ready: boolean
  sync: SyncOverview
  storage: StorageUsage | null
}

export type SyncPhaseName = 'catalogue' | 'new' | 'rescan' | 'details' | 'tags'

export interface SyncPhase {
  name: SyncPhaseName
  state: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  done: number
  failed: number
  total: number | null
  error: string | null
  lastError: string | null
}

export interface SyncRun {
  id: string
  state: 'running' | 'done' | 'cancelled' | 'failed'
  trigger: 'manual' | 'auto'
  rescan: boolean
  stopping: boolean
  waitingUntil: string | null
  waitReason: 'throttled' | 'unavailable' | null
  waitError: string | null
  error: string | null
  startedAt: string | null
  finishedAt: string | null
  phases: SyncPhase[]
}

export interface StatusSummary {
  counts: {
    total: number
    synced: number
    syncing: number
    queued: number
    failed: number
    removed: number
  }
  run: SyncRun | null
}
