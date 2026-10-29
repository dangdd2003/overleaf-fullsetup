import Settings from '@overleaf/settings'
import * as GuardedHttps from '../../transport/GuardedHttps.mjs'
import { withHostSlot } from '../../transport/HostLimiter.mjs'
import * as BlobStore from '../../storage/BlobStore.mjs'
import { DEFAULTS } from '../../TemplateGalleryDefaults.mjs'

// Every request the mirror makes goes through here: one request per host
// slot (HostLimiter), strict per-host allow-lists, size caps and content
// checks before anything reaches the BlobStore.

export const OVERLEAF_ORIGIN = 'https://www.overleaf.com'

const OVERLEAF_HOSTS = Object.freeze(['www.overleaf.com'])
const S3_HOSTS = Object.freeze(['writelatex.s3.amazonaws.com'])

const MiB = 1024 * 1024
const MAX_HTML_BYTES = 8 * MiB
// Published preview JPEGs are ~130 KB (794 px wide); leave ample headroom.
const MAX_IMAGE_BYTES = 8 * MiB
const DEFAULT_MAX_PDF_BYTES = 128 * MiB
const PAGE_TIMEOUT_MS = 30_000
const IMAGE_TIMEOUT_MS = 30_000
const PDF_TIMEOUT_MS = 180_000

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff])
const PDF_MAGIC = '%PDF'

const HTML_HEADERS = Object.freeze({
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
})
const IMAGE_HEADERS = Object.freeze({
  Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
})
const PDF_HEADERS = Object.freeze({ Accept: 'application/pdf,*/*;q=0.8' })

// Upstream answers that mean "this item is gone", not "the host is unwell".
const GONE_STATUSES = new Set([404, 410])

let overrides = null

/**
 * Replaces the transport (withHostSlot, requestRaw, fetchStream) in unit
 * tests. Passing null restores the real implementations.
 */
export function setFetchOverridesForTests(map) {
  overrides = map
}

function transport() {
  return {
    withHostSlot: overrides?.withHostSlot || withHostSlot,
    requestRaw: overrides?.requestRaw || GuardedHttps.requestRaw,
    fetchStream: overrides?.fetchStream || GuardedHttps.fetchStream,
  }
}

function config() {
  return Settings.templateGallery || DEFAULTS
}

function codedError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

function slotOptions(opts) {
  return {
    priority: opts?.priority === 'interactive' ? 'interactive' : 'background',
    signal: opts?.signal,
  }
}

export function overleafUrl(path) {
  return new URL(path, OVERLEAF_ORIGIN).href
}

/**
 * GETs an HTML page on www.overleaf.com.
 * Resolves { status: 200, html, url } or { status: 404|410 } for gone pages;
 * any other outcome rejects (with .status / .retryAfterMs for HTTP errors).
 */
export async function fetchOverleafPage(path, opts = {}) {
  const url = overleafUrl(path)
  const { withHostSlot, requestRaw } = transport()
  return withHostSlot('overleaf', slotOptions(opts), async () => {
    let res
    try {
      res = await requestRaw(url, {
        headers: HTML_HEADERS,
        allowedHosts: OVERLEAF_HOSTS,
        maxBytes: MAX_HTML_BYTES,
        timeoutMs: PAGE_TIMEOUT_MS,
        signal: opts.signal,
      })
    } catch (err) {
      if (GONE_STATUSES.has(err?.status)) return { status: err.status }
      throw err
    }
    if (res.truncated) {
      throw codedError('EBYTECAP', `page exceeds ${MAX_HTML_BYTES} bytes: ${url}`)
    }
    if (res.status !== 200) {
      throw codedError('unexpected_status', `unexpected HTTP ${res.status} from ${url}`)
    }
    return { status: 200, html: res.body.toString('utf8'), url: res.url || url }
  })
}

/**
 * Downloads a signed S3 published-version JPEG into the BlobStore.
 * Resolves { sha256, sizeBytes, mime }.
 */
export async function storeS3Image(imageUrl, opts = {}) {
  const url = GuardedHttps.validateAllowedHost(imageUrl, S3_HOSTS)
  const { withHostSlot, requestRaw } = transport()
  const res = await withHostSlot('s3', slotOptions(opts), () =>
    requestRaw(url.href, {
      headers: IMAGE_HEADERS,
      allowedHosts: S3_HOSTS,
      maxBytes: MAX_IMAGE_BYTES,
      timeoutMs: IMAGE_TIMEOUT_MS,
      followRedirects: false,
      signal: opts.signal,
    })
  )
  if (res.truncated) {
    throw codedError('EBYTECAP', `image exceeds ${MAX_IMAGE_BYTES} bytes`)
  }
  if (res.status !== 200 || !Buffer.isBuffer(res.body)) {
    throw codedError('unexpected_status', `unexpected HTTP ${res.status} for image`)
  }
  if (!res.body.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) {
    throw codedError('not_jpeg', 'published image is not a JPEG')
  }
  const blob = await BlobStore.putBuffer(res.body, {
    storageDir: config().storageDir,
    maxBytes: MAX_IMAGE_BYTES,
  })
  return { sha256: blob.sha256, sizeBytes: blob.sizeBytes, mime: 'image/jpeg' }
}

/**
 * Streams an official item PDF (<item href>.pdf) into the BlobStore.
 * Resolves { status: 200, sha256, sizeBytes } or { status: 404|410 }.
 */
export async function storeOverleafPdf(path, opts = {}) {
  const url = overleafUrl(path)
  const cfg = config()
  const maxBytes = cfg.outbound?.maxPdfBytes || DEFAULT_MAX_PDF_BYTES
  const { withHostSlot, fetchStream } = transport()
  return withHostSlot('overleaf', slotOptions(opts), async () => {
    let res
    try {
      res = await fetchStream(url, {
        headers: PDF_HEADERS,
        allowedHosts: OVERLEAF_HOSTS,
        maxBytes,
        timeoutMs: PDF_TIMEOUT_MS,
        signal: opts.signal,
      })
    } catch (err) {
      if (GONE_STATUSES.has(err?.status)) return { status: err.status }
      throw err
    }
    const declared = Number(res.headers?.['content-length'])
    if (res.status !== 200 || (Number.isFinite(declared) && declared > maxBytes)) {
      res.stream?.destroy?.()
      throw codedError(
        res.status !== 200 ? 'unexpected_status' : 'EBYTECAP',
        res.status !== 200
          ? `unexpected HTTP ${res.status} from ${url}`
          : `PDF of ${declared} bytes exceeds ${maxBytes}`
      )
    }
    const blob = await BlobStore.putStream(res.stream, {
      storageDir: cfg.storageDir,
      magic: PDF_MAGIC,
      maxBytes,
    })
    return { status: 200, sha256: blob.sha256, sizeBytes: blob.sizeBytes }
  })
}

export default {
  OVERLEAF_ORIGIN,
  overleafUrl,
  fetchOverleafPage,
  storeS3Image,
  storeOverleafPdf,
  setFetchOverridesForTests,
}
