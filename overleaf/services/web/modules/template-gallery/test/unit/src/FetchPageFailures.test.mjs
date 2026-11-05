import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const egressState = vi.hoisted(() => ({ egresses: [] }))
vi.mock('../../../app/src/egress/EgressSettings.mjs', () => ({
  snapshot: () => ({ egresses: egressState.egresses }),
  ensureLoaded: async () => ({ egresses: egressState.egresses }),
}))

import {
  fetchOverleafPage,
  setFetchOverridesForTests,
} from '../../../app/src/services/mirror/Fetch.mjs'
import {
  getHostStatus,
  resetRateGateForTests,
} from '../../../app/src/transport/RateGate.mjs'

const path = '/latex/templates/example/abcdefghijkl'
const galleryHtml =
  '<title>A template - Overleaf</title><h1>Example</h1><a href="/login">Log in</a>'

function response(html, url = `https://www.overleaf.com${path}`) {
  return { status: 200, body: Buffer.from(html), url }
}

beforeEach(() => {
  resetRateGateForTests()
  egressState.egresses = []
})

afterEach(() => {
  setFetchOverridesForTests(null)
  resetRateGateForTests()
})

describe('gallery HTTP 200 response failures', () => {
  it('moves a browser challenge to another route before parsing the page', async () => {
    egressState.egresses = [{ id: 'first' }, { id: 'second' }]
    const requestRaw = vi.fn(async (_, { egress }) =>
      response(
        egress.id === 'first'
          ? '<title>Just a moment...</title><form id="challenge-form"></form>'
          : galleryHtml
      )
    )
    setFetchOverridesForTests({ requestRaw })
    expect((await fetchOverleafPage(path)).html).toBe(galleryHtml)
    expect(requestRaw).toHaveBeenCalledTimes(2)
    expect(getHostStatus().overleaf.routes).toEqual([
      expect.objectContaining({
        id: 'first',
        failed: 1,
        blockedUntil: expect.any(Date),
      }),
      expect.objectContaining({ id: 'second', ok: 1, blockedUntil: null }),
    ])
  })

  it.each([
    '<title>Verify you are human</title>',
    '<script>window._cf_chl_opt = {}</script>',
    '<script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1"></script>',
  ])('reports a challenge instead of unsupported layout: %s', async html => {
    setFetchOverridesForTests({ requestRaw: async () => response(html) })
    expect(await fetchOverleafPage(path).catch(err => err)).toMatchObject({
      code: 'upstream_challenge',
      status: 403,
      hostThrottled: true,
    })
  })

  it('identifies a login redirect without blocking the route', async () => {
    setFetchOverridesForTests({
      requestRaw: async () =>
        response('<h1>Login</h1>', 'https://www.overleaf.com/login'),
    })
    expect(await fetchOverleafPage(path).catch(err => err)).toMatchObject({
      code: 'upstream_login',
      status: 401,
    })
    expect(getHostStatus().overleaf.routes[0].blockedUntil).toBeNull()
  })

  it('identifies a login form without treating normal navigation as login', async () => {
    setFetchOverridesForTests({
      requestRaw: async () =>
        response(
          '<h1>Log in</h1><form action="/login"><input type="password"></form>'
        ),
    })
    expect(await fetchOverleafPage(path).catch(err => err)).toMatchObject({
      code: 'upstream_login',
    })
  })

  it('identifies an error page returned with a successful HTTP status', async () => {
    setFetchOverridesForTests({
      requestRaw: async () => response('<title>Internal Server Error</title>'),
    })
    expect(await fetchOverleafPage(path).catch(err => err)).toMatchObject({
      code: 'upstream_error_page',
      status: 500,
    })
  })

  it('does not mistake words in a template abstract or source for a challenge', async () => {
    const html = `${galleryHtml}<p>Verify you are human. Access denied. Internal server error.</p><pre>window._cf_chl_opt = {}</pre><footer><h1>Something went wrong.</h1><div data-sitekey="recaptcha-key"></div><form action="/login"><input type="password"></form></footer>`
    setFetchOverridesForTests({ requestRaw: async () => response(html) })
    expect((await fetchOverleafPage(path)).html).toBe(html)
  })
})
