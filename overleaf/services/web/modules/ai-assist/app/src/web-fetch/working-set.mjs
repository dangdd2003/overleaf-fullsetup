/**
 * What web_fetch keeps in this process's memory for the task at hand, per
 * user, apart from the SQLite cache (cache-store.mjs):
 *
 * - documents read in the last hour, so the next page or find of one
 *   costs neither a database read nor a download, and pages stay the same
 *   text from call to call even when the user turned caching off;
 * - full page text a search provider returned with its results, so reading
 *   a result is answered from it instead of a second round trip.
 *
 * Both are short-lived and bounded by entries and by characters, least
 * recently used first out.
 */

/**
 * How long a document or a search's page text is kept for the task: an hour,
 * as long as providers keep a prompt cache, so a chat picked up again within
 * it reads its pages from memory.
 */
export const WORKING_TTL_MS = 60 * 60 * 1000

class BoundedMap {
  constructor({ maxEntries, maxChars, ttlMs, now = () => Date.now() }) {
    this.maxEntries = maxEntries
    this.maxChars = maxChars
    this.ttlMs = ttlMs
    this.now = now
    this.entries = new Map()
    this.chars = 0
  }

  get(key) {
    const entry = this.entries.get(key)
    if (!entry) return null
    if (this.now() - entry.at >= this.ttlMs) {
      this.delete(key)
      return null
    }
    // Most recently used last
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(key, value, chars) {
    this.delete(key)
    if (chars > this.maxChars) return
    this.entries.set(key, { value, chars, at: this.now() })
    this.chars += chars
    for (const [oldest] of this.entries) {
      if (
        this.entries.size <= this.maxEntries &&
        this.chars <= this.maxChars
      ) {
        break
      }
      this.delete(oldest)
    }
  }

  delete(key) {
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key)
    this.chars -= entry.chars
  }

  clear() {
    this.entries.clear()
    this.chars = 0
  }
}

const documents = new BoundedMap({
  maxEntries: 64,
  maxChars: 64_000_000,
  ttlMs: WORKING_TTL_MS,
})
const searchPages = new BoundedMap({
  maxEntries: 256,
  maxChars: 32_000_000,
  ttlMs: WORKING_TTL_MS,
})

const keyOf = (owner, key) => `${owner ?? 'default'}\n${key}`

/** A document `owner` read in the last hour, by its cache key. */
export function workingDocument(owner, key) {
  return documents.get(keyOf(owner, key))
}

export function keepWorkingDocument(owner, key, doc) {
  if (!doc || typeof doc.text !== 'string') return
  documents.set(keyOf(owner, key), doc, doc.text.length)
}

/**
 * Page text a search returned for `key`: { url, title, text, format, via,
 * published? }. It is read once, by the first web_fetch of that page.
 */
export function keepSearchPage(owner, key, page) {
  if (!page || typeof page.text !== 'string') return
  searchPages.set(keyOf(owner, key), page, page.text.length)
}

export function takeSearchPage(owner, key) {
  const id = keyOf(owner, key)
  const page = searchPages.get(id)
  if (page) searchPages.delete(id)
  return page
}

/** For tests. */
export function clearWorkingSet() {
  documents.clear()
  searchPages.clear()
}
