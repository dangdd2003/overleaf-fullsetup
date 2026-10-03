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
/** The most of one page or download handed back: the web side's PDF cap. */
export const MAX_BODY_BYTES = 128 * 1024 * 1024
/** Chrome's HTTP cache on the profile volume. */
export const DISK_CACHE_BYTES = 100 * 1024 * 1024
/** A profile still bigger than this after cleaning is wiped whole. */
export const PROFILE_MAX_BYTES = 512 * 1024 * 1024

/** `body` cut to MAX_BODY_BYTES, and whether it was cut. */
export function capBody(body, max = MAX_BODY_BYTES) {
  return body.length > max
    ? { body: body.subarray(0, max), truncated: true }
    : { body, truncated: false }
}

/** Bytes under `dir`, without following links. */
function sizeOf(dir) {
  let total = 0
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) total += sizeOf(full)
    else if (entry.isFile()) {
      try {
        total += fs.statSync(full).size
      } catch {}
    }
  }
  return total
}

/**
 * Delete everything a page can store or leave running behind (workers,
 * caches, every kind of site storage, crash dumps) and the locks of a Chrome
 * that did not shut down, keeping only cookies and profile preferences,
 * which bot checks rely on. A profile still bigger than
 * `maxBytes` afterwards is emptied entirely, so no page can fill the volume.
 * Returns whether it was emptied.
 */
export function cleanProfileDir(
  profileDir,
  { maxBytes = PROFILE_MAX_BYTES } = {}
) {
  if (!fs.existsSync(profileDir)) return { wiped: false }
  // Locks of a Chrome that did not shut down (its container was replaced):
  // left in place, the next Chrome asks whether the profile is in use and
  // never starts. Only this container runs a Chrome on this profile.
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    fs.rmSync(path.join(profileDir, name), { force: true })
  }
  const purgeNames = new Set([
    'Service Worker',
    'Cache',
    'Code Cache',
    'GPUCache',
    'IndexedDB',
    'blob_storage',
    'File System',
    'Local Storage',
    'Session Storage',
    'WebStorage',
    'Shared Dictionary',
    'DawnGraphiteCache',
    'DawnWebGPUCache',
    'GraphiteDawnCache',
    'GrShaderCache',
    'ShaderCache',
    'Crashpad',
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

  if (sizeOf(profileDir) <= maxBytes) return { wiped: false }
  for (const entry of fs.readdirSync(profileDir)) {
    fs.rmSync(path.join(profileDir, entry), { recursive: true, force: true })
  }
  return { wiped: true }
}

/**
 * Whether Chrome's own sandbox is really on, read from /proc rather than
 * trusted from a flag: every renderer must run in a PID namespace of its own
 * (the namespace sandbox) and, where the kernel reports it, carry more
 * seccomp filters than this process (Chrome's seccomp-bpf on top of
 * Docker's).
 */
export function checkSandbox({ procRoot = '/proc', selfPid = process.pid } = {}) {
  const read = (pid, file) => {
    try {
      return fs.readFileSync(path.join(procRoot, String(pid), file), 'utf8')
    } catch {
      return null
    }
  }
  const filtersOf = status => {
    const match = /^Seccomp_filters:\s*(\d+)/m.exec(status ?? '')
    return match ? Number(match[1]) : null
  }
  const pidNamespaces = status => {
    const match = /^NSpid:\s*(.+)$/m.exec(status ?? '')
    return match ? match[1].trim().split(/\s+/).length : 0
  }

  let pids = []
  try {
    pids = fs.readdirSync(procRoot).filter(name => /^\d+$/.test(name))
  } catch {
    return { ok: false, reason: `${procRoot} cannot be read` }
  }
  // Chrome may rewrite its command line with spaces instead of NULs
  const renderers = pids.filter(pid => {
    const cmd = read(pid, 'cmdline') ?? ''
    return (
      (cmd.includes('chrome') || cmd.includes('/chrome')) &&
      cmd.replace(/\0/g, ' ').includes('--type=renderer')
    )
  })
  if (renderers.length === 0) {
    return { ok: false, reason: 'no Chrome renderer is running' }
  }
  const ownFilters = filtersOf(read(selfPid, 'status'))
  for (const pid of renderers) {
    const status = read(pid, 'status')
    if (!status) continue
    if (pidNamespaces(status) < 2) {
      return {
        ok: false,
        reason: `renderer ${pid} is not in a PID namespace of its own`,
      }
    }
    const filters = filtersOf(status)
    if (ownFilters !== null && filters !== null && filters <= ownFilters) {
      return {
        ok: false,
        reason: `renderer ${pid} has no seccomp filter of its own (has ${filters}, parent has ${ownFilters})`,
      }
    }
  }
  return { ok: true, reason: `${renderers.length} renderer(s) sandboxed` }
}

/**
 * The URL Chrome is sent to for `url`. Chrome aborts a navigation to a path
 * ending in /favicon.ico (net::ERR_ABORTED, before any request goes out),
 * so such a URL gets an empty query: the same file to any server, and
 * a page Chrome opens.
 */
export function navigationUrl(url) {
  const parsed = new URL(url)
  if (parsed.search || !/\/favicon\.ico$/i.test(parsed.pathname)) return url
  return `${url}?`
}

/** The page's own URL, without the query navigationUrl added. */
function reportedUrl(page, url, navigated) {
  const current = page.url()
  return current === navigated ? url : current
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

async function launchChrome({ profileDir, proxyUrl, browserLang }) {
  const { chromium } = await import('patchright')
  return chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',
    headless: false, // headed Chrome on the Xvfb display server.mjs starts, as Patchright recommends
    viewport: null,
    // Never off: checkSandbox refuses to read pages without it
    chromiumSandbox: true,
    proxy: { server: proxyUrl, bypass: '<-loopback>' },
    args: [
      `--lang=${browserLang}`,
      '--disable-quic',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-component-update',
      '--disable-default-apps',
      '--no-default-browser-check',
      '--no-first-run',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      `--disk-cache-size=${DISK_CACHE_BYTES}`,
    ],
  })
}

export class BrowserEngine {
  constructor({
    profileDir = '/data/profile',
    proxyUrl,
    browserLang = 'en-US',
    launcher = null,
    sandboxCheck = checkSandbox,
    sandboxTimeoutMs = 5_000,
  } = {}) {
    this.profileDir = profileDir
    this.proxyUrl = proxyUrl
    this.browserLang = browserLang
    this.launcher = launcher
    this.sandboxCheck = sandboxCheck
    this.sandboxTimeoutMs = sandboxTimeoutMs
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
    if (cleanProfileDir(this.profileDir).wiped) {
      console.warn(
        `The browser profile was over ${PROFILE_MAX_BYTES} bytes after cleaning and was emptied`
      )
    }
    fs.mkdirSync(this.profileDir, { recursive: true })

    let context
    try {
      context = await (this.launcher ?? launchChrome)({
        profileDir: this.profileDir,
        proxyUrl: this.proxyUrl,
        browserLang: this.browserLang,
      })
    } catch (err) {
      if (/sandbox/i.test(String(err?.message || err))) {
        console.error(
          "Chrome's sandbox could not start. Run the container with services/overleaf-browser/seccomp.json (see README)."
        )
      }
      throw err
    }

    // A renderer exists once a page is open: check it really is sandboxed.
    // Poll briefly because newly forked renderer processes take a few milliseconds
    // to initialize their seccomp-bpf policy after forking from zygote.
    try {
      const page = await context.newPage()
      try {
        const start = Date.now()
        let verdict = this.sandboxCheck()
        while (!verdict.ok && Date.now() - start < this.sandboxTimeoutMs) {
          await new Promise(resolve => setTimeout(resolve, 50))
          verdict = this.sandboxCheck()
        }
        if (!verdict.ok) {
          throw new Error(
            `Chrome's sandbox is not active (${verdict.reason}); refusing to read pages without it`
          )
        }
        console.log(`Chrome sandbox verified: ${verdict.reason}`)
      } finally {
        await page.close().catch(() => {})
      }
    } catch (err) {
      await context.close().catch(() => {})
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

      const navigated = navigationUrl(url)
      const response = await page.goto(navigated, {
        waitUntil: 'domcontentloaded',
        timeout: RAW_NAV_TIMEOUT_MS,
      })

      let whole
      try {
        whole = await response.body()
      } catch {
        whole = Buffer.from(await page.content(), 'utf8')
      }
      const { body, truncated } = capBody(whole)
      const contentType =
        response?.headers()['content-type'] || 'text/html; charset=utf-8'

      return {
        status: response?.status() ?? 200,
        finalUrl: reportedUrl(page, url, navigated),
        contentType,
        body,
        truncated,
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
        let truncated = false
        if (downloaded) {
          const download = await downloadPromise
          if (!download) throw new Error('Download failed')
          // Read no more than the cap, then drop the file from /tmp
          const chunks = []
          let size = 0
          for await (const chunk of await download.createReadStream()) {
            if (size + chunk.length > MAX_BODY_BYTES) {
              chunks.push(chunk.subarray(0, MAX_BODY_BYTES - size))
              truncated = true
              break
            }
            chunks.push(chunk)
            size += chunk.length
          }
          await download.delete().catch(() => {})
          body = Buffer.concat(chunks)
        } else {
          ;({ body, truncated } = capBody(await response.body()))
        }
        return {
          status,
          finalUrl: page.url(),
          contentType: 'application/pdf',
          body,
          truncated,
          challenge: false,
        }
      }

      const { html, challenge } = await waitForSettledPage(page, { signal })
      const { body, truncated } = capBody(Buffer.from(html, 'utf8'))
      return {
        status,
        finalUrl: page.url(),
        contentType: 'text/html; charset=utf-8',
        body,
        truncated,
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
