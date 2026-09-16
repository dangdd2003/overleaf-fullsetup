import { expect } from 'chai'
import { render, fireEvent, renderHook, act } from '@testing-library/react'
import { useAiDock } from '../../../../frontend/js/features/ai-assist/hooks/use-ai-dock'
import { AiAssistRightPanel } from '../../../../frontend/js/features/ai-assist/components/agent/ai-assist-right-panel'
import railEntry from '../../../../frontend/js/features/ai-assist/rail-entry'
import RailPanelHeader from '@/features/ide-react/components/rail/rail-panel-header'
import { RailProvider } from '@/features/ide-react/context/rail-context'
import { ProjectContext } from '@/shared/context/project-context'
import { Nav } from 'react-bootstrap'

describe('AI panel docking', function () {
  beforeEach(function () {
    localStorage.clear()
    window.metaAttributesCache = new Map([
      ['ol-aiAssistEnabled', true],
      ['ol-showAiFeatures', true],
    ])
  })

  afterEach(function () {
    localStorage.clear()
    window.metaAttributesCache = new Map()
  })

  describe('useAiDock hook', function () {
    it('defaults to left dock and open right panel', function () {
      const { result } = renderHook(() => useAiDock())
      expect(result.current.dock).to.equal('left')
      expect(result.current.isRightOpen).to.equal(true)
    })

    it('toggles dock between left and right', function () {
      const { result } = renderHook(() => useAiDock())

      act(() => {
        result.current.toggleDock()
      })
      expect(result.current.dock).to.equal('right')
      expect(localStorage.getItem('ai-assist:dock-position')).to.equal('right')

      act(() => {
        result.current.toggleDock()
      })
      expect(result.current.dock).to.equal('left')
      expect(localStorage.getItem('ai-assist:dock-position')).to.equal('left')
    })

    it('toggles isRightOpen', function () {
      const { result } = renderHook(() => useAiDock())

      act(() => {
        result.current.setIsRightOpen(false)
      })
      expect(result.current.isRightOpen).to.equal(false)

      act(() => {
        result.current.toggleRightOpen()
      })
      expect(result.current.isRightOpen).to.equal(true)
    })

    it('ignores storage events for unrelated keys', function () {
      const { result } = renderHook(() => useAiDock())
      const initialDock = result.current.dock

      act(() => {
        window.dispatchEvent(
          new StorageEvent('storage', { key: 'draft:p1', newValue: 'true' })
        )
      })

      expect(result.current.dock).to.equal(initialDock)
    })
  })

  describe('AiAssistRightPanel', function () {
    it('renders null when dock is left', function () {
      localStorage.setItem('ai-assist:dock-position', 'left')
      const { container } = render(<AiAssistRightPanel order={3} />)
      expect(container.firstChild).to.be.null
    })

    it('renders null when right panel is closed', function () {
      localStorage.setItem('ai-assist:dock-position', 'right')
      localStorage.setItem('ai-assist:right-open', 'false')
      const { container } = render(<AiAssistRightPanel order={3} />)
      expect(container.firstChild).to.be.null
    })

    it('renders null when AI feature is disabled', function () {
      window.metaAttributesCache = new Map([['ol-aiAssistEnabled', false]])
      localStorage.setItem('ai-assist:dock-position', 'right')
      const { container } = render(<AiAssistRightPanel order={3} />)
      expect(container.firstChild).to.be.null
    })
  })

  describe('railEntry with docking', function () {
    it('renders null component when docked to right', function () {
      localStorage.setItem('ai-assist:dock-position', 'right')
      const Component = railEntry.component
      const { container } = render(Component!)
      expect(container.firstChild).to.be.null
    })

    it('renders AiRailTab with undefined eventKey when docked to right', function () {
      localStorage.setItem('ai-assist:dock-position', 'right')
      const Tab = railEntry.tab!
      const { container } = render(
        <Nav>
          <Tab icon="smart_toy" title="AI assistant" eventKey="ai-assist" open={false} />
        </Nav>
      )
      const button = container.querySelector('button')
      expect(button).to.exist
      expect(button?.getAttribute('data-rr-ui-event-key')).to.be.null
    })

    it('renders AiRailTab with eventKey when docked to left', function () {
      localStorage.setItem('ai-assist:dock-position', 'left')
      const Tab = railEntry.tab!
      const { container } = render(
        <Nav>
          <Tab icon="smart_toy" title="AI assistant" eventKey="ai-assist" open={false} />
        </Nav>
      )
      const button = container.querySelector('button')
      expect(button).to.exist
      expect(button?.getAttribute('data-rr-ui-event-key')).to.equal('ai-assist')
    })

    it('toggles right open and stops propagation when clicked on right dock', function () {
      localStorage.setItem('ai-assist:dock-position', 'right')
      localStorage.setItem('ai-assist:right-open', 'false')
      const Tab = railEntry.tab!
      let parentClicked = false
      const { container } = render(
        <div role="presentation" onClick={() => { parentClicked = true }}>
          <Tab icon="smart_toy" title="AI assistant" eventKey="ai-assist" open={false} />
        </div>
      )
      const button = container.querySelector('button')
      fireEvent.click(button!)
      expect(localStorage.getItem('ai-assist:right-open')).to.equal('true')
      expect(parentClicked).to.be.false
    })
  })

  describe('RailPanelHeader onClose separation', function () {
    it('calls onClose and does not collapse rail when onClose is provided', function () {
      let customCloseCalled = false
      localStorage.setItem('rail-is-open-test-project', 'true')
      const { getByRole } = render(
        <ProjectContext.Provider value={{ projectId: 'test-project' } as any}>
          <RailProvider>
            <RailPanelHeader
              title="AI assistant"
              onClose={() => {
                customCloseCalled = true
              }}
            />
          </RailProvider>
        </ProjectContext.Provider>
      )
      const closeBtn = getByRole('button', { name: /close/i })
      fireEvent.click(closeBtn)
      expect(customCloseCalled).to.be.true
      expect(localStorage.getItem('rail-is-open-test-project')).to.equal('true')
    })

    it('collapses rail when onClose is not provided', function () {
      localStorage.setItem('rail-is-open-test-project', 'true')
      const { getByRole } = render(
        <ProjectContext.Provider value={{ projectId: 'test-project' } as any}>
          <RailProvider>
            <RailPanelHeader title="Collaborator chat" />
          </RailProvider>
        </ProjectContext.Provider>
      )
      const closeBtn = getByRole('button', { name: /close/i })
      fireEvent.click(closeBtn)
      expect(localStorage.getItem('rail-is-open-test-project')).to.equal('false')
    })
  })
})
