import { render, screen } from '@testing-library/react'
import { expect } from 'chai'
import sinon from 'sinon'
import { RailProvider } from '@/features/ide-react/context/rail-context'
import { ProjectContext } from '@/shared/context/project-context'
import { OLDropdown } from '@/shared/components/ol/ol-dropdown-menu'
import RailHelpDropdown from '@/features/ide-react/components/rail/rail-help-dropdown'

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

function setMeta({ apiDocsEnabled = false } = {}) {
  window.metaAttributesCache?.clear()
  document.head.innerHTML =
    '<meta name="ol-csrfToken" content="csrf-token-123">' +
    // boolean metas are true by the presence of `content`, absent = false
    (apiDocsEnabled
      ? '<meta name="ol-apiDocsEnabled" data-type="boolean" content="">'
      : '')
}

function renderDropdown() {
  return render(
    <ProjectContext.Provider value={mockProjectContextValue}>
      <RailProvider>
        <OLDropdown show>
          <RailHelpDropdown />
        </OLDropdown>
      </RailProvider>
    </ProjectContext.Provider>
  )
}

describe('RailHelpDropdown', function () {
  afterEach(function () {
    window.metaAttributesCache?.clear()
  })

  it('shows the API documentation link when ol-apiDocsEnabled is true', function () {
    setMeta({ apiDocsEnabled: true })
    renderDropdown()
    expect(screen.getByText('API documentation')).to.exist
  })

  it('hides the API documentation link when ol-apiDocsEnabled is false', function () {
    setMeta({ apiDocsEnabled: false })
    renderDropdown()
    expect(screen.queryByText('API documentation')).to.be.null
  })
})
