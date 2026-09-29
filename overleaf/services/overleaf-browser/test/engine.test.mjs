import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  BrowserEngine,
  cleanProfileDir,
  isChallengeBody,
  routeRaw,
  routeRender,
  waitForSettledPage,
} from '../engine.mjs'

function tmpProfile() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'profile-test-'))
}

function fakeRoute({ navigation = false, type = 'document' } = {}) {
  const calls = []
  return {
    calls,
    request: () => ({
      isNavigationRequest: () => navigation,
      resourceType: () => type,
    }),
    continue: async () => {
      calls.push('continue')
    },
    abort: async () => {
      calls.push('abort')
    },
  }
}

test('cleanProfileDir removes code caches and non-cookie databases but preserves Cookies', () => {
  const tmp = tmpProfile()
  try {
    fs.mkdirSync(path.join(tmp, 'Default'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'Default', 'Cookies'), 'secret-cookie')
    fs.mkdirSync(path.join(tmp, 'Default', 'Service Worker'), {
      recursive: true,
    })
    fs.writeFileSync(
      path.join(tmp, 'Default', 'Service Worker', 'sw.bin'),
      'sw'
    )
    fs.mkdirSync(path.join(tmp, 'Default', 'Cache'), { recursive: true })
    fs.mkdirSync(path.join(tmp, 'Default', 'Code Cache'), { recursive: true })
    fs.mkdirSync(path.join(tmp, 'Default', 'IndexedDB'), { recursive: true })
    fs.mkdirSync(path.join(tmp, 'Default', 'blob_storage'), { recursive: true })
    fs.mkdirSync(path.join(tmp, 'Default', 'GPUCache'), { recursive: true })

    cleanProfileDir(tmp)

    assert.equal(fs.existsSync(path.join(tmp, 'Default', 'Cookies')), true)
    assert.equal(
      fs.readFileSync(path.join(tmp, 'Default', 'Cookies'), 'utf8'),
      'secret-cookie'
    )
    assert.equal(
      fs.existsSync(path.join(tmp, 'Default', 'Service Worker')),
      false
    )
    assert.equal(fs.existsSync(path.join(tmp, 'Default', 'Cache')), false)
    assert.equal(fs.existsSync(path.join(tmp, 'Default', 'Code Cache')), false)
    assert.equal(fs.existsSync(path.join(tmp, 'Default', 'IndexedDB')), false)
    assert.equal(
      fs.existsSync(path.join(tmp, 'Default', 'blob_storage')),
      false
    )
    assert.equal(fs.existsSync(path.join(tmp, 'Default', 'GPUCache')), false)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('waitForSettledPage reads the HTML once, after the text holds still for two polls', async () => {
  let reads = 0
  let contents = 0
  const fakePage = {
    content: async () => {
      contents++
      return '<html><body>Stable text</body></html>'
    },
    evaluate: async () => {
      reads++
      return { title: 'Paper', text: reads === 1 ? 'Initial' : 'Stable text' }
    },
  }

  const res = await waitForSettledPage(fakePage, {
    pollIntervalMs: 1,
    maxSettleMs: 1000,
    sleep: () => Promise.resolve(),
  })

  assert.equal(res.challenge, false)
  assert.equal(res.text, 'Stable text')
  assert.equal(res.html, '<html><body>Stable text</body></html>')
  assert.equal(reads, 3)
  assert.equal(contents, 1)
})

test('waitForSettledPage recognizes uncleared challenge when wait expires', async () => {
  const fakePage = {
    content: async () =>
      '<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>',
    evaluate: async () => ({
      title: 'Just a moment...',
      text: 'Checking your browser',
    }),
  }

  let clock = 1000
  const res = await waitForSettledPage(fakePage, {
    pollIntervalMs: 10,
    maxSettleMs: 50,
    challengeWaitMs: 30,
    now: () => clock,
    sleep: async ms => {
      clock += ms
    },
  })

  assert.equal(res.challenge, true)
})

test('routeRaw lets only the navigation through', async () => {
  const navigation = fakeRoute({ navigation: true })
  await routeRaw(navigation)
  const script = fakeRoute({ type: 'script' })
  await routeRaw(script)
  assert.deepEqual(navigation.calls, ['continue'])
  assert.deepEqual(script.calls, ['abort'])
})

test('routeRender drops images, media and fonts and keeps scripts and styles', async () => {
  const seen = {}
  for (const type of [
    'document',
    'script',
    'stylesheet',
    'xhr',
    'image',
    'media',
    'font',
  ]) {
    const route = fakeRoute({ type })
    await routeRender(route)
    seen[type] = route.calls[0]
  }
  assert.deepEqual(seen, {
    document: 'continue',
    script: 'continue',
    stylesheet: 'continue',
    xhr: 'continue',
    image: 'abort',
    media: 'abort',
    font: 'abort',
  })
})

test('isChallengeBody spots a bot check in raw HTML but not in a long article or a PDF', () => {
  assert.equal(
    isChallengeBody(
      'text/html; charset=utf-8',
      Buffer.from(
        '<html><head><title>Just a moment...</title></head><body></body></html>'
      )
    ),
    true
  )
  const article = `<html><head><title>Just a moment...</title></head><body><p>${'word '.repeat(600)}</p></body></html>`
  assert.equal(isChallengeBody('text/html', Buffer.from(article)), false)
  assert.equal(
    isChallengeBody(
      'application/pdf',
      Buffer.from('<title>Just a moment...</title>')
    ),
    false
  )
})

test('BrowserEngine launches Chrome once when reads arrive together', async () => {
  const tmp = tmpProfile()
  try {
    let launches = 0
    const context = {
      on: () => {},
      close: async () => {},
      newPage: async () => {
        throw new Error('unused')
      },
    }
    const engine = new BrowserEngine({
      profileDir: tmp,
      launcher: async () => {
        launches++
        await new Promise(resolve => setTimeout(resolve, 10))
        return context
      },
    })
    await Promise.all([engine.init(), engine.init()])
    assert.equal(launches, 1)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('BrowserEngine closes the page and reports cancellation when the read is aborted', async () => {
  const tmp = tmpProfile()
  try {
    let markStarted
    const started = new Promise(resolve => {
      markStarted = resolve
    })
    let failGoto = null
    let closed = false
    const page = {
      route: async () => {},
      goto: () =>
        new Promise((_, reject) => {
          failGoto = reject
          markStarted()
        }),
      close: async () => {
        closed = true
        failGoto?.(new Error('Target page, context or browser has been closed'))
      },
      url: () => 'https://example.com/',
    }
    const context = {
      on: () => {},
      close: async () => {},
      newPage: async () => page,
    }
    const engine = new BrowserEngine({
      profileDir: tmp,
      launcher: async () => context,
    })
    const controller = new AbortController()
    const reading = engine.raw('https://example.com/', {
      signal: controller.signal,
    })
    await started
    controller.abort()
    await assert.rejects(reading, err => err.code === 'aborted')
    assert.equal(closed, true)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
