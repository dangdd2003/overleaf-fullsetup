// overleaf/services/web/modules/template-gallery/app/src/TemplateGalleryDefaults.mjs
//
// The only configuration of the mirror. Nothing here is read from env vars or
// settings.js: change a value here and redeploy. The one exception is the
// overleaf.com request budget, which TEMPLATE_GALLERY_FETCH_RPM may override
// (see ModuleSettings.mjs).
const KiB = 1024
const MiB = 1024 * KiB
const HOUR = 3600_000

export const DEFAULTS = {
  // Sub-folder of the main Overleaf data volume (one volume, one backup)
  storageDir: '/var/lib/overleaf/data/template-gallery',
  crawler: {
    // Algolia catalogue weekly, recent listings hourly, detail pages and PDFs
    // fetched by the parallel sync pool (jobs/Scheduler.mjs). Outbound routes
    // and per-route pacing are in transport/RateGate.mjs.
    algolia: {
      // public search-only key from <meta name="ol-algolia">; refreshed
      // automatically when Algolia rejects it
      appId: 'SK53GL4JLY',
      apiKey: '9ac63d917afab223adbd2cd09ad0eb17',
      indexName: 'gallery-production',
    },
  },
  outbound: {
    allowedHosts: [
      'www.overleaf.com',
      'sk53gl4jly-dsn.algolia.net',
      'sk53gl4jly.algolia.net',
      'sk53gl4jly-1.algolianet.com',
      'sk53gl4jly-2.algolianet.com',
      'sk53gl4jly-3.algolianet.com',
      'writelatex.s3.amazonaws.com',
    ],
    timeoutMs: 20_000,
    maxRedirects: 5,
    maxDownloadBytes: 64 * MiB,
    maxPdfBytes: 128 * MiB,
    // Requests a minute to www.overleaf.com per route: each enabled proxy, or
    // the direct connection when none is. N proxies give N times this rate.
    // Shared by the sync and interactive pages. A route that overleaf.com
    // blocks (403, ~5 min) pauses alone; the others keep going. A full first
    // sync of ~10k templates (~2 requests each) takes about 11 h on one route,
    // about 15 min on 50 proxies.
    fetchRpm: 30,
  },
  limits: {
    maxZipBytes: 50 * MiB,
    maxUncompressedBytes: 200 * MiB,
    maxEntries: 1000,
    maxEntryBytes: 25 * MiB,
    maxCompressionRatio: 100,
    maxInspectMs: 60_000,
  },
  runner: {
    pollIntervalMs: 15_000,
    lockLeaseMs: 120_000, // renewed every heartbeat; a dead leader frees it within 2 min
    jobLeaseMs: 600_000,
    heartbeatMs: 60_000,
    gcIntervalMs: HOUR,
    integrityEveryMs: 24 * HOUR,
    integrityBatch: 250,
    tmpMaxAgeMs: HOUR,
    blobGraceMs: 24 * HOUR,
  },
  images: {
    // built-in TeX Live image mapping used by ImageMapper
    map: {
      'texlive-full:2026.1': 'texlive-full:2026',
      'texlive-full:2025.1': 'texlive-full:2025',
      'texlive-full:2024.1': 'texlive-full:2024',
      'texlive-full:2023.1': 'texlive-full:2023',
      'texlive-full:2022.1': 'texlive-full:2022',
    },
  },
}

export const MIN_FETCH_RPM = 1
// The old adaptive floor (one request every 500 ms); faster gets blocked
export const MAX_FETCH_RPM = 120

/**
 * A whole number of requests a minute within the allowed range, or null.
 */
export function parseFetchRpm(value) {
  if (value == null || String(value).trim() === '') return null
  const rpm = Number(value)
  if (!Number.isInteger(rpm)) return null
  if (rpm < MIN_FETCH_RPM || rpm > MAX_FETCH_RPM) return null
  return rpm
}

export default {
  DEFAULTS,
  parseFetchRpm,
}
