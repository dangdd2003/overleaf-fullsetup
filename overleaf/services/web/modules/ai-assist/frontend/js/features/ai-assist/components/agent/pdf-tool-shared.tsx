import { FC, ReactNode, useState } from 'react'

// Pieces the PDF tools' result views share, so every one of them has the same
// header, file links, warnings and page pictures as view_compiled_pdf_page.

/** A source location that opens in the editor, as every tool detail links one. */
export const FileLink: FC<{
  path: string
  line?: number
  openFile: (path: string, line?: number) => void
  children?: ReactNode
}> = ({ path, line, openFile, children }) => (
  <span
    role="button"
    tabIndex={0}
    className="ai-assist-file-link"
    onClick={() => openFile(path, line)}
    onKeyDown={e =>
      (e.key === 'Enter' || e.key === ' ') && openFile(path, line)
    }
  >
    {children ?? (line != null ? `${path}:${line}` : path)}
  </span>
)

/** The boxed title line a PDF tool's result opens with: its parts joined by ' · '. */
export const PdfDetailHeader: FC<{ parts: Array<string | undefined | null | false> }> = ({
  parts,
}) => {
  const text = parts.filter(Boolean).join(' · ')
  if (!text) return null
  return (
    <div className="ai-assist-outline-class ai-assist-pdf-overview-header">
      <span className="ai-assist-pdf-overview-header-title">{text}</span>
    </div>
  )
}

/**
 * One compile error or warning, collapsed to its title — location and
 * message on a single line. Clicking the title drops down the log excerpt.
 */
export function CompileLogEntry({
  entry,
  level,
  openFile,
}: {
  entry: any
  level: 'error' | 'warning'
  openFile: (path: string, line?: number) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const hasExcerpt = Boolean(entry.excerpt)

  return (
    <div className={`ai-assist-log-entry ${level}`}>
      <div className="ai-assist-log-title">
        <span
          role="button"
          tabIndex={0}
          className={entry.file ? 'ai-assist-file-link' : 'ai-assist-log-loc'}
          onClick={() => {
            if (entry.file) openFile(entry.file, entry.line)
          }}
          onKeyDown={e => {
            if (e.key === 'Enter' && entry.file)
              openFile(entry.file, entry.line)
          }}
        >
          {entry.file
            ? `${entry.file}:${entry.line ?? '?'}`
            : level === 'error'
              ? 'Error'
              : 'Warning'}
        </span>
        {hasExcerpt ? (
          <button
            type="button"
            className="ai-assist-log-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded(open => !open)}
          >
            <span className="ai-assist-log-msg">{entry.message}</span>
            <svg
              className={`ai-assist-tool-call-chevron ${expanded ? 'is-expanded' : ''}`}
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 16 16"
              width="13"
              height="13"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polyline points="6 4 10 8 6 12" />
            </svg>
          </button>
        ) : (
          <span className="ai-assist-log-msg">{entry.message}</span>
        )}
      </div>
      {hasExcerpt && expanded && (
        <pre className="ai-assist-log-excerpt">{entry.excerpt}</pre>
      )}
    </div>
  )
}

/**
 * A page picture the server rendered inline. A remote URL in tool output is
 * never loaded: the browser would fetch whatever address the output names.
 */
const INLINE_RASTER_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp);base64,/i

export function getPdfImages(result: any): Array<{ src: string; alt: string }> {
  if (!result || typeof result !== 'object') return []
  const items: Array<{ src: string; alt: string }> = []
  const rawList = Array.isArray(result.images)
    ? result.images
    : result.image
      ? [result.image]
      : []

  for (let i = 0; i < rawList.length; i++) {
    const img = rawList[i]
    if (!img) continue
    let src: unknown = ''
    if (typeof img === 'string') {
      src = img.startsWith('data:') ? img : `data:image/png;base64,${img}`
    } else if (typeof img === 'object') {
      src =
        [img.url, img.src].find(
          (candidate: unknown) =>
            typeof candidate === 'string' &&
            INLINE_RASTER_IMAGE.test(candidate)
        ) ??
        (typeof img.data === 'string'
          ? `data:${img.mediaType || 'image/png'};base64,${img.data}`
          : '')
    }
    if (typeof src === 'string' && INLINE_RASTER_IMAGE.test(src)) {
      items.push({ src, alt: `PDF preview ${i + 1}` })
    }
  }
  return items
}
