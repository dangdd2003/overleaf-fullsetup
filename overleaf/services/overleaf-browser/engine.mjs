import fs from 'node:fs'
import path from 'node:path'
import { isChallenge } from './quality.mjs'

const MAX_READS_BEFORE_RESTART = 200
/** Inside the web side's 25 s raw timeout, which also covers queueing here. */
export const RAW_NAV_TIMEOUT_MS = 15_000
/** With the 15 s settle, inside the web side's 60 s render timeout. */
export const RENDER_NAV_TIMEOUT_MS = 25_000
/** web_fetch keeps text only; these never change what a page says. */
export const RENDER_BLOCKED_TYPES = new Set(['image', 'media', 'font'])

/**
 * Delete ephemeral directories so no page leaves code running behind,
 * while preserving Cookies and profile preferences.
 */
export function cleanProfileDir(profileDir) {
  if (!fs.existsSync(profileDir)) return
  const purgeNames = new Set([
    'Service Worker',
    'Cache',
    'Code Cache',
    'GPUCache',
    'IndexedDB',
    'blob_storage',
  ])

  function walk(current) {
    let entries = []
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (purgeNames.has(entry.name)) {
          fs.rmSync(full, { recursive: true, force: true })
        } else {
          walk(full)
        }
      }
    }
  }

  walk(profileDir)
}

/** Raw reads take the document only; the page's own requests are refused. */
export function routeRaw(route) {
  if (route.request().isNavigationRequest()) return route.continue()
  return route.abort()
}

/** Rendering keeps scripts and styles, which bot checks need, and drops the rest. */
export function routeRender(route) {
  if (RENDER_BLOCKED_TYPES.has(route.request().resourceType()))
    return route.abort()
  return route.continue()
}

/** A raw HTML answer that is a bot check rather than the page. */
export function isChallengeBody(contentType, body) {
  if (!/html/i.test(String(contentType ?? ''))) return false
  const html = body.toString('utf8')
  const text = html.replace(
    /<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/gi,
    ' '
  )
  return isChallenge(html, text)
}

function cancelled() {
  const err = new Error('Request was cancelled')
  err.code = 'aborted'
  return err
}

/** Runs `action` once when `signal` aborts; returns the function that stops watching. */
function watchAbort(signal, action) {
  if (!signal) return () => {}
  if (signal.aborted) {
    action()
    return () => {}
  }
  signal.addEventListener('abort', action, { once: true })
  return () => signal.removeEventListener('abort', action)
}

async function readText(page) {
  try {
    const read = await page.evaluate(() => ({
      title: document.title || '',
      text: document.body ? document.body.innerText : '',
    }))
    return { title: String(read?.title ?? ''), text: String(read?.text ?? '') }
  } catch {
    return { title: '', text: '' }
  }
}

async function readHtml(page) {
  try {
    return await page.content()
  } catch {
    return null
  }
}

/**
 * Poll the page's text after domcontentloaded until it holds still for two
 * polls, then read the HTML once. A bot check gets until challengeWaitMs to
 * clear itself; the whole wait is capped at maxSettleMs.
 */
export async function waitForSettledPage(
  page,
  {
    pollIntervalMs = 500,
    maxSettleMs = 15_000,
    challengeWaitMs = 15_000,
    signal,
    now = () => Date.now(),
    sleep = ms => new Promise(r => setTimeout(r, ms)),
  } = {}
) {
  const start = now()
  const deadline = start + maxSettleMs
  const challengeDeadline = start + challengeWaitMs

  let prevLen = -1
  let stablePolls = 0

  while (now() < deadline) {
    if (signal?.aborted) throw cancelled()
    const { title, text } = await readText(page)
    const len = text.trim().length
    const looksLikeCheck = isChallenge(`<title>${title}</title>`, text)
    stablePolls =
      !looksLikeCheck && len > 0 && len === prevLen ? stablePolls + 1 : 0
    prevLen = len

    if (stablePolls >= 1) {
      const html = await readHtml(page)
      if (html !== null) {
        const challenge = isChallenge(html, text)
        if (!challenge || now() >= challengeDeadline) {
          return { html, text, challenge }
        }
      }
      stablePolls = 0
    } else if (looksLikeCheck && now() >= challengeDeadline) {
      return { html: (await readHtml(page)) ?? '', text, challenge: true }
    }

    await sleep(pollIntervalMs)
  }

  if (signal?.aborted) throw cancelled()
  const { text } = await readText(page)
  const html = (await readHtml(page)) ?? ''
  return { html, text, challenge: isChallenge(html, text) }
}

async function launchChrome({
  profileDir,
  proxyUrl,
  chromiumSandbox,
  browserLang,
}) {
  const { chromium } = await import('patchright')
  return chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',
    headless: false, // headed Chrome on the Xvfb display server.mjs starts, as Patchright recommends
    viewport: null,
    chromiumSandbox,
    proxy: { server: proxyUrl, bypass: '<-loopback>' },
    args: [
      `--lang=${browserLang}`,
      '--disable-quic',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    ],
  })
}

export class BrowserEngine {
  constructor({
    profileDir = '/data/profile',
    proxyUrl = 'http://127.0.0.1:8080',
    chromiumSandbox = true,
    browserLang = 'en-US',
    launcher = null,
  } = {}) {
    this.profileDir = profileDir
    this.proxyUrl = proxyUrl
    this.chromiumSandbox = chromiumSandbox
    this.browserLang = browserLang
    this.launcher = launcher
    this.context = null
    this.starting = null
    this.busyCount = 0
    this.readCount = 0
  }

  version() {
    return 'Google Chrome (Patchright 1.63.0)'
  }

  async init() {
    await this._context()
  }

  /** One launch at a time: a read that arrives during a launch waits for it. */
  async _context() {
    if (this.context) return this.context
    if (!this.starting) {
      this.starting = this._launch().finally(() => {
        this.starting = null
      })
    }
    return this.starting
  }

  async _launch() {
    cleanProfileDir(this.profileDir)
    fs.mkdirSync(this.profileDir, { recursive: true })

    let context
    try {
      context = await (this.launcher ?? launchChrome)({
        profileDir: this.profileDir,
        proxyUrl: this.proxyUrl,
        chromiumSandbox: this.chromiumSandbox,
        browserLang: this.browserLang,
      })
    } catch (err) {
      if (/sandbox/i.test(String(err?.message || err))) {
        console.error(
          "Chrome's sandbox could not start. Run the container with services/overleaf-browser/seccomp.json (see README), or set BROWSER_SANDBOX=off to run without it."
        )
      }
      throw err
    }

    context.on('close', () => {
      if (this.context === context) this.context = null
    })
    this.context = context
    return context
  }

  /** Chrome is relaunched after MAX_READS_BEFORE_RESTART reads, once idle. */
  async _finish() {
    this.busyCount--
    this.readCount++
    if (this.readCount >= MAX_READS_BEFORE_RESTART && this.busyCount === 0) {
      this.readCount = 0
      await this.close()
    }
  }

  async raw(url, { signal } = {}) {
    if (signal?.aborted) throw cancelled()
    const context = await this._context()
    this.busyCount++
    let page = null
    let stopWatching = () => {}
    try {
      page = await context.newPage()
      stopWatching = watchAbort(signal, () => {
        page.close().catch(() => {})
      })
      if (signal?.aborted) throw cancelled()
      await page.route('**/*', routeRaw)

      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: RAW_NAV_TIMEOUT_MS,
      })

      let body
      try {
        body = await response.body()
      } catch {
        body = Buffer.from(await page.content(), 'utf8')
      }
      const contentType =
        response?.headers()['content-type'] || 'text/html; charset=utf-8'

      return {
        status: response?.status() ?? 200,
        finalUrl: page.url(),
        contentType,
        body,
        challenge: isChallengeBody(contentType, body),
      }
    } catch (err) {
      if (signal?.aborted) throw cancelled()
      throw err
    } finally {
      stopWatching()
      await page?.close().catch(() => {})
      await this._finish()
    }
  }

  async render(url, { signal } = {}) {
    if (signal?.aborted) throw cancelled()
    const context = await this._context()
    this.busyCount++
    let page = null
    let stopWatching = () => {}
    try {
      page = await context.newPage()
      stopWatching = watchAbort(signal, () => {
        page.close().catch(() => {})
      })
      if (signal?.aborted) throw cancelled()
      await page.route('**/*', routeRender)

      const downloadPromise = page
        .waitForEvent('download', { timeout: RENDER_NAV_TIMEOUT_MS })
        .catch(() => null)

      let response = null
      let downloaded = false
      try {
        response = await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: RENDER_NAV_TIMEOUT_MS,
        })
      } catch (err) {
        if (!/download is starting/i.test(String(err?.message))) throw err
        downloaded = true
      }

      const status = response?.status() ?? 200
      const isPdf = /application\/(?:x-)?pdf/i.test(
        response?.headers()['content-type'] ?? ''
      )
      if (downloaded || isPdf) {
        let body
        if (downloaded) {
          const download = await downloadPromise
          if (!download) throw new Error('Download failed')
          const chunks = []
          for await (const chunk of await download.createReadStream()) {
            chunks.push(chunk)
          }
          body = Buffer.concat(chunks)
        } else {
          body = await response.body()
        }
        return {
          status,
          finalUrl: page.url(),
          contentType: 'application/pdf',
          body,
          challenge: false,
        }
      }

      const { html, challenge } = await waitForSettledPage(page, { signal })
      return {
        status,
        finalUrl: page.url(),
        contentType: 'text/html; charset=utf-8',
        body: Buffer.from(html, 'utf8'),
        challenge,
      }
    } catch (err) {
      if (signal?.aborted) throw cancelled()
      throw err
    } finally {
      stopWatching()
      await page?.close().catch(() => {})
      await this._finish()
    }
  }

  async close() {
    const context = this.context
    this.context = null
    if (context) await context.close().catch(() => {})
  }
}
