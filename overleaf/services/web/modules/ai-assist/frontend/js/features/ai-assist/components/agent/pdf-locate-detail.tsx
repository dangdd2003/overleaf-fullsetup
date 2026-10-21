import { useTranslation } from 'react-i18next'
import { FileLink, PdfDetailHeader } from './pdf-tool-shared'

// Result views for the tools that point at a place in the PDF: resolve_pdf_block
// (a labelled block to its source lines) and highlight_in_pdf (what the user's
// viewer now shows highlighted).

/** A source range as `path:12` or `path:12–18`. */
function rangeLabel(path: string, line?: number, endLine?: number): string {
  if (line == null) return path
  const end = endLine != null && endLine > line ? `–${endLine}` : ''
  return `${path}:${line}${end}`
}

/** Page numbers as ranges: 1–3, 5. */
export function pageRangeText(pages: unknown[]): string {
  const sorted = [
    ...new Set(pages.filter((page): page is number => Number.isInteger(page))),
  ].sort((a, b) => a - b)
  const ranges: Array<[number, number]> = []
  for (const page of sorted) {
    const last = ranges[ranges.length - 1]
    if (last && page === last[1] + 1) last[1] = page
    else ranges.push([page, page])
  }
  return ranges
    .map(([from, to]) => (from === to ? `${from}` : `${from}–${to}`))
    .join(', ')
}

/** The block a model named from a PDF view, and the source lines behind it. */
export function PdfBlockDetail({
  result,
  args,
  openFile,
}: {
  result: any
  args: any
  openFile: (path: string, line?: number) => void
}) {
  const { t } = useTranslation()
  const block =
    typeof result?.block === 'string' ? result.block : (args?.block ?? '')
  const page =
    typeof result?.page === 'number'
      ? result.page
      : typeof args?.page === 'number'
        ? args.page
        : undefined
  const path = typeof result?.path === 'string' ? result.path : ''
  const line = typeof result?.line === 'number' ? result.line : undefined
  const endLine =
    typeof result?.endLine === 'number' ? result.endLine : undefined

  return (
    <div className="ai-assist-tool-detail-outline ai-assist-tool-detail-pdf-block">
      <PdfDetailHeader
        parts={[
          block &&
            t('ai_assist_tool_pdf_block_title', {
              block,
              defaultValue: `Block ${block}`,
            }),
          page !== undefined &&
            t('ai_assist_tool_pdf_block_page', {
              page,
              defaultValue: `Page ${page}`,
            }),
        ]}
      />

      {path && (
        <div className="ai-assist-outline-section ai-assist-pdf-page-row">
          {page !== undefined && (
            <span className="ai-assist-outline-line ai-assist-pdf-page-badge">
              p{page}
            </span>
          )}
          <FileLink path={path} line={line} openFile={openFile}>
            {rangeLabel(path, line, endLine)}
          </FileLink>
        </div>
      )}
    </div>
  )
}

/** What the user's PDF viewer now highlights: where, on which pages, and whether it is stale. */
export function PdfHighlightDetail({
  result,
  args,
  openFile,
}: {
  result: any
  args: any
  openFile: (path: string, line?: number) => void
}) {
  const { t } = useTranslation()
  const pages: number[] = Array.isArray(result?.pages)
    ? result.pages.filter((page: unknown): page is number =>
        Number.isInteger(page)
      )
    : []
  const count =
    typeof result?.count === 'number'
      ? result.count
      : Array.isArray(result?.highlights)
        ? result.highlights.length
        : 0
  const sourcePath = typeof args?.path === 'string' ? args.path : ''
  const hasBoxes = args?.boxes !== undefined && args?.boxes !== null
  const pageText = pageRangeText(pages)

  return (
    <div className="ai-assist-tool-detail-outline ai-assist-tool-detail-pdf-highlight">
      <PdfDetailHeader
        parts={[
          t('ai_assist_tool_pdf_highlight_title', {
            count,
            defaultValue: `Highlighted ${count} ${count === 1 ? 'area' : 'areas'}`,
          }),
          pages.length > 0 &&
            t('ai_assist_tool_pdf_highlight_pages', {
              count: pages.length,
              pages: pageText,
              defaultValue: `${pages.length === 1 ? 'page' : 'pages'} ${pageText}`,
            }),
        ]}
      />

      {sourcePath && (
        <div className="ai-assist-outline-section">
          <span className="ai-assist-outline-line">
            {t('ai_assist_tool_pdf_highlight_source', 'Source:')}
          </span>
          <FileLink
            path={sourcePath}
            line={typeof args?.line === 'number' ? args.line : undefined}
            openFile={openFile}
          >
            {rangeLabel(
              sourcePath,
              typeof args?.line === 'number' ? args.line : undefined,
              typeof args?.endLine === 'number' ? args.endLine : undefined
            )}
          </FileLink>
        </div>
      )}

      {!sourcePath && hasBoxes && pages.length > 0 && (
        <div className="ai-assist-outline-section ai-assist-pdf-page-row">
          {pages.map(page => (
            <span
              key={page}
              className="ai-assist-outline-line ai-assist-pdf-page-badge"
            >
              p{page}
            </span>
          ))}
        </div>
      )}

      {result?.stale === true && (
        <div className="ai-assist-pdf-warning">
          {t(
            'ai_assist_tool_pdf_highlight_stale',
            'The PDF is older than your last edit, so the highlight may be off. Recompile to refresh it.'
          )}
        </div>
      )}

      {count === 0 ? (
        <div className="ai-assist-tool-detail-note">
          {t(
            'ai_assist_tool_pdf_highlight_none',
            'Nothing to highlight in the current PDF.'
          )}
        </div>
      ) : (
        <div className="ai-assist-tool-detail-note">
          {t(
            'ai_assist_tool_pdf_highlight_shown',
            'Shown in your PDF viewer; the project is unchanged.'
          )}
        </div>
      )}
    </div>
  )
}
