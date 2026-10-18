import fs from 'node:fs'
import { createApp } from './app.mjs'
import { startDisplay } from './display.mjs'
import { BrowserEngine } from './engine.mjs'
import { fetchSmall } from './fetcher.mjs'
import { createEgressProxy } from './proxy.mjs'

/**
 * Headed Google Chrome on Xvfb, driven by Patchright, behind an
 * authenticated HTTP API for AI Assist web_fetch. All outbound traffic from
 * Chrome and fetchSmall goes through an internal guarded proxy that blocks all
 * RFC-1918 / LAN / Docker / metadata IPs, with optional HTTP/SOCKS5 upstream proxy.
 * Overleaf communicates directly with this container over HTTP with Bearer token.
 */

// Fixed: the image's EXPOSE and healthcheck use 3000, and the egress proxy is
// internal to the container (127.0.0.1 only), so neither is a deployment choice
const PORT = 3000
const PROXY_PORT = 8080
const BROWSER_LANG = (process.env.BROWSER_LANG || '').trim() || 'en-US'
const TOKEN = (process.env.BROWSER_TOKEN || '').trim()
const CAPACITY = Math.max(1, Number(process.env.BROWSER_CAPACITY) || 2)

// Upstream proxy: UPSTREAM_PROXY, then the standard HTTPS/ALL/HTTP_PROXY vars
const UPSTREAM_PROXY = (
  process.env.UPSTREAM_PROXY ||
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.ALL_PROXY ||
  process.env.all_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy ||
  ''
).trim() || null

if (!TOKEN || TOKEN.length < 32) {
  console.error(
    'BROWSER_TOKEN must be set to a secret token of at least 32 characters.'
  )
  process.exit(1)
}

// HOME lives on the /tmp tmpfs so a read-only root filesystem works
if (process.env.HOME) fs.mkdirSync(process.env.HOME, { recursive: true })

let display
try {
  display = await startDisplay()
} catch (err) {
  console.error(`Virtual display failed: ${err.message}`)
  process.exit(1)
}
process.env.DISPLAY = display.display
display.child.once('exit', code => {
  console.error(`Xvfb exited (${code}); stopping so the container restarts`)
  process.exit(1)
})

// Internal guarded proxy: intercepts outbound traffic, blocks non-public IPs,
// and routes through upstream HTTP/SOCKS5 proxy when configured
const proxy = createEgressProxy({ upstreamProxy: UPSTREAM_PROXY })
await new Promise(resolve => proxy.listen(PROXY_PORT, '127.0.0.1', resolve))

const maskedProxy = UPSTREAM_PROXY
  ? UPSTREAM_PROXY.replace(/:\/\/[^@]+@/, '://***@')
  : null
console.log(
  `overleaf-browser internal egress proxy on port ${PROXY_PORT}${
    maskedProxy ? ` (chained to ${maskedProxy})` : ' (direct connection)'
  }`
)

const engine = new BrowserEngine({
  profileDir: '/data/profile',
  proxyUrl: `http://127.0.0.1:${PROXY_PORT}`,
  browserLang: BROWSER_LANG,
})

try {
  await engine.init()
} catch (err) {
  console.error(`Browser initialization failed: ${err.message}`)
  process.exit(1)
}

const app = createApp({
  token: TOKEN,
  engine,
  capacity: CAPACITY,
  fetchFile: (url, options) =>
    fetchSmall(url, { ...options, proxyUrl: `http://127.0.0.1:${PROXY_PORT}` }),
})

await new Promise(resolve => app.listen(PORT, '0.0.0.0', resolve))
console.log(
  `overleaf-browser listening on port ${PORT} (${CAPACITY} pages at once)`
)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await engine.close().catch(() => {})
    app.close()
    proxy.close()
    display.child.removeAllListeners('exit')
    display.stop()
    process.exit(0)
  })
}
