import { describe, it, beforeEach } from 'vitest'
import { expect } from 'chai'
import sinon from 'sinon'
import {
  WebRouter,
  endpointHealthKey,
  classifyFailure,
  parseRetryAfter,
  clearEndpointHealth,
  SEARCH_CAPABLE,
  READ_CAPABLE,
} from '../../../../app/src/web-fetch/routing.mjs'

describe('routing.mjs', function () {
  beforeEach(function () {
    clearEndpointHealth()
  })

  describe('capabilities', function () {
    it('defines search and read capabilities', function () {
      expect(SEARCH_CAPABLE.has('searxng')).to.be.true
      expect(SEARCH_CAPABLE.has('ollama')).to.be.true
      expect(SEARCH_CAPABLE.has('websearchapi')).to.be.true
      expect(SEARCH_CAPABLE.has('langsearch')).to.be.true
      expect(READ_CAPABLE.has('ollama')).to.be.true
      expect(READ_CAPABLE.has('websearchapi')).to.be.true
      expect(READ_CAPABLE.has('searxng')).to.be.false
      expect(READ_CAPABLE.has('langsearch')).to.be.false
    })
  })

  describe('endpointHealthKey', function () {
    it('generates identical health keys for identical credentials and distinct for different ones', function () {
      const e1 = { provider: 'ollama', apiKey: 'secret-1', id: 'ollama:0' }
      const e2 = { provider: 'ollama', apiKey: 'secret-1', id: 'ollama:5' }
      const e3 = { provider: 'ollama', apiKey: 'secret-2', id: 'ollama:0' }
      const s1 = {
        provider: 'searxng',
        baseUrl: 'http://searx:8080',
        id: 'searxng:0',
      }
      const s2 = {
        provider: 'searxng',
        baseUrl: 'http://searx:8080/',
        id: 'searxng:1',
      }

      expect(endpointHealthKey(e1)).to.equal(endpointHealthKey(e2))
      expect(endpointHealthKey(e1)).to.not.equal(endpointHealthKey(e3))
      expect(endpointHealthKey(s1)).to.equal(endpointHealthKey(s2))
    })
  })

  describe('parseRetryAfter', function () {
    it('parses seconds integer correctly', function () {
      expect(parseRetryAfter('120')).to.equal(120_000)
      expect(parseRetryAfter(45)).to.equal(45_000)
    })

    it('caps retry-after at 10 minutes (600,000 ms)', function () {
      expect(parseRetryAfter('99999')).to.equal(600_000)
    })

    it('parses HTTP date string correctly', function () {
      const now = Date.parse('2026-09-26T12:00:00Z')
      const target = 'Sat, 26 Sep 2026 12:02:30 GMT'
      expect(parseRetryAfter(target, now)).to.equal(150_000)
    })

    it('returns null for missing or invalid values', function () {
      expect(parseRetryAfter(undefined)).to.be.null
      expect(parseRetryAfter('')).to.be.null
      expect(parseRetryAfter('invalid-date')).to.be.null
    })
  })

  describe('classifyFailure', function () {
    it('classifies aborted errors', function () {
      const err = new Error('aborted')
      err.code = 'aborted'
      const res = classifyFailure(err)
      expect(res.class).to.equal('aborted')
      expect(res.pauseMs).to.equal(0)
    })

    it('classifies key errors (401, 402, 403) with 10 min pause and no provider skip', function () {
      for (const status of [401, 402, 403]) {
        const err = { status }
        const res = classifyFailure(err)
        expect(res.class).to.equal('key')
        expect(res.pauseMs).to.equal(600_000)
        expect(res.skipProvider).to.be.false
      }
    })

    it('classifies rate limit errors (429) with Retry-After or backoff', function () {
      const errWithHeader = { status: 429, headers: { 'retry-after': '30' } }
      const res1 = classifyFailure(errWithHeader)
      expect(res1.class).to.equal('rate')
      expect(res1.pauseMs).to.equal(30_000)
      expect(res1.skipProvider).to.be.false

      const errWithoutHeader = { status: 429 }
      const res2 = classifyFailure(errWithoutHeader, { consecutiveErrors: 1 })
      expect(res2.class).to.equal('rate')
      expect(res2.pauseMs).to.equal(15_000)
    })

    it('classifies provider errors (>=500 or network) with exponential backoff and provider skip', function () {
      const err500 = { status: 502 }
      const res1 = classifyFailure(err500, { consecutiveErrors: 1 })
      expect(res1.class).to.equal('provider')
      expect(res1.pauseMs).to.equal(15_000)
      expect(res1.skipProvider).to.be.true

      const res2 = classifyFailure(err500, { consecutiveErrors: 2 })
      expect(res2.pauseMs).to.equal(30_000)

      const res3 = classifyFailure(err500, { consecutiveErrors: 3 })
      expect(res3.pauseMs).to.equal(60_000)

      const netErr = { kind: 'network', message: 'ECONNREFUSED' }
      const resNet = classifyFailure(netErr, { consecutiveErrors: 1 })
      expect(resNet.class).to.equal('provider')
      expect(resNet.skipProvider).to.be.true
    })

    it('classifies content errors with 0 pause and no provider skip', function () {
      const err = { message: 'too little text', kind: 'thin' }
      const res = classifyFailure(err)
      expect(res.class).to.equal('content')
      expect(res.pauseMs).to.equal(0)
      expect(res.skipProvider).to.be.false
    })
  })

  describe('WebRouter planning & state', function () {
    const settings = {
      providers: {
        searxng: {
          enabled: true,
          baseUrls: ['http://searx-1:8080', 'http://searx-2:8080'],
        },
        ollama: { enabled: true, apiKeys: ['ok1', 'ok2'] },
        websearchapi: { enabled: true, apiKeys: ['wk1'] },
      },
      rotationStrategy: 'round-robin',
      primaryProvider: 'searxng',
    }

    it('filters capabilities: search includes searxng, read excludes searxng', function () {
      const router = new WebRouter(settings, { cacheOwner: 'user-a' })
      const searchPlan = router.plan('search')
      const searchProviders = searchPlan.map(p => p.provider)
      expect(searchProviders).to.deep.equal([
        'searxng',
        'ollama',
        'websearchapi',
      ])

      const readPlan = router.plan('read')
      const readProviders = readPlan.map(p => p.provider)
      expect(readProviders).to.deep.equal(['ollama', 'websearchapi'])
    })

    it('rotates starting provider round-robin per owner across runs', function () {
      const r1 = new WebRouter(settings, { cacheOwner: 'user-rr' })
      const plan1 = r1.plan('search')
      expect(plan1[0].provider).to.equal('searxng')
      r1.success(plan1[0].endpoints[0], 'search')

      const r2 = new WebRouter(settings, { cacheOwner: 'user-rr' })
      const plan2 = r2.plan('search')
      expect(plan2[0].provider).to.equal('ollama')
      r2.success(plan2[0].endpoints[0], 'search')

      const r3 = new WebRouter(settings, { cacheOwner: 'user-rr' })
      const plan3 = r3.plan('search')
      expect(plan3[0].provider).to.equal('websearchapi')
    })

    it('supports provider-priority starting with primaryProvider', function () {
      const prioSettings = {
        ...settings,
        rotationStrategy: 'provider-priority',
        primaryProvider: 'ollama',
      }
      const router = new WebRouter(prioSettings, { cacheOwner: 'user-prio' })
      const plan = router.plan('search')
      expect(plan[0].provider).to.equal('ollama')
    })

    it('supports sticky strategy staying with last successful provider', function () {
      const stickySettings = { ...settings, rotationStrategy: 'sticky' }
      const r1 = new WebRouter(stickySettings, { cacheOwner: 'user-sticky' })
      const plan1 = r1.plan('search')
      expect(plan1[0].provider).to.equal('searxng')
      // Ollama succeeded
      r1.success(plan1[1].endpoints[0], 'search')

      const r2 = new WebRouter(stickySettings, { cacheOwner: 'user-sticky' })
      const plan2 = r2.plan('search')
      expect(plan2[0].provider).to.equal('ollama')
    })

    it('moves fully-paused providers to the end of the plan', function () {
      const router = new WebRouter(settings, { cacheOwner: 'user-pause' })
      const planBefore = router.plan('search')
      // Pause both searxng endpoints
      router.failure(planBefore[0].endpoints[0], { status: 500 })
      router.failure(planBefore[0].endpoints[1], { status: 500 })

      const planAfter = router.plan('search')
      const providers = planAfter.map(p => p.provider)
      expect(providers[providers.length - 1]).to.equal('searxng')
    })

    it('rotates keys within a provider round-robin and moves paused keys to end', function () {
      const router = new WebRouter(settings, { cacheOwner: 'user-keys' })
      const plan1 = router.plan('read')
      const ollamaEndpoints = plan1.find(p => p.provider === 'ollama').endpoints
      expect(ollamaEndpoints[0].apiKey).to.equal('ok1')

      // Pause ok1 with a key error (401)
      router.failure(ollamaEndpoints[0], { status: 401 })

      const plan2 = router.plan('read')
      const ollamaEndpoints2 = plan2.find(
        p => p.provider === 'ollama'
      ).endpoints
      expect(ollamaEndpoints2[0].apiKey).to.equal('ok2')
      expect(ollamaEndpoints2[1].apiKey).to.equal('ok1')
    })
  })
})
