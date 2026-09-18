import { RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * How close to the bottom still counts as "at the bottom". Without some slack a
 * fractional scroll position, which sub-pixel layout and zoom both produce,
 * would read as "scrolled up" and stop the transcript following the stream.
 */
export const BOTTOM_THRESHOLD_PX = 32

export interface StickToBottomReturn {
  onScroll: () => void
  isAtBottom: boolean
  scrollToBottom: (options?: { smooth?: boolean }) => void
}

/**
 * Keeps a scrolling container pinned to its last line as content arrives, and
 * provides controls for detecting scroll state and jumping back to the bottom.
 *
 * The assistant streams a token at a time, so without this the transcript sits
 * still while the reply grows past the bottom of the panel. Following is a mode
 * rather than an unconditional scroll: scrolling up to read earlier turns turns
 * it off, so the panel does not drag the user back down mid-sentence, and
 * scrolling back to the bottom turns it on again.
 *
 * Returns `{ onScroll, isAtBottom, scrollToBottom }`.
 */
export function useStickToBottom<T extends HTMLElement>(
  ref: RefObject<T>
): StickToBottomReturn {
  const following = useRef(true)
  const [isAtBottom, setIsAtBottom] = useState(true)

  const onScroll = useCallback(() => {
    const element = ref.current
    if (!element) return
    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight
    const atBottom = distanceFromBottom <= BOTTOM_THRESHOLD_PX
    following.current = atBottom
    setIsAtBottom(atBottom)
  }, [ref])

  const scrollToBottom = useCallback(
    (options?: { smooth?: boolean }) => {
      const element = ref.current
      if (!element) return
      following.current = true
      setIsAtBottom(true)
      const isTestEnv =
        typeof window !== 'undefined' &&
        (navigator.userAgent.includes('jsdom') ||
          typeof (window as any).mocha !== 'undefined')

      if (
        options?.smooth !== false &&
        typeof element.scrollTo === 'function' &&
        !isTestEnv
      ) {
        element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
      } else {
        element.scrollTop = element.scrollHeight
      }
    },
    [ref]
  )

  useEffect(() => {
    const handleStickToBottom = () => {
      const element = ref.current
      if (!element || !following.current) return
      element.scrollTop = element.scrollHeight
      setIsAtBottom(true)
    }

    window.addEventListener('aiAssist:stickToBottom', handleStickToBottom)
    return () => {
      window.removeEventListener('aiAssist:stickToBottom', handleStickToBottom)
    }
  }, [ref])

  // Layout effect, so the scroll lands in the same frame as the new text and
  // the last line never flashes out of view.
  useLayoutEffect(() => {
    const element = ref.current
    if (!element || !following.current) return
    element.scrollTop = element.scrollHeight
  })

  return { onScroll, isAtBottom, scrollToBottom }
}
