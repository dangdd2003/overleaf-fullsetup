import { RefObject, useCallback, useLayoutEffect, useRef } from 'react'

/**
 * How close to the bottom still counts as "at the bottom". Without some slack a
 * fractional scroll position, which sub-pixel layout and zoom both produce,
 * would read as "scrolled up" and stop the transcript following the stream.
 */
export const BOTTOM_THRESHOLD_PX = 32

/**
 * Keeps a scrolling container pinned to its last line as content arrives.
 *
 * The assistant streams a token at a time, so without this the transcript sits
 * still while the reply grows past the bottom of the panel. Following is a mode
 * rather than an unconditional scroll: scrolling up to read earlier turns turns
 * it off, so the panel does not drag the user back down mid-sentence, and
 * scrolling back to the bottom turns it on again.
 *
 * The effect deliberately has no dependency array. Anything that grows the
 * transcript — a token, a tool call card, the consent notice, an error — does so
 * by re-rendering, and re-pinning after each render is both cheap and exactly
 * what "follow the text" means. Writing `scrollTop` does not itself re-render,
 * and `onScroll` only touches a ref, so this cannot loop.
 *
 * Returns the scroll handler to attach to the same element.
 */
export function useStickToBottom<T extends HTMLElement>(ref: RefObject<T>) {
  const following = useRef(true)

  const onScroll = useCallback(() => {
    const element = ref.current
    if (!element) return
    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight
    following.current = distanceFromBottom <= BOTTOM_THRESHOLD_PX
  }, [ref])

  // Layout effect, so the scroll lands in the same frame as the new text and
  // the last line never flashes out of view.
  useLayoutEffect(() => {
    const element = ref.current
    if (!element || !following.current) return
    element.scrollTop = element.scrollHeight
  })

  return onScroll
}
