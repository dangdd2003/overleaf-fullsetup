import { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { PdfDetailHeader } from './pdf-tool-shared'

type TranslateFn = (key: string, opts?: any) => string

/** A measured value as the server tags it: number plus where it was found. */
function measured(
  value: unknown
): { v: number; by?: string } | undefined {
  const raw =
    value && typeof value === 'object' ? (value as any).v : value
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined
  const by =
    value && typeof value === 'object' && typeof (value as any).by === 'string'
      ? (value as any).by
      : undefined
  return { v: Math.round(raw * 10) / 10, by }
}

/** A number as text, rounded to one decimal, or undefined when absent. */
function plain(value: unknown): string | undefined {
  const m = measured(value)
  return m ? String(m.v) : undefined
}

/** One settings-style row. Renders nothing when there is no value. */
function StyleRow({
  label,
  value,
  by,
}: {
  label: string
  value: string | undefined
  by?: string
}) {
  if (!value) return null
  return (
    <div className="ai-assist-settings-row">
      <span className="ai-assist-settings-key">{label}</span>
      <span className="ai-assist-settings-val">
        {value}
        {by && <span className="ai-assist-outline-line"> · {by}</span>}
      </span>
    </div>
  )
}

/** Labels for the compared properties, keyed by the prop name the server sends. */
const PROP_LABELS: Record<string, [string, string]> = {
  'area.w': ['text_width', 'Text width'],
  'area.h': ['text_height', 'Text height'],
  'area.left': ['left_margin', 'Left margin'],
  'area.right': ['right_margin', 'Right margin'],
  'area.top': ['top_margin', 'Top margin'],
  'area.bottom': ['bottom_margin', 'Bottom margin'],
  'area.gutter': ['column_gap', 'Column gap'],
  'area.cols': ['columns', 'Columns'],
  'body.size': ['body_size', 'Body size'],
  'body.baseline': ['baseline_skip', 'Baseline skip'],
  'body.family': ['body_font', 'Body font'],
  parIndent: ['paragraph_indent', 'Paragraph indent'],
  parSkip: ['paragraph_skip', 'Paragraph skip'],
  'rules.table': ['table_rule', 'Table rule'],
  'rules.header': ['header_rule', 'Header rule'],
  'headings.1.size': ['section_size', 'Section size'],
  'headings.2.size': ['subsection_size', 'Subsection size'],
  'headings.1.before': ['section_before', 'Section space before'],
  'headings.1.after': ['section_after', 'Section space after'],
  'colors.text': ['text_colour', 'Text colour'],
}

/** A compared value as shown in a comparison row: lengths get their unit. */
function comparedValue(prop: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'number') {
    if (prop === 'area.cols') return String(value)
    return `${Math.round(value * 10) / 10} pt`
  }
  return String(value)
}

/**
 * The measured style of a compiled PDF, and where it differs from the
 * template the document should match.
 */
export function PdfStyleDetail({
  result,
}: {
  result: any
  openFile: (path: string, line?: number) => void
}) {
  const { t } = useTranslation()
  const style = result?.style
  if (!style || typeof style !== 'object') return null

  const tr: TranslateFn = t
  const pageCount =
    typeof style.pages === 'number'
      ? tr('ai_assist_tool_pdf_page_count', {
          count: style.pages,
          defaultValue: `${style.pages} page${style.pages === 1 ? '' : 's'}`,
        })
      : undefined

  const area = style.area && typeof style.area === 'object' ? style.area : {}
  const body = style.body && typeof style.body === 'object' ? style.body : {}
  const headings: any[] = Array.isArray(style.headings) ? style.headings : []
  const packages: string[] = Array.isArray(style.packages)
    ? style.packages.filter((p: unknown) => typeof p === 'string')
    : []
  const colours: unknown[] = Array.isArray(style.colours?.text)
    ? style.colours.text
    : []
  const textColours = colours
    .map(c => (Array.isArray(c) ? c[0] : undefined))
    .filter((hex): hex is string => typeof hex === 'string')
    .join(', ')

  const headingLevel = (level: unknown) =>
    tr('ai_assist_tool_pdf_style_heading_level', {
      level: String(level ?? '?'),
      defaultValue: `Heading ${level ?? '?'}`,
    })

  const diff = result?.diff
  const diffs: any[] = Array.isArray(diff?.diffs) ? diff.diffs : []
  const same = typeof diff?.same === 'number' ? diff.same : 0
  const total = same + diffs.length

  const labelFor = (prop: string) => {
    const entry = PROP_LABELS[prop]
    return entry
      ? tr(`ai_assist_tool_pdf_style_${entry[0]}`, { defaultValue: entry[1] })
      : prop
  }

  const areaCols = typeof area.cols === 'number' ? area.cols : undefined
  const fontName =
    (typeof body.font?.name === 'string' && body.font.name) ||
    (typeof body.font?.family === 'string' && body.font.family) ||
    undefined

  const areaRows: Array<[string, unknown]> = [
    [
      tr('ai_assist_tool_pdf_style_text_width', { defaultValue: 'Width' }),
      area.w,
    ],
    [
      tr('ai_assist_tool_pdf_style_text_height', { defaultValue: 'Height' }),
      area.h,
    ],
    [
      tr('ai_assist_tool_pdf_style_left_margin', { defaultValue: 'Left margin' }),
      area.left,
    ],
    [
      tr('ai_assist_tool_pdf_style_right_margin', {
        defaultValue: 'Right margin',
      }),
      area.right,
    ],
    [
      tr('ai_assist_tool_pdf_style_top_margin', { defaultValue: 'Top margin' }),
      area.top,
    ],
    [
      tr('ai_assist_tool_pdf_style_bottom_margin', {
        defaultValue: 'Bottom margin',
      }),
      area.bottom,
    ],
  ]

  const bodyRows: Array<[string, unknown]> = [
    [tr('ai_assist_tool_pdf_style_body_size', { defaultValue: 'Size' }), body.size],
    [
      tr('ai_assist_tool_pdf_style_baseline_skip', {
        defaultValue: 'Baseline skip',
      }),
      body.baseline,
    ],
    [
      tr('ai_assist_tool_pdf_style_paragraph_indent', {
        defaultValue: 'Paragraph indent',
      }),
      style.parIndent,
    ],
    [
      tr('ai_assist_tool_pdf_style_paragraph_skip', {
        defaultValue: 'Paragraph skip',
      }),
      style.parSkip,
    ],
  ]

  const rules = style.rules && typeof style.rules === 'object' ? style.rules : {}
  const ruleRows: Array<[string, unknown]> = [
    [
      tr('ai_assist_tool_pdf_style_table_rule', { defaultValue: 'Table rule' }),
      rules.table?.thicknessPt !== undefined
        ? { v: rules.table.thicknessPt, by: rules.table.by }
        : undefined,
    ],
    [
      tr('ai_assist_tool_pdf_style_header_rule', {
        defaultValue: 'Header rule',
      }),
      rules.header?.thicknessPt !== undefined
        ? { v: rules.header.thicknessPt, by: rules.header.by }
        : undefined,
    ],
  ]

  return (
    <div className="ai-assist-tool-detail-outline ai-assist-tool-detail-pdf-style">
      <PdfDetailHeader
        parts={[
          typeof style.paper === 'string' ? style.paper : undefined,
          typeof style.class === 'string' ? style.class : undefined,
          pageCount,
        ]}
      />

      <div className="ai-assist-outline-class">
        {tr('ai_assist_tool_pdf_style_text_area', { defaultValue: 'Text area' })}
      </div>
      <div className="ai-assist-settings-rows">
        {areaRows.map(([label, value]) => {
          const m = measured(value)
          return (
            <StyleRow
              key={label}
              label={`${label}:`}
              value={m ? `${m.v} pt` : undefined}
              by={m?.by}
            />
          )
        })}
        <StyleRow
          label={`${tr('ai_assist_tool_pdf_style_columns', { defaultValue: 'Columns' })}:`}
          value={areaCols !== undefined ? String(areaCols) : undefined}
        />
        <StyleRow
          label={`${tr('ai_assist_tool_pdf_style_column_gap', { defaultValue: 'Column gap' })}:`}
          value={plain(area.gutter) ? `${plain(area.gutter)} pt` : undefined}
        />
      </div>

      <div className="ai-assist-outline-class">
        {tr('ai_assist_tool_pdf_style_body_text', { defaultValue: 'Body text' })}
      </div>
      <div className="ai-assist-settings-rows">
        {bodyRows.map(([label, value]) => {
          const m = measured(value)
          return (
            <StyleRow
              key={label}
              label={`${label}:`}
              value={m ? `${m.v} pt` : undefined}
              by={m?.by}
            />
          )
        })}
        <StyleRow
          label={`${tr('ai_assist_tool_pdf_style_font', { defaultValue: 'Font' })}:`}
          value={fontName}
        />
        <StyleRow
          label={`${tr('ai_assist_tool_pdf_style_text_colour', { defaultValue: 'Text colour' })}:`}
          value={textColours || undefined}
        />
      </div>

      {headings.length > 0 && (
        <>
          <div className="ai-assist-outline-class">
            {tr('ai_assist_tool_pdf_style_headings', {
              defaultValue: 'Headings',
            })}
          </div>
          <div className="ai-assist-settings-rows">
            {headings.map((h: any, idx: number) => {
              const size = plain(h?.size)
              const flags = [
                h?.bold ? tr('ai_assist_tool_pdf_style_bold', { defaultValue: 'bold' }) : '',
                h?.font ? String(h.font) : '',
              ].filter(Boolean)
              const spacing =
                plain(h?.before) !== undefined || plain(h?.after) !== undefined
                  ? `${plain(h?.before) ?? '?'} / ${plain(h?.after) ?? '?'} pt`
                  : ''
              const value = [size ? `${size} pt` : '', ...flags, spacing]
                .filter(Boolean)
                .join(' · ')
              return (
                <StyleRow
                  key={`heading-${idx}`}
                  label={`${headingLevel(h?.lvl ?? idx + 1)}:`}
                  value={value || undefined}
                />
              )
            })}
          </div>
        </>
      )}

      {ruleRows.some(([, value]) => value !== undefined) && (
        <>
          <div className="ai-assist-outline-class">
            {tr('ai_assist_tool_pdf_style_rules', { defaultValue: 'Rules' })}
          </div>
          <div className="ai-assist-settings-rows">
            {ruleRows.map(([label, value]) => {
              const m = measured(value)
              return (
                <StyleRow
                  key={label}
                  label={`${label}:`}
                  value={m ? `${m.v} pt` : undefined}
                  by={m?.by}
                />
              )
            })}
          </div>
        </>
      )}

      {packages.length > 0 && (
        <div className="ai-assist-outline-packages">
          {tr('ai_assist_tool_pdf_style_packages_label', {
            defaultValue: 'Packages',
          })}
          : {packages.slice(0, 10).join(', ')}
          {packages.length > 10 ? ` +${packages.length - 10} more` : ''}
        </div>
      )}

      {diff && typeof diff === 'object' && (
        <>
          <div className="ai-assist-outline-class">
            {tr('ai_assist_tool_pdf_style_comparison', {
              defaultValue: 'Comparison',
            })}
          </div>
          {diffs.length === 0 ? (
            <div className="ai-assist-tool-detail-success">
              ✓{' '}
              {tr('ai_assist_tool_pdf_style_all_match', {
                count: same,
                defaultValue: `All ${same} compared properties match.`,
              })}
            </div>
          ) : (
            <>
              <div className="ai-assist-pdf-warning">
                {tr('ai_assist_tool_pdf_style_differ', {
                  differ: diffs.length,
                  total,
                  defaultValue: `${diffs.length} of ${total} compared properties differ.`,
                })}
              </div>
              <div className="ai-assist-settings-rows">
                {diffs.map((d: any, idx: number) => {
                  const prop = typeof d?.prop === 'string' ? d.prop : ''
                  const fix: ReactNode =
                    typeof d?.fix === 'string' && d.fix ? (
                      <>
                        {' '}
                        <code>{d.fix}</code>
                      </>
                    ) : null
                  return (
                    <div className="ai-assist-settings-row" key={`${prop}-${idx}`}>
                      <span className="ai-assist-settings-key">
                        {labelFor(prop)}:
                      </span>
                      <span className="ai-assist-settings-val">
                        {comparedValue(prop, d?.now)} →{' '}
                        {comparedValue(prop, d?.template)}
                        {fix}
                      </span>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
