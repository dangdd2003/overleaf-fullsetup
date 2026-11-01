import * as GuardedHttps from '../transport/GuardedHttps.mjs'
import { withHostSlot } from '../transport/HostLimiter.mjs'
import AlgoliaConfigManager from './AlgoliaConfigManager.mjs'

// Server-side Algolia client used by the catalogue crawler. Every HTTP attempt
// takes its own 'algolia' host slot (<= 4 rps). Only network errors and
// transient 5xx move on to the next Algolia host; 429/503 are rethrown so the
// host limiter backs off; 4xx are final, except one key refresh on 401/403.

const RETRYABLE_STATUSES = new Set([500, 502, 504])

function hostsFor(appId) {
  const id = String(appId).toLowerCase()
  return [
    `https://${id}-dsn.algolia.net`,
    `https://${id}-1.algolianet.com`,
    `https://${id}-2.algolianet.com`,
    `https://${id}-3.algolianet.com`,
  ]
}

function isAuthError(err) {
  return err?.status === 401 || err?.status === 403
}

// Limiter refusals apply to the 'algolia' slot as a whole, so another host
// would be refused the same way.
const LIMITER_REFUSALS = new Set([
  'circuit_open',
  'host_backoff',
  'host_busy',
  'limiter_reset',
  'EOUTBOUND_BLOCKED',
])

function shouldTryNextHost(err) {
  if (LIMITER_REFUSALS.has(err?.code) || err?.name === 'AbortError')
    return false
  const status = Number(err?.status) || null
  return status == null || RETRYABLE_STATUSES.has(status)
}

async function queryWithConfig(config, params, opts) {
  const path = `/1/indexes/${encodeURIComponent(config.indexName)}/query`
  const body = JSON.stringify(params)
  let lastError = null

  for (const host of hostsFor(config.appId)) {
    try {
      const res = await withHostSlot(
        'algolia',
        { priority: opts.priority, signal: opts.signal },
        ({ egress } = {}) =>
          GuardedHttps.requestRaw(`${host}${path}`, {
            egress,
            method: 'POST',
            headers: {
              'X-Algolia-Application-Id': config.appId,
              'X-Algolia-API-Key': config.apiKey,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body,
            timeoutMs: opts.timeoutMs || 20_000,
            signal: opts.signal,
          })
      )
      if (res.truncated) {
        const err = new Error('Algolia response exceeded the download cap')
        err.code = 'algolia_response_truncated'
        throw err
      }
      return JSON.parse(res.body.toString('utf8'))
    } catch (err) {
      lastError = err
      if (!shouldTryNextHost(err)) throw err
    }
  }
  throw lastError || new Error('all Algolia hosts failed')
}

/**
 * POSTs a query to the gallery index.
 *
 * @param {object} params - Algolia search parameters (JSON body)
 * @param {{ priority?: string, signal?: AbortSignal, timeoutMs?: number }} [opts]
 */
export async function queryAlgolia(params = {}, opts = {}) {
  const config = await AlgoliaConfigManager.getConfig()
  try {
    return await queryWithConfig(config, params, opts)
  } catch (err) {
    if (!isAuthError(err)) throw err
    let refreshed
    try {
      refreshed = await AlgoliaConfigManager.refresh()
    } catch {
      throw err
    }
    if (
      refreshed.apiKey === config.apiKey &&
      refreshed.appId === config.appId
    ) {
      throw err
    }
    return queryWithConfig(refreshed, params, opts)
  }
}

export default {
  queryAlgolia,
}
