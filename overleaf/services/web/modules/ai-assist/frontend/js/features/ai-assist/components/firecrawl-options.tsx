import ToggleSetting from '@/features/ide-settings/components/toggle-setting'
import DropdownSetting from '@/features/ide-settings/components/dropdown-setting'
import { ApiHeading, SettingsGroup, TextSetting } from './web-search-settings'
import {
  FirecrawlScrapeOptions,
  FirecrawlSearchOptions,
} from '../providers/types'

/**
 * The Firecrawl options as the form edits them: text as typed, and '' for "use
 * the API's default". firecrawlOptionsFromDraft turns it back into the stored
 * options, leaving out everything left at the default. Firecrawl Cloud and
 * self-hosted instances share them, except the proxy and zero data retention,
 * which only Cloud has.
 */
export type FirecrawlDraft = {
  maxResults: string
  developer: boolean
  pdf: boolean
  timeRange: '' | 'hour' | 'day' | 'week' | 'month' | 'year'
  sortByDate: boolean
  includeDomains: string
  excludeDomains: string
  country: string
  location: string
  safeSearch: boolean
  scrapeResults: boolean
  searchTimeout: string
  news: boolean
  highlights: boolean
  onlyMainContent: boolean
  onlyCleanContent: boolean
  maxAge: string
  pdfMode: '' | 'fast' | 'ocr'
  scrapeCountry: string
  languages: string
  includeTags: string
  excludeTags: string
  waitFor: string
  scrapeTimeout: string
  mobile: boolean
  blockAds: boolean
  proxy: '' | 'basic' | 'enhanced'
  zeroDataRetention: boolean
}

type FlagKey = {
  [K in keyof FirecrawlDraft]: FirecrawlDraft[K] extends boolean ? K : never
}[keyof FirecrawlDraft]

export function draftFromFirecrawl(config?: {
  search?: FirecrawlSearchOptions
  scrape?: FirecrawlScrapeOptions
}): FirecrawlDraft {
  const search = config?.search ?? {}
  const scrape = config?.scrape ?? {}
  const number = (value?: number) => (value === undefined ? '' : String(value))
  return {
    maxResults: number(search.maxResults),
    developer: search.categories?.includes('developer') ?? false,
    pdf: search.categories?.includes('pdf') ?? false,
    timeRange: search.timeRange ?? '',
    sortByDate: search.sortByDate ?? false,
    includeDomains: (search.includeDomains ?? []).join(', '),
    excludeDomains: (search.excludeDomains ?? []).join(', '),
    country: search.country ?? '',
    location: search.location ?? '',
    safeSearch: search.safeSearch ?? false,
    scrapeResults: search.scrapeResults ?? false,
    searchTimeout: number(search.timeout),
    news: search.sources?.includes('news') ?? false,
    highlights: search.highlights ?? true,
    onlyMainContent: scrape.onlyMainContent ?? true,
    onlyCleanContent: scrape.onlyCleanContent ?? false,
    maxAge: number(scrape.maxAge),
    pdfMode:
      scrape.pdfMode === 'fast' || scrape.pdfMode === 'ocr'
        ? scrape.pdfMode
        : '',
    scrapeCountry: scrape.country ?? '',
    languages: (scrape.languages ?? []).join(', '),
    includeTags: (scrape.includeTags ?? []).join(', '),
    excludeTags: (scrape.excludeTags ?? []).join(', '),
    waitFor: number(scrape.waitFor),
    scrapeTimeout: number(scrape.timeout),
    mobile: scrape.mobile ?? false,
    blockAds: scrape.blockAds ?? true,
    proxy:
      scrape.proxy === 'basic' || scrape.proxy === 'enhanced'
        ? scrape.proxy
        : '',
    zeroDataRetention: scrape.zeroDataRetention ?? false,
  }
}

function list(text: string) {
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

/** Leaves out what is hidden in the form, such as options Firecrawl refuses together. */
export function firecrawlOptionsFromDraft(
  draft: FirecrawlDraft,
  { cloud }: { cloud: boolean }
): { search?: FirecrawlSearchOptions; scrape?: FirecrawlScrapeOptions } {
  const includeDomains = list(draft.includeDomains)
  const categories = (['developer', 'pdf'] as const).filter(
    category => draft[category]
  )
  const search = withoutEmpty({
    maxResults: inRange(draft.maxResults, 1, 100),
    categories,
    timeRange: draft.timeRange || undefined,
    sortByDate: draft.sortByDate || undefined,
    includeDomains,
    excludeDomains:
      includeDomains.length > 0 ? undefined : list(draft.excludeDomains),
    country: draft.country.trim().toUpperCase(),
    location: draft.location.trim(),
    safeSearch: draft.safeSearch || undefined,
    scrapeResults: draft.scrapeResults || undefined,
    timeout: inRange(draft.searchTimeout, 1000, 300000),
    // Web is the default source; news is added alongside it
    sources: draft.news ? ['web', 'news'] : undefined,
    highlights: draft.highlights ? undefined : false,
  }) as FirecrawlSearchOptions
  const scrape = withoutEmpty({
    onlyMainContent: draft.onlyMainContent ? undefined : false,
    onlyCleanContent: draft.onlyCleanContent || undefined,
    maxAge: inRange(draft.maxAge, 0, Number.MAX_SAFE_INTEGER),
    pdfMode: draft.pdfMode || undefined,
    country: draft.scrapeCountry.trim().toUpperCase(),
    languages: list(draft.languages),
    includeTags: list(draft.includeTags),
    excludeTags: list(draft.excludeTags),
    waitFor: inRange(draft.waitFor, 0, 60000),
    timeout: inRange(draft.scrapeTimeout, 1000, 300000),
    mobile: draft.mobile || undefined,
    blockAds: draft.blockAds ? undefined : false,
    proxy: cloud ? draft.proxy || undefined : undefined,
    zeroDataRetention: cloud ? draft.zeroDataRetention || undefined : undefined,
  }) as FirecrawlScrapeOptions
  return {
    ...(Object.keys(search).length > 0 ? { search } : {}),
    ...(Object.keys(scrape).length > 0 ? { scrape } : {}),
  }
}

type Choice = { value: string; label: string }

/**
 * The options in the order Firecrawl's reference lists them: the Search API's
 * parameters, then the Scrape API's.
 */
export default function FirecrawlOptions({
  idPrefix,
  cloud,
  draft,
  onChange,
}: {
  idPrefix: string
  cloud: boolean
  draft: FirecrawlDraft
  onChange: (next: FirecrawlDraft) => void
}) {
  const set = <K extends keyof FirecrawlDraft>(
    key: K,
    value: FirecrawlDraft[K]
  ) => onChange({ ...draft, [key]: value })

  const id = (key: keyof FirecrawlDraft) => `${idPrefix}-${key}`

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
    key: Exclude<keyof FirecrawlDraft, FlagKey>,
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
      onChange={value => set(key, value as FirecrawlDraft[typeof key])}
    />
  )

  const text = (
    key: Exclude<keyof FirecrawlDraft, FlagKey>,
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
      onChange={value => set(key, value as FirecrawlDraft[typeof key])}
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
          'Max results',
          'Results per search, from 1 to 100. Default 10.',
          '10',
          { type: 'number', min: 1, max: 100 }
        )}
        {toggle(
          'scrapeResults',
          'Include page content',
          "Get each result's page as Markdown and choose snippets from it."
        )}
        {text(
          'searchTimeout',
          'Timeout',
          'Milliseconds to wait for a search, from 1000 to 300000. Default 60000.',
          '60000',
          { type: 'number', min: 1000, max: 300000 }
        )}
        {toggle(
          'highlights',
          'Highlights',
          'Snippets that match the query instead of page descriptions. On by default.'
        )}
      </SettingsGroup>
      <SettingsGroup title="Categories">
        {toggle(
          'developer',
          'Developer',
          'Code repositories, issues and documentation sites.'
        )}
        {toggle('pdf', 'PDF', 'Only PDF documents.')}
        {toggle('news', 'News', 'Also search news articles.')}
      </SettingsGroup>
      <SettingsGroup title="Dates">
        {dropdown('timeRange', 'Time range', 'Only results from this window.', [
          { value: '', label: 'Any time (default)' },
          { value: 'hour', label: 'Past hour' },
          { value: 'day', label: 'Past day' },
          { value: 'week', label: 'Past week' },
          { value: 'month', label: 'Past month' },
          { value: 'year', label: 'Past year' },
        ])}
        {toggle('sortByDate', 'Newest first', 'Sort results by date.')}
      </SettingsGroup>
      <SettingsGroup title="Region">
        {text(
          'country',
          'Country',
          'A two-letter country code such as US or DE. Default US.',
          'US'
        )}
        {text(
          'location',
          'Location',
          'Search as if from this place, such as Germany.',
          'Germany',
          { wide: true }
        )}
        {toggle(
          'safeSearch',
          'Safe search',
          'Filter out explicit results. Off by default.'
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
        {list(draft.includeDomains).length === 0 &&
          text(
            'excludeDomains',
            'Never these domains',
            'Leave out results from these domains, separated by commas.',
            'pinterest.com',
            { wide: true }
          )}
      </SettingsGroup>

      <ApiHeading
        title="Scrape API"
        description="Used when web_fetch reads a page, and for page content in searches."
      />
      <SettingsGroup title="Essentials">
        {toggle(
          'onlyMainContent',
          'Main content only',
          'Leave out headers, navigation, footers and sidebars.'
        )}
        {text(
          'waitFor',
          'Wait for',
          'Milliseconds to let the page load before reading it. Default 0.',
          '0',
          { type: 'number', min: 0, max: 60000 }
        )}
        {text(
          'scrapeTimeout',
          'Timeout',
          'Milliseconds to wait for a page, from 1000 to 300000. Default 60000.',
          '60000',
          { type: 'number', min: 1000, max: 300000 }
        )}
        {text(
          'maxAge',
          'Max cache age',
          'Milliseconds a cached copy may be old. Default 172800000 (2 days).',
          '172800000',
          { type: 'number', min: 0 }
        )}
      </SettingsGroup>
      <SettingsGroup title="Page parts">
        {text(
          'includeTags',
          'Only these tags',
          'Read only these HTML tags or selectors, separated by commas.',
          'article, main',
          { wide: true }
        )}
        {text(
          'excludeTags',
          'Never these tags',
          'Leave out these HTML tags or selectors, separated by commas.',
          'nav, .sidebar',
          { wide: true }
        )}
        {toggle(
          'onlyCleanContent',
          'Clean content',
          'Remove leftover boilerplate with an extra AI pass. Beta.'
        )}
        {dropdown('pdfMode', 'PDF parsing', 'How text is read from PDFs.', [
          { value: '', label: 'Auto (default)' },
          { value: 'fast', label: 'Fast, embedded text only' },
          { value: 'ocr', label: 'OCR every page' },
        ])}
      </SettingsGroup>
      <SettingsGroup title="Browser">
        {text(
          'scrapeCountry',
          'Country',
          'Read pages from this country, such as US or DE. Default US.',
          'US'
        )}
        {text(
          'languages',
          'Languages',
          'Preferred page languages in order, separated by commas.',
          'en-US, de',
          { wide: true }
        )}
        {toggle('mobile', 'Mobile', 'Read pages as a mobile device.')}
        {toggle(
          'blockAds',
          'Block ads',
          'Block ads and cookie pop-ups. On by default.'
        )}
        {cloud &&
          dropdown(
            'proxy',
            'Proxy',
            'Enhanced is slower but gets past stronger bot protection.',
            [
              { value: '', label: 'Auto (default)' },
              { value: 'basic', label: 'Basic' },
              { value: 'enhanced', label: 'Enhanced' },
            ]
          )}
        {cloud &&
          toggle(
            'zeroDataRetention',
            'Zero data retention',
            'Firecrawl keeps no data from the request. Must be enabled for your team.'
          )}
      </SettingsGroup>
    </>
  )
}
