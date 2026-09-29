import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { expect } from 'chai'
import sinon from 'sinon'
import fetchMock from 'fetch-mock'
import GitBridgeModal from '@/features/ide-react/components/modals/git-bridge-modal'
import { ProjectContext } from '@/shared/context/project-context'
import { RailProvider } from '@/features/ide-react/context/rail-context'

describe('<GitBridgeModal />', function () {
  const projectId = '60f1b4a9e1b2c3d4e5f6g7h8'
  const mockProjectContextValue: any = {
    projectId,
    project: {
      _id: projectId,
      name: 'Sample Project',
      features: {},
    },
    joinProject: sinon.stub(),
    updateProject: sinon.stub(),
    joinedOnce: true,
    projectSnapshot: {} as any,
    tags: [],
    features: {},
    name: 'Sample Project',
  }

  function renderModal(props = { show: true, onHide: sinon.stub() }) {
    return render(
      <ProjectContext.Provider value={mockProjectContextValue}>
        <RailProvider>
          <GitBridgeModal {...props} />
        </RailProvider>
      </ProjectContext.Provider>
    )
  }

  beforeEach(function () {
    fetchMock.removeRoutes().clearHistory()
    fetchMock.get('/user/personal-access-tokens', [])
  })

  afterEach(function () {
    fetchMock.removeRoutes().clearHistory()
    sinon.restore()
  })

  it('renders modal dialog with data-testid="git-bridge-modal" and title "Clone with Git"', async function () {
    renderModal()

    const modal = screen.getByTestId('git-bridge-modal')
    expect(modal).to.exist
    expect(screen.getByText('Clone with Git')).to.exist
  })

  it('displays the git clone command with project ID and copy button', async function () {
    renderModal()

    const cloneCode = screen.getByText(new RegExp(`git clone .*\/git\/${projectId}`))
    expect(cloneCode).to.exist
    expect(cloneCode.textContent).to.include(`/git/${projectId}`)
    expect(cloneCode.textContent).to.match(/^git clone https?:\/\//)

    const copyBtn = screen.getByRole('button', {
      name: 'Git clone project command',
    })
    expect(copyBtn).to.exist
  })

  it('displays credentials instructions', async function () {
    renderModal()

    expect(screen.getByText('Credentials')).to.exist
    expect(
      screen.getByText(
        'Username is git, password is a Git Personal Access Token'
      )
    ).to.exist
    expect(screen.getByText('git')).to.exist
  })

  it('generates a token when "Generate token" button is clicked', async function () {
    const fakeToken = 'olp_abcdef1234567890abcdef1234567890'
    fetchMock.post('/user/personal-access-tokens', {
      token: fakeToken,
      tokenPrefix: 'olp_abcd',
      name: 'Token for project Sample Project',
    })

    renderModal()

    const generateBtn = screen.getByRole('button', { name: 'Generate token' })
    expect(generateBtn).to.exist

    fireEvent.click(generateBtn)

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

  it('shows link to settings when user already has existing tokens', async function () {
    fetchMock.removeRoutes().clearHistory()
    fetchMock.get('/user/personal-access-tokens', [
      {
        _id: 'token-1',
        name: 'Existing Token',
        tokenPrefix: 'olp_1234',
        createdAt: new Date().toISOString(),
      },
    ])

    renderModal()

    await waitFor(() => {
      const settingsLink = screen.getByRole('link', {
        name: /Go to settings/,
      })
      expect(settingsLink).to.exist
      expect(settingsLink.getAttribute('href')).to.equal('/user/settings')
    })
  })

  it('calls onHide when close button is clicked', async function () {
    const onHideStub = sinon.stub()
    renderModal({ show: true, onHide: onHideStub })

    const closeBtn = screen.getByRole('button', { name: 'Close dialog' })
    fireEvent.click(closeBtn)

    expect(onHideStub).to.have.been.calledOnce
  })
})
