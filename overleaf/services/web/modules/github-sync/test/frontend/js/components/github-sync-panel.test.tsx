import { expect } from 'chai'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import fetchMock from 'fetch-mock'
import GithubSyncPanel from '../../../../frontend/js/features/github-sync/components/github-sync-panel'

// getMeta caches into window.metaAttributesCache, so it must be cleared
// whenever document.head is rewritten or a stale value leaks between tests.
function setMeta({ enabled = true } = {}) {
  window.metaAttributesCache?.clear()
  document.head.innerHTML =
    '<meta name="ol-project_id" content="proj1">' +
    '<meta name="ol-csrfToken" content="csrf-token-123">' +
    // boolean metas are true by the presence of `content`, absent = false
    (enabled
      ? '<meta name="ol-githubSyncEnabled" data-type="boolean" content="">'
      : '')
}

function renderPanel() {
  setMeta()
  return render(<GithubSyncPanel />)
}

describe('GithubSyncPanel', function () {
  beforeEach(function () {
    fetchMock.removeRoutes().clearHistory()
    setMeta()
  })
  afterEach(function () {
    fetchMock.removeRoutes().clearHistory()
  })

  it('renders nothing and makes no request when the feature is disabled', async function () {
    fetchMock.get('/project/proj1/github/status', { linked: true })
    setMeta({ enabled: false })
    const { container } = render(<GithubSyncPanel />)
    expect(container.firstChild).to.equal(null)
    expect(fetchMock.callHistory.called('/project/proj1/github/status')).to.equal(
      false
    )
  })

  it('renders nothing when not linked', async function () {
    fetchMock.get('/project/proj1/github/status', { linked: false })
    const { container } = renderPanel()
    await waitFor(() => expect(fetchMock.callHistory.called('/project/proj1/github/status')).to.equal(true))
    expect(container.firstChild).to.equal(null)
  })

  it('shows repo, incoming count and pull/push buttons when linked', async function () {
    fetchMock.get('/project/proj1/github/status', {
      linked: true,
      repo: { owner: 'octo', name: 'paper' },
      syncState: 'idle',
      outgoing: true,
      incoming: 3,
    })
    renderPanel()
    await screen.findByText('octo/paper')
    screen.getByRole('button', { name: /pull github changes/i })
    screen.getByRole('button', { name: /push .*changes to github/i })
  })

  it('pull posts with the csrf token', async function () {
    fetchMock.get('/project/proj1/github/status', {
      linked: true,
      repo: { owner: 'octo', name: 'paper' },
      syncState: 'idle',
      outgoing: false,
      incoming: 1,
    })
    fetchMock.post('/project/proj1/github/pull', { code: 'ok', sha: 'abc' })
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: /pull github changes/i }))
    await waitFor(() => expect(fetchMock.callHistory.called('/project/proj1/github/pull')).to.equal(true))
    const call = fetchMock.callHistory.lastCall('/project/proj1/github/pull')
    // fetch-mock normalizes header names to lower case; read them through
    // Headers so the assertion is case-insensitive
    const headers = new Headers(call!.options.headers as HeadersInit)
    expect(headers.get('X-Csrf-Token')).to.equal('csrf-token-123')
  })

  it('conflict state shows the continue-merge button', async function () {
    fetchMock.get('/project/proj1/github/status', {
      linked: true,
      repo: { owner: 'octo', name: 'paper' },
      syncState: 'conflict',
      outgoing: false,
      incoming: 0,
      conflictBranch: 'overleaf-sync-2026-08-28-00-00-00',
    })
    renderPanel()
    await screen.findByRole('button', { name: /manually merged/i })
  })
})
