import { ReactNode, useState } from 'react'
import classNames from 'classnames'

/**
 * A finished result, faded in as one box (`.ai-assist-reveal`) when it
 * replaces the streamed text with something different: the diff, with its
 * struck and added words. Decided once, on mount, so toggling the diff or
 * paging versions afterwards never replays it.
 */
export function RevealBox({
  animate,
  children,
}: {
  animate: boolean
  children: ReactNode
}) {
  const [reveal] = useState(animate)
  return (
    <div className={classNames('ai-reveal-box', { 'ai-assist-reveal': reveal })}>
      {children}
    </div>
  )
}
