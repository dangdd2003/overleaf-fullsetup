import { render, screen, fireEvent } from '@testing-library/react'
import { expect } from 'chai'
import sinon from 'sinon'
import IntegrationsPanel from '@/features/integrations-panel/integrations-panel'
import { RailProvider } from '@/features/ide-react/context/rail-context'
import { ProjectContext } from '@/shared/context/project-context'

describe('<IntegrationsPanel />', function () {
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

  function renderPanel() {
    return render(
      <ProjectContext.Provider value={mockProjectContextValue}>
        <RailProvider>
          <IntegrationsPanel />
        </RailProvider>
      </ProjectContext.Provider>
    )
  }

  beforeEach(function () {
    window.metaAttributesCache.set('ol-gitBridgeEnabled', true)
    window.metaAttributesCache.set('ol-googleDriveSyncEnabled', true)
  })

  afterEach(function () {
    window.metaAttributesCache.delete('ol-gitBridgeEnabled')
    window.metaAttributesCache.delete('ol-googleDriveSyncEnabled')
    sinon.restore()
  })

  it('renders Integrations header and Git card when gitBridgeEnabled is true', function () {
    renderPanel()

    expect(screen.getByText('Integrations')).to.exist
    expect(screen.getByText('Git')).to.exist
    expect(screen.getByText('Git clone this project.')).to.exist
    expect(screen.getByTestId('git-integration-card')).to.exist
  })

  it('renders Google Drive card when googleDriveSyncEnabled is true', function () {
    renderPanel()

    expect(screen.getByText('Integrations')).to.exist
    expect(screen.getByText('Google Drive')).to.exist
    expect(screen.getByText('Synchronize with Google Drive')).to.exist
    expect(screen.getByTestId('google-drive-integration-card')).to.exist
  })

  it('does not render Git card when gitBridgeEnabled is false', function () {
    window.metaAttributesCache.set('ol-gitBridgeEnabled', false)
    renderPanel()

    expect(screen.queryByText('Git')).to.not.exist
    expect(screen.queryByText('Git clone this project.')).to.not.exist
    expect(screen.queryByTestId('git-integration-card')).to.not.exist
  })

  it('does not render Google Drive card when googleDriveSyncEnabled is false', function () {
    window.metaAttributesCache.set('ol-googleDriveSyncEnabled', false)
    renderPanel()

    expect(screen.queryByText('Google Drive')).to.not.exist
    expect(screen.queryByText('Synchronize with Google Drive')).to.not.exist
    expect(screen.queryByTestId('google-drive-integration-card')).to.not.exist
  })

  it('opens Git Bridge modal on clicking Git card', function () {
    renderPanel()

    const gitCard = screen.getByTestId('git-integration-card')
    fireEvent.click(gitCard)
  })

  it('opens Google Drive modal on clicking Google Drive card', function () {
    renderPanel()

    const googleDriveCard = screen.getByTestId('google-drive-integration-card')
    fireEvent.click(googleDriveCard)
  })
})
