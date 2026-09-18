import { expect } from 'chai'
import { render, fireEvent } from '@testing-library/react'
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
      currentScrollTop = Math.min(value, dimensions.scrollHeight - dimensions.clientHeight)
    },
    configurable: true,
  })
}

describe('ThinkingBlock auto-scroll', function () {
  it('auto-scrolls to bottom when dropped down while live', function () {
    const { container } = render(
      <ThinkingBlock thinking="Line 1\nLine 2\nLine 3\nLine 4" isLive={true} />
    )
    const button = container.querySelector('.ai-assist-thinking-header') as HTMLButtonElement
    const body = container.querySelector('.ai-assist-thinking-body') as HTMLDivElement

    makeScrollable(body, { scrollHeight: 1000, clientHeight: 350 })

    // Click to drop down
    fireEvent.click(button)

    // Should force auto-scroll to the bottom (1000 - 350 = 650)
    expect(body.scrollTop).to.equal(650)
  })

  it('continues auto-scrolling as new thinking text generates', function () {
    const { container, rerender } = render(
      <ThinkingBlock thinking="Initial thought" isLive={true} />
    )
    const button = container.querySelector('.ai-assist-thinking-header') as HTMLButtonElement
    const body = container.querySelector('.ai-assist-thinking-body') as HTMLDivElement

    makeScrollable(body, { scrollHeight: 600, clientHeight: 350 })
    fireEvent.click(button)
    expect(body.scrollTop).to.equal(250)

    // New thinking text arrives and scrollHeight increases
    makeScrollable(body, { scrollHeight: 900, clientHeight: 350 })
    rerender(<ThinkingBlock thinking="Initial thought and more..." isLive={true} />)

    // Auto-scroll follows the latest generated text
    expect(body.scrollTop).to.equal(550)
  })

  it('stops auto-scrolling when user manually scrolls up to see history', function () {
    const { container, rerender } = render(
      <ThinkingBlock thinking="Initial thought" isLive={true} />
    )
    const button = container.querySelector('.ai-assist-thinking-header') as HTMLButtonElement
    const body = container.querySelector('.ai-assist-thinking-body') as HTMLDivElement

    makeScrollable(body, { scrollHeight: 1000, clientHeight: 350 })
    fireEvent.click(button)
    expect(body.scrollTop).to.equal(650)

    // User manually scrolls up to view history
    body.scrollTop = 200
    fireEvent.scroll(body)

    // New text arrives
    makeScrollable(body, { scrollHeight: 1200, clientHeight: 350 })
    rerender(<ThinkingBlock thinking="Initial thought and more text..." isLive={true} />)

    // Should stop following and remain at user scrolled position
    expect(body.scrollTop).to.equal(200)
  })

  it('resumes auto-scrolling when user scrolls down to touch the latest result', function () {
    const { container, rerender } = render(
      <ThinkingBlock thinking="Initial thought" isLive={true} />
    )
    const button = container.querySelector('.ai-assist-thinking-header') as HTMLButtonElement
    const body = container.querySelector('.ai-assist-thinking-body') as HTMLDivElement

    makeScrollable(body, { scrollHeight: 1000, clientHeight: 350 })
    fireEvent.click(button)
    expect(body.scrollTop).to.equal(650)

    // User scrolls up
    body.scrollTop = 200
    fireEvent.scroll(body)

    // User scrolls back down to touch the latest result (within 32px of bottom: 1000 - 350 = 650)
    body.scrollTop = 640
    fireEvent.scroll(body)

    // New text arrives
    makeScrollable(body, { scrollHeight: 1300, clientHeight: 350 })
    rerender(<ThinkingBlock thinking="Initial thought and even more text..." isLive={true} />)

    // Auto-scroll resumes and follows the latest text
    expect(body.scrollTop).to.equal(950)
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
    const button = container.querySelector('.ai-assist-thinking-header') as HTMLButtonElement

    fireEvent.click(button)
    expect(dispatched).to.be.true

    window.removeEventListener('aiAssist:stickToBottom', listener)
  })
})
