import fs from 'node:fs'
import { createApp } from './app.mjs'
import { startDisplay } from './display.mjs'
import { BrowserEngine } from './engine.mjs'
import { createGuardedProxy } from './proxy.mjs'

/**
 * Headed Google Chrome on Xvfb, driven by Patchright, behind an
 * authenticated HTTP API for AI Assist web_fetch. All page traffic passes
 * through the guarded proxy.
 */

const PORT = Number(process.env.PORT || 3000)
const PROXY_PORT = Number(process.env.PROXY_PORT || 8080)
const TOKEN = (process.env.BROWSER_TOKEN || '').trim()
const SANDBOX = process.env.BROWSER_SANDBOX !== 'off'
const BROWSER_LANG = process.env.BROWSER_LANG || 'en-US'
const CAPACITY = Math.max(1, Number(process.env.BROWSER_CAPACITY) || 2)

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

const proxy = createGuardedProxy()
await new Promise(resolve => proxy.listen(PROXY_PORT, '127.0.0.1', resolve))

const engine = new BrowserEngine({
  profileDir: '/data/profile',
  proxyUrl: `http://127.0.0.1:${PROXY_PORT}`,
  chromiumSandbox: SANDBOX,
  browserLang: BROWSER_LANG,
})

try {
  await engine.init()
} catch (err) {
  console.error(`Browser initialization failed: ${err.message}`)
  process.exit(1)
}

const app = createApp({ token: TOKEN, engine, capacity: CAPACITY })

await new Promise(resolve => app.listen(PORT, '0.0.0.0', resolve))
console.log(`ai-browser listening on port ${PORT} (${CAPACITY} pages at once)`)

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
