// Every item field that holds a BlobStore sha256 key. GC must treat all of
// them as live and the integrity check verifies them.
//
// `kind` tells the integrity check how to repair a corrupt blob:
//  - media: drop the reference so the mirror fetches it again
//  - source: drop the cached source package so the open flow re-acquires it
//  - validation: drop the validation artefact
//  - upload: admin-provided content that cannot be re-fetched

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
  {
    path: 'sourceBlobStoreKey',
    kind: 'source',
    clears: ['sourceBlobStoreKey', 'sourcePackageHash', 'acquisitionTier'],
  },
  {
    path: 'sourcePackageHash',
    kind: 'source',
    clears: ['sourceBlobStoreKey', 'sourcePackageHash', 'acquisitionTier'],
  },
  { path: 'zip.sha256', kind: 'upload', clears: [] },
  { path: 'thumbnail.sha256', kind: 'upload', clears: [] },
  { path: 'pdf.sha256', kind: 'validation', clears: ['pdf'] },
  { path: 'validation.pdfSha', kind: 'validation', clears: ['validation.pdfSha'] },
  { path: 'validation.logSha', kind: 'validation', clears: ['validation.logSha'] },
  {
    path: 'validation.logSha256',
    kind: 'validation',
    clears: ['validation.logSha256'],
  },
  // pre-mirror hydration cache
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
