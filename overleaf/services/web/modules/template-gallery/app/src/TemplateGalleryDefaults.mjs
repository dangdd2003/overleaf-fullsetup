// overleaf/services/web/modules/template-gallery/app/src/TemplateGalleryDefaults.mjs
const KiB = 1024
const MiB = 1024 * KiB
const GiB = 1024 * MiB
const HOUR = 3600_000

export const DEFAULTS = {
  storageDir: '/var/lib/overleaf/data/template-gallery',
  storage: {
    requireDedicatedMount: true, // Fails closed if not a dedicated mount
    acceptedParentMounts: [], // Dev server: ['/var/lib/overleaf']
    minFreeBytes: 5 * GiB,
    maxStorageBytes: 50 * GiB, // Storage ceiling for blobs, PDFs, and ZIPs
  },
  crawler: {
    // Mirror overleaf.com: Algolia catalogue weekly, recent listings hourly,
    // detail/PDF/tag pages trickled in the background. Request pacing per
    // upstream host is fixed in transport/HostLimiter.mjs.
    enabled: true,
    algolia: {
      // public search-only key from <meta name="ol-algolia">; refreshed
      // automatically when Algolia rejects it
      appId: 'SK53GL4JLY',
      apiKey: '9ac63d917afab223adbd2cd09ad0eb17',
      indexName: 'gallery-production',
    },
  },
  hydration: {
    lazyDetailScrape: true, // Fetch a missing detail when a page is viewed
    cachePdfPreviews: true, // Keep fetched PDFs in the BlobStore
  },
  sourceAcquisition: {
    tiers: [1, 2, 3, 4], // Active acquisition tiers
    tier1Enabled: true, // Authenticated cloud session project clone
    tier2Enabled: true, // Upstream git archive auto-fetch
    tier3Enabled: true, // Anonymous #modalViewSource TeX synthesis
    tier4Enabled: true, // Admin manual BYO-ZIP upload
    autoAcquireOnOpen: true, // Lazily acquire source when user clicks "Open as Template"
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
      'github.com',
      'api.github.com',
      'codeload.github.com',
      'gitlab.com',
    ],
    timeoutMs: 20_000,
    maxRedirects: 5,
    maxDownloadBytes: 64 * MiB,
    maxPdfBytes: 128 * MiB,
  },
  limits: {
    maxZipBytes: 50 * MiB,
    maxUncompressedBytes: 200 * MiB,
    maxEntries: 1000,
    maxEntryBytes: 25 * MiB,
    maxCompressionRatio: 100,
    maxInspectMs: 60_000,
    maxPdfBytes: 25 * MiB,
    maxLogBytes: 64 * KiB,
    maxThumbnailBytes: 512 * KiB,
    maxLicenceFileBytes: 64 * KiB,
    maxDescriptionChars: 4000,
    maxTags: 10,
  },
  validation: {
    sandboxEnforced: false, // Populated from clsi sandbox switch in server-ce settings.js
    allowUnsandboxedAck: false, // Explicit admin override for unsandboxed dev runs
    compileTimeoutMs: 180_000,
    maxRunMs: 360_000,
    maxAttempts: 3,
    backoffBaseMs: 60_000,
    keepFailedStagingMs: 24 * HOUR,
    queueCap: 100,
  },
  runner: {
    pollIntervalMs: 15_000,
    lockLeaseMs: 600_000,
    jobLeaseMs: 600_000,
    heartbeatMs: 60_000,
    gcIntervalMs: HOUR,
    integrityEveryMs: 24 * HOUR,
    integrityBatch: 250,
    tmpMaxAgeMs: HOUR,
    blobGraceMs: 24 * HOUR,
  },
  images: {
    map: {
      'texlive-full:2026.1': 'texlive-full:2026',
      'texlive-full:2025.1': 'texlive-full:2025',
      'texlive-full:2024.1': 'texlive-full:2024',
      'texlive-full:2023.1': 'texlive-full:2023',
      'texlive-full:2022.1': 'texlive-full:2022',
    },
  },
  licence: {
    blockedCodes: ['cc-by-nc-4.0', 'cc-by-nc-sa-4.0', 'cc-by-nc-nd-4.0', 'unknown'],
    counselOverride: [],
    ackRequiredCodes: ['other'],
    ackMinNoteChars: 20,
  },
  attribution: { allowSourceLinks: false },
  search: { pageSize: 24, maxQueryChars: 100 },
}

/**
 * Recursive plain-object merge; arrays and scalars are replaced.
 */
export function mergePlain(base, override) {
  const result = { ...(base || {}) }
  for (const [key, value] of Object.entries(override || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = mergePlain(base?.[key] || {}, value)
    } else {
      result[key] = value
    }
  }
  return result
}

export default {
  DEFAULTS,
  mergePlain,
}
