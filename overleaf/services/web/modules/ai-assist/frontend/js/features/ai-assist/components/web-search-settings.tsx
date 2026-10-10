import { Fragment, ReactNode, useEffect, useState } from 'react'
import classNames from 'classnames'
import OLButton from '@/shared/components/ol/ol-button'
import OLIconButton from '@/shared/components/ol/ol-icon-button'
import OLTooltip from '@/shared/components/ol/ol-tooltip'
import OLFormControl from '@/shared/components/ol/ol-form-control'
import OLFormSelect from '@/shared/components/ol/ol-form-select'
import OLFormSwitch from '@/shared/components/ol/ol-form-switch'
import Setting from '@/features/ide-settings/components/setting'
import { SiteIcon } from './agent/site-icon'
import { WebSearchProviderType } from '../providers/types'

/**
 * Building blocks for the web search provider cards. Each option is one row
 * in the layout of Overleaf's own editor settings: its name and what it does
 * on the left, a compact control on the right.
 */

export const WEB_SEARCH_LABELS: Record<WebSearchProviderType, string> = {
  ollama: 'Ollama web search',
  searxng: 'SearXNG',
  websearchapi: 'WebSearchAPI.ai',
  tavily: 'Tavily',
  firecrawl: 'Firecrawl',
  firecrawlSelfHosted: 'Firecrawl (self-hosted)',
  jina: 'Jina AI',
  langsearch: 'LangSearch',
  exa: 'Exa',
  tinyfish: 'TinyFish',
  parallel: 'Parallel',
  mcp: 'MCP WebSearch',
}

export const WEB_SEARCH_NOTES: Record<WebSearchProviderType, string> = {
  searxng:
    'Your own SearXNG instances, no key needed. This server searches through them and reads pages itself.',
  ollama:
    "Ollama's hosted web search. Searches and page reads both go through ollama.com.",
  websearchapi:
    'Hosted search and page reading through api.websearchapi.ai. Every search and page read uses credits.',
  tavily:
    'Hosted search and page reading through api.tavily.com. Every search and page read uses credits.',
  firecrawl:
    'Hosted search and page reading through api.firecrawl.dev. Every search and page read uses credits.',
  firecrawlSelfHosted:
    'Your own Firecrawl instances for search and page reading. Search needs SEARXNG_ENDPOINT set on the instance.',
  jina: 'Hosted search and page reading through s.jina.ai and r.jina.ai. Every search and page read uses tokens.',
  langsearch:
    'Hosted search through api.langsearch.com. Search uses credits; pages are read by this server.',
  exa: 'Hosted neural and keyword search and page reading through api.exa.ai. Every search and page read uses credits.',
  tinyfish:
    'Hosted search through api.search.tinyfish.ai with X-API-Key. Free up to daily allowance; pages are read by this server.',
  parallel:
    'Hosted search and page extraction through api.parallel.ai. Every search and page read uses credits.',
  mcp: 'Custom POST endpoint accepting {q} JSON and returning search results, or remote MCP WebSearch server.',
}

/**
 * Where to learn about each provider and get what it needs to be set up. The
 * icon is the favicon of `icon`: SearXNG's docs site has none, so its icon
 * comes from the project's public instance list.
 */
export const WEB_SEARCH_LINKS: Record<
  WebSearchProviderType,
  { icon: string; links: { label: string; href: string }[] }
> = {
  searxng: {
    icon: 'https://searx.space',
    links: [
      { label: 'Website', href: 'https://docs.searxng.org' },
      {
        label: 'Installation guide',
        href: 'https://docs.searxng.org/admin/installation.html',
      },
      {
        label: 'Enable JSON output',
        href: 'https://docs.searxng.org/admin/settings/settings_search.html',
      },
    ],
  },
  ollama: {
    icon: 'https://ollama.com',
    links: [
      { label: 'Website', href: 'https://ollama.com' },
      {
        label: 'Web search docs',
        href: 'https://docs.ollama.com/capabilities/web-search',
      },
      { label: 'Get API keys', href: 'https://ollama.com/settings/keys' },
    ],
  },
  websearchapi: {
    icon: 'https://websearchapi.ai',
    links: [
      { label: 'Website', href: 'https://websearchapi.ai' },
      { label: 'API docs', href: 'https://websearchapi.ai/docs' },
      { label: 'Get API keys', href: 'https://websearchapi.ai/dashboard' },
    ],
  },
  tavily: {
    icon: 'https://tavily.com',
    links: [
      { label: 'Website', href: 'https://tavily.com' },
      {
        label: 'API docs',
        href: 'https://docs.tavily.com/documentation/api-reference/introduction',
      },
      { label: 'Get API keys', href: 'https://app.tavily.com' },
    ],
  },
  firecrawl: {
    icon: 'https://www.firecrawl.dev',
    links: [
      { label: 'Website', href: 'https://www.firecrawl.dev' },
      {
        label: 'API docs',
        href: 'https://docs.firecrawl.dev/api-reference/v2-introduction',
      },
      { label: 'Get API keys', href: 'https://www.firecrawl.dev/app/api-keys' },
    ],
  },
  firecrawlSelfHosted: {
    icon: 'https://www.firecrawl.dev',
    links: [
      { label: 'Website', href: 'https://github.com/firecrawl/firecrawl' },
      {
        label: 'Self-hosting guide',
        href: 'https://docs.firecrawl.dev/contributing/self-host',
      },
      {
        label: 'API docs',
        href: 'https://docs.firecrawl.dev/api-reference/v2-introduction',
      },
    ],
  },
  jina: {
    icon: 'https://jina.ai',
    links: [
      { label: 'Website', href: 'https://jina.ai' },
      { label: 'API docs', href: 'https://jina.ai/reader' },
      {
        label: 'Get API keys',
        href: 'https://jina.ai/api-dashboard/key-manager',
      },
    ],
  },
  langsearch: {
    icon: 'https://langsearch.com',
    links: [
      { label: 'Website', href: 'https://langsearch.com' },
      { label: 'API docs', href: 'https://docs.langsearch.com' },
      { label: 'Get API keys', href: 'https://langsearch.com' },
    ],
  },
  exa: {
    icon: 'https://exa.ai',
    links: [
      { label: 'Website', href: 'https://exa.ai' },
      { label: 'API docs', href: 'https://docs.exa.ai' },
      { label: 'Get API keys', href: 'https://dashboard.exa.ai/api-keys' },
    ],
  },
  tinyfish: {
    icon: 'https://tinyfish.ai',
    links: [
      { label: 'Website', href: 'https://tinyfish.ai' },
      {
        label: 'API docs',
        href: 'https://docs.tinyfish.ai/search-api/reference',
      },
      { label: 'Get API keys', href: 'https://agent.tinyfish.ai/api-keys' },
    ],
  },
  parallel: {
    icon: 'https://parallel.ai',
    links: [
      { label: 'Website', href: 'https://parallel.ai' },
      { label: 'API docs', href: 'https://docs.parallel.ai' },
      { label: 'Get API keys', href: 'https://platform.parallel.ai' },
    ],
  },
  mcp: {
    icon: 'https://modelcontextprotocol.io',
    links: [
      { label: 'MCP Documentation', href: 'https://modelcontextprotocol.io' },
      {
        label: 'Connectors Guide',
        href: 'https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool',
      },
    ],
  },
}

/** A provider: its name, what it is, where to set it up, and an on switch. */
export function ProviderCard({
  type,
  enabled,
  onToggle,
  summary,
  isExpanded = false,
  onToggleExpand,
  onRemove,
  children,
}: {
  type: WebSearchProviderType
  enabled: boolean
  onToggle: (enabled: boolean) => void
  summary?: string
  isExpanded?: boolean
  onToggleExpand?: () => void
  onRemove?: () => void
  children: ReactNode
}) {
  const id = `ai-web-search-${type}-enabled`
  return (
    <div
      className={classNames('web-search-provider-card', {
        'is-expanded': isExpanded,
        'is-collapsed': !isExpanded,
      })}
    >
      <div className="web-search-provider-header">
        <div className="web-search-provider-title-group">
          <SiteIcon url={WEB_SEARCH_LINKS[type].icon} />
          <span className="web-search-provider-name">
            {WEB_SEARCH_LABELS[type]}
          </span>
          {summary && (
            <span className="web-search-provider-summary">
              · {summary}
              {!enabled ? ' (Disabled)' : ''}
            </span>
          )}
        </div>
        <div className="web-search-provider-actions">
          <OLFormSwitch
            id={id}
            label=""
            checked={enabled}
            onChange={e => onToggle(e.target.checked)}
          />
          {onToggleExpand && (
            <OLButton
              variant="secondary"
              size="sm"
              type="button"
              onClick={onToggleExpand}
              aria-label={`${isExpanded ? 'Done configuring' : 'Configure'} ${WEB_SEARCH_LABELS[type]}`}
            >
              {isExpanded ? 'Done' : 'Edit'}
            </OLButton>
          )}
          {onRemove && (
            <OLButton
              variant="danger-ghost"
              size="sm"
              type="button"
              onClick={onRemove}
              aria-label={`Remove ${WEB_SEARCH_LABELS[type]}`}
            >
              Remove
            </OLButton>
          )}
        </div>
      </div>
      {isExpanded ? (
        <div className="web-search-provider-body">
          <p className="web-search-provider-note">{WEB_SEARCH_NOTES[type]}</p>
          <p className="web-search-provider-links">
            {WEB_SEARCH_LINKS[type].links.map(({ label, href }, index) => (
              <Fragment key={href}>
                {index > 0 ? ' · ' : null}
                <a href={href} target="_blank" rel="noopener noreferrer">
                  {label}
                </a>
              </Fragment>
            ))}
          </p>
          {children}
          {onToggleExpand && (
            <div className="d-flex justify-content-end mt-3">
              <OLButton
                variant="secondary"
                size="sm"
                type="button"
                onClick={onToggleExpand}
              >
                Done
              </OLButton>
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

/** A heading for one of a provider's APIs, e.g. its Search or Scraper API. */
export function ApiHeading({
  title,
  description,
}: {
  title: string
  description: ReactNode
}) {
  return (
    <div className="web-search-api-heading">
      <h6>{title}</h6>
      <p>{description}</p>
    </div>
  )
}

/** A group of rows under a divider title, as in the editor's settings. */
export function SettingsGroup({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <div className="web-search-settings-group">
      <div className="ide-settings-section-title">{title}</div>
      {children}
    </div>
  )
}

export function TextSetting({
  id,
  label,
  description,
  value,
  placeholder,
  onChange,
  wide = false,
  type = 'text',
  min,
  max,
}: {
  id: string
  label: string
  description: ReactNode
  value: string
  placeholder: string
  onChange: (value: string) => void
  wide?: boolean
  type?: 'text' | 'number'
  min?: number
  max?: number
}) {
  return (
    <Setting controlId={id} label={label} description={description}>
      <OLFormControl
        id={id}
        size="sm"
        type={type}
        min={min}
        max={max}
        className={classNames('web-search-setting-input', {
          'is-wide': wide,
        })}
        value={value}
        placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
      />
    </Setting>
  )
}

type DatePart = 'day' | 'month' | 'year'
type DateParts = Record<DatePart, string>

/** The order this browser's locale writes a date in, such as day/month/year. */
function localeDateOrder(): DatePart[] {
  const order = new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
  })
    .formatToParts(new Date(2000, 11, 31))
    .map(part => part.type)
    .filter(
      (type): type is DatePart =>
        type === 'day' || type === 'month' || type === 'year'
    )
  return order.length === 3 ? order : ['year', 'month', 'day']
}

function dateParts(value: string): DateParts {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  return match
    ? {
        year: match[1],
        month: String(Number(match[2])),
        day: String(Number(match[3])),
      }
    : { year: '', month: '', day: '' }
}

function daysIn(parts: DateParts) {
  return parts.year && parts.month
    ? new Date(Number(parts.year), Number(parts.month), 0).getDate()
    : 31
}

/**
 * A date picked from day, month and year dropdowns, in the order and month
 * names of the browser's locale. The value is YYYY-MM-DD, or '' until all
 * three are chosen.
 */
export function DateSetting({
  id,
  label,
  description,
  value,
  onChange,
}: {
  id: string
  label: string
  description: ReactNode
  value: string
  onChange: (value: string) => void
}) {
  const [parts, setParts] = useState(() => dateParts(value))

  // Follow a value set from outside, such as when the form is reset
  useEffect(() => {
    const next = dateParts(value)
    if (value && next.year) setParts(next)
    else if (!value) {
      setParts(current =>
        current.year && current.month && current.day
          ? { year: '', month: '', day: '' }
          : current
      )
    }
  }, [value])

  const choose = (part: DatePart, choice: string) => {
    const next = { ...parts, [part]: choice }
    if (next.day && Number(next.day) > daysIn(next)) {
      next.day = String(daysIn(next))
    }
    setParts(next)
    onChange(
      next.year && next.month && next.day
        ? `${next.year}-${next.month.padStart(2, '0')}-${next.day.padStart(2, '0')}`
        : ''
    )
  }

  const monthName = new Intl.DateTimeFormat(undefined, { month: 'short' })
  const thisYear = new Date().getFullYear()
  const choices: Record<DatePart, { value: string; label: string }[]> = {
    day: Array.from({ length: daysIn(parts) }, (_, i) => ({
      value: String(i + 1),
      label: String(i + 1),
    })),
    month: Array.from({ length: 12 }, (_, i) => ({
      value: String(i + 1),
      label: monthName.format(new Date(2000, i, 1)),
    })),
    year: Array.from({ length: thisYear - 1989 }, (_, i) => ({
      value: String(thisYear - i),
      label: String(thisYear - i),
    })),
  }
  const names: Record<DatePart, string> = {
    day: 'Day',
    month: 'Month',
    year: 'Year',
  }

  return (
    <Setting
      controlId={`${id}-${localeDateOrder()[0]}`}
      label={label}
      description={description}
    >
      <div className="web-search-date-setting">
        {localeDateOrder().map(part => (
          <OLFormSelect
            key={part}
            id={`${id}-${part}`}
            size="sm"
            aria-label={`${label}: ${names[part].toLowerCase()}`}
            value={parts[part]}
            onChange={e => choose(part, e.target.value)}
          >
            <option value="">{names[part]}</option>
            {choices[part].map(choice => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </OLFormSelect>
        ))}
      </div>
    </Setting>
  )
}

/** Several values of one kind, such as API keys or instance URLs. */
export function ListSetting({
  id,
  label,
  description,
  itemLabel,
  values,
  placeholder,
  secret = false,
  onChange,
}: {
  id: string
  label: string
  description: ReactNode
  itemLabel: string
  values: string[]
  placeholder: string
  secret?: boolean
  onChange: (values: string[]) => void
}) {
  return (
    <>
      <Setting controlId={`${id}-0`} label={label} description={description}>
        <OLButton
          variant="secondary"
          size="sm"
          type="button"
          onClick={() => onChange([...values, ''])}
        >
          Add {itemLabel}
        </OLButton>
      </Setting>
      <div className="web-search-setting-list">
        {values.map((value, idx) => (
          <div key={idx} className="d-flex gap-2 align-items-center">
            <OLFormControl
              id={`${id}-${idx}`}
              size="sm"
              type={secret ? 'password' : 'text'}
              autoComplete="off"
              value={value}
              placeholder={placeholder}
              onChange={e => {
                const next = [...values]
                next[idx] = e.target.value
                onChange(next)
              }}
            />
            {values.length > 1 && (
              <OLTooltip id={`${id}-remove-${idx}`} description="Remove">
                <span>
                  <OLIconButton
                    variant="danger-ghost"
                    size="sm"
                    type="button"
                    onClick={() => onChange(values.filter((_, i) => i !== idx))}
                    accessibilityLabel={`Remove ${itemLabel} ${idx + 1}`}
                    icon="delete"
                  />
                </span>
              </OLTooltip>
            )}
          </div>
        ))}
      </div>
    </>
  )
}
