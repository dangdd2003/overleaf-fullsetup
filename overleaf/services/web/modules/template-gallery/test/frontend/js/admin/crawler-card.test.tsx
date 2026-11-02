import { expect } from 'chai'
import i18next from 'i18next'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import fetchMock from 'fetch-mock'
import sinon from 'sinon'
import enTranslations from '../../../../../../locales/en.json'
import { ADMIN_API } from '../../../../frontend/js/api/client'
import CrawlerCard from '../../../../frontend/js/components/admin/monitor/crawler-card'
import type { SyncOverview, SyncRun } from '../../../../frontend/js/api/types'

function overview(overrides: Partial<SyncOverview> = {}): SyncOverview {
  return {
    autoSync: false,
    refetchDays: 7,
    nextAutoRunAt: null,
    listUpdatedAt: null,
    ...overrides,
  }
}

function runningRun(overrides: Partial<SyncRun> = {}): SyncRun {
  return {
    id: 'run-1',
    state: 'running',
    trigger: 'manual',
    rescan: false,
    stopping: false,
    waitingUntil: null,
    waitReason: null,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    phases: [
      { name: 'catalogue', state: 'done', done: 10, failed: 0, total: 10 },
      { name: 'new', state: 'done', done: 3, failed: 0, total: null },
      { name: 'rescan', state: 'skipped', done: 0, failed: 0, total: null },
      { name: 'details', state: 'running', done: 25, failed: 2, total: 100 },
      { name: 'tags', state: 'pending', done: 0, failed: 0, total: null },
    ],
    ...overrides,
  }
}

function renderCard(run: SyncRun | null = null, sync = overview()) {
  const onChanged = sinon.stub()
  const onFlash = sinon.stub()
  render(
    <CrawlerCard
      overview={sync}
      run={run}
      onChanged={onChanged}
      onFlash={onFlash}
    />
  )
  return { onChanged, onFlash }
}

function lastBody() {
  return JSON.parse(fetchMock.callHistory.lastCall()!.options.body as string)
}

describe('crawler card', function () {
  before(function () {
    i18next.addResourceBundle('en', 'translation', enTranslations, true, true)
  })

  beforeEach(function () {
    window.metaAttributesCache.set('ol-csrfToken', 'test-csrf-token')
  })

  afterEach(function () {
    cleanup()
    fetchMock.removeRoutes().clearHistory()
    window.metaAttributesCache.delete('ol-csrfToken')
  })

  it('starts a sync and flashes that it started', async function () {
    fetchMock.post(`${ADMIN_API}/crawler/sync`, {
      status: 202,
      body: { accepted: true, runId: 'run-1' },
    })
    const { onFlash, onChanged } = renderCard()

    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }))

    await waitFor(() => sinon.assert.calledOnce(onChanged))
    sinon.assert.calledWith(onFlash, {
      type: 'success',
      content: 'Sync started.',
    })
    expect(lastBody()).to.deep.equal({ action: 'sync', rescan: false })
  })

  it('asks for a full listing rescan when the option is ticked', async function () {
    fetchMock.post(`${ADMIN_API}/crawler/sync`, {
      status: 202,
      body: { accepted: true, runId: 'run-1' },
    })
    const { onChanged } = renderCard()

    fireEvent.click(screen.getByLabelText('Also rescan the whole listing (slow)'))
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }))

    await waitFor(() => sinon.assert.calledOnce(onChanged))
    expect(lastBody()).to.deep.equal({ action: 'sync', rescan: true })
  })

  it('shows the translated error when a sync is already running', async function () {
    fetchMock.post(`${ADMIN_API}/crawler/sync`, {
      status: 409,
      body: { error: 'run_active' },
    })
    const { onChanged } = renderCard()

    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).to.contain('A sync is already running.')
    sinon.assert.notCalled(onChanged)
  })

  it('says automatic sync is off by default', function () {
    renderCard()
    screen.getByText('Off: only when you click Sync now')
    screen.getByText('Idle')
  })

  it('shows the phases of a running sync, without skipped ones', function () {
    renderCard(runningRun())

    screen.getByText('Running')
    screen.getByText('Template list')
    screen.getByText('Details and PDFs')
    screen.getByText('25 of 100 synced')
    screen.getByText('2 failed in this sync')
    expect(screen.queryByText('Full listing rescan')).to.be.null
    expect(screen.queryByRole('button', { name: 'Sync now' })).to.be.null
  })

  it('stops the running sync', async function () {
    fetchMock.post(`${ADMIN_API}/crawler/sync/stop`, {
      status: 202,
      body: { stopping: true },
    })
    const { onChanged } = renderCard(runningRun())

    fireEvent.click(screen.getByRole('button', { name: 'Stop sync' }))

    await waitFor(() => sinon.assert.calledOnce(onChanged))
    expect(fetchMock.callHistory.called(`${ADMIN_API}/crawler/sync/stop`)).to
      .be.true
  })

  it('disables the stop button while the sync is stopping', function () {
    renderCard(runningRun({ stopping: true }))

    expect(
      (
        screen.getByRole('button', {
          name: 'Stopping after the requests in progress…',
        }) as HTMLButtonElement
      ).disabled
    ).to.be.true
  })
})
