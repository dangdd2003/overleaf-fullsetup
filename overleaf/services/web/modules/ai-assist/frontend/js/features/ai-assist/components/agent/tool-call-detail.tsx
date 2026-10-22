import { FC, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ToolCallRecord } from '../../agent/agent-messages'
import { cleanStoredResult } from '../../agent/conversation-store'
import { useOpenFileInEditor } from '../../hooks/use-open-file'
import DiffView from './diff-view'
import CodeView from './code-view'
import { MarkdownContent } from './markdown-content'
import { hostOf, safeHttpHref } from '../../agent/web-sources'
import { describeWebFailure } from '../../agent/web-errors'
import { isConnectorToolName } from '../../agent/mcp-tool-output'
import { McpToolDetail } from './mcp-tool-detail'
import { SiteIcon } from './site-icon'
import { CopyToClipboard } from '@/shared/components/copy-to-clipboard'
import { ImageLightbox } from './image-lightbox'
import {
  CompileLogEntry,
  FileLink,
  PdfDetailHeader,
  getPdfImages,
  type TranslateFn,
} from './pdf-tool-shared'
import { PdfDiffDetail } from './pdf-diff-detail'
import { PdfStyleDetail } from './pdf-style-detail'
import { PdfBlockDetail, PdfHighlightDetail } from './pdf-locate-detail'

/** The file an edit touched, as Claude Code shows it above the diff. */
function DiffFileHeader({
  call,
  line,
  isRejected,
  isCancelled,
}: {
  call: ToolCallRecord
  line: number
  isRejected: boolean
  isCancelled: boolean
}) {
  const { t } = useTranslation()
  const openFile = useOpenFileInEditor()
  const path: string = (call.args as any)?.path ?? ''

  return (
    <div className="ai-assist-tool-detail-header">
      <span
        role="button"
        tabIndex={0}
        className="ai-assist-tool-detail-path"
        title={t('ai_assist_open_file', {
          path,
          defaultValue: `Open ${path}`,
        })}
        onClick={() => openFile(path, line)}
        onKeyDown={e => e.key === 'Enter' && openFile(path, line)}
      >
        {path}
      </span>
      {isRejected && (
        <span className="ai-assist-tool-detail-badge rejected">
          {t('ai_assist_rejected_badge', 'Rejected')}
        </span>
      )}
      {isCancelled && (
        <span className="ai-assist-tool-detail-badge cancelled">
          {t('ai_assist_cancelled_badge', 'Cancelled')}
        </span>
      )}
      {path && (
        <CopyToClipboard
          content={path}
          tooltipId={`ai-assist-copy-path-${call.id}`}
          unfilled
        />
      )}
    </div>
  )
}

function DiffResultView({
  call,
  result,
  args,
  oldText,
  newText,
  startLine,
}: {
  call: ToolCallRecord
  result: any
  args: any
  oldText: string
  newText: string
  startLine: number
}) {
  const { t } = useTranslation()
  const openFile = useOpenFileInEditor()
  const isRejected = result?.status === 'rejected'
  const isCancelled = result?.status === 'stopped'

  return (
    <div
      className={`ai-assist-tool-detail-diff ${isRejected ? 'is-rejected' : ''} ${isCancelled ? 'is-cancelled' : ''}`}
    >
      <DiffFileHeader
        call={call}
        line={startLine}
        isRejected={isRejected}
        isCancelled={isCancelled}
      />
      <DiffView
        oldText={oldText}
        newText={newText}
        startLine={startLine}
        path={args.path}
        onLineClick={line => args.path && openFile(args.path, line)}
      />
      {result?.note && (
        <div className="ai-assist-tool-detail-note ai-assist-tool-detail-rejection">
          <strong>{t('ai_assist_user_reason', 'User note:')}</strong>{' '}
          {result.note}
        </div>
      )}
      {result?.message && (
        <div className="ai-assist-tool-detail-note">{result.message}</div>
      )}
    </div>
  )
}

/**
 * One web page as a row, the way Claude.ai lists search results: the site's
 * icon, the page title, and the domain on the right, the whole row a link.
 */
function WebPageRow({
  url,
  title,
  hint,
}: {
  url: string
  title?: string
  hint?: string
}) {
  const href = safeHttpHref(url)
  const body = (
    <>
      <SiteIcon url={url} />
      <span className="ai-assist-web-row-title">{title || hostOf(url)}</span>
      <span className="ai-assist-web-row-meta">{hostOf(url)}</span>
    </>
  )
  // The URL came from a model or a web page: a non-http(s) one is never a link
  if (!href) {
    return (
      <span className="ai-assist-web-row" title={hint || title || url}>
        {body}
      </span>
    )
  }
  return (
    <a
      className="ai-assist-web-row"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={hint || title || url}
    >
      {body}
    </a>
  )
}

/** A fetched page's address: a link when it is plain http(s), text otherwise. */
function PageAddress({ url }: { url: string }) {
  const href = safeHttpHref(url)
  if (!href) {
    return (
      <span className="ai-assist-web-fetch-url" title={url}>
        {url}
      </span>
    )
  }
  return (
    <a
      className="ai-assist-web-fetch-url"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={url}
    >
      {url}
    </a>
  )
}

function WebToolError({ call, result }: { call: ToolCallRecord; result: any }) {
  const { t } = useTranslation()
  const args = (call.args ?? {}) as any
  const url = typeof result?.url === 'string' ? result.url : args.url
  const tool = call.name === 'web_search' ? 'web_search' : 'web_fetch'
  const failure = describeWebFailure(
    tool,
    typeof result?.error === 'string'
      ? result.error
      : typeof result === 'string'
        ? result
        : 'The request failed.',
    url
  )
  return (
    <div className="ai-assist-web-detail">
      {tool === 'web_search' && typeof url === 'string' && url && (
        <WebPageRow url={url} title={result?.title} />
      )}
      {tool === 'web_fetch' && (
        <div className="ai-assist-web-fetch-header">
          {url ? (
            <PageAddress url={url} />
          ) : (
            <span className="ai-assist-web-fetch-url is-missing">
              {result?.title || t('ai_assist_web_fetch_no_url', 'Web page')}
            </span>
          )}
        </div>
      )}
      <div className="ai-assist-web-error" role="alert">
        <div className="ai-assist-web-error-head">
          <span className="ai-assist-web-error-icon" aria-hidden="true">
            ✗
          </span>
          <div className="ai-assist-web-error-text">
            <div className="ai-assist-web-error-title">{failure.title}</div>
            <div className="ai-assist-web-error-why">{failure.explanation}</div>
          </div>
        </div>
        {failure.fixes.length > 0 && (
          <ul className="ai-assist-web-error-fixes">
            {failure.fixes.map(fix => (
              <li key={fix}>{fix}</li>
            ))}
          </ul>
        )}
        <details className="ai-assist-web-error-details">
          <summary>
            {failure.attempts.length > 0
              ? t('ai_assist_web_error_tried', {
                  count: failure.attempts.length,
                  defaultValue: `What was tried (${failure.attempts.length})`,
                })
              : t('ai_assist_web_error_technical', 'Technical details')}
          </summary>
          {failure.attempts.length > 0 ? (
            <ul className="ai-assist-web-attempts">
              {failure.attempts.map(attempt => {
                const httpCode = attempt.raw
                  ? /HTTP \d{3}/.exec(attempt.raw)?.[0]
                  : undefined
                return (
                  <li
                    key={attempt.route}
                    className={`ai-assist-web-attempt is-${attempt.kind}`}
                  >
                    <span className="ai-assist-web-attempt-route">
                      {attempt.label}
                    </span>
                    <span
                      className="ai-assist-web-attempt-why"
                      title={attempt.raw}
                    >
                      {attempt.summary}
                      {httpCode && <code>{httpCode}</code>}
                    </span>
                  </li>
                )
              })}
            </ul>
          ) : (
            <pre className="ai-assist-tool-detail-text">{failure.raw}</pre>
          )}
        </details>
      </div>
    </div>
  )
}

const VIA_LABELS: Record<string, string> = {
  browser: 'browser',
  ollama: 'Ollama',
  websearchapi: 'WebSearchAPI.ai',
  tavily: 'Tavily',
  firecrawl: 'Firecrawl',
  firecrawlSelfHosted: 'Firecrawl',
  jina: 'Jina Reader',
  exa: 'Exa',
}

// [short label, full name for the tooltip]
const ARCHIVE_LABELS: Record<string, [string, string]> = {
  wayback: ['Wayback', 'Internet Archive'],
  'archive.today': ['archive.today', 'archive.today'],
}

type WebFetchNote = { label: string; title: string }

/**
 * The notes beside a fetched page: which part, when, and how it was read.
 * Each label is kept short so the URL keeps its room; the title says it in full.
 */
export function webFetchNotes(result: any): WebFetchNote[] {
  if (!result || typeof result !== 'object') return []
  const notes: WebFetchNote[] = []
  // A find searched every page, so it names the search, not a page
  if (typeof result.find === 'string' && Array.isArray(result.matches)) {
    const total = Number.isInteger(result.totalMatches)
      ? result.totalMatches
      : result.matches.length
    const pages = Array.isArray(result.matchPages)
      ? result.matchPages.length
      : new Set(result.matches.map((match: any) => match.page)).size
    const matches = `${total} match${total === 1 ? '' : 'es'}`
    notes.push(
      total > 0
        ? {
            label: pages > 1 ? `${matches} · ${pages} pp.` : matches,
            title: `${matches} on ${pages} page${pages === 1 ? '' : 's'}`,
          }
        : { label: 'No matches', title: 'No matches' }
    )
  } else if (result.totalPages > 1) {
    const page = result.page ?? 1
    notes.push({
      label: `p. ${page}/${result.totalPages}`,
      title: `Page ${page} of ${result.totalPages}`,
    })
  }
  if (result.published) {
    notes.push({
      label: `Pub. ${result.published}`,
      title: `Published ${result.published}`,
    })
  }
  if (result.archived || result.archiveUrl) {
    const [short, full] = ARCHIVE_LABELS[result.via] ?? ARCHIVE_LABELS.wayback
    notes.push(
      result.archived
        ? {
            label: `${short} ${result.archived}`,
            title: `Read from the ${full} copy of ${result.archived}`,
          }
        : { label: short, title: `Read from the ${full} copy` }
    )
  } else if (VIA_LABELS[result.via]) {
    notes.push({
      label: `via ${VIA_LABELS[result.via]}`,
      title: `Read via ${VIA_LABELS[result.via]}`,
    })
  }
  if (result.partial) {
    notes.push({
      label: 'Partial',
      title: 'Only part of this page could be read',
    })
  }
  return notes
}

export function badBoxesLabel(count: number, t: TranslateFn): string {
  return t('ai_assist_tool_view_pdf_page_bad_boxes', {
    count,
    defaultValue: `${count} bad box${count === 1 ? '' : 'es'}`,
  })
}

export function overviewFindings(page: any, t: TranslateFn): string[] {
  if (!page || typeof page !== 'object') return []
  const findings: string[] = []
  if (page.blank) {
    findings.push(t('ai_assist_tool_pdf_blank', 'blank'))
  }
  if (typeof page.endsAt === 'number') {
    findings.push(
      t('ai_assist_tool_pdf_ends_at', {
        defaultValue: `ends ${page.endsAt}% down`,
      })
    )
  }
  const gaps: any[] = Array.isArray(page.gaps) ? page.gaps : []
  for (const gap of gaps) {
    if (typeof gap?.top === 'number' && typeof gap?.bottom === 'number') {
      findings.push(
        t('ai_assist_tool_pdf_gap', {
          defaultValue: `empty ${gap.top}–${gap.bottom}%`,
        })
      )
    }
  }
  const overflows: any[] = Array.isArray(page.overflow) ? page.overflow : []
  for (const overflow of overflows) {
    if (typeof overflow?.mm === 'number') {
      const side = overflow.side === 'left' ? 'left' : 'right'
      findings.push(
        t('ai_assist_tool_pdf_overflow', {
          defaultValue: `${Math.round(overflow.mm)} mm past ${side} margin`,
        })
      )
    }
  }
  if (page.badBoxes > 0) {
    findings.push(badBoxesLabel(page.badBoxes, t))
  }
  const refs = Number(page.unresolved?.refs) || 0
  const cites = Number(page.unresolved?.cites) || 0
  if (refs > 0) {
    findings.push(
      t('ai_assist_tool_pdf_unresolved_refs', {
        count: refs,
        defaultValue: `${refs} unresolved ref${refs === 1 ? '' : 's'}`,
      })
    )
  }
  if (cites > 0) {
    findings.push(
      t('ai_assist_tool_pdf_unresolved_cites', {
        count: cites,
        defaultValue: `${cites} unresolved cite${cites === 1 ? '' : 's'}`,
      })
    )
  }
  return findings
}

/** A line range as one span: `12` for a single line, `12–18` for several */
function lineSpan(startLine: number, endLine?: number): string {
  return typeof endLine === 'number' && endLine > startLine
    ? `${startLine}–${endLine}`
    : `${startLine}`
}

/** The context with the query emphasised, as text and never as markup */
function highlightQuery(text: string, query: string) {
  if (!query) return text
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text
    .split(new RegExp(`(${escaped})`, 'i'))
    .map((part, idx) => (idx % 2 === 1 ? <mark key={idx}>{part}</mark> : part))
}

/** One page of an overview: its source, what it flags, and the worst bad box */
function PdfOverviewPage({
  page,
  openFile,
}: {
  page: any
  openFile: (path: string, line?: number) => void
}) {
  const { t } = useTranslation()
  const sources: any[] = Array.isArray(page?.source)
    ? page.source.filter((source: any) => typeof source?.path === 'string')
    : []
  const findings = overviewFindings(page, t)
  const worst = page?.worstBadBox
  const isClean = findings.length === 0 && !worst

  return (
    <div className={`ai-assist-pdf-page ${isClean ? 'is-clean' : 'has-findings'}`}>
      <div className="ai-assist-outline-section ai-assist-pdf-page-row">
        <span className="ai-assist-outline-line ai-assist-pdf-page-badge">
          {t('ai_assist_tool_pdf_page_badge', {
            page: page?.page,
            defaultValue: `p${page?.page}`,
          })}
        </span>
        {sources.map((source: any, idx: number) => (
          <FileLink
            key={`${source.path}:${source.startLine}:${idx}`}
            path={source.path}
            line={source.startLine}
            openFile={openFile}
          >
            {`${source.path}:${lineSpan(source.startLine, source.endLine)}`}
          </FileLink>
        ))}
        {findings.length > 0 ? (
          <span className="ai-assist-outline-findings is-flagged">
            {findings.join(' · ')}
          </span>
        ) : (
          <span className="ai-assist-pdf-page-clean">
            {t('ai_assist_tool_pdf_clean', 'No layout issues')}
          </span>
        )}
      </div>
      {worst && typeof worst === 'object' && (
        <div className="ai-assist-tool-detail-log">
          <CompileLogEntry
            entry={{
              file: worst.path,
              line: worst.line,
              message: worst.message,
            }}
            level="warning"
            openFile={openFile}
          />
        </div>
      )}
    </div>
  )
}

function PdfPreviewThumbs({
  images,
  title,
  downloadName,
}: {
  images: Array<{ src: string }>
  title: string
  downloadName: string
}) {
  const { t } = useTranslation()
  const [previewImage, setPreviewImage] = useState<{
    src: string
    title: string
  } | null>(null)

  if (images.length === 0) return null

  return (
    <>
      <div className="ai-assist-pdf-image-container">
        {images.map((img, idx) => (
          <div
            key={idx}
            className="ai-assist-pdf-image-thumb"
            role="button"
            tabIndex={0}
            title={t('ai_assist_click_to_zoom', 'Click to enlarge preview')}
            onClick={() => setPreviewImage({ src: img.src, title })}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                setPreviewImage({ src: img.src, title })
              }
            }}
          >
            <img
              src={img.src}
              alt={t('ai_assist_tool_pdf_preview_alt', {
                count: idx + 1,
                defaultValue: `PDF preview ${idx + 1}`,
              })}
            />
          </div>
        ))}
      </div>
      {previewImage && (
        <ImageLightbox
          src={previewImage.src}
          title={previewImage.title}
          downloadName={downloadName}
          isOpen={Boolean(previewImage)}
          onClose={() => setPreviewImage(null)}
        />
      )}
    </>
  )
}

function PdfPageDetail({
  result,
  args,
  openFile,
}: {
  result: any
  args: any
  openFile: (path: string, line?: number) => void
}) {
  const { t } = useTranslation()

  const page =
    typeof result?.page === 'number'
      ? result.page
      : typeof args?.page === 'number'
        ? args.page
        : 1
  const pageCount =
    typeof result?.pageCount === 'number'
      ? result.pageCount
      : typeof args?.pageCount === 'number'
        ? args.pageCount
        : undefined
  const pageSize = result?.pageSize
  const sizeText =
    typeof pageSize?.width === 'number' && typeof pageSize?.height === 'number'
      ? `${pageSize.width} × ${pageSize.height} pt`
      : undefined

  const region =
    result?.region && result.region !== 'full' ? result.region : args?.region
  const regionLabel = region && region !== 'full' ? `(${region})` : undefined

  const focus = result?.focus
  const zoomed =
    typeof focus?.path === 'string' && typeof focus?.line === 'number'
  const continuesOn: number[] = Array.isArray(focus?.continuesOn)
    ? focus.continuesOn
    : []
  const pagesWord = continuesOn.length === 1 ? 'page' : 'pages'

  const rows: any[] = Array.isArray(result?.sourceMap) ? result.sourceMap : []
  const sourceRanges: any[] = Array.isArray(result?.sourceRanges)
    ? result.sourceRanges
    : []
  const boxes: any[] = Array.isArray(result?.badBoxes) ? result.badBoxes : []
  const textLines: any[] = Array.isArray(result?.text?.lines)
    ? result.text.lines.filter((line: any) => typeof line?.text === 'string')
    : []

  const pdfImages = getPdfImages(result)
  const isClean = boxes.length === 0

  const pageLabel = t('ai_assist_tool_pdf_page_label', {
    page,
    defaultValue: `Page ${page}`,
  })
  const pageTitle = pageCount
    ? t('ai_assist_tool_pdf_page_of', {
        page,
        count: pageCount,
        defaultValue: `Page ${page} of ${pageCount}`,
      })
    : pageLabel

  return (
    <div className="ai-assist-tool-detail-outline ai-assist-tool-detail-pdf-page">
      <PdfDetailHeader parts={[pageTitle, regionLabel, sizeText]} />

      {zoomed && (
        <div className="ai-assist-outline-class">
          {t('ai_assist_tool_pdf_zoomed_on', 'Zoomed on')}{' '}
          <FileLink
            path={focus.path}
            line={focus.line}
            openFile={openFile}
          >
            {`${focus.path}:${lineSpan(focus.line, focus.endLine)}`}
          </FileLink>
          {continuesOn.length > 0 && (
            <>
              {' · '}
              {t('ai_assist_tool_pdf_continues_on', {
                count: continuesOn.length,
                defaultValue: `continues on ${pagesWord} ${continuesOn.join(', ')}`,
              })}
            </>
          )}
        </div>
      )}

      {result?.note && (
        <div className="ai-assist-tool-detail-note">{result.note}</div>
      )}

      <PdfPreviewThumbs
        images={pdfImages}
        title={pageLabel}
        downloadName={`pdf-page-${page}.png`}
      />

      {sourceRanges.length > 0 && (
        <div className="ai-assist-pdf-sources">
          <span className="ai-assist-pdf-sources-label">
            {t('ai_assist_tool_pdf_sources', 'Sources:')}
          </span>{' '}
          {sourceRanges.map((sr, idx) => (
            <span key={`${sr.path}:${sr.startLine}:${idx}`}>
              <FileLink
                path={sr.path}
                line={sr.startLine}
                openFile={openFile}
              >
                {`${sr.path}:${lineSpan(sr.startLine, sr.endLine)}`}
              </FileLink>
              {idx < sourceRanges.length - 1 ? ', ' : ''}
            </span>
          ))}
        </div>
      )}

      {rows.map((row: any, idx: number) => (
        <div
          key={`${row.path}:${row.line}:${idx}`}
          className="ai-assist-outline-section"
        >
          <span className="ai-assist-outline-line">
            {t('ai_assist_tool_pdf_at_percent', {
              y: row.y,
              defaultValue: `At ${row.y}%:`,
            })}
          </span>
          <FileLink path={row.path} line={row.line} openFile={openFile} />
        </div>
      ))}

      {boxes.length > 0 && (
        <div className="ai-assist-tool-detail-log">
          {boxes.map((box: any, idx: number) => (
            <CompileLogEntry
              key={`box-${box.path ?? ''}:${box.line ?? 0}:${idx}`}
              entry={{ file: box.path, line: box.line, message: box.message }}
              level="warning"
              openFile={openFile}
            />
          ))}
        </div>
      )}

      {textLines.length > 0 && (
        <>
          <div className="ai-assist-outline-class">
            {t('ai_assist_tool_pdf_text_heading', 'Text on the page')}
          </div>
          {textLines.map((line: any, idx: number) => (
            <div
              key={`text-${line.y}:${idx}`}
              className="ai-assist-outline-section"
            >
              <span className="ai-assist-outline-line">{line.y}%</span>
              <span className="ai-assist-pdf-text-line">{line.text}</span>
            </div>
          ))}
          {result?.text?.truncated && (
            <div className="ai-assist-tool-detail-note">
              {t(
                'ai_assist_tool_pdf_text_truncated',
                'Only part of the text is shown'
              )}
            </div>
          )}
        </>
      )}

      {isClean && rows.length === 0 && !zoomed && !result?.note && (
        <div className="ai-assist-tool-detail-success">
          ✓{' '}
          {t('ai_assist_tool_pdf_clean_page', {
            page,
            defaultValue: `Page ${page} rendered cleanly with no layout issues.`,
          })}
        </div>
      )}
    </div>
  )
}

function PdfOverviewDetail({
  result,
  openFile,
}: {
  result: any
  openFile: (path: string, line?: number) => void
}) {
  const { t } = useTranslation()

  const paper = result?.paper ?? {}
  const fonts = result?.fonts ?? {}
  const notEmbedded: string[] = Array.isArray(fonts.notEmbedded)
    ? fonts.notEmbedded
    : []
  const type3: string[] = Array.isArray(fonts.type3) ? fonts.type3 : []
  const size =
    typeof paper.width === 'number' && typeof paper.height === 'number'
      ? `${paper.width} × ${paper.height} mm`
      : undefined
  const pageCount =
    typeof result?.pageCount === 'number'
      ? t('ai_assist_tool_pdf_page_count', {
          count: result.pageCount,
          defaultValue: `${result.pageCount} page${result.pageCount === 1 ? '' : 's'}`,
        })
      : undefined
  const overviewTitle = t('ai_assist_tool_pdf_overview_title', 'PDF overview')
  const headerParts = [
    ...(result?.mixedSizes
      ? [t('ai_assist_tool_pdf_mixed_sizes', 'Mixed page sizes')]
      : [paper.name, paper.orientation, size]),
    pageCount,
  ].filter(Boolean)

  const overviewImages = getPdfImages(result)
  const pages: any[] = Array.isArray(result?.pages) ? result.pages : []

  return (
    <div className="ai-assist-tool-detail-outline ai-assist-tool-detail-pdf-overview">
      <PdfDetailHeader
        parts={headerParts.length > 0 ? headerParts : [overviewTitle]}
      />

      <PdfPreviewThumbs
        images={overviewImages}
        title={overviewTitle}
        downloadName="pdf-overview.png"
      />

      {notEmbedded.length > 0 && (
        <div className="ai-assist-pdf-warning">
          {t('ai_assist_tool_pdf_fonts_not_embedded', {
            defaultValue: `Fonts not embedded: ${notEmbedded.join(', ')}`,
          })}
        </div>
      )}
      {type3.length > 0 && (
        <div className="ai-assist-pdf-warning">
          {t('ai_assist_tool_pdf_fonts_type3', {
            defaultValue: `Type 3 fonts: ${type3.join(', ')}`,
          })}
        </div>
      )}

      {pages.length > 0 ? (
        <div className="ai-assist-pdf-pages-list">
          {pages.map((page: any, idx: number) => (
            <PdfOverviewPage
              key={`pdf-page-${page?.page ?? ''}:${idx}`}
              page={page}
              openFile={openFile}
            />
          ))}
        </div>
      ) : (
        <div className="ai-assist-tool-detail-success">
          ✓{' '}
          {t(
            'ai_assist_tool_pdf_all_clean',
            'All pages compiled cleanly with no layout issues detected.'
          )}
        </div>
      )}
    </div>
  )
}

export const ToolCallDetailView: FC<{ call: ToolCallRecord }> = ({ call }) => {
  const { t } = useTranslation()
  const args = (call.args ?? {}) as any
  const rawResult = useMemo(() => cleanStoredResult(call.result), [call.result])
  const result = rawResult as any
  const openFile = useOpenFileInEditor()

  if (
    (call.name === 'web_search' || call.name === 'web_fetch') &&
    (call.isError || result?.error)
  ) {
    return <WebToolError call={call} result={result} />
  }

  // A connector's tool, and the reader for its long results
  if (isConnectorToolName(call.name)) {
    return <McpToolDetail call={call} result={rawResult} />
  }

  if (call.isError || result?.error) {
    const errorMsg =
      result?.error ||
      (typeof result === 'string' ? result : 'The tool execution failed.')
    return (
      <div className="ai-assist-tool-detail-error" role="alert">
        ✗ {errorMsg}
      </div>
    )
  }

  // 1. read_file
  if (call.name === 'read_file') {
    const rawLines = Array.isArray(result?.lines)
      ? result.lines
      : typeof result?.content === 'string'
        ? result.content.split('\n')
        : null

    if (rawLines && rawLines.length > 0) {
      const startLine =
        typeof result?.from === 'number'
          ? result.from
          : typeof args?.from === 'number'
            ? args.from
            : 1
      return (
        <div className="ai-assist-tool-detail-code">
          <CodeView
            lines={rawLines}
            startLine={startLine}
            onLineClick={line => args.path && openFile(args.path, line)}
          />
          {result?.truncated && (
            <div className="ai-assist-tool-detail-note">
              (lines {result.from ?? 1}-{result.to ?? ''} of{' '}
              {result.totalLines ?? ''})
            </div>
          )}
        </div>
      )
    }

    if (args.path) {
      return (
        <div className="ai-assist-tool-detail-code">
          <div className="ai-assist-tool-detail-note">
            File:{' '}
            <span
              role="button"
              tabIndex={0}
              className="ai-assist-file-link"
              onClick={() => openFile(args.path, args.from)}
              onKeyDown={e =>
                e.key === 'Enter' && openFile(args.path, args.from)
              }
            >
              {args.path}
            </span>{' '}
            {args.from ? `(lines ${args.from}-${args.to ?? ''})` : ''}
          </div>
        </div>
      )
    }
  }

  // 2. edit_file
  if (call.name === 'edit_file') {
    const oldText = args.oldText ?? args.old_text ?? args.old_string ?? ''
    const newText = args.newText ?? args.new_text ?? args.new_string ?? ''
    const startLine =
      result?.startLine ?? args?.from ?? args?.startLine ?? 1

    if (oldText || newText) {
      return (
        <DiffResultView
          call={call}
          result={result}
          args={args}
          oldText={oldText}
          newText={newText}
          startLine={startLine}
        />
      )
    }
  }

  // 3. create_file
  if (call.name === 'create_file') {
    return (
      <DiffResultView
        call={call}
        result={result}
        args={args}
        oldText=""
        newText={args.content ?? ''}
        startLine={1}
      />
    )
  }

  // 4. list_files: clean list of project files with lines/size
  if (call.name === 'list_files') {
    const files: any[] = Array.isArray(result)
      ? result
      : Array.isArray(result?.files)
        ? result.files
        : []

    if (files.length > 0) {
      return (
        <div className="ai-assist-tool-detail-files">
          {files.map((file: any, idx: number) => (
            <div key={file.path || idx} className="ai-assist-file-row">
              <FileLink path={file.path} openFile={openFile}>
                {file.path}
              </FileLink>
              <span className="ai-assist-file-meta">
                {file.lines != null
                  ? `${file.lines} lines`
                  : file.size != null
                    ? `${Math.max(1, Math.round(file.size / 1024))} KB`
                    : file.type}
              </span>
            </div>
          ))}
        </div>
      )
    }
  }

  // 5. get_outline: clean section hierarchy with line numbers
  if (call.name === 'get_outline' || call.name === 'outline_project') {
    const sections: any[] = Array.isArray(result?.sections)
      ? result.sections
      : []
    const packages: string[] = Array.isArray(result?.packages)
      ? result.packages
      : []

    if (sections.length > 0 || packages.length > 0) {
      return (
        <div className="ai-assist-tool-detail-outline">
          {result?.documentClass && (
            <div className="ai-assist-outline-class">
              Document class: <code>{result.documentClass}</code>
            </div>
          )}
          {sections.map((sec: any, idx: number) => (
            <div
              key={`${sec.path ?? ''}:${sec.line ?? 0}:${idx}`}
              className="ai-assist-outline-section"
              style={{
                paddingLeft: `${Math.max(0, (sec.level ?? 1) - 1) * 12}px`,
              }}
            >
              <span className="ai-assist-outline-line">Line {sec.line}:</span>
              <span
                role="button"
                tabIndex={0}
                className="ai-assist-file-link"
                onClick={() => openFile(sec.path, sec.line)}
                onKeyDown={e =>
                  (e.key === 'Enter' || e.key === ' ') &&
                  openFile(sec.path, sec.line)
                }
              >
                {sec.title}
              </span>
            </div>
          ))}
          {packages.length > 0 && (
            <div className="ai-assist-outline-packages">
              Packages: {packages.slice(0, 10).join(', ')}
              {packages.length > 10 ? ` +${packages.length - 10} more` : ''}
            </div>
          )}
        </div>
      )
    }
  }

  // 6. compile_project & get_compile_result
  if (
    call.name === 'compile_project' ||
    call.name === 'get_compile_result' ||
    call.name === 'get_compile_log'
  ) {
    const errors = Array.isArray(result?.errors) ? result.errors : []
    const warnings = Array.isArray(result?.warnings) ? result.warnings : []

    if (errors.length > 0 || warnings.length > 0) {
      return (
        <div className="ai-assist-tool-detail-log">
          {errors.map((err: any, idx: number) => (
            <CompileLogEntry
              key={`err-${err.file ?? ''}:${err.line ?? 0}:${idx}`}
              entry={err}
              level="error"
              openFile={openFile}
            />
          ))}
          {warnings.slice(0, 5).map((warn: any, idx: number) => (
            <CompileLogEntry
              key={`warn-${warn.file ?? ''}:${warn.line ?? 0}:${idx}`}
              entry={warn}
              level="warning"
              openFile={openFile}
            />
          ))}
        </div>
      )
    }

    if (result?.status === 'success') {
      return (
        <div className="ai-assist-tool-detail-success">
          ✓ Compiled successfully with 0 errors and 0 warnings.
        </div>
      )
    }

    if (result?.status === 'none') {
      return (
        <div className="ai-assist-tool-detail-note">
          No previous compile log available.
        </div>
      )
    }
  }

  // 6b. view_compiled_pdf_page: which source lines the page shows, thumbnail preview,
  // the block it was zoomed on, its bad boxes, and any text read from it.
  if (
    call.name === 'view_compiled_pdf_page' &&
    (typeof result?.page === 'number' ||
      typeof args?.page === 'number' ||
      typeof args?.line === 'number' ||
      typeof args?.path === 'string')
  ) {
    return (
      <PdfPageDetail
        result={result}
        args={args}
        openFile={openFile}
      />
    )
  }

  // 6c. view_compiled_pdf_overview: overview thumbnails, the paper and any font problems,
  // then each page's source and what it flags
  if (
    call.name === 'view_compiled_pdf_overview' &&
    (Array.isArray(result?.pages) ||
      result?.pageCount != null ||
      args?.fromPage != null)
  ) {
    return (
      <PdfOverviewDetail
        result={result}
        openFile={openFile}
      />
    )
  }

  // 6d. search_compiled_pdf: each match, where it sits, and its source
  if (call.name === 'search_compiled_pdf' && Array.isArray(result?.matches)) {
    const matches: any[] = result.matches
    const query: string =
      typeof result.query === 'string'
        ? result.query
        : typeof args.query === 'string'
          ? args.query
          : ''
    if (matches.length === 0) {
      return (
        <div className="ai-assist-tool-detail-outline">
          <PdfDetailHeader
            parts={[
              t('ai_assist_tool_pdf_search_none', {
                query,
                defaultValue: `No matches for "${query}"`,
              }),
            ]}
          />
        </div>
      )
    }
    const total =
      typeof result.matchCount === 'number' ? result.matchCount : matches.length
    // The pages the shown matches fall on, as one range
    let firstPage = Infinity
    let lastPage = -Infinity
    let n = 0
    for (const match of matches) {
      if (typeof match?.page === 'number') {
        if (match.page < firstPage) firstPage = match.page
        if (match.page > lastPage) lastPage = match.page
        n++
      }
    }
    const pagesLabel =
      n === 0
        ? undefined
        : firstPage === lastPage
          ? t('ai_assist_tool_pdf_search_page', {
              page: firstPage,
              defaultValue: `page ${firstPage}`,
            })
          : t('ai_assist_tool_pdf_search_pages', {
              first: firstPage,
              last: lastPage,
              defaultValue: `pages ${firstPage}–${lastPage}`,
            })
    return (
      <div className="ai-assist-tool-detail-outline">
        <PdfDetailHeader
          parts={[
            t('ai_assist_tool_pdf_search_matches', {
              count: total,
              query,
              defaultValue: `${total} ${total === 1 ? 'match' : 'matches'} for "${query}"`,
            }),
            pagesLabel,
          ]}
        />
        <div className="ai-assist-tool-detail-search">
          {matches.map((match: any, idx: number) => {
            const context =
              typeof match?.context === 'string'
                ? match.context
                : typeof match?.text === 'string'
                  ? match.text
                  : ''
            const line = match?.line ?? undefined
            return (
              <div
                key={`pdf-match-${match?.page}:${match?.y}:${idx}`}
                className="ai-assist-search-hit"
              >
                <span className="ai-assist-search-loc">
                  {t('ai_assist_tool_pdf_page_badge', {
                    page: match?.page,
                    defaultValue: `p${match?.page}`,
                  })}
                  {typeof match?.y === 'number' ? ` · ${match.y}%` : ''}
                </span>
                {typeof match?.path === 'string' && (
                  <FileLink
                    path={match.path}
                    line={line}
                    openFile={openFile}
                  />
                )}
                <span className="ai-assist-search-text">
                  {highlightQuery(context, query)}
                </span>
              </div>
            )
          })}
          {result.truncated && (
            <div className="ai-assist-tool-detail-note">
              {t('ai_assist_tool_pdf_search_showing', {
                count: total,
                shown: matches.length,
                defaultValue: `showing ${matches.length} of ${total}`,
              })}
            </div>
          )}
        </div>
      </div>
    )
  }

  // 6e. resolve_pdf_block: the block's page and the source lines it came from
  if (call.name === 'resolve_pdf_block') {
    return <PdfBlockDetail result={result} args={args} openFile={openFile} />
  }

  // 6f. diff_compiled_pdf: what each page changed since the build before
  if (call.name === 'diff_compiled_pdf') {
    return <PdfDiffDetail result={result} />
  }

  // 6g. inspect_compiled_style: the measured style, and how it differs
  if (
    call.name === 'inspect_compiled_style' &&
    result?.style &&
    typeof result.style === 'object'
  ) {
    return <PdfStyleDetail result={result} />
  }

  // 6h. highlight_in_pdf: what was highlighted in the user's viewer
  if (call.name === 'highlight_in_pdf') {
    return (
      <PdfHighlightDetail result={result} args={args} openFile={openFile} />
    )
  }

  // 7. search_text
  if (call.name === 'search_text' || call.name === 'search_project') {
    const hits = Array.isArray(result?.hits) ? result.hits : []
    if (hits.length > 0) {
      return (
        <div className="ai-assist-tool-detail-search">
          {hits.map((hit: any, idx: number) => {
            if (typeof hit === 'string') {
              return (
                <div key={idx} className="ai-assist-search-hit">
                  {hit}
                </div>
              )
            }
            return (
              <div key={idx} className="ai-assist-search-hit">
                <span
                  role="button"
                  tabIndex={0}
                  className="ai-assist-file-link"
                  onClick={() => openFile(hit.path, hit.line)}
                  onKeyDown={e =>
                    e.key === 'Enter' && openFile(hit.path, hit.line)
                  }
                >
                  {hit.path}:{hit.line ?? '?'}
                </span>
                <span className="ai-assist-search-text">{hit.text}</span>
              </div>
            )
          })}
        </div>
      )
    }
    return (
      <div className="ai-assist-tool-detail-note">
        No matches found for &quot;{args.query}&quot;.
      </div>
    )
  }

  // 8. get_references
  if (
    (call.name === 'get_references' || call.name === 'list_references') &&
    result
  ) {
    return <ReferencesDetail result={result} openFile={openFile} />
  }

  // 9. web_search: the results as rows, like Claude.ai's search card
  if (call.name === 'web_search' && Array.isArray(result?.results)) {
    return (
      <div className="ai-assist-web-detail">
        {result.relaxed && (
          <div className="ai-assist-web-note">
            {t(
              'ai_assist_web_search_relaxed',
              'Nothing matched the date or news filter, so these are unfiltered results.'
            )}
          </div>
        )}
        {result.results.length === 0 ? (
          <div className="ai-assist-web-note">
            {t('ai_assist_web_search_empty', 'No results.')}
          </div>
        ) : (
          result.results.map((entry: any, idx: number) => (
            <WebPageRow
              key={`${entry.url}-${idx}`}
              url={entry.url}
              title={entry.title}
              hint={
                [entry.title, entry.published].filter(Boolean).join(' · ') ||
                undefined
              }
            />
          ))
        )}
      </div>
    )
  }

  // 10. web_fetch: the page read, and which part of it
  if (call.name === 'web_fetch') {
    const url =
      (typeof result?.url === 'string'
        ? result.url
        : typeof args?.url === 'string'
          ? args.url
          : '') || ''
    const notes = result ? webFetchNotes(result) : []
    const hasMatches =
      Array.isArray(result?.matches) && result.matches.length > 0
    const hasContent =
      typeof result?.content === 'string' && result.content.trim().length > 0
    const hasText =
      typeof result?.text === 'string' && result.text.trim().length > 0
    const outputText = hasContent
      ? result.content
      : hasText
        ? result.text
        : typeof result === 'string'
          ? result
          : null

    return (
      <div className="ai-assist-web-fetch-detail">
        <div className="ai-assist-web-fetch-header">
          {url ? (
            <PageAddress url={url} />
          ) : (
            <span className="ai-assist-web-fetch-url is-missing">
              {result?.title || t('ai_assist_web_fetch_no_url', 'Web page')}
            </span>
          )}
          {notes.length > 0 && (
            <span
              className="ai-assist-web-fetch-notes"
              title={notes.map(note => note.title).join('\n')}
            >
              {notes.map(note => (
                <span key={note.label} className="ai-assist-web-fetch-note">
                  {note.label}
                </span>
              ))}
            </span>
          )}
        </div>
        <div className="ai-assist-web-fetch-box">
          {hasMatches ? (
            <div className="ai-assist-web-fetch-content">
              {result.matches.map((match: any, idx: number) => (
                <div key={`${match.heading ?? 'passage'}:${match.page ?? 0}:${idx}`} className="ai-assist-web-fetch-passage">
                  {(match.heading ||
                    (typeof match.page === 'number' &&
                      result?.totalPages > 1)) && (
                    <div className="ai-assist-web-fetch-heading">
                      {match.heading ||
                        t('ai_assist_web_fetch_passage', 'Passage')}
                      {typeof match.page === 'number' && result?.totalPages > 1
                        ? ` (page ${match.page})`
                        : ''}
                    </div>
                  )}
                  <MarkdownContent content={match.text || ''} baseUrl={url} />
                </div>
              ))}
            </div>
          ) : typeof result?.find === 'string' ? (
            <div className="ai-assist-web-note">
              No passages found mentioning &quot;{result.find}&quot;.
            </div>
          ) : outputText ? (
            <div className="ai-assist-web-fetch-content">
              <MarkdownContent content={outputText} baseUrl={url} />
            </div>
          ) : (
            <div className="ai-assist-web-note">No content available.</div>
          )}
        </div>
      </div>
    )
  }

  // 11. list_available_settings
  if (call.name === 'list_available_settings') {
    const options = result?.options ?? (typeof result === 'object' ? result : null)
    if (options) {
      return <ListAvailableSettingsDetail options={options} />
    }
  }

  // 12. get_project_settings
  if (call.name === 'get_project_settings') {
    const settings = result?.settings ?? (typeof result === 'object' ? result : null)
    if (settings) {
      return <GetProjectSettingsDetail settings={settings} openFile={openFile} />
    }
  }

  // 13. configure settings tools
  if (
    call.name === 'configure_appearance_settings' ||
    call.name === 'configure_editor_settings' ||
    call.name === 'configure_compiler_settings' ||
    call.name === 'configure_project_settings'
  ) {
    return <ConfigureSettingsDetail call={call} result={result} />
  }

  // Generic / fallback tool: show formatted key-values rather than an unstyled pre
  return <GenericToolDetail call={call} result={result} />
}

function ReferencesDetail({
  result,
  openFile,
}: {
  result: any
  openFile: (path: string, line?: number) => void
}) {
  if (!result || typeof result !== 'object') return null
  const labels = Array.isArray(result.labels) ? result.labels : []
  const duplicateLabels = Array.isArray(result.duplicateLabels)
    ? result.duplicateLabels
    : []
  const refs = Array.isArray(result.refs) ? result.refs : []
  const citations = Array.isArray(result.citations) ? result.citations : []
  const bibKeys = Array.isArray(result.bibKeys) ? result.bibKeys : []

  const totalItems =
    labels.length +
    duplicateLabels.length +
    refs.length +
    citations.length +
    bibKeys.length

  if (totalItems === 0) {
    return (
      <div className="ai-assist-tool-detail-note">
        No labels, references, or citations found in project.
      </div>
    )
  }

  return (
    <div className="ai-assist-tool-detail-refs">
      {duplicateLabels.length > 0 && (
        <div className="ai-assist-refs-warning">
          <strong>Duplicate labels:</strong> {duplicateLabels.join(', ')}
        </div>
      )}

      {refs.length > 0 && (
        <div className="ai-assist-refs-section">
          <div className="ai-assist-refs-section-title">
            Cross-References ({refs.length})
          </div>
          <div className="ai-assist-refs-list">
            {refs.map((r: any, idx: number) => (
              <div
                key={`ref-${idx}`}
                className={`ai-assist-ref-item ${r.resolved ? 'is-resolved' : 'is-unresolved'}`}
              >
                <span className="ai-assist-ref-cmd">
                  \{r.command || 'ref'}&#123;{r.key}&#125;
                </span>
                <span
                  role="button"
                  tabIndex={0}
                  className="ai-assist-file-link"
                  onClick={() => r.path && openFile(r.path, r.line)}
                  onKeyDown={e =>
                    e.key === 'Enter' && r.path && openFile(r.path, r.line)
                  }
                >
                  {r.path}:{r.line ?? '?'}
                </span>
                <span
                  className={`ai-assist-ref-badge ${r.resolved ? 'resolved' : 'unresolved'}`}
                >
                  {r.resolved ? '✓ OK' : '✗ Unresolved'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {citations.length > 0 && (
        <div className="ai-assist-refs-section">
          <div className="ai-assist-refs-section-title">
            Citations ({citations.length})
          </div>
          <div className="ai-assist-refs-list">
            {citations.map((c: any, idx: number) => (
              <div
                key={`cite-${idx}`}
                className={`ai-assist-ref-item ${c.resolved ? 'is-resolved' : 'is-unresolved'}`}
              >
                <span className="ai-assist-ref-cmd">
                  \{c.command || 'cite'}&#123;{c.key}&#125;
                </span>
                <span
                  role="button"
                  tabIndex={0}
                  className="ai-assist-file-link"
                  onClick={() => c.path && openFile(c.path, c.line)}
                  onKeyDown={e =>
                    e.key === 'Enter' && c.path && openFile(c.path, c.line)
                  }
                >
                  {c.path}:{c.line ?? '?'}
                </span>
                <span
                  className={`ai-assist-ref-badge ${c.resolved ? 'resolved' : 'unresolved'}`}
                >
                  {c.resolved ? '✓ OK' : '✗ Missing'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {labels.length > 0 && (
        <div className="ai-assist-refs-section">
          <div className="ai-assist-refs-section-title">
            Labels ({labels.length})
          </div>
          <div className="ai-assist-refs-list">
            {labels.slice(0, 30).map((l: any, idx: number) => (
              <div key={`lbl-${idx}`} className="ai-assist-ref-item">
                <span className="ai-assist-ref-cmd">
                  \label&#123;{l.key}&#125;
                </span>
                <span
                  role="button"
                  tabIndex={0}
                  className="ai-assist-file-link"
                  onClick={() => l.path && openFile(l.path, l.line)}
                  onKeyDown={e =>
                    e.key === 'Enter' && l.path && openFile(l.path, l.line)
                  }
                >
                  {l.path}:{l.line ?? '?'}
                </span>
              </div>
            ))}
            {labels.length > 30 && (
              <div className="ai-assist-tool-detail-note">
                +{labels.length - 30} more labels
              </div>
            )}
          </div>
        </div>
      )}

      {bibKeys.length > 0 && (
        <div className="ai-assist-refs-section">
          <div className="ai-assist-refs-section-title">
            Bibliography Entries ({bibKeys.length})
          </div>
          <div className="ai-assist-refs-list">
            {bibKeys.slice(0, 30).map((b: any, idx: number) => (
              <div key={`bib-${idx}`} className="ai-assist-ref-item">
                <span className="ai-assist-ref-cmd">@{b.key}</span>
                <span
                  role="button"
                  tabIndex={0}
                  className="ai-assist-file-link"
                  onClick={() => b.path && openFile(b.path, b.line)}
                  onKeyDown={e =>
                    e.key === 'Enter' && b.path && openFile(b.path, b.line)
                  }
                >
                  {b.path}:{b.line ?? '?'}
                </span>
              </div>
            ))}
            {bibKeys.length > 30 && (
              <div className="ai-assist-tool-detail-note">
                +{bibKeys.length - 30} more entries
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

const SETTING_LABELS: Record<string, string> = {
  overallTheme: 'Overall Theme',
  editorTheme: 'Editor Theme',
  editorLightTheme: 'Editor Light Theme',
  editorDarkTheme: 'Editor Dark Theme',
  darkModePdf: 'Dark Mode PDF',
  fontSize: 'Font Size',
  fontFamily: 'Font Family',
  lineHeight: 'Line Spacing',
  compiler: 'Compiler Engine',
  imageName: 'TeX Live Version',
  rootDocPath: 'Root Document',
  rootDocId: 'Root Doc ID',
  draft: 'Draft Mode',
  stopOnFirstError: 'Stop on Error',
  mode: 'Keybinding Mode',
  autoComplete: 'Auto-complete',
  autoPairDelimiters: 'Auto-close Brackets',
  syntaxValidation: 'Syntax Validation',
  pdfViewer: 'PDF Viewer',
  mathPreview: 'Math Preview',
  breadcrumbs: 'Breadcrumbs Bar',
  editorTabs: 'Editor Tabs',
  spellCheckLanguage: 'Spell-check Language',
}

function list<T = any>(val: unknown): T[] {
  return Array.isArray(val) ? (val as T[]) : []
}

function ListAvailableSettingsDetail({ options }: { options: any }) {
  if (!options || typeof options !== 'object') return null
  const compilers: string[] = list(options.compilers)
  const imageNames: any[] = list(options.imageNames)
  const overallThemes: string[] = list(options.overallThemes)
  const editorThemes: string[] = Array.isArray(options.editorThemes)
    ? options.editorThemes.map((t: any) =>
        typeof t === 'string' ? t : t.name
      )
    : []
  const fontFamilies: any[] = list(options.fontFamilies)
  const editorModes: string[] = list(options.editorModes)
  const lineHeights: string[] = list(options.lineHeights)
  const spellCheckLanguages: any[] = list(options.spellCheckLanguages)
  const pdfViewers: string[] = options.pdfViewers || ['pdfjs', 'native']

  return (
    <div className="ai-assist-settings-detail">
      {compilers.length > 0 && (
        <div className="ai-assist-settings-group">
          <span className="ai-assist-settings-group-label">
            LaTeX Compilers
          </span>
          <div className="ai-assist-settings-chips">
            {compilers.map(c => (
              <span key={c} className="ai-assist-settings-chip">
                {c}
              </span>
            ))}
          </div>
        </div>
      )}

      {imageNames.length > 0 && (
        <div className="ai-assist-settings-group">
          <span className="ai-assist-settings-group-label">
            TeX Live Versions
          </span>
          <div className="ai-assist-settings-chips">
            {imageNames.map((img: any) => (
              <span
                key={img.imageName || img}
                className="ai-assist-settings-chip"
                title={img.imageDesc}
              >
                {img.imageDesc || img.imageName || img}
              </span>
            ))}
          </div>
        </div>
      )}

      {editorThemes.length > 0 && (
        <div className="ai-assist-settings-group">
          <span className="ai-assist-settings-group-label">
            Editor Syntax Themes
          </span>
          <div className="ai-assist-settings-chips">
            {editorThemes.map(theme => (
              <span key={theme} className="ai-assist-settings-chip">
                {theme}
              </span>
            ))}
          </div>
        </div>
      )}

      {overallThemes.length > 0 && (
        <div className="ai-assist-settings-group">
          <span className="ai-assist-settings-group-label">Overall Themes</span>
          <div className="ai-assist-settings-chips">
            {overallThemes.map(t => (
              <span key={t} className="ai-assist-settings-chip">
                {t}
              </span>
            ))}
          </div>
        </div>
      )}

      {editorModes.length > 0 && (
        <div className="ai-assist-settings-group">
          <span className="ai-assist-settings-group-label">
            Keybinding Modes
          </span>
          <div className="ai-assist-settings-chips">
            {editorModes.map(m => (
              <span key={m} className="ai-assist-settings-chip">
                {m}
              </span>
            ))}
          </div>
        </div>
      )}

      {fontFamilies.length > 0 && (
        <div className="ai-assist-settings-group">
          <span className="ai-assist-settings-group-label">Code Fonts</span>
          <div className="ai-assist-settings-chips">
            {fontFamilies.map((f: any) => (
              <span
                key={f.name || f}
                className="ai-assist-settings-chip"
                title={f.label}
              >
                {f.label ? `${f.name} (${f.label})` : f.name || f}
              </span>
            ))}
          </div>
        </div>
      )}

      {lineHeights.length > 0 && (
        <div className="ai-assist-settings-group">
          <span className="ai-assist-settings-group-label">Line Spacing</span>
          <div className="ai-assist-settings-chips">
            {lineHeights.map(lh => (
              <span key={lh} className="ai-assist-settings-chip">
                {lh}
              </span>
            ))}
          </div>
        </div>
      )}

      {spellCheckLanguages.length > 0 && (
        <div className="ai-assist-settings-group">
          <span className="ai-assist-settings-group-label">
            Spellcheck Languages
          </span>
          <div className="ai-assist-settings-chips">
            {spellCheckLanguages.slice(0, 14).map((lang: any) => (
              <span
                key={lang.code || lang}
                className="ai-assist-settings-chip"
              >
                {lang.name
                  ? `${lang.name} (${lang.code})`
                  : lang.code || lang}
              </span>
            ))}
            {spellCheckLanguages.length > 14 && (
              <span className="ai-assist-settings-chip-more">
                +{spellCheckLanguages.length - 14} more
              </span>
            )}
          </div>
        </div>
      )}

      {pdfViewers.length > 0 && (
        <div className="ai-assist-settings-group">
          <span className="ai-assist-settings-group-label">PDF Viewer</span>
          <div className="ai-assist-settings-chips">
            {pdfViewers.map(v => (
              <span key={v} className="ai-assist-settings-chip">
                {v}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function GetProjectSettingsDetail({
  settings,
  openFile,
}: {
  settings: any
  openFile: (path: string) => void
}) {
  if (!settings || typeof settings !== 'object') return null
  const { compiler, appearance, editor, spelling, name, description } =
    settings

  return (
    <div className="ai-assist-settings-detail">
      {name && (
        <div className="ai-assist-settings-section-header">
          <strong>Project:</strong> {name}
          {description ? ` — ${description}` : ''}
        </div>
      )}

      {compiler && (
        <div className="ai-assist-settings-group">
          <span className="ai-assist-settings-group-label">Compiler</span>
          <div className="ai-assist-settings-rows">
            <div className="ai-assist-settings-row">
              <span className="ai-assist-settings-key">Compiler:</span>
              <span className="ai-assist-settings-val">
                {compiler.compiler || 'pdflatex'}
              </span>
            </div>
            <div className="ai-assist-settings-row">
              <span className="ai-assist-settings-key">TeX Live:</span>
              <span className="ai-assist-settings-val">
                {compiler.imageName || 'default'}
              </span>
            </div>
            {compiler.rootDocPath && (
              <div className="ai-assist-settings-row">
                <span className="ai-assist-settings-key">Root Doc:</span>
                <span
                  role="button"
                  tabIndex={0}
                  className="ai-assist-file-link"
                  onClick={() => openFile(compiler.rootDocPath)}
                  onKeyDown={e =>
                    e.key === 'Enter' && openFile(compiler.rootDocPath)
                  }
                >
                  {compiler.rootDocPath}
                </span>
              </div>
            )}
            <div className="ai-assist-settings-row">
              <span className="ai-assist-settings-key">Draft Mode:</span>
              <span className="ai-assist-settings-val">
                {compiler.draft ? 'Enabled' : 'Disabled'}
              </span>
            </div>
            <div className="ai-assist-settings-row">
              <span className="ai-assist-settings-key">Stop on Error:</span>
              <span className="ai-assist-settings-val">
                {compiler.stopOnFirstError ? 'Enabled' : 'Disabled'}
              </span>
            </div>
          </div>
        </div>
      )}

      {appearance && (
        <div className="ai-assist-settings-group">
          <span className="ai-assist-settings-group-label">Appearance</span>
          <div className="ai-assist-settings-rows">
            <div className="ai-assist-settings-row">
              <span className="ai-assist-settings-key">Overall Theme:</span>
              <span className="ai-assist-settings-val">
                {appearance.overallTheme || 'system'}
              </span>
            </div>
            <div className="ai-assist-settings-row">
              <span className="ai-assist-settings-key">Editor Theme:</span>
              <span className="ai-assist-settings-val">
                {appearance.editorTheme || 'textmate'}
              </span>
            </div>
            <div className="ai-assist-settings-row">
              <span className="ai-assist-settings-key">Font Size:</span>
              <span className="ai-assist-settings-val">
                {appearance.fontSize ?? 12}px
              </span>
            </div>
            {appearance.fontFamily && (
              <div className="ai-assist-settings-row">
                <span className="ai-assist-settings-key">Font Family:</span>
                <span className="ai-assist-settings-val">
                  {appearance.fontFamily}
                </span>
              </div>
            )}
            {appearance.lineHeight && (
              <div className="ai-assist-settings-row">
                <span className="ai-assist-settings-key">Line Spacing:</span>
                <span className="ai-assist-settings-val">
                  {appearance.lineHeight}
                </span>
              </div>
            )}
            <div className="ai-assist-settings-row">
              <span className="ai-assist-settings-key">Dark Mode PDF:</span>
              <span className="ai-assist-settings-val">
                {appearance.darkModePdf ? 'Enabled' : 'Disabled'}
              </span>
            </div>
          </div>
        </div>
      )}

      {editor && (
        <div className="ai-assist-settings-group">
          <span className="ai-assist-settings-group-label">
            Editor Behavior
          </span>
          <div className="ai-assist-settings-rows">
            <div className="ai-assist-settings-row">
              <span className="ai-assist-settings-key">Keybindings:</span>
              <span className="ai-assist-settings-val">
                {editor.mode || 'none'}
              </span>
            </div>
            <div className="ai-assist-settings-row">
              <span className="ai-assist-settings-key">Auto-complete:</span>
              <span className="ai-assist-settings-val">
                {editor.autoComplete ? 'On' : 'Off'}
              </span>
            </div>
            <div className="ai-assist-settings-row">
              <span className="ai-assist-settings-key">
                Auto-close Brackets:
              </span>
              <span className="ai-assist-settings-val">
                {editor.autoPairDelimiters ? 'On' : 'Off'}
              </span>
            </div>
            <div className="ai-assist-settings-row">
              <span className="ai-assist-settings-key">
                Syntax Validation:
              </span>
              <span className="ai-assist-settings-val">
                {editor.syntaxValidation ? 'On' : 'Off'}
              </span>
            </div>
            <div className="ai-assist-settings-row">
              <span className="ai-assist-settings-key">PDF Viewer:</span>
              <span className="ai-assist-settings-val">
                {editor.pdfViewer || 'pdfjs'}
              </span>
            </div>
            <div className="ai-assist-settings-row">
              <span className="ai-assist-settings-key">Math Preview:</span>
              <span className="ai-assist-settings-val">
                {editor.mathPreview ? 'On' : 'Off'}
              </span>
            </div>
          </div>
        </div>
      )}

      {spelling?.spellCheckLanguage && (
        <div className="ai-assist-settings-group">
          <span className="ai-assist-settings-group-label">Spelling</span>
          <div className="ai-assist-settings-rows">
            <div className="ai-assist-settings-row">
              <span className="ai-assist-settings-key">Language:</span>
              <span className="ai-assist-settings-val">
                {spelling.spellCheckLanguage}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function ConfigureSettingsDetail({
  call,
  result,
}: {
  call: ToolCallRecord
  result: any
}) {
  const args = (call.args ?? {}) as Record<string, any>
  const updated = (result?.updatedSettings ?? args) as Record<string, any>
  const keys = Object.keys(updated).filter(
    k => k !== 'status' && k !== 'message'
  )
  const message = result?.message || 'Settings updated successfully.'

  const formatValue = (key: string, val: any) => {
    if (typeof val === 'boolean') return val ? 'Enabled' : 'Disabled'
    if (key === 'fontSize' && typeof val === 'number') return `${val}px`
    return String(val ?? '')
  }

  return (
    <div className="ai-assist-settings-detail">
      <div className="ai-assist-tool-detail-success">✓ {message}</div>
      {keys.length > 0 && (
        <div className="ai-assist-settings-rows">
          {keys.map(key => (
            <div key={key} className="ai-assist-settings-row">
              <span className="ai-assist-settings-key">
                {SETTING_LABELS[key] || key}:
              </span>
              <span className="ai-assist-settings-val">
                {formatValue(key, updated[key])}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function GenericToolDetail({
  call,
  result,
}: {
  call: ToolCallRecord
  result: any
}) {
  const callArgsObj =
    call.args && typeof call.args === 'object' && !Array.isArray(call.args)
      ? (call.args as Record<string, unknown>)
      : null
  const hasArgs = Boolean(callArgsObj && Object.keys(callArgsObj).length > 0)
  const resultObj =
    result && typeof result === 'object' && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : null
  const hasResult = Boolean(resultObj && Object.keys(resultObj).length > 0)

  if (!hasArgs && !hasResult) {
    if (typeof result === 'string' && result.trim()) {
      return <div className="ai-assist-tool-detail-text">{result}</div>
    }
    return (
      <div className="ai-assist-tool-detail-note">
        No additional parameters.
      </div>
    )
  }

  return (
    <div className="ai-assist-tool-detail-generic">
      {hasArgs && callArgsObj && (
        <div className="ai-assist-settings-rows">
          {Object.entries(callArgsObj).map(([k, v]) => (
            <div key={`arg-${k}`} className="ai-assist-settings-row">
              <span className="ai-assist-settings-key">{k}:</span>
              <span className="ai-assist-settings-val">
                {typeof v === 'object' ? JSON.stringify(v) : String(v)}
              </span>
            </div>
          ))}
        </div>
      )}
      {typeof result === 'string' && result.trim() && hasArgs && (
        <div className="ai-assist-tool-detail-text">{result}</div>
      )}
      {hasResult && resultObj && (
        <div className="ai-assist-settings-rows">
          {Object.entries(resultObj).map(([k, v]) => (
            <div key={`res-${k}`} className="ai-assist-settings-row">
              <span className="ai-assist-settings-key">{k}:</span>
              <span className="ai-assist-settings-val">
                {typeof v === 'object' ? JSON.stringify(v) : String(v)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
