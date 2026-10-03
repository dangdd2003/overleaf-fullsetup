import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  BrowserEngine,
  MAX_BODY_BYTES,
  capBody,
  checkSandbox,
  cleanProfileDir,
  isChallengeBody,
  navigationUrl,
  routeRaw,
  routeRender,
  waitForSettledPage,
} from '../engine.mjs'

const SANDBOXED = () => ({ ok: true, reason: 'test' })

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
      newPage: async () => ({ close: async () => {} }),
    }
    const engine = new BrowserEngine({
      profileDir: tmp,
      sandboxCheck: SANDBOXED,
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
      sandboxCheck: SANDBOXED,
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

test('navigationUrl adds an empty query to a bare favicon.ico, which Chrome refuses to open', () => {
  assert.equal(
    navigationUrl('https://github.com/favicon.ico'),
    'https://github.com/favicon.ico?'
  )
  assert.equal(
    navigationUrl('https://www.python.org/static/FAVICON.ICO'),
    'https://www.python.org/static/FAVICON.ICO?'
  )
  assert.equal(
    navigationUrl('https://example.com/favicon.ico?v=2'),
    'https://example.com/favicon.ico?v=2'
  )
  assert.equal(
    navigationUrl('https://example.com/favicon.png'),
    'https://example.com/favicon.png'
  )
  assert.equal(navigationUrl('https://example.com/'), 'https://example.com/')
})

test('BrowserEngine reads a bare favicon.ico by its empty-query form', async () => {
  const tmp = tmpProfile()
  try {
    const visited = []
    const icon = Buffer.from([0, 0, 1, 0])
    const page = {
      route: async () => {},
      goto: async url => {
        visited.push(url)
        return {
          body: async () => icon,
          headers: () => ({ 'content-type': 'image/x-icon' }),
          status: () => 200,
        }
      },
      close: async () => {},
      url: () => visited.at(-1),
    }
    const engine = new BrowserEngine({
      profileDir: tmp,
      sandboxCheck: SANDBOXED,
      launcher: async () => ({
        on: () => {},
        close: async () => {},
        newPage: async () => page,
      }),
    })
    const read = await engine.raw('https://github.com/favicon.ico')
    assert.deepEqual(visited, ['https://github.com/favicon.ico?'])
    assert.equal(read.finalUrl, 'https://github.com/favicon.ico')
    assert.deepEqual(read.body, icon)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('cleanProfileDir removes the lock a Chrome that did not shut down left behind', () => {
  const tmp = tmpProfile()
  try {
    // Chrome's lock is a link to "<host>-<pid>" of a container that is gone
    fs.symlinkSync('old-container-22', path.join(tmp, 'SingletonLock'))
    fs.symlinkSync('/tmp/gone/SingletonSocket', path.join(tmp, 'SingletonSocket'))
    fs.symlinkSync('12345', path.join(tmp, 'SingletonCookie'))
    fs.writeFileSync(path.join(tmp, 'Local State'), '{}')
    cleanProfileDir(tmp)
    for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      assert.throws(() => fs.lstatSync(path.join(tmp, name)), { code: 'ENOENT' })
    }
    assert.equal(fs.readFileSync(path.join(tmp, 'Local State'), 'utf8'), '{}')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('cleanProfileDir purges every kind of site storage and keeps cookies and preferences', () => {
  const tmp = tmpProfile()
  try {
    const profile = path.join(tmp, 'Default')
    fs.mkdirSync(profile, { recursive: true })
    fs.writeFileSync(path.join(profile, 'Cookies'), 'cookie')
    fs.writeFileSync(path.join(profile, 'Preferences'), '{}')
    const purged = [
      'Local Storage',
      'Session Storage',
      'File System',
      'WebStorage',
      'Shared Dictionary',
    ]
    for (const name of purged) {
      fs.mkdirSync(path.join(profile, name), { recursive: true })
    }
    fs.mkdirSync(path.join(tmp, 'Crashpad'), { recursive: true })

    assert.deepEqual(cleanProfileDir(tmp), { wiped: false })

    assert.equal(fs.readFileSync(path.join(profile, 'Cookies'), 'utf8'), 'cookie')
    assert.equal(fs.existsSync(path.join(profile, 'Preferences')), true)
    for (const name of purged) {
      assert.equal(fs.existsSync(path.join(profile, name)), false, name)
    }
    assert.equal(fs.existsSync(path.join(tmp, 'Crashpad')), false)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('cleanProfileDir empties a profile still too big after cleaning', () => {
  const tmp = tmpProfile()
  try {
    fs.mkdirSync(path.join(tmp, 'Default'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'Default', 'Cookies'), 'x'.repeat(2048))
    assert.deepEqual(cleanProfileDir(tmp, { maxBytes: 1024 }), { wiped: true })
    assert.deepEqual(fs.readdirSync(tmp), [])
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('capBody cuts a body over the cap and says so', () => {
  assert.equal(MAX_BODY_BYTES, 128 * 1024 * 1024)
  assert.deepEqual(capBody(Buffer.from('abcdef'), 4), {
    body: Buffer.from('abcd'),
    truncated: true,
  })
  assert.deepEqual(capBody(Buffer.from('ab'), 4), {
    body: Buffer.from('ab'),
    truncated: false,
  })
})

/** A fake /proc: `processes` maps pid -> { cmdline, status }. */
function fakeProc(processes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proc-test-'))
  for (const [pid, { cmdline, status }] of Object.entries(processes)) {
    fs.mkdirSync(path.join(root, pid))
    fs.writeFileSync(path.join(root, pid, 'cmdline'), cmdline)
    fs.writeFileSync(path.join(root, pid, 'status'), status)
  }
  fs.mkdirSync(path.join(root, 'self'))
  return root
}

const NODE = {
  cmdline: 'node\0server.mjs\0',
  status: 'Name:\tnode\nSeccomp:\t2\nSeccomp_filters:\t1\nNSpid:\t1\n',
}

test('checkSandbox passes when every renderer has its own PID namespace and seccomp filter', () => {
  const root = fakeProc({
    1: NODE,
    40: {
      cmdline: '/opt/google/chrome/chrome --type=renderer --lang=en-US',
      status: 'Seccomp:\t2\nSeccomp_filters:\t2\nNSpid:\t40\t3\n',
    },
  })
  try {
    const verdict = checkSandbox({ procRoot: root, selfPid: 1 })
    assert.equal(verdict.ok, true, verdict.reason)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('checkSandbox fails without a renderer, without a namespace, or without a filter', () => {
  const cases = {
    'no renderer': { 1: NODE },
    'no namespace': {
      1: NODE,
      40: {
        cmdline: 'chrome\0--type=renderer\0',
        status: 'Seccomp_filters:\t2\nNSpid:\t40\n',
      },
    },
    'no filter of its own': {
      1: NODE,
      40: {
        cmdline: 'chrome\0--type=renderer\0',
        status: 'Seccomp_filters:\t1\nNSpid:\t40\t3\n',
      },
    },
  }
  for (const [name, processes] of Object.entries(cases)) {
    const root = fakeProc(processes)
    try {
      assert.equal(checkSandbox({ procRoot: root, selfPid: 1 }).ok, false, name)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
})

test('BrowserEngine refuses to start, and closes Chrome, when the sandbox is not active', async () => {
  const tmp = tmpProfile()
  try {
    let closed = false
    const context = {
      on: () => {},
      close: async () => {
        closed = true
      },
      newPage: async () => ({ close: async () => {} }),
    }
    const engine = new BrowserEngine({
      profileDir: tmp,
      sandboxCheck: () => ({ ok: false, reason: 'no namespace' }),
      launcher: async () => context,
    })
    await assert.rejects(engine.init(), /sandbox is not active \(no namespace\)/)
    assert.equal(closed, true)
    assert.equal(engine.context, null)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
