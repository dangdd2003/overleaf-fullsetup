import crypto from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import { isPublicAddress } from './address.mjs'
import { isChallengeBody } from './engine.mjs'
import { HostPacer } from './pacer.mjs'
import { Slots } from './slots.mjs'

/**
 * How long a read waits for a free browser page. Raw must stay well inside
 * the web side's 25 s raw timeout, render inside its 60 s.
 */
export const SLOT_WAIT_MS = {
  raw: 5_000,
  render: 10_000,
  fetch: 3_000,
  fetchChrome: 5_000,
}
/**
 * Small-file fetches (site icons) at once. They open no browser page, so
 * they have places of their own and never wait for a page read.
 */
export const FETCH_CAPACITY = 8
/**
 * Small files a bot check refused to plain HTTP, read by Chrome at once.
 * Their own pages, so an icon never waits behind a page read.
 */
export const FETCH_CHROME_CAPACITY = 2

/**
 * A plain-HTTP answer that is a bot check rather than the file (Cloudflare
 * and the like refuse a client that is not a browser): Chrome may pass it.
 */
export function refusedAsBot(outcome) {
  return (
    outcome.status === 403 ||
    outcome.status === 503 ||
    isChallengeBody(outcome.contentType, outcome.body)
  )
}

function verifyToken(header, expected) {
  if (!header || !expected) return false
  const match = /^Bearer\s+(.+)$/i.exec(header)
  if (!match) return false
  const token = match[1].trim()
  const a = Buffer.from(token)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

function sendJson(res, status, data, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    ...headers,
  })
  res.end(JSON.stringify(data))
}

export function createApp({
  token,
  engine,
  pacer = new HostPacer(),
  capacity = 2,
  slotWaitMs = SLOT_WAIT_MS,
  fetchFile = null,
  fetchCapacity = FETCH_CAPACITY,
  fetchChromeCapacity = FETCH_CHROME_CAPACITY,
} = {}) {
  if (!token || token.length < 32) {
    throw new Error('BROWSER_TOKEN must be at least 32 characters.')
  }
  const slots = new Slots(capacity)
  const fetchSlots = new Slots(fetchCapacity)
  const fetchChromeSlots = new Slots(fetchChromeCapacity)

  const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, 'http://127.0.0.1')
    const pathname = parsedUrl.pathname

    if (req.method === 'GET' && pathname === '/v1/health') {
      sendJson(res, 200, {
        ok: true,
        api: 1,
        engine: 'patchright-chrome',
        browser: engine?.version() || 'unknown',
        busy: slots.busy,
        capacity: slots.size,
      })
      return
    }

    if (!verifyToken(req.headers['authorization'], token)) {
      sendJson(res, 401, { error: 'Unauthorized', kind: 'http' })
      return
    }

    if (
      req.method !== 'POST' ||
      (pathname !== '/v1/raw' &&
        pathname !== '/v1/render' &&
        pathname !== '/v1/fetch')
    ) {
      sendJson(res, 404, { error: 'Not found', kind: 'http' })
      return
    }

    // Read JSON body
    let bodyText = ''
    try {
      for await (const chunk of req) {
        bodyText += chunk.toString('utf8')
        if (bodyText.length > 64 * 1024) throw new Error('Body too large')
      }
    } catch {
      sendJson(res, 400, {
        error: 'Failed to read request body',
        kind: 'content',
      })
      return
    }

    let parsedBody
    try {
      parsedBody = JSON.parse(bodyText || '{}')
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON', kind: 'content' })
      return
    }

    const targetUrl =
      typeof parsedBody.url === 'string' ? parsedBody.url.trim() : ''
    let parsedTarget
    try {
      parsedTarget = new URL(targetUrl)
      if (
        parsedTarget.protocol !== 'http:' &&
        parsedTarget.protocol !== 'https:'
      ) {
        throw new Error('Only http and https are allowed')
      }
    } catch {
      sendJson(res, 400, { error: 'Invalid URL', kind: 'content' })
      return
    }

    const host = parsedTarget.hostname
    if (net.isIP(host) ? !isPublicAddress(host) : !host.includes('.')) {
      sendJson(res, 403, {
        error: `${host} is not a public address`,
        kind: 'content',
      })
      return
    }

    const mode = pathname.slice('/v1/'.length)
    // The web side gave up (its own timeout or a cancelled run): stop
    // queueing and close the page. res, not req: req closes once its body is read.
    const controller = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) controller.abort()
    })
    const { signal } = controller

    let releasePacer = null
    let releaseSlot = null
    try {
      let outcome
      if (mode === 'fetch') {
        // A small file a browser would ask for anyway (an icon): it keeps
        // a host's cooldown but not the spacing between page reads
        const retryAfter = pacer.getCooldown(host)
        if (retryAfter > 0) {
          throw Object.assign(new Error(`Host ${host} is cooling down`), {
            status: 429,
            retryAfter,
          })
        }
        const head = parsedBody.head === true
        releaseSlot = await fetchSlots.acquire({
          signal,
          waitMs: slotWaitMs.fetch,
        })
        outcome = await fetchFile(targetUrl, { signal, head })
        // Chrome's fingerprint and cookies pass many checks plain HTTP does not
        if (refusedAsBot(outcome)) {
          releaseSlot()
          releaseSlot = await fetchChromeSlots.acquire({
            signal,
            waitMs: slotWaitMs.fetchChrome,
          })
          // An icon's bot check never cools the host down for page reads
          outcome = { ...(await engine.raw(targetUrl, { signal })), challenge: false }
        }
      } else {
        releasePacer = await pacer.acquire(host, { signal })
        releaseSlot = await slots.acquire({ signal, waitMs: slotWaitMs[mode] })
        outcome = await engine[mode](targetUrl, { signal })
      }

      if (outcome.status === 429) {
        pacer.setCooldown(host, outcome.retryAfter || 60)
      } else if (outcome.challenge) {
        pacer.setCooldown(host, 600) // 10 minutes
      }

      res.writeHead(200, {
        'Content-Type': outcome.contentType || 'text/html; charset=utf-8',
        'X-Page-Status': String(outcome.status || 200),
        'X-Page-Url': encodeURI(outcome.finalUrl || targetUrl),
        'X-Page-Truncated': outcome.truncated ? '1' : '0',
      })
      res.end(outcome.body)
    } catch (err) {
      if (signal.aborted) {
        res.destroy()
        return
      }
      if (err.status === 429) {
        sendJson(
          res,
          429,
          { error: err.message, kind: 'http' },
          {
            'Retry-After': String(err.retryAfter || 60),
          }
        )
        return
      }
      sendJson(res, err.status || 502, {
        error: String(err.message || err),
        kind: err.kind || 'network',
      })
    } finally {
      releaseSlot?.()
      releasePacer?.()
    }
  })

  return server
}
