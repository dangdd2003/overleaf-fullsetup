import { expect } from 'chai'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import fetchMock from 'fetch-mock'
import GithubSettingsWidget from '../../../../frontend/js/features/github-sync/components/github-settings-widget'

// getMeta caches into window.metaAttributesCache, so it must be cleared
// whenever document.head is rewritten or a stale value leaks between tests.
function setMeta({ enabled = true } = {}) {
  window.metaAttributesCache?.clear()
  document.head.innerHTML =
    '<meta name="ol-csrfToken" content="csrf-token-123">' +
    // boolean metas are true by the presence of `content`, absent = false
    (enabled
      ? '<meta name="ol-githubSyncEnabled" data-type="boolean" content="">'
      : '')
}

describe('GithubSettingsWidget', function () {
  beforeEach(function () {
    fetchMock.removeRoutes().clearHistory()
    setMeta()
  })
  afterEach(function () {
    fetchMock.removeRoutes().clearHistory()
  })

  it('renders nothing and makes no request when the feature is disabled', function () {
    fetchMock.get('/auth/github/status', { linked: true, username: 'octo' })
    setMeta({ enabled: false })
    const { container } = render(<GithubSettingsWidget />)
    expect(container.firstChild).to.equal(null)
    expect(fetchMock.callHistory.called('/auth/github/status')).to.equal(false)
  })

  it('renders the link button when not linked', async function () {
    fetchMock.get('/auth/github/status', { linked: false, username: null })
    render(<GithubSettingsWidget />)
    await waitFor(() => {
      screen.getByRole('link', { name: /link to your github account/i })
    })
    expect(screen.getByRole('link', { name: /link/i }).getAttribute('href')).to.equal(
      '/auth/github/oauth'
    )
  })

  it('shows the linked username and unlinks with CSRF token', async function () {
    fetchMock.get('/auth/github/status', { linked: true, username: 'octocat' })
    fetchMock.post('/auth/github/unlink', { ok: true })
    // avoid reload in jsdom
    const _origLocation = window.location
    // jsdom cannot assign location cleanly; the component guards with try/catch
    render(<GithubSettingsWidget />)
    // the component renders "@{username} — {description}" as one text node,
    // so an exact-string matcher cannot match it
    await screen.findByText(/octocat/)
    fireEvent.click(screen.getByRole('button', { name: /unlink github repository/i }))
    fireEvent.click(
      await screen.findAllByRole('button', { name: /unlink github repository/i }).then(btns => btns[btns.length - 1])
    )
    await waitFor(() => expect(fetchMock.callHistory.called('/auth/github/unlink')).to.equal(true))
    const call = fetchMock.callHistory.lastCall('/auth/github/unlink')
    // fetch-mock normalizes header names to lower case; read them through
    // Headers so the assertion is case-insensitive
    const headers = new Headers(call!.options.headers as HeadersInit)
    expect(headers.get('X-Csrf-Token')).to.equal('csrf-token-123')
  })
})
