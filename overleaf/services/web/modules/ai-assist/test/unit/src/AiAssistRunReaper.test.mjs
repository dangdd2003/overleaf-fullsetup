import { expect } from 'chai'
import sinon from 'sinon'
import Settings from '@overleaf/settings'
import '../../../app/src/ModuleSettings.mjs'
import { AiAssistRunReaper } from '../../../app/src/AiAssistRunReaper.mjs'

describe('AiAssistRunReaper', function () {
  let mockStore
  let mockControl
  let reaper
  let origGrace
  let origHeartbeat

  beforeEach(function () {
    origGrace = Settings.aiAssist?.orphanGraceSeconds
    origHeartbeat = Settings.aiAssist?.heartbeatStaleSeconds
    if (Settings.aiAssist) {
      Settings.aiAssist.orphanGraceSeconds = 300
      Settings.aiAssist.heartbeatStaleSeconds = 1800
    }

    mockStore = {
      getActiveRuns: sinon.stub().resolves([]),
      getRun: sinon.stub().resolves(null),
      setZeroSince: sinon.stub().resolves(),
      clearZeroSince: sinon.stub().resolves(),
      reconcileStaleRuns: sinon.stub().resolves([]),
    }

    mockControl = {
      publish: sinon.stub().resolves(),
    }

    reaper = new AiAssistRunReaper({
      store: mockStore,
      control: mockControl,
    })
  })

  afterEach(function () {
    if (Settings.aiAssist) {
      Settings.aiAssist.orphanGraceSeconds = origGrace
      Settings.aiAssist.heartbeatStaleSeconds = origHeartbeat
    }
  })

  it('cancels run with 0 watchers and zeroSince older than grace period', async function () {
    mockStore.getActiveRuns.resolves(['run-abandoned'])
    const oldZeroSince = Date.now() - 400_000 // 400s ago (> 300s grace)
    const runData = {
      runId: 'run-abandoned',
      status: 'running',
      watchers: 0,
      zeroSince: oldZeroSince,
    }
    mockStore.getRun.withArgs('run-abandoned').resolves(runData)

    const cancelled = await reaper.sweepOnce()

    expect(mockControl.publish.calledWith('run-abandoned', { action: 'stop' })).to.be.true
    expect(cancelled).to.deep.equal(['run-abandoned'])
    expect(mockStore.reconcileStaleRuns.calledOnce).to.be.true
  })

  it('leaves run with 0 watchers alone when zeroSince is within grace period', async function () {
    mockStore.getActiveRuns.resolves(['run-fresh-zero'])
    const recentZeroSince = Date.now() - 60_000 // 60s ago (< 300s grace)
    mockStore.getRun.withArgs('run-fresh-zero').resolves({
      runId: 'run-fresh-zero',
      status: 'running',
      watchers: 0,
      zeroSince: recentZeroSince,
    })

    const cancelled = await reaper.sweepOnce()

    expect(mockControl.publish.called).to.be.false
    expect(cancelled).to.be.empty
  })

  it('stamps zeroSince on first observation of 0 watchers without cancelling', async function () {
    mockStore.getActiveRuns.resolves(['run-first-zero'])
    mockStore.getRun.withArgs('run-first-zero').resolves({
      runId: 'run-first-zero',
      status: 'running',
      watchers: 0,
      zeroSince: 0,
    })

    const cancelled = await reaper.sweepOnce()

    expect(mockControl.publish.called).to.be.false
    expect(mockStore.setZeroSince.calledWith('run-first-zero', sinon.match.number)).to.be.true
    expect(cancelled).to.be.empty
  })

  it('clears zeroSince on run with active watchers', async function () {
    mockStore.getActiveRuns.resolves(['run-watched'])
    mockStore.getRun.withArgs('run-watched').resolves({
      runId: 'run-watched',
      status: 'running',
      watchers: 2,
      zeroSince: Date.now() - 500_000,
    })

    const cancelled = await reaper.sweepOnce()

    expect(mockStore.clearZeroSince.calledWith('run-watched')).to.be.true
    expect(mockControl.publish.called).to.be.false
    expect(cancelled).to.be.empty
  })

  it('does nothing when orphanGraceSeconds is 0 (reaping disabled escape hatch)', async function () {
    Settings.aiAssist.orphanGraceSeconds = 0
    mockStore.getActiveRuns.resolves(['run-1'])
    mockStore.getRun.withArgs('run-1').resolves({
      runId: 'run-1',
      status: 'running',
      watchers: 0,
      zeroSince: Date.now() - 600_000,
    })

    const cancelled = await reaper.sweepOnce()

    expect(mockControl.publish.called).to.be.false
    expect(mockStore.getActiveRuns.called).to.be.false
    expect(cancelled).to.be.empty
  })

  it('re-reads watchers immediately before aborting and skips if watcher reconnected', async function () {
    mockStore.getActiveRuns.resolves(['run-reconnect'])
    const staleRun = {
      runId: 'run-reconnect',
      status: 'running',
      watchers: 0,
      zeroSince: Date.now() - 400_000,
    }
    const freshReconnectedRun = {
      runId: 'run-reconnect',
      status: 'running',
      watchers: 1, // Watcher reconnected!
      zeroSince: '',
    }

    mockStore.getRun
      .onFirstCall().resolves(staleRun)
      .onSecondCall().resolves(freshReconnectedRun)

    const cancelled = await reaper.sweepOnce()

    expect(mockControl.publish.called).to.be.false
    expect(cancelled).to.be.empty
  })
})
