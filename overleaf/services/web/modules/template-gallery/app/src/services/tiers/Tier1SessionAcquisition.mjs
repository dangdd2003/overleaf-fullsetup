import * as cheerio from 'cheerio'
import { configCol } from '../../persistence/Collections.mjs'
import SessionCredentialStore from '../../crypto/SessionCredentialStore.mjs'
import { requestRaw } from '../../transport/GuardedHttps.mjs'
import {
  withHostSlot,
  isTransientCode,
  isThrottledError,
} from '../../transport/HostLimiter.mjs'
import { commitZipBuffer, pickMainFile, resolveLimits } from './TierSupport.mjs'
import { logInfo, logWarn } from '../../observability/Log.mjs'

// Tier 1: replay the official "Open as Template" flow on overleaf.com with a
// session cookie an admin stored, download the resulting project as a zip and
// delete the temporary upstream project again. Only used when a cookie exists.

const ORIGIN = 'https://www.overleaf.com'
const SESSION_COOKIE = 'overleaf_session2'

/**
 * Query string of the official CTA:
 * /project/new/template/<publishedId>?[brandVariationId=N&]id=<objectID>&[latexEngine=..&]mainFile=..&templateName=..&texImage=..
 *
 * @param {object} item
 * @returns {{ publishedId: string, query: URLSearchParams } | null}
 */
export function buildOpenParams(item) {
  const publishedId = item?.publishedId
  const objectID = item?.objectID
  if (publishedId == null || !/^\d+$/.test(String(publishedId))) return null
  if (objectID == null || !/^\d+$/.test(String(objectID))) return null

  const query = new URLSearchParams()
  if (item.brandVariationId != null) {
    query.set('brandVariationId', String(item.brandVariationId))
  }
  query.set('id', String(objectID))
  if (item.latexEngine) query.set('latexEngine', item.latexEngine)
  if (item.mainFile) query.set('mainFile', item.mainFile)
  query.set('templateName', item.templateName || item.title || '')
  if (item.texImage) query.set('texImage', item.texImage)
  return { publishedId: String(publishedId), query }
}

// Minimal cookie jar so load-balancer/session cookies set during the flow are
// replayed on the following requests.
class CookieJar {
  constructor(storedCookie) {
    this.cookies = new Map()
    const raw = String(storedCookie || '').trim()
    if (raw.includes('=')) {
      for (const part of raw.split(';')) {
        this.#add(part)
      }
    } else if (raw) {
      this.cookies.set(SESSION_COOKIE, raw)
    }
  }

  #add(pair) {
    const index = pair.indexOf('=')
    if (index <= 0) return
    const name = pair.slice(0, index).trim()
    const value = pair.slice(index + 1).trim()
    if (name) this.cookies.set(name, value)
  }

  absorb(response) {
    const setCookie = response?.headers?.['set-cookie']
    for (const header of [].concat(setCookie || [])) {
      this.#add(String(header).split(';')[0])
    }
  }

  header() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
  }
}

class SessionRejectedError extends Error {
  constructor(reason) {
    super(`overleaf.com rejected the stored session (${reason})`)
    this.reason = reason
  }
}

function isLoginRedirect(response) {
  const status = response?.status || 0
  const location = String(response?.headers?.location || '')
  return status >= 300 && status < 400 && /\/(login|register)\b/.test(location)
}

/**
 * Parse the official template loader page (new_from_template.pug) into the
 * form it would auto-submit.
 *
 * @param {string} html
 * @returns {{ action: string, fields: URLSearchParams, csrfToken: string|null } | null}
 */
export function parseLoaderForm(html) {
  const $ = cheerio.load(html || '')
  const csrfToken = $('meta[name="ol-csrfToken"]').attr('content') || null
  const form = $('form[data-ol-auto-submit], form[action^="/project/new/template"]').first()
  if (!form.length) return null

  const fields = new URLSearchParams()
  form.find('input[name]').each((_, el) => {
    const input = $(el)
    if ((input.attr('type') || '').toLowerCase() === 'submit') return
    fields.append(input.attr('name'), input.attr('value') ?? '')
  })
  if (!fields.get('_csrf') && csrfToken) fields.set('_csrf', csrfToken)
  return {
    action: form.attr('action') || '/project/new/template',
    fields,
    csrfToken: csrfToken || fields.get('_csrf'),
  }
}

/**
 * @param {object} item
 * @param {object} [cfg] - limit overrides (defaults: TemplateGalleryDefaults)
 * @param {{ sessionCookie?: string, storageDir?: string, priority?: string }} [opts]
 */
export async function acquireViaCloudSession(item, cfg = {}, opts = {}) {
  const col = await configCol()
  let storedCookie = opts.sessionCookie || null
  // Ciphertext of the stored cookie this attempt used, so a cookie re-saved by
  // an admin meanwhile is not invalidated by this attempt's failure.
  let storedEncryptedCookie = null
  if (!storedCookie) {
    const credential = await SessionCredentialStore.getDecryptedSessionCredential(col)
    if (!credential?.cookie) {
      return { acquired: false, reason: 'no_session_cookie' }
    }
    storedCookie = credential.cookie
    storedEncryptedCookie = credential.encryptedCookie || null
  }

  const openParams = buildOpenParams(item)
  if (!openParams) {
    return { acquired: false, reason: 'missing_open_params' }
  }

  const jar = new CookieJar(storedCookie)
  // The session cookie is for overleaf.com from this server's own address, so
  // this acquisition never goes through an outbound proxy.
  const slotOpts = { priority: opts.priority || 'interactive', egress: 'direct' }
  const call = (url, options) =>
    withHostSlot('overleaf', slotOpts, async () => {
      const response = await requestRaw(url, {
        followRedirects: false,
        ...options,
        headers: { ...(options?.headers || {}), Cookie: jar.header() },
      })
      jar.absorb(response)
      return response
    })

  let projectId = null
  let csrfToken = null
  try {
    // 1. The official loader page carries the CSRF token and the form fields.
    const loaderUrl = `${ORIGIN}/project/new/template/${openParams.publishedId}?${openParams.query}`
    const loader = await call(loaderUrl, { method: 'GET' })
    if (isLoginRedirect(loader)) throw new SessionRejectedError('login_redirect')
    const form = loader.status === 200 ? parseLoaderForm(loader.body.toString('utf8')) : null
    if (!form) {
      return { acquired: false, reason: 'loader_unparseable' }
    }
    csrfToken = form.csrfToken

    // 2. Submitting it creates the project and redirects to /project/<id>.
    const created = await call(new URL(form.action, ORIGIN).toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.fields.toString(),
    })
    if (isLoginRedirect(created)) throw new SessionRejectedError('login_redirect')
    const match = /^\/project\/([a-f0-9]{24})\b/i.exec(
      new URL(String(created.headers?.location || ''), ORIGIN).pathname
    )
    if (!match) {
      logWarn('tier1_project_not_created', { token: item.token, status: created.status })
      return { acquired: false, reason: 'project_creation_failed' }
    }
    projectId = match[1]

    // 3. Download the project zip.
    const limits = resolveLimits(cfg)
    const download = await call(`${ORIGIN}/project/${projectId}/download/zip`, {
      method: 'GET',
      followRedirects: true,
      maxBytes: limits.maxZipBytes,
    })
    if (download.truncated) {
      return { acquired: false, reason: 'zip_too_large' }
    }
    if (download.status !== 200 || !download.body?.length) {
      return { acquired: false, reason: 'zip_download_failed' }
    }

    const committed = await commitZipBuffer(download.body, {
      cfg,
      storageDir: opts.storageDir,
    })
    logInfo('tier1_acquired', { token: item.token, zipSha256: committed.zipSha256 })
    return {
      acquired: true,
      tier: 1,
      ...committed,
      mainFile: pickMainFile(committed.inspection.texCandidates, item.mainFile),
      hasMissingDependencies: false,
      missingFiles: [],
    }
  } catch (err) {
    // A throttled request is the host refusing this client, not a bad session.
    // overleaf.com answers rate limits with a plain 403, so a throttle must not
    // invalidate the cookie even though its status looks like a rejection.
    if (isTransientCode(err?.code) || isThrottledError(err)) {
      logWarn('tier1_transient_error', { token: item.token, code: err?.code, err: err?.message })
      return { acquired: false, reason: 'upstream_busy', code: err?.code, transient: true }
    }
    const status = err?.status || err?.statusCode
    if (err instanceof SessionRejectedError || status === 401 || status === 403) {
      const reason = err instanceof SessionRejectedError ? err.reason : `upstream_${status}`
      await SessionCredentialStore.markSessionInvalid(col, reason, storedEncryptedCookie).catch(markErr =>
        logWarn('tier1_mark_session_invalid_failed', { err: markErr.message })
      )
      logWarn('tier1_session_rejected', { token: item.token, reason })
      return { acquired: false, reason: 'session_unauthorized' }
    }
    logWarn('tier1_failed', { token: item.token, code: err?.code, status, err: err?.message })
    return { acquired: false, reason: 'tier1_error', error: err?.message }
  } finally {
    // Never leave the temporary project behind in the upstream account.
    if (projectId) {
      await call(`${ORIGIN}/project/${projectId}`, {
        method: 'DELETE',
        headers: csrfToken ? { 'X-Csrf-Token': csrfToken } : {},
      }).catch(err =>
        logWarn('tier1_upstream_delete_failed', { projectId, err: err.message })
      )
    }
  }
}

export default {
  buildOpenParams,
  parseLoaderForm,
  acquireViaCloudSession,
}
