import { expect } from 'chai'
import { useRef } from 'react'
import { render, fireEvent } from '@testing-library/react'
import { useStickToBottom } from '../../../../frontend/js/features/ai-assist/hooks/use-stick-to-bottom'

/**
 * jsdom has no layout, so scrollHeight and clientHeight are permanently 0 and
 * scrollTop is a plain property. Defining them makes the element behave like a
 * real overflowing box: writing scrollTop sticks, and the hook's arithmetic has
 * something to work with.
 */
function makeScrollable(
  element: HTMLElement,
  { scrollHeight, clientHeight }: { scrollHeight: number; clientHeight: number }
) {
  let scrollTop = 0
  Object.defineProperty(element, 'scrollHeight', { get: () => scrollHeight })
  Object.defineProperty(element, 'clientHeight', { get: () => clientHeight })
  Object.defineProperty(element, 'scrollTop', {
    get: () => scrollTop,
    set: value => {
      scrollTop = Math.min(value, scrollHeight - clientHeight)
    },
  })
}

function Panel({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const onScroll = useStickToBottom(ref)
  return (
    <div data-testid="scroller" ref={ref} onScroll={onScroll}>
      {text}
    </div>
  )
}

describe('useStickToBottom', function () {
  it('scrolls to the bottom as new content arrives', function () {
    const { getByTestId, rerender } = render(<Panel text="first" />)
    const scroller = getByTestId('scroller')
    makeScrollable(scroller, { scrollHeight: 1000, clientHeight: 200 })

    rerender(<Panel text="first and then a lot more" />)

    expect(scroller.scrollTop).to.equal(800)
  })

  it('stops following once the user scrolls up', function () {
    const { getByTestId, rerender } = render(<Panel text="first" />)
    const scroller = getByTestId('scroller')
    makeScrollable(scroller, { scrollHeight: 1000, clientHeight: 200 })

    // Well clear of the bottom: 1000 - 100 - 200 = 700px away.
    scroller.scrollTop = 100
    fireEvent.scroll(scroller)

    rerender(<Panel text="a streaming reply that keeps growing" />)

    expect(scroller.scrollTop).to.equal(100)
  })

  it('resumes following when the user scrolls back to the bottom', function () {
    const { getByTestId, rerender } = render(<Panel text="first" />)
    const scroller = getByTestId('scroller')
    makeScrollable(scroller, { scrollHeight: 1000, clientHeight: 200 })

    scroller.scrollTop = 100
    fireEvent.scroll(scroller)
    scroller.scrollTop = 800
    fireEvent.scroll(scroller)

    rerender(<Panel text="more text still arriving" />)

    expect(scroller.scrollTop).to.equal(800)
  })

  it('treats being a few pixels short of the bottom as still following', function () {
    const { getByTestId, rerender } = render(<Panel text="first" />)
    const scroller = getByTestId('scroller')
    makeScrollable(scroller, { scrollHeight: 1000, clientHeight: 200 })

    // 10px from the bottom, which sub-pixel layout produces on its own.
    scroller.scrollTop = 790
    fireEvent.scroll(scroller)

    rerender(<Panel text="more text still arriving" />)

    expect(scroller.scrollTop).to.equal(800)
  })
})
