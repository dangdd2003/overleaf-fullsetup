import { render, screen, fireEvent, waitFor } from '@testing-library/react'
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
        'Manage authentication tokens used for cloning and pushing via Git.'
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
