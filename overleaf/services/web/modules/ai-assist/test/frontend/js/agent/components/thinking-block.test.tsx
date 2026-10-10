import { expect } from 'chai'
import { render, fireEvent, waitFor } from '@testing-library/react'
import { ThinkingBlock } from '../../../../../frontend/js/features/ai-assist/components/agent/thinking-block'

function makeScrollable(
  element: HTMLElement,
  dimensions: { scrollHeight: number; clientHeight: number }
) {
  let currentScrollTop = (element as any)._scrollTop ?? 0
  Object.defineProperty(element, '_scrollTop', {
    get: () => currentScrollTop,
    set: v => {
      currentScrollTop = v
    },
    configurable: true,
  })
  Object.defineProperty(element, 'scrollHeight', {
    get: () => dimensions.scrollHeight,
    configurable: true,
  })
  Object.defineProperty(element, 'clientHeight', {
    get: () => dimensions.clientHeight,
    configurable: true,
  })
  Object.defineProperty(element, 'scrollTop', {
    get: () => currentScrollTop,
    set: value => {
      currentScrollTop = Math.min(
        value,
        dimensions.scrollHeight - dimensions.clientHeight
      )
    },
    configurable: true,
  })
}

// The scroll container is the content element; the body only animates height.
describe('ThinkingBlock auto-scroll', function () {
  it('auto-scrolls to bottom when dropped down while live', function () {
    const { container } = render(
      <ThinkingBlock thinking="Line 1\nLine 2\nLine 3\nLine 4" isLive={true} />
    )
    const button = container.querySelector(
      '.ai-assist-thinking-header'
    ) as HTMLButtonElement
    const scroller = container.querySelector(
      '.ai-assist-thinking-content'
    ) as HTMLDivElement

    makeScrollable(scroller, { scrollHeight: 1000, clientHeight: 350 })

    // Click to drop down
    fireEvent.click(button)

    // Should force auto-scroll to the bottom (1000 - 350 = 650)
    expect(scroller.scrollTop).to.equal(650)
  })

  it('continues auto-scrolling as new thinking text generates', function () {
    const { container, rerender } = render(
      <ThinkingBlock thinking="Initial thought" isLive={true} />
    )
    const button = container.querySelector(
      '.ai-assist-thinking-header'
    ) as HTMLButtonElement
    const scroller = container.querySelector(
      '.ai-assist-thinking-content'
    ) as HTMLDivElement

    makeScrollable(scroller, { scrollHeight: 600, clientHeight: 350 })
    fireEvent.click(button)
    expect(scroller.scrollTop).to.equal(250)

    // New thinking text arrives and scrollHeight increases
    makeScrollable(scroller, { scrollHeight: 900, clientHeight: 350 })
    rerender(
      <ThinkingBlock thinking="Initial thought and more..." isLive={true} />
    )

    // Auto-scroll follows the latest generated text
    expect(scroller.scrollTop).to.equal(550)
  })

  it('stops auto-scrolling when user manually scrolls up to see history', function () {
    const { container, rerender } = render(
      <ThinkingBlock thinking="Initial thought" isLive={true} />
    )
    const button = container.querySelector(
      '.ai-assist-thinking-header'
    ) as HTMLButtonElement
    const scroller = container.querySelector(
      '.ai-assist-thinking-content'
    ) as HTMLDivElement

    makeScrollable(scroller, { scrollHeight: 1000, clientHeight: 350 })
    fireEvent.click(button)
    expect(scroller.scrollTop).to.equal(650)

    // User manually scrolls up to view history
    scroller.scrollTop = 200
    fireEvent.scroll(scroller)

    // New text arrives
    makeScrollable(scroller, { scrollHeight: 1200, clientHeight: 350 })
    rerender(
      <ThinkingBlock
        thinking="Initial thought and more text..."
        isLive={true}
      />
    )

    // Should stop following and remain at user scrolled position
    expect(scroller.scrollTop).to.equal(200)
  })

  it('resumes auto-scrolling when user scrolls down to touch the latest result', function () {
    const { container, rerender } = render(
      <ThinkingBlock thinking="Initial thought" isLive={true} />
    )
    const button = container.querySelector(
      '.ai-assist-thinking-header'
    ) as HTMLButtonElement
    const scroller = container.querySelector(
      '.ai-assist-thinking-content'
    ) as HTMLDivElement

    makeScrollable(scroller, { scrollHeight: 1000, clientHeight: 350 })
    fireEvent.click(button)
    expect(scroller.scrollTop).to.equal(650)

    // User scrolls up
    scroller.scrollTop = 200
    fireEvent.scroll(scroller)

    // User scrolls back down to touch the latest result (within 32px of bottom: 1000 - 350 = 650)
    scroller.scrollTop = 640
    fireEvent.scroll(scroller)

    // New text arrives
    makeScrollable(scroller, { scrollHeight: 1300, clientHeight: 350 })
    rerender(
      <ThinkingBlock
        thinking="Initial thought and even more text..."
        isLive={true}
      />
    )

    // Auto-scroll resumes and follows the latest text
    expect(scroller.scrollTop).to.equal(950)
  })

  it('dispatches aiAssist:stickToBottom when dropped down', function () {
    let dispatched = false
    const listener = () => {
      dispatched = true
    }
    window.addEventListener('aiAssist:stickToBottom', listener)

    const { container } = render(
      <ThinkingBlock thinking="Some thinking" isLive={true} />
    )
    const button = container.querySelector(
      '.ai-assist-thinking-header'
    ) as HTMLButtonElement

    fireEvent.click(button)
    expect(dispatched).to.be.true

    window.removeEventListener('aiAssist:stickToBottom', listener)
  })

  it('animates dropdown state with is-expanded on body and chevron', function () {
    const { container } = render(
      <ThinkingBlock thinking="Detailed thought process" isLive={false} />
    )
    const button = container.querySelector(
      '.ai-assist-thinking-header'
    ) as HTMLButtonElement
    const chevron = container.querySelector(
      '.ai-assist-thinking-chevron'
    ) as SVGElement
    const body = container.querySelector(
      '.ai-assist-thinking-body'
    ) as HTMLDivElement

    expect(button.getAttribute('aria-expanded')).to.equal('false')
    expect(chevron.classList.contains('is-expanded')).to.be.false
    expect(body.classList.contains('is-expanded')).to.be.false

    // Expand
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).to.equal('true')
    expect(chevron.classList.contains('is-expanded')).to.be.true
    expect(body.classList.contains('is-expanded')).to.be.true

    // Collapse
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).to.equal('false')
    expect(chevron.classList.contains('is-expanded')).to.be.false
    expect(body.classList.contains('is-expanded')).to.be.false
  })

  it('applies token streaming fade animation when expanded during live generation', async function () {
    const { container, rerender } = render(
      <ThinkingBlock thinking="Thinking step one" isLive={true} />
    )
    const button = container.querySelector(
      '.ai-assist-thinking-header'
    ) as HTMLButtonElement
    const content = container.querySelector(
      '.ai-assist-thinking-content'
    ) as HTMLDivElement

    // Expand dropdown
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).to.equal('true')

    // Stream new tokens
    rerender(
      <ThinkingBlock
        thinking="Thinking step one and step two with more reasoning"
        isLive={true}
      />
    )

    // Newly revealed chunks are wrapped in ai-assist-stream-fade spans
    await waitFor(() => {
      const fadeSpans = content.querySelectorAll('.ai-assist-stream-fade')
      expect(fadeSpans.length).to.be.greaterThan(0)
    })
  })

  it('renders completed thinking block statically without animation spans when not live', function () {
    const { container } = render(
      <ThinkingBlock thinking="Finished thought process" isLive={false} />
    )
    const button = container.querySelector(
      '.ai-assist-thinking-header'
    ) as HTMLButtonElement
    const content = container.querySelector(
      '.ai-assist-thinking-content'
    ) as HTMLDivElement

    fireEvent.click(button)
    expect(content.textContent?.trim()).to.equal('Finished thought process')
    expect(content.querySelectorAll('.ai-assist-stream-fade')).to.have.length(0)
  })
})
