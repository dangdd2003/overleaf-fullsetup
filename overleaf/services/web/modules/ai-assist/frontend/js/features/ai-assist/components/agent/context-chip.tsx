import type { ReactNode } from 'react'

/**
 * One item of context waiting in the composer: editor code, a file, an image,
 * PDF text or a PDF area. Every kind has the same shape, so they read as one
 * row: an icon or a thumbnail, where the item comes from, what it is, and a
 * remove button. Only the leading mark and the words change.
 */
export function ContextChip({
  icon,
  thumbnail,
  source,
  detail,
  title,
  removeLabel,
  onRemove,
  className = '',
}: {
  /** A 12px mark for the kind; left out when there is a thumbnail. */
  icon?: ReactNode
  /** A data URL, shown in the icon's place for images and PDF areas. */
  thumbnail?: string
  /** Where it comes from: a file name, "Image", "PDF p.3". */
  source: string
  /** What it is there: lines, a file name and size, a snippet. */
  detail?: string
  /** The full description, for the tooltip. */
  title?: string
  removeLabel?: string
  /** Leave out for an item that cannot be removed, such as a capture. */
  onRemove?: () => void
  className?: string
}) {
  const label = detail ? `${source}: ${detail}` : source
  return (
    <span
      className={`ai-assist-selection-chip ${className}`.trim()}
      title={title ?? label}
    >
      <span className="ai-assist-selection-chip-icon" aria-hidden="true">
        {thumbnail ? (
          <img className="ai-assist-selection-chip-thumb" src={thumbnail} alt="" />
        ) : (
          icon
        )}
      </span>
      <span className="ai-assist-selection-chip-label">{label}</span>
      {onRemove && (
        <button
          type="button"
          className="ai-assist-selection-chip-close"
          onClick={event => {
            event.preventDefault()
            event.stopPropagation()
            onRemove()
          }}
          aria-label={removeLabel}
          title={removeLabel}
        >
          <svg
            viewBox="0 0 16 16"
            width="12"
            height="12"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <line x1="4" y1="4" x2="12" y2="12" />
            <line x1="12" y1="4" x2="4" y2="12" />
          </svg>
        </button>
      )}
    </span>
  )
}

/** The `<>` mark of editor code. */
export function CodeIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="5 4 1 8 5 12" />
      <polyline points="11 4 15 8 11 12" />
    </svg>
  )
}
