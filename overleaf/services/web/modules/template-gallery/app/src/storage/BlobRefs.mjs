// Every item field that holds a BlobStore sha256 key. GC must treat all of
// them as live and the integrity check verifies them.
//
// `kind` tells the integrity check how to repair a corrupt blob:
//  - media: drop the reference so the mirror fetches it again
//  - source: drop the cached source package so the open flow re-acquires it

// The source package is one record: a broken package drops all of it, including
// the zip.sha256 that cachedSource() falls back to.
const SOURCE_CLEARS = Object.freeze([
  'sourceBlobStoreKey',
  'sourcePackageHash',
  'acquisitionTier',
  'sourceAcquired',
  'zip.sha256',
])

export const BLOB_REF_FIELDS = Object.freeze([
  {
    path: 'media.thumbSha',
    kind: 'media',
    clears: ['media.thumbSha', 'media.thumbMime', 'mirror.thumbAt'],
  },
  {
    path: 'media.previewSha',
    kind: 'media',
    clears: ['media.previewSha', 'media.previewMime', 'mirror.previewAt'],
  },
  {
    path: 'media.pdfSha',
    kind: 'media',
    clears: ['media.pdfSha', 'media.pdfBytes', 'mirror.pdfAt'],
  },
  { path: 'sourceBlobStoreKey', kind: 'source', clears: SOURCE_CLEARS },
  { path: 'sourcePackageHash', kind: 'source', clears: SOURCE_CLEARS },
  { path: 'zip.sha256', kind: 'source', clears: SOURCE_CLEARS },
  // pre-mirror hydration cache, kept so GC does not sweep it
  { path: 'pdfBlobStoreKey', kind: 'media', clears: ['pdfBlobStoreKey'] },
])

const SHA_REGEX = /^[a-f0-9]{64}$/

export const BLOB_REF_PROJECTION = Object.freeze(
  Object.fromEntries(BLOB_REF_FIELDS.map(ref => [ref.path, 1]))
)

// Matches docs holding at least one blob reference.
export const HAS_BLOB_REF_FILTER = Object.freeze({
  $or: BLOB_REF_FIELDS.map(ref => ({ [ref.path]: { $type: 'string' } })),
})

function readPath(doc, path) {
  let value = doc
  for (const key of path.split('.')) {
    if (value == null || typeof value !== 'object') return undefined
    value = value[key]
  }
  return value
}

/**
 * Lists the blob references held by an item doc.
 *
 * @returns {Array<{ path: string, kind: string, clears: string[], sha: string }>}
 */
export function blobRefsOf(doc) {
  const refs = []
  for (const ref of BLOB_REF_FIELDS) {
    const sha = readPath(doc, ref.path)
    if (typeof sha === 'string' && SHA_REGEX.test(sha)) refs.push({ ...ref, sha })
  }
  return refs
}

export default {
  BLOB_REF_FIELDS,
  BLOB_REF_PROJECTION,
  HAS_BLOB_REF_FILTER,
  blobRefsOf,
}
