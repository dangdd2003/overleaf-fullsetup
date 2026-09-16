import { FC } from 'react'
import { DiffStats } from './diff-stats'

/** Claude Code-style "+12 -3" line change badge. */
export const DiffStatBadge: FC<{ stats: DiffStats }> = ({ stats }) => {
  if (stats.added === 0 && stats.removed === 0) return null

  return (
    <span className="ai-assist-diff-stat" aria-hidden="true">
      <span className="ai-assist-diff-stat-added">+{stats.added}</span>
      <span className="ai-assist-diff-stat-removed">-{stats.removed}</span>
    </span>
  )
}
