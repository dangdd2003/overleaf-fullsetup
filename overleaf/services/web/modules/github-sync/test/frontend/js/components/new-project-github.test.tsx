import { expect } from 'chai'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import fetchMock from 'fetch-mock'
import NewProjectGithubMenu from '../../../../frontend/js/features/github-sync/components/new-project-github-menu'
import NewProjectGithubModalWrapper from '../../../../frontend/js/features/github-sync/components/new-project-github-modal-wrapper'

describe('NewProjectGithub', function () {
  beforeEach(function () {
    if (typeof window !== 'undefined' && (window as any).metaAttributesCache) {
      ;(window as any).metaAttributesCache.clear()
    }
    document.head.innerHTML =
      '<meta name="ol-csrfToken" content="csrf-token-123">' +
      // boolean metas are true by the presence of `content`, absent = false
      '<meta name="ol-githubSyncEnabled" data-type="boolean" content="">'
    fetchMock.removeRoutes().clearHistory()
  })

  function disableFeature() {
    ;(window as any).metaAttributesCache?.clear()
    document.head.innerHTML =
      '<meta name="ol-csrfToken" content="csrf-token-123">'
  }
  afterEach(function () {
    fetchMock.removeRoutes().clearHistory()
  })

  it('renders neither menu nor modal when the feature is disabled', function () {
    disableFeature()
    const menu = render(<NewProjectGithubMenu onClick={() => {}} />)
    expect(menu.container.firstChild).to.equal(null)
    const modal = render(<NewProjectGithubModalWrapper onHide={() => {}} />)
    expect(modal.container.firstChild).to.equal(null)
  })

  it('renders the menu item and invokes onClick', function () {
    let clicked = false
    render(<NewProjectGithubMenu onClick={() => { clicked = true }} />)
    fireEvent.click(screen.getByText(/github/i))
    expect(clicked).to.equal(true)
  })

  it('lists repos and imports the selected one', async function () {
    fetchMock.get('/auth/github/repos', {
      repos: [
        { name: 'paper', owner: { login: 'octo' }, private: false, default_branch: 'main', empty: false },
      ],
    })
    fetchMock.post('/auth/github/import', { projectId: 'newproj', warnings: [] })
    render(<NewProjectGithubModalWrapper onHide={() => {}} />)
    const option = await screen.findByText(/octo\/paper/)
    fireEvent.click(option)
    fireEvent.click(await screen.findByRole('button', { name: /^import$/i }))
    await waitFor(() => expect(fetchMock.callHistory.called('/auth/github/import')).to.equal(true))
    const call = fetchMock.callHistory.lastCall('/auth/github/import')
    expect(JSON.parse(call!.options.body as string)).to.deep.include({
      repoOwner: 'octo',
      repoName: 'paper',
    })
  })
})
