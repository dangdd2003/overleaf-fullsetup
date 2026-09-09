import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'

const CACHE_TTL_MS = 5 * 60 * 1000
const FETCH_TIMEOUT_MS = 1500

let cache = null // { expiresAt, categories }

/**
 * Describe the MCP tools grouped by category, for the OAuth consent page.
 *
 * The MCP service exposes this over an unauthenticated endpoint because tool
 * descriptions carry no user data and the consent page renders before the
 * visitor holds a token. Any failure (MCP disabled, unreachable, slow)
 * degrades to an empty list so the consent page falls back to its static
 * scope description instead of breaking.
 *
 * @returns {Promise<Array<object>>}
 */
export async function getToolCategories() {
  if (!Settings.enableMcp || !Settings.mcp?.serviceUrl) {
    return []
  }

  const now = Date.now()
  if (cache && cache.expiresAt > now) {
    return cache.categories
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(`${Settings.mcp.serviceUrl}/tools/metadata`, {
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(`unexpected status ${response.status}`)
    }
    const body = await response.json()
    const categories = body.categories || []
    cache = { expiresAt: now + CACHE_TTL_MS, categories }
    return categories
  } catch (err) {
    logger.warn({ err }, 'failed to fetch MCP tool metadata for consent page')
    return []
  } finally {
    clearTimeout(timeout)
  }
}

export function _resetCacheForTests() {
  cache = null
}
