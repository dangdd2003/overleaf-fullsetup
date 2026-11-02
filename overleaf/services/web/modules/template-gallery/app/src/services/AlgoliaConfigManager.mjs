import * as GuardedHttps from '../transport/GuardedHttps.mjs'
import { withHostSlot } from '../transport/RateGate.mjs'
import { configCol } from '../persistence/Collections.mjs'
import { DEFAULTS } from '../TemplateGalleryDefaults.mjs'

// The public search-only key ships in <meta name="ol-algolia"> on every
// overleaf.com gallery page. We start from the configured default key and
// only scrape a fresh one when Algolia rejects the current key (401/403).

const CONFIG_DOC_ID = 'algolia_config'
const TEMPLATES_URL = 'https://www.overleaf.com/latex/templates'
const MIN_REFRESH_INTERVAL_MS = 10 * 60 * 1000

let cachedConfig = null
let lastRefreshAttemptAt = 0

function decodeHtmlEntities(str) {
  if (!str || typeof str !== 'string') return ''
  return str
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/**
 * Extracts and parses <meta name="ol-algolia" content="..."> from HTML.
 *
 * @param {string} html
 * @returns {{ appId: string, apiKey: string, indexes?: any, indexName?: string } | null}
 */
export function extractMetaFromHtml(html) {
  if (!html || typeof html !== 'string') return null
  const tagMatch = /<meta\s+[^>]*name=["']ol-algolia["'][^>]*>/i.exec(html)
  if (!tagMatch) return null
  const contentMatch = /content=(?:"([^"]*)"|'([^']*)')/i.exec(tagMatch[0])
  if (!contentMatch) return null
  try {
    const parsed = JSON.parse(
      decodeHtmlEntities(contentMatch[1] ?? contentMatch[2])
    )
    if (!parsed || typeof parsed !== 'object') return null
    if (!parsed.indexName && parsed.indexes?.gallery) {
      parsed.indexName = parsed.indexes.gallery
    }
    return parsed
  } catch {
    return null
  }
}

function configuredDefaults() {
  const alg = DEFAULTS.crawler.algolia
  return {
    appId: alg.appId,
    apiKey: alg.apiKey,
    indexName: alg.indexName,
    source: 'settings',
  }
}

function fromDoc(doc) {
  return {
    appId: doc.appId,
    apiKey: doc.apiKey,
    indexName: doc.indexName,
    source: 'scraped',
    fetchedAt: doc.fetchedAt,
  }
}

/**
 * Returns the Algolia credentials to use: last scraped key if any, otherwise
 * the configured default key.
 *
 */
export async function getConfig() {
  if (cachedConfig) return cachedConfig
  try {
    const col = await configCol()
    const doc = await col.findOne({ _id: CONFIG_DOC_ID })
    if (doc?.appId && doc?.apiKey && doc?.indexName) {
      cachedConfig = fromDoc(doc)
      return cachedConfig
    }
  } catch {
    // fall through to settings
  }
  return configuredDefaults()
}

/**
 * Scrapes a fresh key from overleaf.com and persists it. Only a successful
 * scrape is persisted; failures throw so a transient outage never pins a
 * stale key. Attempts are rate limited to one per 10 minutes per process.
 *
 * @param {{ templatesUrl?: string, force?: boolean }} [opts]
 */
export async function refresh(opts = {}) {
  const now = Date.now()
  if (!opts.force && now - lastRefreshAttemptAt < MIN_REFRESH_INTERVAL_MS) {
    const err = new Error('algolia key refresh attempted too recently')
    err.code = 'refresh_throttled'
    throw err
  }
  lastRefreshAttemptAt = now

  const html = await withHostSlot('overleaf', { priority: 'background' }, ({ egress } = {}) =>
    GuardedHttps.fetchText(opts.templatesUrl || TEMPLATES_URL, {
      egress,
      timeoutMs: 15_000,
    })
  )
  const extracted = extractMetaFromHtml(html)
  if (!extracted?.appId || !extracted?.apiKey) {
    const err = new Error('ol-algolia meta tag not found')
    err.code = 'algolia_meta_missing'
    throw err
  }

  const doc = {
    appId: extracted.appId,
    apiKey: extracted.apiKey,
    indexName:
      extracted.indexes?.gallery ||
      extracted.indexName ||
      configuredDefaults().indexName,
    fetchedAt: new Date(now),
  }
  const col = await configCol()
  await col.updateOne({ _id: CONFIG_DOC_ID }, { $set: doc }, { upsert: true })
  cachedConfig = fromDoc(doc)
  return cachedConfig
}

/**
 * Clears the in-memory cache and refresh throttle (tests).
 */
export function clearCache() {
  cachedConfig = null
  lastRefreshAttemptAt = 0
}

export default {
  extractMetaFromHtml,
  getConfig,
  refresh,
  clearCache,
}
