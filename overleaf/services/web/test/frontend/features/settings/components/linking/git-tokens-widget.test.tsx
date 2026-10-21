import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from '@testing-library/react'
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

  it('hides the token permissions section when ol-mcpEnabled is false', async function () {
    window.metaAttributesCache.set('ol-mcpEnabled', false)
    fetchMock.get('/user/personal-access-tokens', [])
    render(<GitTokensWidget />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Generate token' })).to.exist
    })
    expect(screen.queryByLabelText('Git integration')).to.be.null
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
      expect(
        fetchMock.callHistory
          .calls('/user/personal-access-tokens')
          .some(c => c.options?.method?.toUpperCase() === 'POST')
      ).to.be.true
    })
    const post = fetchMock.callHistory
      .calls('/user/personal-access-tokens')
      .find(c => c.options?.method?.toUpperCase() === 'POST')
    const body = JSON.parse((post?.options?.body as string) || '{}')
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
      const tokenPrefix = screen.getByText('olp_1234************')
      const row = tokenPrefix.closest('tr')!
      expect(within(row).getByText('AI assistant (MCP)')).to.exist
    })
  })

  it('shows a token limit message when creating a token is refused with 409', async function () {
    const fullList = Array.from({ length: 20 }, (_, i) => ({
      _id: `token-${i}`,
      name: `Token ${i}`,
      tokenPrefix: `olp_${i}`.padEnd(8, '0'),
      createdAt: '2026-08-24T00:00:00.000Z',
    }))
    fetchMock.get('/user/personal-access-tokens', fullList)
    fetchMock.post('/user/personal-access-tokens', {
      status: 409,
      body: {
        code: 'token_limit_reached',
        message: 'you can have at most 20 active personal access tokens',
      },
    })

    render(<GitTokensWidget />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Add another token' })).to.exist
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add another token' }))

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).to.match(
        /reached the token limit/
      )
    })
    expect(
      screen.queryByText(/You will only see this authentication token once/)
    ).to.be.null
  })

  it('shows a rate limit message when creating a token is refused with 429', async function () {
    fetchMock.get('/user/personal-access-tokens', [])
    fetchMock.post('/user/personal-access-tokens', {
      status: 429,
      body: 'Rate limit reached, please try again later',
    })

    render(<GitTokensWidget />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Generate token' })).to.exist
    })
    fireEvent.click(screen.getByRole('button', { name: 'Generate token' }))

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).to.match(
        /Too many requests/
      )
    })
  })

  it('shows a generic error when the create request fails unexpectedly', async function () {
    fetchMock.get('/user/personal-access-tokens', [])
    fetchMock.post('/user/personal-access-tokens', { status: 500, body: {} })

    render(<GitTokensWidget />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Generate token' })).to.exist
    })
    fireEvent.click(screen.getByRole('button', { name: 'Generate token' }))

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).to.equal(
        'Sorry, something went wrong'
      )
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

    fetchMock.get('/user/personal-access-tokens', [], {
      overwriteRoutes: true,
    } as any)

    const confirmDeleteBtn = screen.getAllByRole('button', {
      name: 'Delete token',
    })
    // In modal, confirm delete button
    fireEvent.click(confirmDeleteBtn[confirmDeleteBtn.length - 1])

    await waitFor(() => {
      expect(
        fetchMock.callHistory.called(
          '/user/personal-access-tokens/token-to-delete'
        )
      ).to.be.true
    })
  })

  it('clears generateError when a token is deleted', async function () {
    const mockTokens = [
      {
        _id: 'token-1',
        name: 'Work Laptop',
        tokenPrefix: 'olp_1234',
        createdAt: '2026-08-24T00:00:00.000Z',
      },
    ]
    fetchMock.get('/user/personal-access-tokens', mockTokens)
    fetchMock.post('/user/personal-access-tokens', {
      status: 409,
      body: {
        code: 'token_limit_reached',
        message: 'you can have at most 20 active personal access tokens',
      },
    })
    fetchMock.delete('/user/personal-access-tokens/token-1', 200)

    render(<GitTokensWidget />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Add another token' })).to.exist
    })

    fireEvent.click(screen.getByRole('button', { name: 'Add another token' }))

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).to.match(
        /reached the token limit/
      )
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

    fetchMock.get('/user/personal-access-tokens', [], {
      overwriteRoutes: true,
    } as any)

    const confirmDeleteBtn = screen.getAllByRole('button', {
      name: 'Delete token',
    })
    fireEvent.click(confirmDeleteBtn[confirmDeleteBtn.length - 1])

    await waitFor(() => {
      expect(screen.queryByRole('alert')).to.be.null
    })
  })
})
