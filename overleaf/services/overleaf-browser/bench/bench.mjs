import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isChallenge } from '../quality.mjs'

const BROWSER_URL = process.env.AI_ASSIST_BROWSER_URL || 'http://127.0.0.1:3000'
const BROWSER_TOKEN = process.env.AI_ASSIST_BROWSER_TOKEN || ''

if (!BROWSER_TOKEN) {
  console.error('AI_ASSIST_BROWSER_TOKEN is required for benchmark.')
  process.exit(1)
}

const urlsFile = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'urls.txt'
)
const urls = fs
  .readFileSync(urlsFile, 'utf8')
  .split('\n')
  .map(l => l.trim())
  .filter(l => l && !l.startsWith('#'))

console.log(`Benchmarking ${urls.length} URLs against ${BROWSER_URL}...`)

async function testUrl(endpoint, url) {
  const start = Date.now()
  try {
    const res = await fetch(`${BROWSER_URL}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${BROWSER_TOKEN}`,
      },
      body: JSON.stringify({ url }),
    })
    const elapsed = Date.now() - start
    const status = Number(res.headers.get('x-page-status') || res.status)
    const text = await res.text()
    const challenge = isChallenge(text, '')
    return { status, elapsed, challenge, ok: res.ok && !challenge }
  } catch (err) {
    return {
      status: 0,
      elapsed: Date.now() - start,
      challenge: false,
      ok: false,
      error: err.message,
    }
  }
}

for (const url of urls) {
  const raw = await testUrl('/v1/raw', url)
  const render = await testUrl('/v1/render', url)
  console.log(
    `[${url}] raw: ${raw.status} (${raw.elapsed}ms, ok=${raw.ok}) | render: ${render.status} (${render.elapsed}ms, ok=${render.ok})`
  )
}
