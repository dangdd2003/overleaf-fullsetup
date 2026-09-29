import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { describeStatus, webError } from './util.mjs'
import {
  guardedLookup,
  parseFetchUrl,
  MAX_DOWNLOAD_BYTES,
  MAX_PDF_BYTES,
  REQUEST_TIMEOUT_MS,
} from './transport.mjs'

export const DEFAULT_CURL_PATH =
  process.env.AI_ASSIST_CURL_IMPERSONATE ||
  '/usr/local/lib/curl-impersonate/curl-impersonate'

let curlAvailabilityCache = null

/** Checks once whether the curl-impersonate binary exists and is executable. */
export function isCurlImpersonateAvailable(binaryPath = DEFAULT_CURL_PATH) {
  if (curlAvailabilityCache !== null && binaryPath === DEFAULT_CURL_PATH) {
    return curlAvailabilityCache
  }
  try {
    fs.accessSync(binaryPath, fs.constants.X_OK)
    if (binaryPath === DEFAULT_CURL_PATH) curlAvailabilityCache = true
    return true
  } catch {
    if (binaryPath === DEFAULT_CURL_PATH) curlAvailabilityCache = false
    return false
  }
}

/** Resets cached availability (for testing). */
export function _resetCurlAvailabilityCache() {
  curlAvailabilityCache = null
}

/** Resolves addresses through the provided guarded lookup function. */
function resolveAddresses(hostname, lookupFn) {
  return new Promise((resolve, reject) => {
    lookupFn(hostname, { all: true }, (err, addresses) => {
      if (err) return reject(err)
      const list = Array.isArray(addresses) ? addresses : []
      if (list.length === 0) {
        const errNotFound = new Error(`Could not resolve ${hostname}`)
        errNotFound.code = 'ENOTFOUND'
        return reject(errNotFound)
      }
      resolve(list.map(a => a.address))
    })
  })
}

/**
 * Executes a single HTTP hop via curl-impersonate matching requestOnce contract:
 * resolves { status, contentType, body, truncated } or { redirect },
 * rejects with the same webErrors.
 */
export async function curlFetch(
  rawUrl,
  {
    signal,
    maxBytes = MAX_DOWNLOAD_BYTES,
    pdfMaxBytes = maxBytes === MAX_DOWNLOAD_BYTES ? MAX_PDF_BYTES : maxBytes,
    timeoutMs = REQUEST_TIMEOUT_MS,
    lookup = guardedLookup,
    curlBinary = DEFAULT_CURL_PATH,
    spawnFn = spawn,
  } = {}
) {
  const parsed = parseFetchUrl(rawUrl)
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80')
  const host = parsed.hostname

  const addresses = await resolveAddresses(host, lookup)
  const resolveArg = `${host}:${port}:${addresses.join(',')}`

  const timeoutSec = Math.max(1, Math.round(timeoutMs / 1000))

  const args = [
    '-q',
    '--impersonate',
    'chrome150',
    '--compressed',
    '-sS',
    '--noproxy',
    '*',
    '--proto',
    '=http,https',
    '--max-redirs',
    '0',
    '--max-time',
    String(timeoutSec),
    '--resolve',
    resolveArg,
    '-o',
    '-',
    '-w',
    '%{stderr}%{json}\n',
    parsed.toString(),
  ]

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawnFn(curlBinary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      return reject(
        webError(`Failed to spawn curl-impersonate: ${err.message}`, {
          kind: 'network',
        })
      )
    }

    const chunks = []
    let size = 0
    let truncated = false
    let stderrText = ''
    let isSettled = false

    const cleanup = () => {
      if (signal) signal.removeEventListener('abort', onAbort)
    }

    const onAbort = () => {
      if (isSettled) return
      isSettled = true
      cleanup()
      try {
        child.kill()
      } catch {}
      reject(webError('Request was cancelled', { kind: 'network' }))
    }

    if (signal) {
      if (signal.aborted) {
        try {
          child.kill()
        } catch {}
        return reject(webError('Request was cancelled', { kind: 'network' }))
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    const maxStreamLimit = Math.max(
      Number.isFinite(maxBytes) ? maxBytes : 0,
      Number.isFinite(pdfMaxBytes) ? pdfMaxBytes : 0
    )

    child.stdout.on('data', chunk => {
      if (truncated) return
      size += chunk.length
      if (maxStreamLimit > 0 && size > maxStreamLimit) {
        chunks.push(chunk.subarray(0, chunk.length - (size - maxStreamLimit)))
        truncated = true
        process.nextTick(() => {
          try {
            child.kill()
          } catch {}
        })
      } else {
        chunks.push(chunk)
      }
    })

    child.stderr.on('data', chunk => {
      stderrText += chunk.toString('utf8')
    })

    child.on('error', err => {
      if (isSettled) return
      isSettled = true
      cleanup()
      reject(
        webError(`curl error: ${err.message}`, {
          kind: 'network',
        })
      )
    })

    child.on('close', code => {
      if (isSettled) return
      isSettled = true
      cleanup()

      let meta = null
      const lines = stderrText.trim().split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim()
        if (line.startsWith('{') && line.endsWith('}')) {
          try {
            meta = JSON.parse(line)
            break
          } catch {}
        }
      }

      if (!meta) {
        const lastErr =
          lines[lines.length - 1] || `curl exited with code ${code}`
        return reject(
          webError(`Could not fetch ${parsed}: ${lastErr}`, { kind: 'network' })
        )
      }

      const status = meta.http_code ?? 0
      const contentType = meta.content_type || ''
      const isPdf = /application\/(?:x-)?pdf/i.test(contentType)
      const allowedLimit = isPdf ? Math.max(maxBytes, pdfMaxBytes) : maxBytes

      if (status >= 300 && status < 400 && meta.redirect_url) {
        return resolve({ redirect: meta.redirect_url })
      }

      if (status >= 400) {
        const reason = describeStatus(status)
        return reject(
          webError(
            `${parsed} returned HTTP ${status}${reason ? `: ${reason}` : ''}.`,
            {
              status,
              kind: 'http',
            }
          )
        )
      }

      if (code !== 0 && !truncated && status === 0) {
        const msg =
          meta.errormsg || stderrText.trim() || `curl exit code ${code}`
        return reject(
          webError(`Could not fetch ${parsed}: ${msg}`, { kind: 'network' })
        )
      }

      let body = Buffer.concat(chunks)
      if (
        Number.isFinite(allowedLimit) &&
        allowedLimit > 0 &&
        body.length > allowedLimit
      ) {
        body = body.subarray(0, allowedLimit)
        truncated = true
      }

      resolve({
        status,
        contentType,
        body,
        truncated,
      })
    })
  })
}
