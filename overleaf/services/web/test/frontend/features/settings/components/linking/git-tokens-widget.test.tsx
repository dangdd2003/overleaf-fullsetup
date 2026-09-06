import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { expect } from 'chai'
import sinon from 'sinon'
import fetchMock from 'fetch-mock'
import { GitTokensWidget } from '@/features/settings/components/linking/git-tokens-widget'

describe('<GitTokensWidget />', function () {
  beforeEach(function () {
    fetchMock.removeRoutes().clearHistory()
  })

  afterEach(function () {
    fetchMock.removeRoutes().clearHistory()
    sinon.restore()
  })

  it('renders section heading "Git integration" and empty state generate button', async function () {
    fetchMock.get('/user/personal-access-tokens', [])
    render(<GitTokensWidget />)

    expect(screen.getByText('Git integration')).to.exist
    expect(
      screen.getByText(
        /With Git integration, you can clone your Overleaf projects with Git/
      )
    ).to.exist

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Generate token' })).to.exist
    })
  })

  it('renders table of active tokens with masked prefix, created date, last used date, and delete button', async function () {
    const mockTokens = [
      {
        _id: 'token-1',
        name: 'Work Laptop',
        tokenPrefix: 'olp_1234',
        createdAt: '2026-08-24T00:00:00.000Z',
        lastUsedAt: '2026-08-24T01:00:00.000Z',
      },
      {
        _id: 'token-2',
        name: 'CI Server',
        tokenPrefix: 'olp_5678',
        createdAt: '2026-08-20T00:00:00.000Z',
      },
    ]
    fetchMock.get('/user/personal-access-tokens', mockTokens)

    render(<GitTokensWidget />)

    await waitFor(() => {
      expect(screen.getByText('olp_1234************')).to.exist
      expect(screen.getByText('olp_5678************')).to.exist
      expect(screen.getByText('N/A')).to.exist
    })

    const addAnotherBtn = screen.getByRole('button', {
      name: 'Add another token',
    })
    expect(addAnotherBtn).to.exist

    const deleteButtons = screen.getAllByRole('button', {
      name: 'Remove',
    })
    expect(deleteButtons).to.have.length(2)
  })

  it('generates a new token and shows the warning modal', async function () {
    fetchMock.get('/user/personal-access-tokens', [])
    const fakeToken = 'olp_newtoken1234567890123456789012'
    fetchMock.post('/user/personal-access-tokens', {
      token: fakeToken,
      tokenPrefix: 'olp_newt',
      name: 'Git Token',
    })

    render(<GitTokensWidget />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Generate token' })).to.exist
    })

    fireEvent.click(screen.getByRole('button', { name: 'Generate token' }))

    await waitFor(() => {
      expect(
        screen.getByText(
          /You will only see this authentication token once so please copy it and keep it safe/
        )
      ).to.exist
    })

    const tokenCode = screen.getByText(fakeToken)
    expect(tokenCode).to.exist
    expect(tokenCode.textContent).to.equal(fakeToken)
  })

  it('shows the Git integration scope checkbox but hides the MCP checkbox when ol-mcpEnabled is false', async function () {
    window.metaAttributesCache.set('ol-mcpEnabled', false)
    fetchMock.get('/user/personal-access-tokens', [])
    render(<GitTokensWidget />)

    await waitFor(() => {
      expect(screen.getByLabelText('Git integration')).to.exist
    })
    expect(screen.queryByLabelText('AI assistant (MCP)')).to.be.null
  })

  it('submits the selected scopes when generating a token', async function () {
    window.metaAttributesCache.set('ol-mcpEnabled', true)
    fetchMock.get('/user/personal-access-tokens', [])
    fetchMock.post('/user/personal-access-tokens', {
      token: 'olp_x',
      tokenPrefix: 'olp_x',
      name: 'Git Token',
      scopes: ['git_bridge', 'mcp'],
    })

    render(<GitTokensWidget />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Generate token' })).to.exist
    })

    fireEvent.click(screen.getByLabelText('AI assistant (MCP)'))
    fireEvent.click(screen.getByRole('button', { name: 'Generate token' }))

    await waitFor(() => {
      expect(fetchMock.called('/user/personal-access-tokens', { method: 'POST' }))
        .to.be.true
    })
    const call = fetchMock.callHistory
      ? fetchMock.callHistory.calls('/user/personal-access-tokens')
      : []
    const body = JSON.parse(
      (call[call.length - 1]?.options?.body as string) || '{}'
    )
    expect(body.scopes).to.deep.equal(['git_bridge', 'mcp'])
  })

  it('renders scope badges in the token list', async function () {
    window.metaAttributesCache.set('ol-mcpEnabled', true)
    fetchMock.get('/user/personal-access-tokens', [
      {
        _id: 'token-1',
        name: 'AI',
        tokenPrefix: 'olp_1234',
        createdAt: '2026-08-24T00:00:00.000Z',
        scopes: ['mcp'],
      },
    ])

    render(<GitTokensWidget />)

    await waitFor(() => {
      const tokenPrefix = screen.getByText('olp_1234')
      const row = tokenPrefix.closest('tr')!
      expect(within(row).getByText('AI assistant (MCP)')).to.exist
    })
  })

  it('deletes a token when confirmed in delete modal', async function () {
    const mockTokens = [
      {
        _id: 'token-to-delete',
        name: 'Work Laptop',
        tokenPrefix: 'olp_del1',
        createdAt: '2026-08-24T00:00:00.000Z',
      },
    ]
    fetchMock.get('/user/personal-access-tokens', mockTokens)
    fetchMock.delete('/user/personal-access-tokens/token-to-delete', 200)

    render(<GitTokensWidget />)

    await waitFor(() => {
      expect(screen.getByText('olp_del1************')).to.exist
    })

    const deleteBtn = screen.getByRole('button', { name: 'Remove' })
    fireEvent.click(deleteBtn)

    await waitFor(() => {
      expect(
        screen.getByText(
          'Are you sure you want to delete this Git token? Any Git repositories configured with this token will lose access.'
        )
      ).to.exist
    })

    fetchMock.get(
      '/user/personal-access-tokens',
      [],
      { overwriteRoutes: true }
    )

    const confirmDeleteBtn = screen.getAllByRole('button', {
      name: 'Delete token',
    })
    // In modal, confirm delete button
    fireEvent.click(confirmDeleteBtn[confirmDeleteBtn.length - 1])

    await waitFor(() => {
      expect(
        fetchMock.called('/user/personal-access-tokens/token-to-delete')
      ).to.be.true
    })
  })
})
