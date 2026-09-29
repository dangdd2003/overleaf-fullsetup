import fs from 'node:fs'
import Path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import logger from '@overleaf/logger'
import Settings from '@overleaf/settings'
import '../ModuleSettings.mjs'
import { HOUR_MS, collapse } from './util.mjs'

/**
 * Web search results and the pages web_fetch read, per user, in one SQLite
 * file on the data volume. They outlive a restart and stay out of the web
 * process's memory. Pages are full-text indexed, so a search can find a page
 * the user already read.
 *
 * Entries expire on read after the user's cache hours, and are deleted after
 * the longest cache the settings allow. Past a user's entry or byte limit the
 * least recently used go first.
 */

/** The longest cache the settings allow (168 hours). */
const MAX_AGE_MS = 168 * HOUR_MS

const SCHEMA = `
CREATE TABLE IF NOT EXISTS searches (
  owner TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  at INTEGER NOT NULL,
  used INTEGER NOT NULL,
  PRIMARY KEY (owner, key)
);
CREATE INDEX IF NOT EXISTS searches_used ON searches (owner, used);

CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY,
  owner TEXT NOT NULL,
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  value TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  at INTEGER NOT NULL,
  used INTEGER NOT NULL,
  UNIQUE (owner, key)
);
CREATE INDEX IF NOT EXISTS pages_used ON pages (owner, used);

CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
  title, text,
  content = 'pages', content_rowid = 'id',
  tokenize = 'porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS pages_insert AFTER INSERT ON pages BEGIN
  INSERT INTO pages_fts (rowid, title, text) VALUES (new.id, new.title, new.text);
END;
CREATE TRIGGER IF NOT EXISTS pages_delete AFTER DELETE ON pages BEGIN
  INSERT INTO pages_fts (pages_fts, rowid, title, text)
    VALUES ('delete', old.id, old.title, old.text);
END;
CREATE TRIGGER IF NOT EXISTS pages_update AFTER UPDATE OF title, text ON pages BEGIN
  INSERT INTO pages_fts (pages_fts, rowid, title, text)
    VALUES ('delete', old.id, old.title, old.text);
  INSERT INTO pages_fts (rowid, title, text) VALUES (new.id, new.title, new.text);
END;
`

/** Words too common to require of a matching page. */
const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'that',
  'this',
  'what',
  'about',
  'how',
  'does',
  'can',
  'use',
  'using',
])
const MAX_TERMS = 8

let db = null
let statements = new Map()
let lastPurge = 0
let lastUse = 0

function openAt(file) {
  if (file !== ':memory:') {
    fs.mkdirSync(Path.dirname(file), { recursive: true })
  }
  const opened = new DatabaseSync(file)
  try {
    opened.exec(
      // auto_vacuum first: it only takes effect before the first table exists
      'PRAGMA auto_vacuum = INCREMENTAL; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;'
    )
    opened.exec(SCHEMA)
  } catch (err) {
    opened.close()
    throw err
  }
  return opened
}

/**
 * Opens the cache at `file` (a path, or ':memory:'), closing the one open.
 * A file that cannot be opened leaves the cache in memory for this process.
 */
export function openWebCache(file) {
  closeWebCache()
  try {
    db = openAt(file)
  } catch (err) {
    logger.warn(
      { err, file },
      'AI Assist web cache cannot be opened; keeping it in memory'
    )
    db = openAt(':memory:')
  }
  purgeExpired()
  return db
}

export function closeWebCache() {
  if (db) db.close()
  db = null
  statements = new Map()
}

function database() {
  return db ?? openWebCache(Settings.aiAssist?.webCachePath || ':memory:')
}

function statement(sql) {
  const current = database()
  let prepared = statements.get(sql)
  if (!prepared) {
    prepared = current.prepare(sql)
    statements.set(sql, prepared)
  }
  return prepared
}

function purgeExpired() {
  const before = Date.now() - MAX_AGE_MS
  statement('DELETE FROM searches WHERE at < ?').run(before)
  statement('DELETE FROM pages WHERE at < ?').run(before)
  // Bounded, because this runs on the web process's event loop: give up to
  // 8 MB of freed pages back to the disk (a no-op on files made before
  // auto_vacuum was set), tidy a little of the page index, refresh the query
  // planner's statistics.
  database().exec(
    "PRAGMA incremental_vacuum(2000); INSERT INTO pages_fts (pages_fts, rank) VALUES ('merge', 200); PRAGMA optimize;"
  )
  lastPurge = Date.now()
}

/** Strictly increasing, so the order of use survives entries made in one millisecond. */
function useStamp() {
  lastUse = Math.max(Date.now(), lastUse + 1)
  return lastUse
}

function estimateEntryBytes(value) {
  if (value && typeof value.text === 'string') {
    return 2 * value.text.length + 1024
  }
  if (typeof value === 'string') {
    return 2 * value.length + 64
  }
  return 1024
}

/**
 * One user's searches or pages. Same interface as a map with an age limit:
 * `get(key, maxAgeMs)` and `set(key, value)`.
 */
class StoredCache {
  constructor(table, owner, maxEntries, maxBytes = Infinity) {
    this.table = table
    this.owner = String(owner)
    this.maxEntries = maxEntries
    this.maxBytes = maxBytes
  }

  /**
   * The value if it was stored less than `maxAgeMs` ago. The age limit is
   * checked on read, not fixed on write, so shortening it in the settings
   * also retires what is already cached.
   */
  get(key, maxAgeMs) {
    const isPages = this.table === 'pages'
    const row = statement(
      `SELECT value, at${isPages ? ', text' : ''} FROM ${this.table} WHERE owner = ? AND key = ?`
    ).get(this.owner, key)
    if (!row) return null
    if (Date.now() - row.at >= maxAgeMs) {
      this._delete(key)
      return null
    }
    statement(
      `UPDATE ${this.table} SET used = ? WHERE owner = ? AND key = ?`
    ).run(useStamp(), this.owner, key)
    const value = JSON.parse(row.value)
    return isPages ? { ...value, text: row.text } : value
  }

  set(key, value) {
    const bytes = estimateEntryBytes(value)
    const now = Date.now()
    if (this.table === 'pages') {
      const { text = '', ...rest } = value ?? {}
      statement(
        `INSERT INTO pages (owner, key, title, text, value, bytes, at, used)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (owner, key) DO UPDATE SET
           title = excluded.title, text = excluded.text, value = excluded.value,
           bytes = excluded.bytes, at = excluded.at, used = excluded.used`
      ).run(
        this.owner,
        key,
        String(rest.title ?? ''),
        String(text),
        JSON.stringify(rest),
        bytes,
        now,
        useStamp()
      )
    } else {
      statement(
        `INSERT INTO searches (owner, key, value, bytes, at, used)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (owner, key) DO UPDATE SET
           value = excluded.value, bytes = excluded.bytes,
           at = excluded.at, used = excluded.used`
      ).run(this.owner, key, JSON.stringify(value), bytes, now, useStamp())
    }
    this._evict()
    if (now - lastPurge > HOUR_MS) purgeExpired()
  }

  clear() {
    statement(`DELETE FROM ${this.table} WHERE owner = ?`).run(this.owner)
  }

  /**
   * Which of `keys` are stored less than `maxAgeMs` ago, in one indexed
   * lookup. Unlike `get`, it leaves their order of use alone.
   */
  held(keys, maxAgeMs) {
    if (keys.length === 0) return new Set()
    const rows = statement(
      `SELECT key FROM ${this.table}
       WHERE owner = ? AND at > ? AND key IN (SELECT value FROM json_each(?))`
    ).all(this.owner, Date.now() - maxAgeMs, JSON.stringify(keys))
    return new Set(rows.map(row => row.key))
  }

  /**
   * This user's pages, read less than `maxAgeMs` ago, that contain every
   * word of `query`: best match first, the title counting most, each with the
   * passage around the words.
   */
  search(query, { maxAgeMs, limit = 3 } = {}) {
    const terms = [
      ...new Set(
        collapse(query)
          .toLowerCase()
          .split(/[^\p{L}\p{N}]+/u)
          .filter(term => term.length >= 2 && !STOPWORDS.has(term))
      ),
    ].slice(0, MAX_TERMS)
    if (this.table !== 'pages' || terms.length === 0) return []
    const rows = statement(
      `SELECT pages.value AS value,
         snippet(pages_fts, 1, '', '', ' … ', 48) AS snippet
       FROM pages_fts JOIN pages ON pages.id = pages_fts.rowid
       WHERE pages_fts MATCH ? AND pages.owner = ? AND pages.at > ?
       ORDER BY bm25(pages_fts, 5.0, 1.0)
       LIMIT ?`
    ).all(
      terms.map(term => `"${term}"`).join(' '),
      this.owner,
      Date.now() - maxAgeMs,
      limit
    )
    return rows.map(row => ({ ...JSON.parse(row.value), snippet: row.snippet }))
  }

  _delete(key) {
    statement(`DELETE FROM ${this.table} WHERE owner = ? AND key = ?`).run(
      this.owner,
      key
    )
  }

  /** Least recently used first, keeping at least one entry. */
  _evict() {
    const { count, total } = statement(
      `SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS total FROM ${this.table} WHERE owner = ?`
    ).get(this.owner)
    let entries = count
    let bytes = total
    if (entries <= this.maxEntries && bytes <= this.maxBytes) return
    const oldest = statement(
      `SELECT key, bytes FROM ${this.table} WHERE owner = ? ORDER BY used ASC`
    ).all(this.owner)
    for (const row of oldest) {
      if (
        entries <= this.maxEntries &&
        (bytes <= this.maxBytes || entries <= 1)
      ) {
        break
      }
      this._delete(row.key)
      entries--
      bytes -= row.bytes
    }
  }
}

/** A user's search and page caches, holding at most the given entries. */
export function ownerWebCaches(owner, { searches, pages, pageBytes }) {
  return {
    searches: new StoredCache('searches', owner, searches),
    documents: new StoredCache('pages', owner, pages, pageBytes),
  }
}

export function clearWebCacheStore() {
  statement('DELETE FROM searches').run()
  statement('DELETE FROM pages').run()
}
