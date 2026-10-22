import fs from 'node:fs'
import { spawn } from 'node:child_process'
import {
  httpStatusError,
  isPdfType,
  webError,
} from './util.mjs'
import {
  guardedLookup,
  parseFetchUrl,
  MAX_DOWNLOAD_BYTES,
  MAX_PDF_BYTES,
  REQUEST_TIMEOUT_MS,
} from './transport.mjs'

export const DEFAULT_CURL_PATH =
  '/usr/local/lib/curl-impersonate/curl-impersonate'
const STDERR_KEEP_CHARS = 64 * 1024
// The response headers come first on stderr (-D), before the timing line
const STDERR_HEAD_CHARS = 16 * 1024
// A child that has not finished this long after its own --max-time is killed
const KILL_GRACE_MS = 5_000
// What the curl child is given. It inherits nothing else: the web process holds
// session secrets and provider keys. The wrapper sets LD_PRELOAD itself, so
// it is not passed on from here.
const CURL_ENV_NAMES = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LD_LIBRARY_PATH',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'CURL_CA_BUNDLE',
]

/** The environment for the curl child: an allowlist of names, LC_* included. */
export function curlChildEnv(source = process.env) {
  const env = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (CURL_ENV_NAMES.includes(key) || key.startsWith('LC_')) env[key] = value
  }
  return env
}

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
 * The status and content type of the last response in curl's header dump. Used
 * when the size cap killed curl before its timing line was written.
 */
export function parseDumpedHeaders(text) {
  let status = 0
  let contentType = ''
  for (const line of String(text).split(/\r?\n/)) {
    const statusLine = /^HTTP\/\S+\s+(\d{3})/.exec(line)
    if (statusLine) {
      status = Number(statusLine[1])
      contentType = ''
      continue
    }
    const header = /^content-type:\s*(.*)$/i.exec(line)
    if (header) contentType = header[1].trim()
  }
  return { status, contentType }
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
  // URL keeps the brackets of an IPv6 literal; the lookup and --resolve want it bare
  const host = parsed.hostname.replace(/^\[|\]$/g, '')

  const addresses = await resolveAddresses(host, lookup)
  const resolveHost = host.includes(':') ? `[${host}]` : host
  const resolveArg = `${resolveHost}:${port}:${addresses.join(',')}`

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
    // Headers go to stderr, so a child killed at the size cap still says
    // what the page was
    '-D',
    '/dev/stderr',
    '-w',
    '%{stderr}%{json}\n',
    parsed.toString(),
  ]

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawnFn(curlBinary, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: curlChildEnv(),
      })
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
    let stderrHead = ''
    let isSettled = false

    // Wall-clock backstop: curl's --max-time should end the transfer first, but
    // a child that stops making progress must not hold the request open.
    const deadlineTimer = setTimeout(() => {
      if (isSettled) return
      isSettled = true
      cleanup()
      try {
        child.kill('SIGKILL')
      } catch {}
      reject(
        webError(
          `${parsed} did not answer within ${Math.round(timeoutMs / 1000)}s.`,
          { kind: 'network' }
        )
      )
    }, timeoutMs + KILL_GRACE_MS)

    const cleanup = () => {
      clearTimeout(deadlineTimer)
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
      const text = chunk.toString('utf8')
      if (stderrHead.length < STDERR_HEAD_CHARS) {
        stderrHead += text.slice(0, STDERR_HEAD_CHARS - stderrHead.length)
      }
      // Only the tail is kept: the timing line curl writes last is what is read
      stderrText = (stderrText + text).slice(-STDERR_KEEP_CHARS)
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

      if (!meta && truncated) {
        // Killed at the size cap: no timing line, but the headers were dumped.
        // The page is kept up to the cap and marked truncated, not failed.
        const { status, contentType } = parseDumpedHeaders(stderrHead)
        if (status >= 400) return reject(httpStatusError(parsed, status))
        const allowed = isPdfType(contentType)
          ? Math.max(maxBytes, pdfMaxBytes)
          : maxBytes
        let body = Buffer.concat(chunks)
        if (body.length > allowed) body = body.subarray(0, allowed)
        return resolve({
          status: status || 200,
          contentType,
          body,
          truncated: true,
        })
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
      const isPdf = isPdfType(contentType)
      const allowedLimit = isPdf ? Math.max(maxBytes, pdfMaxBytes) : maxBytes

      if (status >= 300 && status < 400 && meta.redirect_url) {
        return resolve({ redirect: meta.redirect_url })
      }

      if (status >= 400) {
        return reject(httpStatusError(parsed, status))
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
