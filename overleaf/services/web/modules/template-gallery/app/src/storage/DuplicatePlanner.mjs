// overleaf/services/web/modules/template-gallery/app/src/storage/DuplicatePlanner.mjs
//
// Pure duplicate detection for the dedup collector (no I/O, no Mongo).
//
// Two published items are duplicates when any of these holds:
//  (a) media.pdfSha is identical: the same PDF bytes, and the same family and
//      normalized title;
//  (b) dedup.pdfNormSha is identical: the same PDF after volatile metadata
//      (creation/modification dates, trailer /ID, XMP dates and document ids)
//      is removed, and the same family and normalized title;
//  (c) media.previewSha is identical AND the same family and normalized title,
//      where the title has at least PREVIEW_MIN_TITLE_WORDS words and the preview
//      is shared by at most PREVIEW_MAX_SHARE candidates (a placeholder preview
//      is shared by many items and never links anything).
// A title is required for every rule: an untitled item is never linked.
// Groups are the connected components of these links (union-find).
//
// Normalization only removes data that changes without a content change. It
// does not decode compressed object streams, so a PDF whose metadata lives in a
// compressed stream is simply not matched by (b). Missed matches are the safe side.

import crypto from 'node:crypto'
import { BLOB_REF_FIELDS, blobRefsOf } from './BlobRefs.mjs'
import { isValidSha256 } from './Paths.mjs'
import { isValidToken } from '../util/GalleryUrls.mjs'

// A preview shared by more candidates than this is a placeholder, not evidence.
const PREVIEW_MAX_SHARE = 2
// A preview+title link needs a specific title; "Resume" alone is not enough.
const PREVIEW_MIN_TITLE_WORDS = 3

// Applied to the PDF as latin1 text, so every byte maps to one character and
// the replacements never depend on the encoding.
const VOLATILE_PATTERNS = Object.freeze([
  // /CreationDate (D:...) and /ModDate (D:...), literal and hex strings
  [/\/(CreationDate|ModDate)\s*\((?:[^()\\]|\\.)*\)/g, '/$1()'],
  [/\/(CreationDate|ModDate)\s*<[0-9a-fA-F\s]*>/g, '/$1<>'],
  // trailer /ID [<...> <...>], random per save
  [/\/ID\s*\[\s*<[0-9a-fA-F]*>\s*<[0-9a-fA-F]*>\s*\]/g, '/ID[]'],
])

// XMP date and document id elements, <name ...>...</name>. Not a regex: a lazy
// `[\s\S]*?</name>` scans to the end of the file for every opener that has no
// closer, which is quadratic on a crafted PDF.
const XMP_ELEMENT_OPEN =
  /<(xmp:(?:CreateDate|ModifyDate|MetadataDate)|xmpMM:(?:DocumentID|InstanceID|OriginalDocumentID))(?=[\s>])/g

function stripXmpElements(text) {
  const parts = []
  const closeAt = new Map() // name -> index of the next </name> (cached, scanned forward only)
  const noCloser = new Set()
  let copied = 0
  let gtAt = -1 // index of the next '>' (cached, scanned forward only)
  XMP_ELEMENT_OPEN.lastIndex = 0
  let match
  while ((match = XMP_ELEMENT_OPEN.exec(text)) !== null) {
    const name = match[1]
    const from = match.index + match[0].length
    if (gtAt < from) {
      gtAt = text.indexOf('>', from)
      // no '>' left, so no later opener has an end either
      if (gtAt === -1) break
    }
    // no closer after one opener means none after any later opener of the same name
    if (noCloser.has(name)) continue
    const bodyStart = gtAt + 1
    if (!closeAt.has(name) || closeAt.get(name) < bodyStart) {
      const close = text.indexOf(`</${name}>`, bodyStart)
      if (close === -1) {
        noCloser.add(name)
        continue
      }
      closeAt.set(name, close)
    }
    const end = closeAt.get(name) + name.length + 3
    parts.push(text.slice(copied, match.index))
    copied = end
    XMP_ELEMENT_OPEN.lastIndex = end
  }
  parts.push(text.slice(copied))
  return parts.join('')
}

// and the attribute form
const XMP_ATTRIBUTE = /\b(xmp:(?:CreateDate|ModifyDate|MetadataDate)|xmpMM:(?:DocumentID|InstanceID|OriginalDocumentID))="[^"]*"/g

/**
 * The PDF with its volatile metadata removed.
 *
 * @param {Buffer} buffer
 * @returns {Buffer}
 */
export function normalizePdf(buffer) {
  let text = Buffer.from(buffer).toString('latin1')
  for (const [pattern, replacement] of VOLATILE_PATTERNS) {
    text = text.replace(pattern, replacement)
  }
  text = stripXmpElements(text).replace(XMP_ATTRIBUTE, '')
  return Buffer.from(text, 'latin1')
}

/**
 * sha256 of the normalized PDF.
 *
 * @param {Buffer} buffer
 * @returns {string}
 */
export function pdfNormSha(buffer) {
  return crypto.createHash('sha256').update(normalizePdf(buffer)).digest('hex')
}

/**
 * Lowercase, accents removed, runs of punctuation and spaces collapsed.
 * Returns null for an empty title, so (c) never links untitled items.
 *
 * @param {unknown} title
 * @returns {string | null}
 */
export function normalizeTitle(title) {
  const value = String(title ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
  return value || null
}

/**
 * Only published, not removed items take part, and never a tombstone or an item an admin kept.
 *
 * @param {any} item
 * @returns {boolean}
 */
export function isDedupCandidate(item) {
  return Boolean(
    item &&
      isValidToken(item.token) &&
      item.state === 'published' &&
      !item.duplicateOf &&
      !item.mirror?.removedAt &&
      item.dedup?.keep !== true
  )
}

function createdMs(item) {
  const ms = item.createdAt ? Date.parse(item.createdAt) : NaN
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY
}

/**
 * Canonical order: featured or curated first, then a source package, more tags,
 * more opens, oldest, and finally the token (so the choice is deterministic).
 *
 * @param {any[]} members
 * @param {Set<string>} featuredTokens
 * @returns {any[]} sorted, canonical first
 */
export function sortCanonical(members, featuredTokens = new Set()) {
  const keyOf = item => [
    featuredTokens.has(item.token) || item.featured === true ? 0 : 1,
    item.sourceAcquired === true ? 0 : 1,
    -(Array.isArray(item.tags) ? item.tags.length : 0),
    -(Number(item.stats?.opens) || 0),
    createdMs(item),
    item.token,
  ]
  return [...members].sort((a, b) => {
    const ka = keyOf(a)
    const kb = keyOf(b)
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1
    }
    return 0
  })
}

/**
 * Groups duplicate candidates. Returns the groups (2+ members) with their
 * canonical item first and the reasons that linked them.
 *
 * @param {any[]} items
 * @param {{ featuredTokens?: Set<string> }} [opts]
 * @returns {Array<{ members: any[], reasons: string[] }>}
 */
export function groupDuplicates(items, opts = {}) {
  const candidates = (items || []).filter(isDedupCandidate)
  const parent = candidates.map((_, i) => i)
  const find = i => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]
      i = parent[i]
    }
    return i
  }
  const union = (a, b) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb)
  }

  // How many candidates show each preview: a placeholder is shared by many
  const previewCounts = new Map()
  for (const item of candidates) {
    const previewSha = item.media?.previewSha
    if (isValidSha256(previewSha)) previewCounts.set(previewSha, (previewCounts.get(previewSha) || 0) + 1)
  }

  // key -> [indices, reason]
  const keys = new Map()
  const addKey = (key, index, reason) => {
    const entry = keys.get(key) || { indices: [], reason }
    entry.indices.push(index)
    keys.set(key, entry)
  }
  candidates.forEach((item, index) => {
    // Every rule also needs the same family and a title
    const title = normalizeTitle(item.title)
    if (!title) return
    const scope = `${item.family ?? ''}|${title}`
    const pdfSha = item.media?.pdfSha
    if (isValidSha256(pdfSha)) addKey(`pdf:${pdfSha}|${scope}`, index, 'same_pdf')
    const normSha = item.dedup?.pdfNormSha
    if (isValidSha256(normSha)) addKey(`norm:${normSha}|${scope}`, index, 'same_normalized_pdf')
    const previewSha = item.media?.previewSha
    if (
      isValidSha256(previewSha) &&
      title.split(' ').length >= PREVIEW_MIN_TITLE_WORDS &&
      previewCounts.get(previewSha) <= PREVIEW_MAX_SHARE
    ) {
      addKey(`image:${previewSha}|${scope}`, index, 'same_preview_and_title')
    }
  })

  const linked = []
  for (const entry of keys.values()) {
    if (entry.indices.length < 2) continue
    linked.push(entry)
    for (const index of entry.indices.slice(1)) union(entry.indices[0], index)
  }

  const byRoot = new Map()
  for (let i = 0; i < candidates.length; i++) {
    const root = find(i)
    const group = byRoot.get(root) || { indices: [], reasons: new Set() }
    group.indices.push(i)
    byRoot.set(root, group)
  }
  for (const entry of linked) {
    byRoot.get(find(entry.indices[0])).reasons.add(entry.reason)
  }

  const groups = []
  for (const group of byRoot.values()) {
    if (group.indices.length < 2) continue
    groups.push({
      members: sortCanonical(group.indices.map(i => candidates[i]), opts.featuredTokens),
      reasons: [...group.reasons].sort(),
    })
  }
  groups.sort((a, b) => (a.members[0].token < b.members[0].token ? -1 : 1))
  return groups
}

/**
 * What happens to one duplicate: the blob refs the canonical does not share
 * are unset (so GC can sweep the files), and the shas it stops referencing are listed.
 * The source package is one record, so it is cleared as a whole.
 *
 * @param {any} canonical item with the blob ref fields
 * @param {any} duplicate item with the blob ref fields
 */
export function buildTombstone(canonical, duplicate) {
  const canonicalShas = new Set(blobRefsOf(canonical).map(ref => ref.sha))
  const unset = {}
  const dropShas = new Set()
  const keepShas = new Set()
  let sourceDiffers = false
  const sourceShas = []
  for (const ref of blobRefsOf(duplicate)) {
    if (canonicalShas.has(ref.sha)) {
      keepShas.add(ref.sha)
    } else if (ref.kind === 'source') {
      sourceDiffers = true
      sourceShas.push(ref.sha)
    } else {
      for (const field of ref.clears) unset[field] = ''
      dropShas.add(ref.sha)
    }
  }
  if (sourceDiffers) {
    const sourceField = BLOB_REF_FIELDS.find(ref => ref.kind === 'source')
    for (const field of sourceField.clears) unset[field] = ''
    for (const sha of sourceShas) dropShas.add(sha)
  }
  return {
    token: duplicate.token,
    unset,
    dropShas: [...dropShas],
    keepShas: [...keepShas],
  }
}

/**
 * Tags of the duplicates that the canonical lacks, by name.
 */
function tagsToMerge(canonical, duplicates) {
  const have = new Set((canonical.tags || []).map(tag => tag?.name).filter(Boolean))
  const out = new Map()
  for (const dup of duplicates) {
    for (const tag of dup.tags || []) {
      const name = tag?.name
      if (!name || have.has(name) || out.has(name)) continue
      out.set(name, tag)
    }
  }
  return [...out.values()]
}

/**
 * Full plan for a set of items: groups, tombstones and the tags to merge.
 * Pure: nothing is written.
 *
 * @param {any[]} items
 * @param {{ featuredTokens?: Set<string> }} [opts]
 * @returns {{ groups: Array<object>, tombstones: number, duplicateTokens: number }}
 */
export function planDedup(items, opts = {}) {
  const groups = groupDuplicates(items, opts).map(group => {
    const [canonical, ...duplicates] = group.members
    return {
      canonical: canonical.token,
      reasons: group.reasons,
      duplicates: duplicates.map(dup => dup.token),
      tombstones: duplicates.map(dup => buildTombstone(canonical, dup)),
      tagsToAdd: tagsToMerge(canonical, duplicates),
    }
  })
  return {
    groups,
    tombstones: groups.reduce((n, group) => n + group.tombstones.length, 0),
    duplicateTokens: groups.reduce((n, group) => n + group.duplicates.length, 0),
  }
}

export default {
  normalizePdf,
  pdfNormSha,
  normalizeTitle,
  isDedupCandidate,
  sortCanonical,
  groupDuplicates,
  buildTombstone,
  planDedup,
}
