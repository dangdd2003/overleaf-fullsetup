import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setCollectionOverrideForTests } from '../../../app/src/persistence/Collections.mjs'
import {
  MAX_THUMB_DATA_URI_BYTES,
  normalizeDataUri,
  transformHit,
  buildItemUpsert,
  runCatalogue,
} from '../../../app/src/services/TemplateCrawlerService.mjs'
import { createFakeCollection, rejectionOf } from './S-P4-support.mjs'

const OLD = new Date('2020-01-01T00:00:00Z')

function hit(objectID, token, title, imageUrl = null) {
  return {
    objectID,
    url: `/latex/templates/${token}-slug/${token}`,
    title,
    author: 'Author',
    description: '',
    tags: [{ name: 'cv', title: 'CV' }],
    type: 'template',
    official: true,
    featured: false,
    imageUrl,
  }
}

const HITS = [
  hit('1', 'aaaaaaaaaaaa', 'Algolia A'),
  hit('2', 'bbbbbbbbbbbb', 'Algolia B'),
  hit('3', 'cccccccccccc', 'Algolia C'),
  hit('5', 'dddddddddddd', 'Algolia D'),
]

// One leaf covers every hit. `beforeLeaf` runs after the crawler has read the
// existing items, i.e. while an admin could be editing them.
function fakeAlgolia(beforeLeaf) {
  let ran = false
  return async params => {
    if (params.hitsPerPage === 0) {
      return { nbHits: HITS.length, facets: {}, exhaustiveNbHits: true }
    }
    if (!ran) {
      ran = true
      await beforeLeaf()
    }
    return {
      nbHits: HITS.length,
      hits: HITS,
      nbPages: 1,
      exhaustiveNbHits: true,
    }
  }
}

describe('S-P4 crawler: thumbnail cap', () => {
  const prefix = 'data:image/jpeg;base64,'

  it('keeps a thumbnail exactly at the 64 KiB cap and drops one byte over it', () => {
    expect(MAX_THUMB_DATA_URI_BYTES).toBe(64 * 1024)
    const atLimit =
      prefix + 'A'.repeat(MAX_THUMB_DATA_URI_BYTES - prefix.length)
    const overLimit =
      prefix + 'A'.repeat(MAX_THUMB_DATA_URI_BYTES - prefix.length + 1)
    expect(normalizeDataUri(atLimit)).toBe(atLimit)
    expect(normalizeDataUri(overLimit)).toBeNull()
  })

  it('stores no thumbnail on the item when the hit carries an oversized one', () => {
    const oversized = prefix + 'A'.repeat(MAX_THUMB_DATA_URI_BYTES)
    const doc = transformHit(hit('9', 'eeeeeeeeeeee', 'Big', oversized))
    expect(doc).not.toBeNull()
    expect(doc.thumbDataUri).toBeNull()
  })
})
