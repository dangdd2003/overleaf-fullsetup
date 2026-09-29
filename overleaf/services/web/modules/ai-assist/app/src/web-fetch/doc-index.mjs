import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import Path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import Settings from '@overleaf/settings'
import { searchText, termsOf } from './blocks.mjs'
import { runExtractJob } from './extract/pool.mjs'
import {
  memorySource,
  partialThreshold,
  shapeBoost,
  spellingsOf,
} from './find.mjs'
import { pageMap } from './pages.mjs'

/**
 * How web_fetch pages and searches a document of any size.
 *
 * A short document is paged and scanned in memory on each call. A long one
 * is indexed once, in an extraction worker: its page map is computed there,
 * and its blocks go into an SQLite FTS5 file, so a find is a few indexed
 * queries plus the blocks it returns, however large the document. Indexes
 * stay open for the documents read most recently, and their files live in a
 * folder of this process's own, next to the web cache, removed with it.
 */

/** From this size a document is indexed instead of scanned on every find. */
export const INDEXED_DOCUMENT_CHARS = 1_000_000
/** Indexes kept open, most recently used first. */
const MAX_OPEN_INDEXES = 16
/** Ranked matches read per alternative; the rest are counted and located. */
const TOP_HITS = 200
/** An index let go stays usable this long for a find still running on it. */
const CLOSE_DELAY_MS = 60_000

const open = new Map()
let folder = null

function isRunning(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

/** This process's index folder, clearing those of processes that have ended. */
export function indexFolder() {
  if (folder) return folder
  const cache = Settings.aiAssist?.webCachePath
  let base =
    cache && cache !== ':memory:'
      ? Path.join(Path.dirname(cache), 'web-find')
      : Path.join(os.tmpdir(), 'ai-assist-web-find')
  try {
    for (const name of fs.readdirSync(base)) {
      const pid = Number(name)
      if (Number.isInteger(pid) && pid !== process.pid && !isRunning(pid)) {
        fs.rmSync(Path.join(base, name), { recursive: true, force: true })
      }
    }
  } catch {
    // no folder yet
  }
  try {
    folder = Path.join(base, String(process.pid))
    fs.rmSync(folder, { recursive: true, force: true })
    fs.mkdirSync(folder, { recursive: true })
    return folder
  } catch {
    base = Path.join(os.tmpdir(), 'ai-assist-web-find')
    folder = Path.join(base, String(process.pid))
    fs.rmSync(folder, { recursive: true, force: true })
    fs.mkdirSync(folder, { recursive: true })
    return folder
  }
}

/** The same text read at the same time from the same address. */
function identity(doc) {
  return crypto
    .createHash('sha256')
    .update(`${doc.url}\n${doc.fetchedAt ?? ''}\n${doc.text.length}\n`)
    .update(doc.text.slice(0, 65_536))
    .update(doc.text.slice(-65_536))
    .digest('hex')
    .slice(0, 32)
}

function release(entry) {
  const timer = setTimeout(() => {
    entry
      .then(built => {
        built.db.close()
        fs.rmSync(built.file, { force: true })
      })
      .catch(() => {})
  }, CLOSE_DELAY_MS)
  timer.unref?.()
}

async function build(doc, size, key, runJob) {
  const file = Path.join(indexFolder(), `${key}.sqlite`)
  const { count, map } = await runJob({
    kind: 'index',
    text: doc.text,
    file,
    size,
    url: doc.url,
  })
  return {
    db: new DatabaseSync(file, { readOnly: true }),
    file,
    count,
    maps: new Map([[size, map]]),
    statements: new Map(),
  }
}

/** FTS5 tokens of normalized text, as its unicode61 tokenizer splits them. */
function tokensOf(phrase) {
  return phrase.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
}

const prefix = token => `"${token}"*`

/** Matches from a document's FTS5 index, in find's terms (see find.mjs). */
function indexSource(built, doc) {
  const statement = sql => {
    let prepared = built.statements.get(sql)
    if (!prepared) {
      prepared = built.db.prepare(sql)
      built.statements.set(sql, prepared)
    }
    return prepared
  }
  const blocks = new Map()
  const block = index => {
    let found = blocks.get(index)
    if (!found) {
      const row = statement(
        'SELECT start, stop, kind, level, path FROM blocks WHERE id = ?'
      ).get(index + 1)
      found = {
        index,
        kind: row.kind,
        start: row.start,
        end: row.stop,
        level: row.level,
        path: JSON.parse(row.path),
        text: doc.text.slice(row.start, row.stop),
      }
      blocks.set(index, found)
    }
    return found
  }
  const startOf = index =>
    blocks.get(index)?.start ??
    statement('SELECT start FROM blocks WHERE id = ?').get(index + 1).start
  const ids = query =>
    statement('SELECT rowid AS id FROM fts WHERE fts MATCH ?')
      .all(query)
      .map(row => row.id - 1)
  const ranked = query =>
    statement(
      `SELECT rowid AS id, bm25(fts, 1.0, 0.5) AS rank FROM fts
       WHERE fts MATCH ? ORDER BY rank LIMIT ${TOP_HITS}`
    ).all(query)

  /** A phrase made only of symbols has no words to look up: scan for it. */
  const scan = (phrase, spelling) => {
    const found = []
    for (const row of statement(
      'SELECT id, start, stop FROM blocks'
    ).iterate()) {
      if (searchText(doc.text.slice(row.start, row.stop)).includes(phrase)) {
        found.push(row.id - 1)
      }
    }
    const hits = found.slice(0, TOP_HITS).map(index => ({
      index,
      level: 0,
      term: spelling,
      phrase,
      score: shapeBoost(block(index), phrase, searchText(block(index).text)),
    }))
    return { hits, ids: found }
  }

  const search = alternative => {
    for (const spelling of spellingsOf(alternative)) {
      const phrase = searchText(spelling)
      if (!phrase) continue
      const tokens = tokensOf(phrase)
      if (tokens.length === 0) {
        const scanned = scan(phrase, spelling)
        if (scanned.ids.length > 0) return scanned
        continue
      }
      // The phrase, its last word as a prefix: "range phrase" finds "range phrases"
      const query = `body : "${tokens.join(' ')}"*`
      const matched = ids(query)
      if (matched.length === 0) continue
      const hits = ranked(query).map(row => {
        const found = block(row.id - 1)
        return {
          index: row.id - 1,
          level: 0,
          term: spelling,
          phrase,
          score: -row.rank + shapeBoost(found, phrase, searchText(found.text)),
        }
      })
      return { hits, ids: matched }
    }

    const display = spellingsOf(alternative)[0] ?? ''
    const terms = termsOf(searchText(display))
    const words = [...new Set(terms.flatMap(tokensOf))]
    if (words.length < 2) return { hits: [], ids: [] }
    const any = words.map(prefix)
    const inBody = `body : (${any.join(' OR ')})`

    // Every word, in the block or the headings above it, at least one in the block
    const all = `${any.join(' AND ')} AND ${inBody}`
    const matched = ids(all)
    if (matched.length > 0) {
      const hits = ranked(all).map(row => {
        const found = block(row.id - 1)
        return {
          index: row.id - 1,
          level: 1,
          term: display,
          terms,
          score: -row.rank + words.length + shapeBoost(found, null, ''),
        }
      })
      return { hits, ids: matched }
    }

    // Most of the words
    const needed = partialThreshold(words.length)
    if (!Number.isFinite(needed)) return { hits: [], ids: [] }
    const covered = new Map()
    for (const word of any) {
      for (const id of ids(word)) covered.set(id, (covered.get(id) ?? 0) + 1)
    }
    const body = new Set(ids(inBody))
    const partial = [...covered]
      .filter(([id, count]) => count >= needed && body.has(id))
      .map(([id]) => id)
      .sort((a, b) => a - b)
    if (partial.length === 0) return { hits: [], ids: [] }
    const wanted = new Set(partial)
    const hits = []
    for (const row of statement(
      'SELECT rowid AS id, bm25(fts, 1.0, 0.5) AS rank FROM fts WHERE fts MATCH ? ORDER BY rank'
    ).iterate(any.join(' OR '))) {
      const index = row.id - 1
      if (!wanted.has(index)) continue
      hits.push({
        index,
        level: 2,
        term: display,
        terms,
        score:
          -row.rank + covered.get(index) + shapeBoost(block(index), null, ''),
      })
      if (hits.length >= TOP_HITS) break
    }
    return { hits, ids: partial }
  }

  return { count: built.count, block, startOf, search }
}

/**
 * The page map for pages of `size`, and the source find searches, for `doc`.
 * `runJob` runs extraction-worker jobs (tests run them in-process).
 */
export async function documentIndex(
  doc,
  size,
  { runJob = runExtractJob } = {}
) {
  if (doc.text.length < INDEXED_DOCUMENT_CHARS) {
    let source = null
    return {
      map: pageMap(doc.text, size),
      get source() {
        source ??= memorySource(doc)
        return source
      },
    }
  }

  const key = identity(doc)
  let entry = open.get(key)
  if (entry) {
    open.delete(key)
  } else {
    entry = build(doc, size, key, runJob)
    entry.catch(() => open.delete(key))
  }
  open.set(key, entry)
  while (open.size > MAX_OPEN_INDEXES) {
    const [oldest, stale] = open.entries().next().value
    open.delete(oldest)
    release(stale)
  }

  const built = await entry
  let map = built.maps.get(size)
  if (!map) {
    map = await runJob({ kind: 'pagemap', text: doc.text, size, url: doc.url })
    built.maps.set(size, map)
  }
  return { map, source: indexSource(built, doc) }
}

/** Closes every index: for tests and shutdown. */
export function closeDocumentIndexes() {
  for (const entry of open.values()) {
    entry
      .then(built => {
        built.db.close()
        fs.rmSync(built.file, { force: true })
      })
      .catch(() => {})
  }
  open.clear()
}
