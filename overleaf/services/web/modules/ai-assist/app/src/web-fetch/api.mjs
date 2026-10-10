import { ProviderError, fetchWithRetry } from '../AiAssistProviders.mjs'
import { REQUEST_TIMEOUT_MS } from './transport.mjs'
import { webError } from './util.mjs'

/**
 * Requests to the search and page-reader APIs the user configured. Unlike a
 * page fetch, the address is configured, not chosen by the model, so it is
 * not limited to public addresses (a SearXNG instance may be on the LAN).
 */

export async function upstreamError(res, label, type) {
  const raw = await res.text().catch(() => '')
  let detail = /<html|<!doctype/i.test(raw) ? '' : raw.slice(0, 300).trim()
  try {
    const parsed = JSON.parse(raw)
    let candidate =
      parsed?.error?.message ??
      (typeof parsed?.error === 'string' ? parsed.error : null) ??
      parsed?.detail?.error ??
      parsed?.readableMessage ??
      parsed?.message
    if (Array.isArray(parsed?.detail)) {
      const fieldDetails = parsed.detail
        .map(d =>
          typeof d === 'string'
            ? d
            : `${d?.loc?.filter(x => x !== 'body')?.join('.') || 'param'}: ${d?.msg || 'invalid'}`
        )
        .filter(Boolean)
        .join('; ')
      if (fieldDetails) {
        candidate = candidate ? `${candidate} (${fieldDetails})` : fieldDetails
      }
    } else if (typeof parsed?.detail === 'string') {
      candidate = parsed.detail
    } else if (Array.isArray(parsed?.errors)) {
      const errorList = parsed.errors
        .map(e => e?.message || e?.msg || (typeof e === 'string' ? e : ''))
        .filter(Boolean)
        .join('; ')
      if (errorList) {
        candidate = candidate ? `${candidate} (${errorList})` : errorList
      }
    }
    if (typeof candidate === 'string') detail = candidate.trim()
  } catch {
    // keep the raw text
  }
  let hint = ''
  if (type === 'searxng' && res.status === 403) {
    hint =
      'SearXNG refuses JSON requests until "json" is added to search.formats in its settings.yml.'
  } else if (type === 'searxng' && res.status === 429) {
    hint =
      "SearXNG's bot limiter blocked the request; allow this server's address or turn the limiter off for it."
  } else if (
    type === 'websearchapi' &&
    (res.status === 401 || res.status === 402 || res.status === 403)
  ) {
    hint =
      'The WebSearchAPI.ai API key was rejected or is out of credits. Create one at https://websearchapi.ai and update it in Account Settings.'
  } else if (type === 'tavily' && [401, 403, 432, 433].includes(res.status)) {
    hint =
      'The Tavily API key was rejected or reached its usage limit. Create one at https://app.tavily.com and update it in Account Settings.'
  } else if (
    type === 'firecrawl' &&
    (res.status === 401 || res.status === 402 || res.status === 403)
  ) {
    hint =
      'The Firecrawl API key was rejected or is out of credits. Create one at https://www.firecrawl.dev/app/api-keys and update it in Account Settings.'
  } else if (
    type === 'firecrawlSelfHosted' &&
    (res.status === 401 || res.status === 403)
  ) {
    hint =
      'The self-hosted Firecrawl instance refused the request. Overleaf supports instances run with USE_DB_AUTHENTICATION=false.'
  } else if (type === 'firecrawl' && res.status === 429) {
    hint =
      "Firecrawl's rate or concurrency limit was reached. Wait a moment before trying again."
  } else if (
    type === 'jina' &&
    (res.status === 401 || res.status === 402 || res.status === 403)
  ) {
    hint =
      'The Jina API key was rejected or is out of tokens. Create one at https://jina.ai/api-dashboard/key-manager and update it in Account Settings.'
  } else if (type === 'jina' && res.status === 429) {
    hint = "Jina's rate limit was reached. Wait a moment before trying again."
  } else if (
    type === 'langsearch' &&
    (res.status === 401 || res.status === 402 || res.status === 403)
  ) {
    hint =
      'The LangSearch API key was rejected or is out of credits. Create one at https://langsearch.com and update it in Account Settings.'
  } else if (type === 'langsearch' && res.status === 429) {
    hint =
      "LangSearch's rate limit was reached. Wait a moment before trying again."
  } else if (
    type === 'exa' &&
    (res.status === 401 || res.status === 402 || res.status === 403)
  ) {
    hint =
      'The Exa API key was rejected or is out of credits. Create one at https://dashboard.exa.ai/api-keys and update it in Account Settings.'
  } else if (type === 'exa' && res.status === 429) {
    hint = "Exa's rate limit was reached. Wait a moment before trying again."
  } else if (
    type === 'parallel' &&
    (res.status === 401 || res.status === 402 || res.status === 403)
  ) {
    hint =
      'The Parallel API key was rejected or is out of credits. Create one at https://parallel.ai and update it in Account Settings.'
  } else if (type === 'parallel' && res.status === 429) {
    hint = "Parallel's rate limit was reached. Wait a moment before trying again."
  } else if (res.status === 401 || res.status === 403) {
    hint =
      'The Ollama API key was rejected. Create one at https://ollama.com/settings/keys and update it in Account Settings.'
  } else if (res.status === 429) {
    hint =
      'The web search rate limit was reached. Wait a moment before searching again.'
  }
  const cleanDetail = detail ? detail.replace(/\.+$/, '') : ''
  const message = `${label} returned HTTP ${res.status}${cleanDetail ? `: ${cleanDetail}` : ''}.${hint ? ` ${hint}` : ''}`
  return webError(message, { status: res.status, hint })
}

/** A provider API request, bounded in time, with its failure explained for the model. */
export async function apiRequest(
  url,
  init,
  {
    signal,
    label,
    providerType,
    timeoutMs = REQUEST_TIMEOUT_MS,
    fetchFn = fetch,
  } = {}
) {
  const timeout = AbortSignal.timeout(timeoutMs)
  const combined = AbortSignal.any([signal, timeout].filter(Boolean))
  let res
  try {
    res = await fetchWithRetry(
      url,
      { ...init, signal: combined },
      { maxRetries: 0, fetchFn }
    )
  } catch (err) {
    if (signal?.aborted)
      throw new ProviderError('Request was cancelled', { code: 'aborted' })
    if (timeout.aborted) {
      throw webError(`${label} did not answer within ${timeoutMs / 1000}s.`, {
        kind: 'network',
      })
    }
    throw webError(
      `Could not reach ${label}: ${err?.cause?.code || err?.message || 'network error'}.`,
      { kind: 'network' }
    )
  }
  if (!res.ok) throw await upstreamError(res, label, providerType)
  return res
}

/** apiRequest, with the answer parsed as JSON. */
export async function apiJson(url, init, options) {
  const res = await apiRequest(url, init, options)
  try {
    return await res.json()
  } catch {
    throw webError(`${options.label} returned a response that is not JSON.`)
  }
}
