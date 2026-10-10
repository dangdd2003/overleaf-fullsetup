import ToggleSetting from '@/features/ide-settings/components/toggle-setting'
import DropdownSetting from '@/features/ide-settings/components/dropdown-setting'
import { ApiHeading, SettingsGroup, TextSetting } from './web-search-settings'
import {
  ParallelExtractOptions,
  ParallelProviderConfig,
  ParallelSearchMode,
  ParallelSearchOptions,
} from '../providers/types'

/**
 * The Parallel options as the form edits them: text as typed, and '' for "use the
 * API's default". parallelOptionsFromDraft turns it back into stored options.
 * See https://docs.parallel.ai/search/search-quickstart and https://docs.parallel.ai/extract
 */
export type ParallelDraft = {
  // Search options
  maxResults: string
  mode: '' | ParallelSearchMode
  location: string
  includeDomains: string
  excludeDomains: string
  afterDate: string
  maxCharsTotal: string
  maxCharsPerResult: string
  maxAgeSeconds: string
  timeoutSeconds: string
  disableCacheFallback: boolean

  // Extract / Read options
  readFullContent: boolean
  readMaxCharsPerResult: string
  readMaxAgeSeconds: string
  readTimeoutSeconds: string
  readDisableCacheFallback: boolean
}

type FlagKey = {
  [K in keyof ParallelDraft]: ParallelDraft[K] extends boolean ? K : never
}[keyof ParallelDraft]

export function draftFromParallel(
  config?: ParallelProviderConfig
): ParallelDraft {
  const search = config?.search ?? {}
  const read = config?.read ?? {}
  const number = (value?: number) => (value === undefined ? '' : String(value))
  const strings = (list?: string[]) => (list ?? []).join(', ')

  return {
    maxResults: number(search.maxResults),
    mode: search.mode ?? '',
    location: search.location ?? '',
    includeDomains: strings(search.includeDomains),
    excludeDomains: strings(search.excludeDomains),
    afterDate: search.afterDate ?? '',
    maxCharsTotal: number(search.maxCharsTotal),
    maxCharsPerResult: number(search.maxCharsPerResult),
    maxAgeSeconds: number(search.maxAgeSeconds),
    timeoutSeconds: number(search.timeoutSeconds),
    disableCacheFallback: search.disableCacheFallback ?? false,

    readFullContent: read.fullContent ?? true,
    readMaxCharsPerResult: number(read.maxCharsPerResult),
    readMaxAgeSeconds: number(read.maxAgeSeconds),
    readTimeoutSeconds: number(read.timeoutSeconds),
    readDisableCacheFallback: read.disableCacheFallback ?? false,
  }
}

function commaSeparated(text: string) {
  return text
    .split(/[\s,]+/)
    .map(item => item.trim())
    .filter(Boolean)
}

function withoutEmpty<T extends object>(object: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(object).filter(
      ([, value]) =>
        value !== undefined &&
        value !== '' &&
        !(Array.isArray(value) && value.length === 0)
    )
  ) as Partial<T>
}

function inRange(raw: string, min: number, max: number) {
  const parsed = Math.trunc(Number(raw))
  return raw.trim() && Number.isFinite(parsed)
    ? Math.min(max, Math.max(min, parsed))
    : undefined
}

function inFloat(raw: string, min: number, max: number) {
  const parsed = Number(raw.trim())
  return raw.trim() && Number.isFinite(parsed)
    ? Math.min(max, Math.max(min, parsed))
    : undefined
}

function cleanDate(raw: string) {
  const text = raw.trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : undefined
}

export function parallelOptionsFromDraft(draft: ParallelDraft): {
  search?: ParallelSearchOptions
  read?: ParallelExtractOptions
} {
  const search = withoutEmpty({
    maxResults: inRange(draft.maxResults, 1, 20),
    mode: draft.mode || undefined,
    location: draft.location.trim().toLowerCase().slice(0, 2) || undefined,
    includeDomains: commaSeparated(draft.includeDomains),
    excludeDomains: commaSeparated(draft.excludeDomains),
    afterDate: cleanDate(draft.afterDate),
    maxCharsTotal: inRange(draft.maxCharsTotal, 1, 10000000),
    maxCharsPerResult: inRange(draft.maxCharsPerResult, 1, 1000000),
    maxAgeSeconds: inRange(draft.maxAgeSeconds, 600, 31536000),
    timeoutSeconds: inFloat(draft.timeoutSeconds, 1, 120),
    disableCacheFallback: draft.disableCacheFallback ? true : undefined,
  }) as ParallelSearchOptions

  const read = withoutEmpty({
    fullContent: draft.readFullContent === false ? false : undefined,
    maxCharsPerResult: inRange(draft.readMaxCharsPerResult, 1, 1000000),
    maxAgeSeconds: inRange(draft.readMaxAgeSeconds, 600, 31536000),
    timeoutSeconds: inFloat(draft.readTimeoutSeconds, 1, 120),
    disableCacheFallback: draft.readDisableCacheFallback ? true : undefined,
  }) as ParallelExtractOptions

  return {
    ...(Object.keys(search).length > 0 ? { search } : {}),
    ...(Object.keys(read).length > 0 ? { read } : {}),
  }
}

type Choice = { value: string; label: string }

export default function ParallelOptions({
  draft,
  onChange,
}: {
  draft: ParallelDraft
  onChange: (next: ParallelDraft) => void
}) {
  const set = <K extends keyof ParallelDraft>(key: K, value: ParallelDraft[K]) =>
    onChange({ ...draft, [key]: value })

  const id = (key: keyof ParallelDraft) => `ai-web-search-parallel-${key}`

  const toggle = (key: FlagKey, label: string, description: string) => (
    <ToggleSetting
      id={id(key)}
      label={label}
      description={description}
      checked={draft[key]}
      onChange={value => set(key, value)}
    />
  )

  const dropdown = (
    key: Exclude<keyof ParallelDraft, FlagKey>,
    label: string,
    description: string,
    options: Choice[]
  ) => (
    <DropdownSetting
      id={id(key)}
      label={label}
      description={description}
      width="wide"
      options={options}
      value={draft[key] as string}
      onChange={value => set(key, value as ParallelDraft[typeof key])}
    />
  )

  const text = (
    key: Exclude<keyof ParallelDraft, FlagKey>,
    label: string,
    description: string,
    placeholder: string,
    extra: {
      wide?: boolean
      type?: 'number'
      min?: number
      max?: number
    } = {}
  ) => (
    <TextSetting
      id={id(key)}
      label={label}
      description={description}
      placeholder={placeholder}
      value={draft[key] as string}
      onChange={value => set(key, value as ParallelDraft[typeof key])}
      {...extra}
    />
  )

  return (
    <>
      <ApiHeading
        title="Search API"
        description="Used for every web_search. Blank fields use the default each one names."
      />
      <SettingsGroup title="Essentials">
        {text(
          'maxResults',
          'Results per search',
          'Number of results to return, from 1 to 20. Default 10.',
          '10',
          { type: 'number', min: 1, max: 20 }
        )}
        {dropdown(
          'mode',
          'Search mode',
          'Search speed and depth mode. Fast (~700ms) is recommended for agents.',
          [
            { value: '', label: 'Advanced (default)' },
            { value: 'turbo', label: 'Turbo (~300ms)' },
            { value: 'fast', label: 'Fast (~700ms)' },
            { value: 'basic', label: 'Basic (~500ms)' },
            { value: 'advanced', label: 'Advanced' },
          ]
        )}
        {text(
          'location',
          'Country',
          'Two-letter country code for geo-targeting, such as us or gb.',
          'us'
        )}
        {text(
          'afterDate',
          'Published after',
          'Only results published on or after this date (YYYY-MM-DD).',
          'YYYY-MM-DD'
        )}
        {text(
          'maxCharsTotal',
          'Total characters',
          'Maximum combined characters across all returned excerpts.',
          'Unlimited',
          { type: 'number', min: 1 }
        )}
        {text(
          'maxCharsPerResult',
          'Characters per excerpt',
          'Maximum character length for each returned excerpt.',
          'Unlimited',
          { type: 'number', min: 1 }
        )}
      </SettingsGroup>

      <SettingsGroup title="Domains">
        {text(
          'includeDomains',
          'Only these domains',
          'Return results from these domains, separated by commas.',
          'arxiv.org, ctan.org',
          { wide: true }
        )}
        {text(
          'excludeDomains',
          'Never these domains',
          'Leave out results from these domains, separated by commas.',
          'pinterest.com',
          { wide: true }
        )}
      </SettingsGroup>

      <SettingsGroup title="Timing & cache">
        {text(
          'timeoutSeconds',
          'Fetch timeout',
          'Seconds to wait for real-time page fetches (1–120). Default 15.',
          '15',
          { type: 'number', min: 1, max: 120 }
        )}
        {text(
          'maxAgeSeconds',
          'Max cache age',
          'Seconds a cached page copy may be kept (minimum 600).',
          '86400',
          { type: 'number', min: 600 }
        )}
        {toggle(
          'disableCacheFallback',
          'Disable cache fallback',
          'Require real-time live fetches only; fail if live crawl fails rather than returning cached copy.'
        )}
      </SettingsGroup>

      <ApiHeading
        title="Extract API"
        description="Used when web_fetch reads a page."
      />
      <SettingsGroup title="Essentials">
        {toggle(
          'readFullContent',
          'Full page content',
          'Extract full markdown content of the page. Turn off to retrieve excerpts only.'
        )}
        {!draft.readFullContent &&
          text(
            'readMaxCharsPerResult',
            'Characters per excerpt',
            'Maximum characters per excerpt when full content is disabled.',
            'Unlimited',
            { type: 'number', min: 1 }
          )}
        {text(
          'readTimeoutSeconds',
          'Timeout',
          'Seconds to wait for page extraction (1–120). Default 30.',
          '30',
          { type: 'number', min: 1, max: 120 }
        )}
        {text(
          'readMaxAgeSeconds',
          'Max cache age',
          'Seconds a cached page extract may be kept (minimum 600).',
          '86400',
          { type: 'number', min: 600 }
        )}
        {toggle(
          'readDisableCacheFallback',
          'Disable cache fallback for extraction',
          'Require real-time live extraction only without cached fallback.'
        )}
      </SettingsGroup>
    </>
  )
}
