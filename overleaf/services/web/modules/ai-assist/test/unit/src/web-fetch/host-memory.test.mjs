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
    expect(isStepSkipped(host, 'direct')).to.be.false

    recordHostFailure(host, 'direct', 'bot check')
    expect(isStepSkipped(host, 'direct')).to.be.true

    // Other steps for same host are not skipped unless recorded
    expect(isStepSkipped(host, 'browser')).to.be.false

    // 25 hours later
    const future = Date.now() + 25 * 60 * 60 * 1000
    expect(isStepSkipped(host, 'direct', future)).to.be.false
  })

  it('never skips adapters or archives even if recorded', function () {
    const host = 'arxiv.org'
    recordHostFailure(host, 'arxiv', 'timeout')
    recordHostFailure(host, 'wayback', 'timeout')
    recordHostFailure(host, 'archive.today', '404')

    expect(isStepSkipped(host, 'arxiv')).to.be.false
    expect(isStepSkipped(host, 'wayback')).to.be.false
    expect(isStepSkipped(host, 'archive.today')).to.be.false
  })

  it('success clears step failure for host', function () {
    const host = 'flaky.example.com'
    recordHostFailure(host, 'direct', 'HTTP 429')
    expect(isStepSkipped(host, 'direct')).to.be.true

    recordHostSuccess(host, 'direct')
    expect(isStepSkipped(host, 'direct')).to.be.false
  })

  it('caps memory at 1000 hosts with LRU eviction', function () {
    for (let i = 0; i < 1100; i++) {
      recordHostFailure(`host-${i}.example.com`, 'direct', 'HTTP 403')
    }
    // Oldest should have been evicted
    expect(isStepSkipped('host-0.example.com', 'direct')).to.be.false
    // Recent should be present
    expect(isStepSkipped('host-1099.example.com', 'direct')).to.be.true
  })
})
