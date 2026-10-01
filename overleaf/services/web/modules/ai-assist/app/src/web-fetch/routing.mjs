import crypto from 'node:crypto'
import { buildEndpointPool } from '../AiAssistWebTools.mjs'

export const SEARCH_CAPABLE = new Set([
  'searxng',
  'ollama',
  'websearchapi',
  'tavily',
  'firecrawl',
  'firecrawlSelfHosted',
  'jina',
  'langsearch',
  'exa',
  'mcp',
])
export const READ_CAPABLE = new Set([
  'ollama',
  'websearchapi',
  'tavily',
  'firecrawl',
  'firecrawlSelfHosted',
  'jina',
  'exa',
])

const MAX_PAUSE_MS = 10 * 60 * 1000 // 10 minutes
const BASE_BACKOFF_MS = 15_000 // 15 seconds
const MAX_OWNER_TRACKING = 1000

export function endpointHealthKey(endpoint) {
  const provider = endpoint?.provider || 'unknown'
  const rawTarget = endpoint?.apiKey ?? endpoint?.baseUrl ?? endpoint?.id ?? ''
  const normalized =
    typeof rawTarget === 'string' ? rawTarget.trim().replace(/\/+$/, '') : ''
  const hash = crypto
    .createHash('sha256')
    .update(normalized)
    .digest('hex')
    .slice(0, 16)
  return `${provider}:${hash}`
}

export function parseRetryAfter(value, now = Date.now()) {
  if (value === undefined || value === null) return null
  const str = String(value).trim()
  if (!str) return null
  const seconds = Number(str)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_PAUSE_MS)
  }
  const date = Date.parse(str)
  if (Number.isFinite(date)) {
    const diff = date - now
    return diff > 0 ? Math.min(diff, MAX_PAUSE_MS) : 0
  }
  return null
}

export function classifyFailure(
  err,
  { consecutiveErrors = 0, now = Date.now() } = {}
) {
  if (err?.code === 'aborted') {
    return { class: 'aborted', pauseMs: 0, skipProvider: false }
  }

  const status = Number(err?.status)
  // 432 and 433 are Tavily's key, plan and pay-as-you-go limits
  if ([401, 402, 403, 432, 433].includes(status)) {
    return { class: 'key', pauseMs: MAX_PAUSE_MS, skipProvider: false }
  }

  if (status === 429) {
    const rawHeader = err?.headers?.['retry-after'] ?? err?.retryAfter
    const retryAfterMs = parseRetryAfter(rawHeader, now)
    if (retryAfterMs !== null) {
      return { class: 'rate', pauseMs: retryAfterMs, skipProvider: false }
    }
    const count = Math.max(1, consecutiveErrors)
    const backoff = Math.min(
      BASE_BACKOFF_MS * Math.pow(2, count - 1),
      MAX_PAUSE_MS
    )
    return { class: 'rate', pauseMs: backoff, skipProvider: false }
  }

  const isNetwork =
    err?.kind === 'network' ||
    /network|timeout|connection|dns|econnrefused/i.test(err?.message || '')
  if ((Number.isInteger(status) && status >= 500) || isNetwork) {
    const count = Math.max(1, consecutiveErrors)
    const backoff = Math.min(
      BASE_BACKOFF_MS * Math.pow(2, count - 1),
      MAX_PAUSE_MS
    )
    return { class: 'provider', pauseMs: backoff, skipProvider: true }
  }

  return { class: 'content', pauseMs: 0, skipProvider: false }
}

const globalEndpointHealth = new Map()
const globalOwnerPositions = new Map()

export function clearEndpointHealth() {
  globalEndpointHealth.clear()
  globalOwnerPositions.clear()
}

export class WebRouter {
  constructor(
    settings,
    {
      healthStore = globalEndpointHealth,
      ownerStore = globalOwnerPositions,
      cacheOwner = 'default',
    } = {}
  ) {
    this.settings = settings
    this.pool = buildEndpointPool(settings)
    this.healthStore = healthStore
    this.ownerStore = ownerStore
    this.cacheOwner = cacheOwner || 'default'
  }

  _getOwnerState() {
    let state = this.ownerStore.get(this.cacheOwner)
    if (!state) {
      if (this.ownerStore.size >= MAX_OWNER_TRACKING) {
        const oldestKey = this.ownerStore.keys().next().value
        if (oldestKey) this.ownerStore.delete(oldestKey)
      }
      state = {
        lastStartProvider: { search: null, read: null },
        stickyProvider: { search: null, read: null },
        providerKeyPointers: new Map(),
      }
      this.ownerStore.set(this.cacheOwner, state)
    }
    return state
  }

  isHealthy(endpoint) {
    const key = endpointHealthKey(endpoint)
    const entry = this.healthStore.get(key)
    return !entry || entry.cooldownUntil <= Date.now()
  }

  getCooldownRemaining(endpoint) {
    const key = endpointHealthKey(endpoint)
    const entry = this.healthStore.get(key)
    if (!entry) return 0
    return Math.max(0, entry.cooldownUntil - Date.now())
  }

  success(endpoint, tool = 'search') {
    const key = endpointHealthKey(endpoint)
    this.healthStore.set(key, { cooldownUntil: 0, consecutiveErrors: 0 })
    const ownerState = this._getOwnerState()
    if (endpoint?.provider) {
      ownerState.stickyProvider[tool] = endpoint.provider
    }
  }

  failure(endpoint, err) {
    const key = endpointHealthKey(endpoint)
    const prev = this.healthStore.get(key) || { consecutiveErrors: 0 }
    const nextErrors = (prev.consecutiveErrors || 0) + 1
    const classification = classifyFailure(err, {
      consecutiveErrors: nextErrors,
    })

    if (classification.pauseMs > 0) {
      this.healthStore.set(key, {
        cooldownUntil: Date.now() + classification.pauseMs,
        consecutiveErrors: nextErrors,
      })
    }
    return classification
  }

  plan(tool = 'search') {
    const capabilitySet = tool === 'read' ? READ_CAPABLE : SEARCH_CAPABLE
    const matchingEndpoints = this.pool.filter(e =>
      capabilitySet.has(e.provider)
    )
    if (matchingEndpoints.length === 0) return []

    const distinctProviders = []
    const providerMap = new Map()
    for (const ep of matchingEndpoints) {
      if (!providerMap.has(ep.provider)) {
        providerMap.set(ep.provider, [])
        distinctProviders.push(ep.provider)
      }
      providerMap.get(ep.provider).push(ep)
    }

    const ownerState = this._getOwnerState()
    const strategy = this.settings.rotationStrategy || 'round-robin'
    let startIndex = 0

    if (strategy === 'provider-priority') {
      const primary = this.settings.primaryProvider
      const idx = distinctProviders.indexOf(primary)
      if (idx !== -1) startIndex = idx
    } else if (strategy === 'sticky') {
      const sticky = ownerState.stickyProvider[tool]
      const idx = sticky ? distinctProviders.indexOf(sticky) : -1
      if (idx !== -1) {
        startIndex = idx
      } else {
        const primary = this.settings.primaryProvider
        const pIdx = distinctProviders.indexOf(primary)
        if (pIdx !== -1) startIndex = pIdx
      }
    } else {
      // round-robin
      const last = ownerState.lastStartProvider[tool]
      const lastIdx = last ? distinctProviders.indexOf(last) : -1
      startIndex = lastIdx === -1 ? 0 : (lastIdx + 1) % distinctProviders.length
      ownerState.lastStartProvider[tool] = distinctProviders[startIndex]
    }

    const orderedProviders = [
      ...distinctProviders.slice(startIndex),
      ...distinctProviders.slice(0, startIndex),
    ]

    // Sort providers: providers where all endpoints are paused move to the end
    const activeProviders = []
    const pausedProviders = []
    for (const provider of orderedProviders) {
      const eps = providerMap.get(provider)
      const hasHealthy = eps.some(e => this.isHealthy(e))
      if (hasHealthy) {
        activeProviders.push(provider)
      } else {
        pausedProviders.push(provider)
      }
    }
    const finalProviderList = [...activeProviders, ...pausedProviders]

    return finalProviderList.map(provider => {
      const eps = providerMap.get(provider)
      let ptr = ownerState.providerKeyPointers.get(provider) ?? 0
      ownerState.providerKeyPointers.set(provider, (ptr + 1) % eps.length)

      const rotated = [...eps.slice(ptr), ...eps.slice(0, ptr)]
      const healthyKeys = rotated.filter(e => this.isHealthy(e))
      const pausedKeys = rotated.filter(e => !this.isHealthy(e))
      return {
        provider,
        endpoints: [...healthyKeys, ...pausedKeys],
      }
    })
  }

  // Backward compatibility alias for existing callers
  select({ attempted = new Set() } = {}) {
    if (this.pool.length === 0) return null
    const unattempted = this.pool.filter(
      e => SEARCH_CAPABLE.has(e.provider) && !attempted.has(e.id)
    )
    if (unattempted.length === 0) return null

    const strategy = this.settings.rotationStrategy || 'round-robin'

    if (strategy === 'sticky') {
      if (this.stickyId) {
        const found = unattempted.find(e => e.id === this.stickyId)
        if (found && this.isHealthy(found)) return found
      }
      const healthy = unattempted.find(e => this.isHealthy(e))
      const chosen = healthy || unattempted[0]
      this.stickyId = chosen.id
      return chosen
    }

    if (strategy === 'provider-priority') {
      const primary = this.settings.primaryProvider || 'searxng'
      const primaryPool = unattempted.filter(e => e.provider === primary)
      const healthyPrimary = primaryPool.filter(e => this.isHealthy(e))
      if (healthyPrimary.length > 0) {
        this.pointer = ((this.pointer ?? -1) + 1) % healthyPrimary.length
        return healthyPrimary[this.pointer]
      }
      const fallbackPool = unattempted.filter(e => e.provider !== primary)
      const healthyFallback = fallbackPool.filter(e => this.isHealthy(e))
      if (healthyFallback.length > 0) {
        this.fallbackPointer =
          ((this.fallbackPointer ?? -1) + 1) % healthyFallback.length
        return healthyFallback[this.fallbackPointer]
      }
      return primaryPool[0] || unattempted[0]
    }

    // Default: 'round-robin'
    const healthy = unattempted.filter(e => this.isHealthy(e))
    const candidates = healthy.length > 0 ? healthy : unattempted
    this.pointer = ((this.pointer ?? -1) + 1) % candidates.length
    return candidates[this.pointer]
  }

  markSuccess(id) {
    const ep = this.pool.find(e => e.id === id)
    if (ep) this.success(ep, 'search')
    this.stickyId = id
  }

  markFailure(id, err) {
    const ep = this.pool.find(e => e.id === id)
    if (ep) this.failure(ep, err)
    if (this.stickyId === id) this.stickyId = null
  }
}
