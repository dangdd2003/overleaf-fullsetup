import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ImageLightbox } from './image-lightbox'
import {
  PdfDetailHeader,
  getPdfImages,
  formatPageRanges,
  type TranslateFn,
} from './pdf-tool-shared'

export { formatPageRanges }

export interface PdfDiffRegion {
  x: number
  y: number
  w: number
  h: number
  kind?: string
}

export interface PdfDiffShift {
  y?: number
  shiftPt?: number
}

export interface PdfDiffPage {
  page?: number | null
  beforePage?: number | null
  status?: string
  reason?: string
  changedFraction?: number
  regions?: PdfDiffRegion[]
  shiftedBelow?: PdfDiffShift
}

export interface PdfDiffResult {
  status?: string
  changed?: boolean
  beforeBuildId?: string
  afterBuildId?: string
  dpi?: number
  pageCount?: { before?: number; after?: number }
  pairing?: string
  pages?: PdfDiffPage[]
  unchangedPages?: number[]
  highlights?: unknown[]
  summary?: string[]
  images?: unknown[]
  truncated?: boolean
}

/** What one page of a diff changed, as short findings in the overview's wording */
function diffFindings(page: PdfDiffPage, t: TranslateFn): string[] {
  if (page.status === 'removed') {
    return [
      t('ai_assist_tool_pdf_diff_removed', {
        page: page.beforePage,
        defaultValue: `removed (was p${page.beforePage})`,
      }),
    ]
  }
  if (page.status === 'added') {
    return [t('ai_assist_tool_pdf_diff_new_page', 'new page')]
  }

  const findings: string[] = []
  if (page.reason === 'size_changed') {
    findings.push(
      t('ai_assist_tool_pdf_diff_size_changed', 'page size changed')
    )
  }

  const regions: PdfDiffRegion[] = Array.isArray(page.regions)
    ? page.regions.filter(
        (region): region is PdfDiffRegion =>
          typeof region?.y === 'number' && typeof region?.h === 'number'
      )
    : []
  // One range per kind: the top of the highest region to the bottom of the lowest
  for (const kind of ['changed', 'moved', 'added'] as const) {
    const ofKind = regions.filter(region => region.kind === kind)
    if (ofKind.length === 0) continue
    const top = Math.round(Math.min(...ofKind.map(region => region.y)) * 100)
    const bottom = Math.round(
      Math.max(...ofKind.map(region => region.y + region.h)) * 100
    )
    findings.push(
      `${t(`ai_assist_tool_pdf_diff_${kind}`, kind)} ${top}–${bottom}%`
    )
  }

  const shift = page.shiftedBelow
  if (typeof shift?.y === 'number' && typeof shift?.shiftPt === 'number') {
    const direction =
      shift.shiftPt >= 0
        ? t('ai_assist_tool_pdf_diff_down', 'down')
        : t('ai_assist_tool_pdf_diff_up', 'up')
    const pt = Math.abs(Math.round(shift.shiftPt))
    findings.push(
      t('ai_assist_tool_pdf_diff_shifted', {
        y: Math.round(shift.y * 100),
        direction,
        pt,
        defaultValue: `content below ${Math.round(shift.y * 100)}% shifted ${direction} ${pt} pt`,
      })
    )
  }

  if (findings.length === 0 && typeof page.changedFraction === 'number') {
    findings.push(
      t('ai_assist_tool_pdf_diff_fraction', {
        percent: Math.round(page.changedFraction * 100),
        defaultValue: `${Math.round(page.changedFraction * 100)}% changed`,
      })
    )
  }
  if (findings.length === 0) {
    findings.push(t('ai_assist_tool_pdf_diff_changed', 'changed'))
  }
  return findings
}

/**
 * The result of diff_compiled_pdf: each page that changed since the build
 * before, what changed on it, the pages that did not, and the changed regions
 * boxed on the new build's picture. Stored results may lack the per-page
 * detail, so the server's summary lines stand in for it.
 */
export function PdfDiffDetail({
  result,
}: {
  result: PdfDiffResult
}) {
  const { t } = useTranslation()
  const [previewImage, setPreviewImage] = useState<{
    src: string
    title: string
  } | null>(null)

  const pages: PdfDiffPage[] = Array.isArray(result?.pages)
    ? result.pages.filter((page): page is PdfDiffPage => Boolean(page && typeof page === 'object'))
    : []
  const summary: string[] = Array.isArray(result?.summary)
    ? result.summary.filter((line: unknown): line is string => typeof line === 'string')
    : []
  const unchanged: number[] = Array.isArray(result?.unchangedPages)
    ? result.unchangedPages.filter((page: unknown) => typeof page === 'number')
    : []

  const before = result?.pageCount?.before
  const after = result?.pageCount?.after
  const pageCountText =
    typeof before === 'number' && typeof after === 'number' && before !== after
      ? t('ai_assist_tool_pdf_diff_page_count', {
          before,
          after,
          defaultValue: `${before} → ${after} pages`,
        })
      : undefined

  const changed = result?.changed === true
  const headerTitle =
    pages.length > 0
      ? t('ai_assist_tool_pdf_diff_pages_changed', {
          count: pages.length,
          defaultValue: `${pages.length} page${pages.length === 1 ? '' : 's'} changed`,
        })
      : changed
        ? t('ai_assist_tool_pdf_diff_changed_title', 'Changed')
        : t('ai_assist_tool_pdf_diff_no_change', 'No visible change')

  const diffImages = getPdfImages(result)
  // Rows come from the per-page detail, or from the summary when it is missing
  const rows: Array<{ key: string; page?: any; text?: string }> =
    pages.length > 0
      ? pages.map((page: any, idx: number) => ({
          key: `pdf-diff-${page.page ?? page.beforePage ?? ''}:${idx}`,
          page,
        }))
      : summary.map((text, idx) => ({ key: `pdf-diff-summary-${idx}`, text }))

  return (
    <div className="ai-assist-tool-detail-outline ai-assist-tool-detail-pdf-diff">
      <PdfDetailHeader parts={[headerTitle, pageCountText]} />

      {diffImages.length > 0 && (
        <div className="ai-assist-pdf-image-container">
          {diffImages.map((img, idx) => (
            <div
              key={idx}
              className="ai-assist-pdf-image-thumb"
              role="button"
              tabIndex={0}
              title={t('ai_assist_click_to_zoom', 'Click to enlarge preview')}
              onClick={() =>
                setPreviewImage({
                  src: img.src,
                  title: t('ai_assist_tool_pdf_diff_regions', 'Changed regions'),
                })
              }
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  setPreviewImage({
                    src: img.src,
                    title: t('ai_assist_tool_pdf_diff_regions', 'Changed regions'),
                  })
                }
              }}
            >
              <img src={img.src} alt={img.alt} />
            </div>
          ))}
        </div>
      )}

      {rows.length > 0 ? (
        <div className="ai-assist-pdf-pages-list">
          {rows.map(row =>
            row.page ? (
              <div key={row.key} className="ai-assist-pdf-page has-findings">
                <div className="ai-assist-outline-section ai-assist-pdf-page-row">
                  <span className="ai-assist-outline-line ai-assist-pdf-page-badge">
                    p{row.page.status === 'removed' ? row.page.beforePage : row.page.page}
                  </span>
                  <span className="ai-assist-outline-findings is-flagged">
                    {diffFindings(row.page, t).join(' · ')}
                  </span>
                </div>
              </div>
            ) : (
              <div key={row.key} className="ai-assist-pdf-page has-findings">
                <div className="ai-assist-outline-section ai-assist-pdf-page-row">
                  <span className="ai-assist-outline-findings">{row.text}</span>
                </div>
              </div>
            )
          )}
        </div>
      ) : (
        !changed && (
          <div className="ai-assist-tool-detail-success">
            ✓{' '}
            {t(
              'ai_assist_tool_pdf_diff_none',
              'No visible change from the previous build.'
            )}
          </div>
        )
      )}

      {unchanged.length > 0 && (
        <div className="ai-assist-tool-detail-note">
          {t('ai_assist_tool_pdf_diff_unchanged', {
            pages: formatPageRanges(unchanged),
            count: unchanged.length,
            defaultValue: `Unchanged: ${unchanged.length === 1 ? 'page' : 'pages'} ${formatPageRanges(unchanged)}`,
          })}
        </div>
      )}

      {result?.truncated && (
        <div className="ai-assist-tool-detail-note">
          {t(
            'ai_assist_tool_pdf_diff_truncated',
            'More pages changed; pass pages to see the rest.'
          )}
        </div>
      )}

      {previewImage && (
        <ImageLightbox
          src={previewImage.src}
          title={previewImage.title}
          downloadName="pdf-diff.png"
          isOpen={Boolean(previewImage)}
          onClose={() => setPreviewImage(null)}
        />
      )}
    </div>
  )
}
