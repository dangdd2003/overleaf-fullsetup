import EgressSettings from '../egress/EgressSettings.mjs'
import GuardedHttps from '../transport/GuardedHttps.mjs'
import { getHostStatus } from '../transport/RateGate.mjs'
import { logError, logWarn } from '../observability/Log.mjs'

// Admin API for outbound proxies. Error envelope: { error: <code> }, as in
// AdminController. Responses never contain proxy logins.

const PROBE_URL = 'https://www.overleaf.com/'
const PROBE_HOST = 'www.overleaf.com'
const PROBE_TIMEOUT_MS = 15_000
const PROBE_MAX_BYTES = 64 * 1024

const STATUS_BY_CODE = Object.freeze({
  invalid_scheme: 400,
  invalid_host: 400,
  invalid_port: 400,
  invalid_label: 400,
  invalid_flag: 400,
  invalid_login: 400,
  invalid_text: 400,
  proxy_limit: 400,
  not_found: 404,
  duplicate: 409,
  version_conflict: 409,
  secret_not_configured: 409,
})

const PROBE_ERROR_BY_CODE = Object.freeze({
  EPROXY_UNREACHABLE: 'proxy_unreachable',
  EPROXY_AUTH: 'proxy_auth',
  EPROXY_CONNECT: 'proxy_refused',
  EPROXY_PROTOCOL: 'proxy_protocol',
  EADDRBLOCKED: 'address_blocked',
  ETIMEDOUT: 'timeout',
})

function sendCode(res, status, code) {
  return res.status(status).json({ error: code })
}

function sendError(res, err) {
  const status = STATUS_BY_CODE[err?.code]
  if (status) return sendCode(res, status, err.code)
  logError('tg.egress.internal', err)
  return sendCode(res, 500, 'internal')
}

// Health comes from the RateGate routes that carry each proxy. The route id is
// the proxy id. A proxy with no route yet has never been used. Each host has
// its own route for a proxy, so the worst state wins: an idle route on one host
// must not hide a blocked route on another.
//   backoff: upstream blocked the route; it resumes at backoffUntil
//   error:   the proxy or connection failed; it rests until backoffUntil
const HEALTH_RANK = Object.freeze({
  idle: 0,
  ok: 1,
  error: 2,
  backoff: 3,
})

function routeHealth() {
  const routes = new Map()
  for (const host of Object.values(getHostStatus())) {
    for (const route of host.routes) {
      const current = routes.get(route.id)
      if (
        !current ||
        HEALTH_RANK[healthOf(route).state] > HEALTH_RANK[healthOf(current).state]
      ) {
        routes.set(route.id, route)
      }
    }
  }
  return routes
}

function healthOf(route) {
  if (!route) {
    return { state: 'idle', backoffUntil: null, lastError: null, lastSuccessAt: null, lastStatus: null }
  }
  let state = 'idle'
  if (route.blockedUntil) state = 'backoff'
  else if (route.restUntil) state = 'error'
  else if (route.lastError) state = 'error'
  else if (route.lastSuccessAt) state = 'ok'
  const until = route.blockedUntil || route.restUntil
  return {
    state,
    backoffUntil: until ? new Date(until).toISOString() : null,
    lastError: route.lastError ?? null,
    lastSuccessAt: route.lastSuccessAt ? new Date(route.lastSuccessAt).toISOString() : null,
    lastStatus: route.lastStatus ?? null,
  }
}

function withHealth(proxy, routes) {
  return {
    id: proxy.id,
    label: proxy.label,
    scheme: proxy.scheme,
    host: proxy.host,
    port: proxy.port,
    enabled: proxy.enabled,
    allowPrivate: proxy.allowPrivate,
    hasAuth: proxy.hasAuth,
    health: healthOf(routes.get(proxy.id)),
  }
}

function viewWithHealth(view) {
  const routes = routeHealth()
  return {
    proxies: view.proxies.map(proxy => withHealth(proxy, routes)),
  }
}

// Only the fields the admin form can send are passed on
function bodyOf(req) {
  return req.body && typeof req.body === 'object' ? req.body : {}
}

export async function getEgress(req, res) {
  try {
    return res.status(200).json(viewWithHealth(await EgressSettings.view()))
  } catch (err) {
    return sendError(res, err)
  }
}

export async function createProxy(req, res) {
  try {
    const { proxy } = await EgressSettings.createProxy(bodyOf(req))
    return res.status(201).json({ proxy: withHealth(proxy, routeHealth()) })
  } catch (err) {
    return sendError(res, err)
  }
}

export async function createProxiesBulk(req, res) {
  try {
    const { text, allowPrivate } = bodyOf(req)
    const { added, errors } = await EgressSettings.createProxiesFromText(text, {
      allowPrivate: allowPrivate ?? false,
    })
    const view = await EgressSettings.view()
    return res.status(200).json({
      added,
      errors,
      proxies: viewWithHealth(view).proxies,
    })
  } catch (err) {
    return sendError(res, err)
  }
}

export async function updateProxy(req, res) {
  try {
    const { proxy } = await EgressSettings.updateProxy(req.params.id, bodyOf(req))
    return res.status(200).json({ proxy: withHealth(proxy, routeHealth()) })
  } catch (err) {
    return sendError(res, err)
  }
}

export async function deleteProxy(req, res) {
  try {
    const view = await EgressSettings.deleteProxy(req.params.id)
    return res.status(200).json(viewWithHealth(view))
  } catch (err) {
    return sendError(res, err)
  }
}

function probeErrorCode(err) {
  if (err?.status === 403) return 'upstream_blocked'
  if (err?.status) return 'unexpected_status'
  return PROBE_ERROR_BY_CODE[err?.code] || 'unreachable'
}

/**
 * One GET of the gallery's own origin through this proxy only. No redirects,
 * no rate-gate slot, so the result is not affected by blocked sync routes.
 */
async function probe(egress) {
  const started = Date.now()
  const proxyAddress = `${egress.scheme}://${egress.host}:${egress.port}`
  try {
    const res = await GuardedHttps.requestRaw(PROBE_URL, {
      egress,
      allowedHosts: [PROBE_HOST],
      followRedirects: false,
      timeoutMs: PROBE_TIMEOUT_MS,
      maxBytes: PROBE_MAX_BYTES,
    })
    const ok = res.status >= 200 && res.status < 300
    return {
      ok,
      status: res.status,
      latencyMs: Date.now() - started,
      proxyAddress,
      ...(ok ? {} : { error: res.status === 403 ? 'upstream_blocked' : 'unexpected_status' }),
    }
  } catch (err) {
    logWarn('tg_egress_probe_failed', { id: egress.id, code: err?.code ?? null })
    return {
      ok: false,
      status: err?.status ?? null,
      latencyMs: Date.now() - started,
      proxyAddress,
      error: probeErrorCode(err),
    }
  }
}

export async function testProxy(req, res) {
  try {
    const egress = await EgressSettings.findProxyEgress(req.params.id)
    if (!egress) return sendCode(res, 404, 'not_found')
    return res.status(200).json(await probe(egress))
  } catch (err) {
    return sendError(res, err)
  }
}

const EgressController = {
  getEgress,
  createProxy,
  createProxiesBulk,
  updateProxy,
  deleteProxy,
  testProxy,
}

export default EgressController
