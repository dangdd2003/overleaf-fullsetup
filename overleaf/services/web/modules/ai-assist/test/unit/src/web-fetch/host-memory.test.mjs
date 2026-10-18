import { describe, it, beforeEach } from 'vitest'
import { expect } from 'chai'
import {
  recordHostFailure,
  recordHostSuccess,
  isStepSkipped,
  clearHostMemory,
} from '../../../../app/src/web-fetch/host-memory.mjs'

describe('host-memory', function () {
  beforeEach(function () {
    clearHostMemory()
  })

  it('remembers failure for a step and skips it for 24h', function () {
    const host = 'blocked.example.com'
    expect(isStepSkipped('u1', host, 'direct')).to.be.false

    recordHostFailure('u1', host, 'direct', 'bot check')
    expect(isStepSkipped('u1', host, 'direct')).to.be.true

    // Other steps for same host are not skipped unless recorded
    expect(isStepSkipped('u1', host, 'browser')).to.be.false

    // 25 hours later
    const future = Date.now() + 25 * 60 * 60 * 1000
    expect(isStepSkipped('u1', host, 'direct', future)).to.be.false
  })

  it('never skips adapters or archives even if recorded', function () {
    const host = 'arxiv.org'
    recordHostFailure('u1', host, 'arxiv', 'timeout')
    recordHostFailure('u1', host, 'wayback', 'timeout')
    recordHostFailure('u1', host, 'archive.today', '404')

    expect(isStepSkipped('u1', host, 'arxiv')).to.be.false
    expect(isStepSkipped('u1', host, 'wayback')).to.be.false
    expect(isStepSkipped('u1', host, 'archive.today')).to.be.false
  })

  it('success clears step failure for host', function () {
    const host = 'flaky.example.com'
    recordHostFailure('u1', host, 'direct', 'HTTP 429')
    expect(isStepSkipped('u1', host, 'direct')).to.be.true

    recordHostSuccess('u1', host, 'direct')
    expect(isStepSkipped('u1', host, 'direct')).to.be.false
  })

  it('caps memory at 1000 hosts with LRU eviction', function () {
    for (let i = 0; i < 1100; i++) {
      recordHostFailure('u1', `host-${i}.example.com`, 'direct', 'HTTP 403')
    }
    // Oldest should have been evicted
    expect(isStepSkipped('u1', 'host-0.example.com', 'direct')).to.be.false
    // Recent should be present
    expect(isStepSkipped('u1', 'host-1099.example.com', 'direct')).to.be.true
  })

  it('keeps a blocked host per owner, so one user does not skip it for another', function () {
    recordHostFailure('u1', 'example.com', 'direct', 'HTTP 403')
    expect(isStepSkipped('u1', 'example.com', 'direct')).to.be.true
    expect(isStepSkipped('u2', 'example.com', 'direct')).to.be.false
  })
})
