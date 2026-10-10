import { expect } from 'chai'
import { render, fireEvent, renderHook, act } from '@testing-library/react'
import { useAiDock } from '../../../../frontend/js/features/ai-assist/hooks/use-ai-dock'
import { AiAssistRightPanel } from '../../../../frontend/js/features/ai-assist/components/agent/ai-assist-right-panel'
import railEntry from '../../../../frontend/js/features/ai-assist/rail-entry'
import AgentPanelHeader from '../../../../frontend/js/features/ai-assist/components/agent/agent-panel-header'
import { RailProvider } from '@/features/ide-react/context/rail-context'
import { ProjectContext } from '@/shared/context/project-context'
import { Nav } from 'react-bootstrap'
import { PanelGroup } from 'react-resizable-panels'

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

    it('renders panel and resize handle when docked to right', function () {
      localStorage.setItem('ai-assist:dock-position', 'right')
      // In the IDE the panel is a child of the outer PanelGroup (main-layout)
      // inside the project provider
      const { container } = render(
        <ProjectContext.Provider value={{ projectId: 'test-project' } as any}>
          <PanelGroup direction="horizontal">
            <AiAssistRightPanel order={3} />
          </PanelGroup>
        </ProjectContext.Provider>
      )
      expect(container.querySelector('#ide-redesign-ai-assist-resize-handle')).to
        .exist
      expect(container.querySelector('#ide-redesign-ai-assist-right-panel')).to
        .exist
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
          <Tab
            icon="smart_toy"
            title="AI assistant"
            eventKey="ai-assist"
            open={false}
          />
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
          <Tab
            icon="smart_toy"
            title="AI assistant"
            eventKey="ai-assist"
            open={false}
          />
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
        <div
          role="presentation"
          onClick={() => {
            parentClicked = true
          }}
        >
          <Tab
            icon="smart_toy"
            title="AI assistant"
            eventKey="ai-assist"
            open={false}
          />
        </div>
      )
      const button = container.querySelector('button')
      fireEvent.click(button!)
      expect(localStorage.getItem('ai-assist:right-open')).to.equal('true')
      expect(parentClicked).to.be.false
    })
  })

  describe('AgentPanelHeader onClose separation', function () {
    it('calls onClose and does not collapse rail when onClose is provided', function () {
      let customCloseCalled = false
      localStorage.setItem('rail-is-open-test-project', 'true')
      const { getByRole } = render(
        <ProjectContext.Provider value={{ projectId: 'test-project' } as any}>
          <RailProvider>
            <AgentPanelHeader
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
            <AgentPanelHeader title="Collaborator chat" />
          </RailProvider>
        </ProjectContext.Provider>
      )
      const closeBtn = getByRole('button', { name: /close/i })
      fireEvent.click(closeBtn)
      expect(localStorage.getItem('rail-is-open-test-project')).to.equal(
        'false'
      )
    })
  })

  describe('AgentPanelHeader title animation', function () {
    it('renders text transformation from initial title to new title with dynamic duration', function () {
      const { container, rerender } = render(
        <ProjectContext.Provider value={{ projectId: 'test-project' } as any}>
          <RailProvider>
            <AgentPanelHeader title="AI assistant" isGeneratingTitle={false} />
          </RailProvider>
        </ProjectContext.Provider>
      )

      expect(container.querySelector('.ai-assist-title-transform-container')).to
        .be.null

      rerender(
        <ProjectContext.Provider value={{ projectId: 'test-project' } as any}>
          <RailProvider>
            <AgentPanelHeader title="Fix typo" isGeneratingTitle={true} />
          </RailProvider>
        </ProjectContext.Provider>
      )

      const transformContainer = container.querySelector(
        '.ai-assist-title-transform-container'
      )
      expect(transformContainer).to.exist

      const oldLayer = container.querySelector('.ai-assist-title-layer-old')
      const newLayer = container.querySelector('.ai-assist-title-layer-new')
      expect(oldLayer?.textContent).to.equal('AI assistant')
      expect(newLayer?.textContent).to.equal('Fix typo')

      const shortDurationStr = (
        transformContainer as HTMLElement
      )?.style.getPropertyValue('--ai-title-animation-duration')
      expect(shortDurationStr).to.include('s')
      const shortDuration = parseFloat(shortDurationStr)

      // Test with a longer title to confirm duration increases proportionally to keep speed constant
      const { container: longContainer } = render(
        <ProjectContext.Provider value={{ projectId: 'test-project' } as any}>
          <RailProvider>
            <AgentPanelHeader
              title="Fetch Phan Van Giang Details From Historical Records"
              isGeneratingTitle={true}
            />
          </RailProvider>
        </ProjectContext.Provider>
      )

      const longTransformContainer = longContainer.querySelector(
        '.ai-assist-title-transform-container'
      )
      const longDurationStr = (
        longTransformContainer as HTMLElement
      )?.style.getPropertyValue('--ai-title-animation-duration')
      const longDuration = parseFloat(longDurationStr)

      expect(longDuration).to.be.greaterThan(shortDuration)
    })

    it('clears transformation and triggers onTitleAnimationEnd when animation ends', function () {
      let animationEnded = false
      const { container } = render(
        <ProjectContext.Provider value={{ projectId: 'test-project' } as any}>
          <RailProvider>
            <AgentPanelHeader
              title="Fetch Phan Van Giang Details"
              isGeneratingTitle={true}
              onTitleAnimationEnd={() => {
                animationEnded = true
              }}
            />
          </RailProvider>
        </ProjectContext.Provider>
      )

      const transformContainer = container.querySelector(
        '.ai-assist-title-transform-container'
      )
      expect(transformContainer).to.exist

      fireEvent.animationEnd(transformContainer!)

      expect(container.querySelector('.ai-assist-title-transform-container')).to
        .be.null
      const finalTitle = container.querySelector('.ai-assist-panel-title-text')
      expect(finalTitle?.textContent).to.equal('Fetch Phan Van Giang Details')
      expect(animationEnded).to.be.true
    })
  })
})
