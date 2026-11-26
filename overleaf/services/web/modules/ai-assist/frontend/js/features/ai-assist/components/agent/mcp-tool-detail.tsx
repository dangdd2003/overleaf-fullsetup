import { ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ToolCallRecord } from '../../agent/agent-messages'
import {
  ConnectorOutcome,
  connectorOutcome,
  McpLinkItem,
  mcpLinkItems,
  OutputSegment,
  outputSegments,
  parseJsonOutput,
} from '../../agent/mcp-tool-output'
import { WebPageRow } from './web-page-row'
import { MarkdownContent } from './markdown-content'
import { CopyToClipboard } from '@/shared/components/copy-to-clipboard'
import type { TranslateFn } from './pdf-tool-shared'

/** Past this many characters, or lines, a value or output is clamped. */
const LONG_TEXT_CHARS = 250
const LONG_TEXT_LINES = 3
const MAX_CHIPS = 12
/** Past this many pages, a list of pages is clamped. */
const LINK_ROWS = 6

const isPrimitive = (value: unknown) =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value)

const isLong = (text: string, lines: number) =>
  text.length > LONG_TEXT_CHARS || text.split('\n').length > lines

function ShowMoreChevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`ai-assist-tool-call-chevron ${open ? 'is-expanded' : ''}`}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      width="11"
      height="11"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="6 4 10 8 6 12" />
    </svg>
  )
}

/**
 * Content that is clamped when it is long, with a toggle to open it. A
 * short one is shown whole, with no toggle.
 */
function ClampedBlock({
  long,
  className,
  children,
}: {
  long: boolean
  className: string
  children: ReactNode
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  if (!long) return <div className={className}>{children}</div>

  return (
    <div className="ai-assist-mcp-clamp-wrap">
      <div
        className={`${className} ai-assist-mcp-clamp ${open ? 'is-open' : 'is-collapsed'}`}
      >
        {children}
      </div>
      <button
        type="button"
        className="ai-assist-mcp-more"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {open
          ? t('ai_assist_mcp_show_less', 'Show less')
          : t('ai_assist_mcp_show_more', 'Show more')}
        <ShowMoreChevron open={open} />
      </button>
    </div>
  )
}

/** One input argument: its value plainly, a list as chips, an object as JSON. */
function InputValue({ value }: { value: unknown }) {
  const { t } = useTranslation()

  if (typeof value === 'string') {
    if (value === '') {
      return <span className="ai-assist-mcp-scalar">&quot;&quot;</span>
    }
    return (
      <ClampedBlock long={isLong(value, 4)} className="ai-assist-mcp-text">
        {value}
      </ClampedBlock>
    )
  }

  if (isPrimitive(value)) {
    return <span className="ai-assist-mcp-scalar">{String(value)}</span>
  }

  if (Array.isArray(value) && value.every(isPrimitive)) {
    if (value.length === 0) {
      return <span className="ai-assist-mcp-scalar">[]</span>
    }
    const shown = value.slice(0, MAX_CHIPS)
    const rest = value.length - shown.length
    return (
      <div className="ai-assist-mcp-chips">
        {shown.map((item, index) => (
          <span key={index} className="ai-assist-mcp-chip">
            {String(item)}
          </span>
        ))}
        {rest > 0 && (
          <span className="ai-assist-mcp-chip is-more">
            {t('ai_assist_mcp_more_count', {
              count: rest,
              defaultValue: `+${rest} more`,
            })}
          </span>
        )}
      </div>
    )
  }

  const json = JSON.stringify(value, null, 2) ?? String(value)
  return (
    <ClampedBlock long={isLong(json, 4)} className="ai-assist-mcp-code-wrap">
      <pre className="ai-assist-mcp-code">{json}</pre>
    </ClampedBlock>
  )
}

/** The page the result came from, in words: "12,345 characters · showing page 1 …" */
function pagingLabel(outcome: ConnectorOutcome, t: TranslateFn): string {
  const parts: string[] = []
  if (outcome.chars != null) {
    const chars = outcome.chars.toLocaleString('en-US')
    parts.push(
      t('ai_assist_mcp_characters', {
        count: outcome.chars,
        defaultValue: `${chars} characters`,
      })
    )
  }
  if (outcome.page) {
    const { page, pages, more } = outcome.page
    parts.push(
      more
        ? t('ai_assist_mcp_page_more', {
            defaultValue: `showing page ${page} of ${pages} — the assistant can read more`,
          })
        : t('ai_assist_mcp_page_end', {
            defaultValue: `page ${page} of ${pages}, the end`,
          })
    )
  }
  return parts.join(' · ')
}

function OutputBody({
  body,
  segments,
  json,
  links,
}: {
  body: string
  segments: OutputSegment[]
  json?: string
  links: McpLinkItem[] | null
}) {
  // A list of pages reads as one, like the built-in web search
  if (links) {
    return (
      <ClampedBlock
        long={links.length > LINK_ROWS}
        className="ai-assist-mcp-links ai-assist-web-detail"
      >
        {links.map((link, index) => (
          <WebPageRow
            key={`${link.url}-${index}`}
            url={link.url}
            title={link.title}
            hint={[link.title, link.date].filter(Boolean).join(' · ') || undefined}
          />
        ))}
      </ClampedBlock>
    )
  }

  if (json !== undefined) {
    return (
      <ClampedBlock
        long={isLong(json, LONG_TEXT_LINES)}
        className="ai-assist-mcp-code-wrap"
      >
        <pre className="ai-assist-mcp-code">{json}</pre>
      </ClampedBlock>
    )
  }

  return (
    <ClampedBlock
      long={isLong(body, LONG_TEXT_LINES)}
      className="ai-assist-mcp-md-wrap"
    >
      {segments.map((segment, index) =>
        segment.kind === 'image' ? (
          <ImagePlaceholder key={index} mime={segment.mime} />
        ) : (
          <div key={index} className="ai-assist-mcp-md">
            <MarkdownContent content={segment.text} />
          </div>
        )
      )}
    </ClampedBlock>
  )
}

function ImagePlaceholder({ mime }: { mime: string }) {
  const { t } = useTranslation()
  return (
    <span className="ai-assist-mcp-image">
      {t('ai_assist_mcp_image', {
        mime,
        defaultValue: `Image (${mime})`,
      })}
    </span>
  )
}

function OutputSection({
  call,
  outcome,
}: {
  call: ToolCallRecord
  outcome: ConnectorOutcome
}) {
  const { t } = useTranslation()

  const { segments, json, links, hasOutput } = useMemo(() => {
    const segs = outputSegments(outcome.body)
    const isAllText = segs.every((segment) => segment.kind === 'text')
    const parsed = isAllText ? parseJsonOutput(outcome.body) : undefined
    const hasOut = segs.some(
      (segment) => segment.kind === 'image' || segment.text.trim() !== ''
    )
    return {
      segments: segs,
      json:
        parsed !== undefined ? JSON.stringify(parsed, null, 2) : undefined,
      links: parsed !== undefined ? mcpLinkItems(parsed) : null,
      hasOutput: hasOut,
    }
  }, [outcome.body])

  if (outcome.isError) {
    return (
      <div className="ai-assist-tool-detail-error" role="alert">
        ✗{' '}
        {outcome.error ||
          outcome.raw ||
          t('ai_assist_mcp_failed', 'The tool failed.')}
      </div>
    )
  }

  const label = [
    links
      ? t('ai_assist_mcp_pages', {
          count: links.length,
          defaultValue: `${links.length} page${links.length === 1 ? '' : 's'}`,
        })
      : '',
    pagingLabel(outcome, t),
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="ai-assist-mcp-output">
      {(label || outcome.raw.trim() !== '') && (
        <div className="ai-assist-mcp-output-head">
          {label && <span className="ai-assist-mcp-meta">{label}</span>}
          {outcome.raw.trim() !== '' && (
            <CopyToClipboard
              content={outcome.raw}
              tooltipId={`ai-assist-copy-mcp-${call.id}`}
            />
          )}
        </div>
      )}
      {hasOutput ? (
        <OutputBody
          body={outcome.body}
          segments={segments}
          json={json}
          links={links}
        />
      ) : (
        <div className="ai-assist-mcp-empty">
          {t('ai_assist_mcp_no_output', 'No output')}
        </div>
      )}
      {outcome.truncated && (
        <div className="ai-assist-tool-detail-note">
          {t('ai_assist_mcp_trimmed', 'Output trimmed in saved history')}
        </div>
      )}
      {outcome.notice && (
        <div className="ai-assist-tool-detail-note">{outcome.notice}</div>
      )}
    </div>
  )
}

/**
 * A connector tool's call: its arguments as rows, then what the connector
 * returned, with a long result clamped and paged the way the backend pages it.
 */
export function McpToolDetail({
  call,
  result,
}: {
  call: ToolCallRecord
  result: unknown
}) {
  const { t } = useTranslation()
  const args =
    call.args && typeof call.args === 'object' && !Array.isArray(call.args)
      ? (call.args as Record<string, unknown>)
      : null
  const argEntries = args ? Object.entries(args) : []
  const running = result === undefined
  const outcome = useMemo(
    () => (running ? null : connectorOutcome(result, Boolean(call.isError))),
    [result, call.isError, running]
  )

  return (
    <div className="ai-assist-mcp-detail">
      {argEntries.length > 0 && (
        <div className="ai-assist-mcp-section">
          <div className="ai-assist-mcp-label">
            {t('ai_assist_mcp_input', 'Input')}
          </div>
          <div className="ai-assist-mcp-rows">
            {argEntries.map(([name, value]) => (
              <div key={name} className="ai-assist-mcp-row">
                <span className="ai-assist-mcp-key" title={name}>
                  {name}
                </span>
                <div className="ai-assist-mcp-val">
                  <InputValue value={value} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {running || !outcome ? (
        <div className="ai-assist-mcp-section">
          <div className="ai-assist-mcp-label">
            {t('ai_assist_mcp_output', 'Output')}
          </div>
          <div className="ai-assist-mcp-empty">
            {t('ai_assist_tool_running', 'Running…')}
          </div>
        </div>
      ) : (
        <div className="ai-assist-mcp-section">
          <div className="ai-assist-mcp-label">
            {t('ai_assist_mcp_output', 'Output')}
          </div>
          <OutputSection call={call} outcome={outcome} />
        </div>
      )}
    </div>
  )
}
