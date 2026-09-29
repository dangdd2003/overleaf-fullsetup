import ToggleSetting from '@/features/ide-settings/components/toggle-setting'
import DropdownSetting from '@/features/ide-settings/components/dropdown-setting'
import { ApiHeading, SettingsGroup, TextSetting } from './web-search-settings'
import {
  WebsearchapiProviderConfig,
  WebsearchapiScrapeOptions,
  WebsearchapiSearchOptions,
} from '../providers/types'

/**
 * The WebSearchAPI.ai options as the form edits them: text as typed, and ''
 * for "use the API's default". websearchapiOptionsFromDraft turns it back into
 * the stored options, leaving out everything left at the default.
 */
export type WebsearchapiDraft = {
  maxResults: string
  country: string
  language: string
  sortBy: '' | 'relevance' | 'date'
  safeSearch: boolean
  includeDomains: string
  excludeDomains: string
  includeContent: boolean
  contentLength: '' | 'short' | 'medium' | 'long'
  includeAnswer: boolean
  answerLength: '' | 'short' | 'medium' | 'long'
  timeframe: '' | 'day' | 'week' | 'month' | 'year'
  siteSearch: string
  exactTerms: string
  excludeTerms: string
  fileType: string
  engine: '' | 'direct' | 'browser' | 'cf-browser-rendering'
  timeout: string
  tokenBudget: string
  retainImages: '' | 'all' | 'none'
  targetSelector: string
  removeSelector: string
  respondWith: '' | 'default' | 'readerlm-v2'
  proxy: string
  locale: string
  withGeneratedAlt: boolean
  withIframe: boolean
  withShadowDom: boolean
  noCache: boolean
  dnt: boolean
}

type FlagKey = {
  [K in keyof WebsearchapiDraft]: WebsearchapiDraft[K] extends boolean
    ? K
    : never
}[keyof WebsearchapiDraft]

export function draftFromWebsearchapi(
  config?: WebsearchapiProviderConfig
): WebsearchapiDraft {
  const search = config?.search ?? {}
  const scrape = config?.scrape ?? {}
  return {
    maxResults:
      search.maxResults === undefined ? '' : String(search.maxResults),
    country: search.country ?? '',
    language: search.language ?? '',
    sortBy: search.sortBy ?? '',
    safeSearch: search.safeSearch ?? true,
    includeDomains: (search.includeDomains ?? []).join(', '),
    excludeDomains: (search.excludeDomains ?? []).join(', '),
    includeContent: search.includeContent ?? false,
    contentLength: search.contentLength ?? '',
    includeAnswer: search.includeAnswer ?? false,
    answerLength: search.answerLength ?? '',
    timeframe: search.timeframe ?? '',
    siteSearch: search.siteSearch ?? '',
    exactTerms: search.exactTerms ?? '',
    excludeTerms: search.excludeTerms ?? '',
    fileType: search.fileType ?? '',
    engine: scrape.engine ?? '',
    timeout: scrape.timeout === undefined ? '' : String(scrape.timeout),
    tokenBudget:
      scrape.tokenBudget === undefined ? '' : String(scrape.tokenBudget),
    retainImages: scrape.retainImages ?? '',
    targetSelector: scrape.targetSelector ?? '',
    removeSelector: scrape.removeSelector ?? '',
    respondWith: scrape.respondWith ?? '',
    proxy: scrape.proxy ?? '',
    locale: scrape.locale ?? '',
    withGeneratedAlt: scrape.withGeneratedAlt ?? false,
    withIframe: scrape.withIframe ?? false,
    withShadowDom: scrape.withShadowDom ?? false,
    noCache: scrape.noCache ?? false,
    dnt: scrape.dnt ?? false,
  }
}

function domains(text: string) {
  return text
    .split(/[\s,]+/)
    .map(domain => domain.trim())
    .filter(Boolean)
}

function withoutEmpty<T extends object>(object: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(object).filter(
      ([, value]) =>
        value !== undefined &&
        value !== '' &&
        value !== false &&
        !(Array.isArray(value) && value.length === 0)
    )
  ) as Partial<T>
}

export function websearchapiOptionsFromDraft(draft: WebsearchapiDraft): {
  search?: WebsearchapiSearchOptions
  scrape?: WebsearchapiScrapeOptions
} {
  const timeout = Math.trunc(Number(draft.timeout))
  const maxResults = Math.trunc(Number(draft.maxResults))
  const tokenBudget = Math.trunc(Number(draft.tokenBudget))
  const search = withoutEmpty({
    maxResults:
      draft.maxResults.trim() && Number.isFinite(maxResults)
        ? Math.min(20, Math.max(1, maxResults))
        : undefined,
    country: draft.country.trim().toLowerCase(),
    language: draft.language.trim().toLowerCase(),
    sortBy: draft.sortBy || undefined,
    includeDomains: domains(draft.includeDomains),
    excludeDomains: domains(draft.excludeDomains),
    includeContent: draft.includeContent,
    contentLength: draft.includeContent ? draft.contentLength : '',
    includeAnswer: draft.includeAnswer,
    answerLength: draft.includeAnswer ? draft.answerLength : '',
    timeframe: draft.timeframe || undefined,
    siteSearch: draft.siteSearch.trim().toLowerCase(),
    exactTerms: draft.exactTerms.trim(),
    excludeTerms: draft.excludeTerms.trim(),
    fileType: draft.fileType.trim().replace(/^\./, '').toLowerCase(),
  }) as WebsearchapiSearchOptions
  // On is the API's default, so only turning it off is worth sending
  if (!draft.safeSearch) search.safeSearch = false
  const scrape = withoutEmpty({
    engine: draft.engine || undefined,
    timeout:
      draft.timeout.trim() && Number.isFinite(timeout)
        ? Math.min(120, Math.max(1, timeout))
        : undefined,
    tokenBudget:
      draft.tokenBudget.trim() && Number.isFinite(tokenBudget)
        ? Math.min(1000000, Math.max(100, tokenBudget))
        : undefined,
    retainImages: draft.retainImages || undefined,
    targetSelector: draft.targetSelector.trim(),
    removeSelector: draft.removeSelector.trim(),
    respondWith: draft.respondWith || undefined,
    proxy: draft.proxy.trim().toLowerCase(),
    locale: draft.locale.trim(),
    withGeneratedAlt: draft.withGeneratedAlt,
    withIframe: draft.withIframe,
    withShadowDom: draft.withShadowDom,
    noCache: draft.noCache,
    dnt: draft.dnt,
  }) as WebsearchapiScrapeOptions
  return {
    ...(Object.keys(search).length > 0 ? { search } : {}),
    ...(Object.keys(scrape).length > 0 ? { scrape } : {}),
  }
}

type Choice = { value: string; label: string }

const LENGTHS: Choice[] = [
  { value: '', label: 'Medium (default)' },
  { value: 'short', label: 'Short' },
  { value: 'long', label: 'Long' },
]

/**
 * The options in the order the WebSearchAPI.ai reference lists them: the
 * Search API's content, search, domain and advanced parameters, then the
 * Scraper API's essential, timing, content selection, media and advanced ones.
 */
export default function WebsearchapiOptions({
  draft,
  onChange,
}: {
  draft: WebsearchapiDraft
  onChange: (next: WebsearchapiDraft) => void
}) {
  const set = <K extends keyof WebsearchapiDraft>(
    key: K,
    value: WebsearchapiDraft[K]
  ) => onChange({ ...draft, [key]: value })

  const id = (key: keyof WebsearchapiDraft) =>
    `ai-web-search-websearchapi-${key}`

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
    key: Exclude<keyof WebsearchapiDraft, FlagKey>,
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
      onChange={value => set(key, value as WebsearchapiDraft[typeof key])}
    />
  )

  const text = (
    key: Exclude<keyof WebsearchapiDraft, FlagKey>,
    label: string,
    description: string,
    placeholder: string,
    extra: { wide?: boolean; type?: 'number'; min?: number; max?: number } = {}
  ) => (
    <TextSetting
      id={id(key)}
      label={label}
      description={description}
      placeholder={placeholder}
      value={draft[key] as string}
      onChange={value => set(key, value as WebsearchapiDraft[typeof key])}
      {...extra}
    />
  )

  return (
    <>
      <ApiHeading
        title="Search API"
        description="Used for every web_search. Blank fields use the default each one names, and a filter the assistant sets for one search wins over yours."
      />
      <SettingsGroup title="Essentials">
        {text(
          'maxResults',
          'Max results',
          'Results per search, from 1 to 20. Default 10.',
          '10',
          { type: 'number', min: 1, max: 20 }
        )}
      </SettingsGroup>
      <SettingsGroup title="Content">
        {toggle(
          'includeContent',
          'Include page content',
          "Extract each result's main text and choose snippets from it. 2 credits per search instead of 1."
        )}
        {draft.includeContent &&
          dropdown(
            'contentLength',
            'Content length',
            'How much text to extract from each result.',
            LENGTHS
          )}
        {toggle(
          'includeAnswer',
          'Generate an answer',
          'Add an AI-written answer based on the results. +1 credit per search.'
        )}
        {draft.includeAnswer &&
          dropdown(
            'answerLength',
            'Answer length',
            'How long the generated answer is.',
            LENGTHS
          )}
      </SettingsGroup>
      <SettingsGroup title="Search">
        {text(
          'country',
          'Country',
          'Two-letter country code for results, such as us, uk or ca. Default us.',
          'us'
        )}
        {text(
          'language',
          'Language',
          'Two-letter language code for results, such as en, fr or es. Default en.',
          'en'
        )}
        {toggle(
          'safeSearch',
          'Safe search',
          'Filter out explicit results. On by default.'
        )}
        {dropdown('timeframe', 'Time range', 'Only results from this window.', [
          { value: '', label: 'Any time (default)' },
          { value: 'day', label: 'Past day' },
          { value: 'week', label: 'Past week' },
          { value: 'month', label: 'Past month' },
          { value: 'year', label: 'Past year' },
        ])}
      </SettingsGroup>
      <SettingsGroup title="Domains">
        {text(
          'includeDomains',
          'Only these domains',
          'Return results from these domains only, separated by commas.',
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
        {text(
          'siteSearch',
          'Only this site',
          'Search a single website only.',
          'ctan.org',
          { wide: true }
        )}
      </SettingsGroup>
      <SettingsGroup title="Advanced">
        {dropdown(
          'sortBy',
          'Sort results by',
          'Most relevant first, or newest first.',
          [
            { value: '', label: 'Relevance (default)' },
            { value: 'date', label: 'Date' },
          ]
        )}
        {text(
          'exactTerms',
          'Exact phrase',
          'Only pages containing this exact word or phrase.',
          'LaTeX',
          { wide: true }
        )}
        {text(
          'excludeTerms',
          'Without words',
          'Leave out pages containing these words.',
          'forum',
          { wide: true }
        )}
        {text(
          'fileType',
          'File type',
          'Only files of this type, such as pdf.',
          'pdf'
        )}
      </SettingsGroup>

      <ApiHeading
        title="Scraper API"
        description="Used when web_fetch reads a page."
      />
      <SettingsGroup title="Essentials">
        {dropdown(
          'engine',
          'Engine',
          "Direct reads the page's HTML (1 credit). Browser runs the page's JavaScript first (2 credits). Cloudflare uses Cloudflare's browser rendering.",
          [
            { value: '', label: 'Direct (default)' },
            { value: 'browser', label: 'Browser' },
            { value: 'cf-browser-rendering', label: 'Cloudflare' },
          ]
        )}
      </SettingsGroup>
      <SettingsGroup title="Timing">
        {text(
          'timeout',
          'Timeout',
          'Seconds to wait for the page to load, from 1 to 120. Default 10.',
          '10',
          { type: 'number', min: 1, max: 120 }
        )}
        {text(
          'tokenBudget',
          'Token budget',
          'Most tokens a page may return, from 100 to 1000000.',
          'None',
          { type: 'number', min: 100, max: 1000000 }
        )}
      </SettingsGroup>
      <SettingsGroup title="Content selection">
        {text(
          'targetSelector',
          'Read only',
          'CSS selectors of the parts to extract, such as main or article.',
          'main, article, .content',
          { wide: true }
        )}
        {text(
          'removeSelector',
          'Remove',
          'CSS selectors of the parts to strip, such as header, footer or nav.',
          'header, footer, nav, .ads',
          { wide: true }
        )}
      </SettingsGroup>
      <SettingsGroup title="Media">
        {toggle(
          'withGeneratedAlt',
          'Generate image descriptions',
          'Describe images with AI-written alt text. +1 credit per page.'
        )}
        {dropdown(
          'retainImages',
          'Images',
          'Keep images in the page text, or remove them all.',
          [
            { value: '', label: 'Keep (default)' },
            { value: 'none', label: 'Remove' },
          ]
        )}
      </SettingsGroup>
      <SettingsGroup title="Advanced">
        {toggle(
          'noCache',
          'Bypass cache',
          "Always read a fresh copy instead of WebSearchAPI.ai's cached one."
        )}
        {toggle(
          'withIframe',
          'Include iframes',
          'Also extract content inside iframes.'
        )}
        {toggle(
          'withShadowDom',
          'Include Shadow DOM',
          'Also extract content inside Shadow DOM.'
        )}
        {dropdown(
          'respondWith',
          'Processing',
          'ReaderLM-v2 converts pages with an enhanced model.',
          [
            { value: '', label: 'Default' },
            { value: 'readerlm-v2', label: 'ReaderLM-v2' },
          ]
        )}
        {text(
          'proxy',
          'Proxy location',
          'auto, none, or a two-letter country code such as us.',
          'auto'
        )}
        {text(
          'locale',
          'Browser locale',
          'The locale the page is read in, such as en-US.',
          'en-US'
        )}
        {toggle('dnt', 'Do Not Track', 'Send the Do Not Track header.')}
      </SettingsGroup>
    </>
  )
}
