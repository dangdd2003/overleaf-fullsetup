import ToggleSetting from '@/features/ide-settings/components/toggle-setting'
import DropdownSetting from '@/features/ide-settings/components/dropdown-setting'
import { ApiHeading, SettingsGroup, TextSetting } from './web-search-settings'
import {
  JinaProviderConfig,
  JinaReadOptions,
  JinaSearchOptions,
} from '../providers/types'

/**
 * The Jina options as the form edits them: text as typed, and '' for "use the
 * API's default". jinaOptionsFromDraft turns it back into the stored options,
 * leaving out everything left at the default.
 */
export type JinaDraft = {
  maxResults: string
  includeContent: boolean
  type: '' | 'news'
  country: string
  language: string
  location: string
  includeDomains: string
  engine: '' | 'browser' | 'direct' | 'cf-browser-rendering'
  timeout: string
  targetSelector: string
  removeSelector: string
  retainImages: '' | 'none' | 'alt'
  withGeneratedAlt: boolean
  withIframe: boolean
  withShadowDom: boolean
  respondWith: '' | 'readerlm-v2'
  proxy: string
  locale: string
  noCache: boolean
  dnt: boolean
  tokenBudget: string
  waitForSelector: string
  cacheTolerance: string
}

type FlagKey = {
  [K in keyof JinaDraft]: JinaDraft[K] extends boolean ? K : never
}[keyof JinaDraft]

export function draftFromJina(config?: JinaProviderConfig): JinaDraft {
  const search = config?.search ?? {}
  const read = config?.read ?? {}
  const number = (value?: number) => (value === undefined ? '' : String(value))
  return {
    maxResults: number(search.maxResults),
    includeContent: search.includeContent ?? false,
    type: search.type ?? '',
    country: search.country ?? '',
    language: search.language ?? '',
    location: search.location ?? '',
    includeDomains: (search.includeDomains ?? []).join(', '),
    engine: read.engine ?? '',
    timeout: number(read.timeout),
    targetSelector: read.targetSelector ?? '',
    removeSelector: read.removeSelector ?? '',
    retainImages: read.retainImages ?? '',
    withGeneratedAlt: read.withGeneratedAlt ?? false,
    withIframe: read.withIframe ?? false,
    withShadowDom: read.withShadowDom ?? false,
    respondWith: read.respondWith ?? '',
    proxy: read.proxy ?? '',
    locale: read.locale ?? '',
    noCache: read.noCache ?? false,
    dnt: read.dnt ?? false,
    tokenBudget: number(read.tokenBudget),
    waitForSelector: read.waitForSelector ?? '',
    cacheTolerance: number(read.cacheTolerance),
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

function inRange(raw: string, min: number, max: number) {
  const parsed = Math.trunc(Number(raw))
  return raw.trim() && Number.isFinite(parsed)
    ? Math.min(max, Math.max(min, parsed))
    : undefined
}

/** Leaves out what is hidden in the form, such as options Jina ignores together. */
export function jinaOptionsFromDraft(draft: JinaDraft): {
  search?: JinaSearchOptions
  read?: JinaReadOptions
} {
  const search = withoutEmpty({
    maxResults: inRange(draft.maxResults, 1, 20),
    includeContent: draft.includeContent,
    type: draft.type || undefined,
    country: draft.country.trim().toLowerCase(),
    language: draft.language.trim().toLowerCase(),
    location: draft.location.trim(),
    includeDomains: domains(draft.includeDomains),
  }) as JinaSearchOptions
  const read = withoutEmpty({
    engine: draft.engine || undefined,
    timeout: inRange(draft.timeout, 1, 180),
    targetSelector: draft.targetSelector.trim(),
    removeSelector: draft.removeSelector.trim(),
    retainImages: draft.retainImages || undefined,
    withGeneratedAlt: draft.respondWith ? undefined : draft.withGeneratedAlt,
    withIframe: draft.withIframe,
    withShadowDom: draft.withShadowDom,
    respondWith: draft.respondWith || undefined,
    proxy: draft.proxy.trim().toLowerCase(),
    locale: draft.locale.trim(),
    noCache: draft.noCache,
    dnt: draft.dnt,
    tokenBudget: inRange(draft.tokenBudget, 1, Number.MAX_SAFE_INTEGER),
    waitForSelector: draft.waitForSelector.trim(),
    cacheTolerance: draft.noCache
      ? undefined
      : inRange(draft.cacheTolerance, 0, Number.MAX_SAFE_INTEGER),
  }) as JinaReadOptions
  return {
    ...(Object.keys(search).length > 0 ? { search } : {}),
    ...(Object.keys(read).length > 0 ? { read } : {}),
  }
}

type Choice = { value: string; label: string }

/**
 * The options in the order Jina's reference lists them: the Search API's
 * parameters, then the Reader API's headers.
 */
export default function JinaOptions({
  draft,
  onChange,
}: {
  draft: JinaDraft
  onChange: (next: JinaDraft) => void
}) {
  const set = <K extends keyof JinaDraft>(key: K, value: JinaDraft[K]) =>
    onChange({ ...draft, [key]: value })

  const id = (key: keyof JinaDraft) => `ai-web-search-jina-${key}`

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
    key: Exclude<keyof JinaDraft, FlagKey>,
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
      onChange={value => set(key, value as JinaDraft[typeof key])}
    />
  )

  const text = (
    key: Exclude<keyof JinaDraft, FlagKey>,
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
      onChange={value => set(key, value as JinaDraft[typeof key])}
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
          'Results per search, from 1 to 20. Default 10.',
          '10',
          { type: 'number', min: 1, max: 20 }
        )}
        {toggle(
          'includeContent',
          'Include page content',
          "Read each result's page and choose snippets from it. Slower and uses more tokens."
        )}
        {dropdown(
          'type',
          'Result type',
          'News returns only news articles and uses more tokens.',
          [
            { value: '', label: 'Web (default)' },
            { value: 'news', label: 'News' },
          ]
        )}
      </SettingsGroup>
      <SettingsGroup title="Region">
        {text(
          'country',
          'Country',
          'Two-letter country code for results, such as us or gb.',
          'us'
        )}
        {text(
          'language',
          'Language',
          'Language code for results, such as en or zh-cn.',
          'en'
        )}
        {text(
          'location',
          'Location',
          'Search as if from this place, such as Berlin.',
          'Berlin',
          { wide: true }
        )}
      </SettingsGroup>
      <SettingsGroup title="Domains">
        {text(
          'includeDomains',
          'Only these domains',
          'Return results from these domains only, separated by commas.',
          'arxiv.org, ctan.org',
          { wide: true }
        )}
      </SettingsGroup>

      <ApiHeading
        title="Reader API"
        description="Used when web_fetch reads a page."
      />
      <SettingsGroup title="Essentials">
        {dropdown(
          'engine',
          'Engine',
          "Browser runs the page's JavaScript first. Direct reads the HTML only and is faster.",
          [
            { value: '', label: 'Auto (default)' },
            { value: 'browser', label: 'Browser' },
            { value: 'direct', label: 'Direct' },
            { value: 'cf-browser-rendering', label: 'Cloudflare' },
          ]
        )}
        {text(
          'timeout',
          'Timeout',
          'Seconds to wait for the page to load, from 1 to 180.',
          'Auto',
          { type: 'number', min: 1, max: 180 }
        )}
        {text(
          'tokenBudget',
          'Token budget',
          'Most tokens a page may use; longer pages fail.',
          'None',
          { type: 'number', min: 1 }
        )}
      </SettingsGroup>
      <SettingsGroup title="Content selection">
        {text(
          'targetSelector',
          'Read only',
          'CSS selectors of the parts to extract, such as main or article.',
          'main, article',
          { wide: true }
        )}
        {text(
          'removeSelector',
          'Remove',
          'CSS selectors of the parts to strip, such as nav or footer.',
          'nav, footer, .sidebar',
          { wide: true }
        )}
        {text(
          'waitForSelector',
          'Wait for',
          'CSS selectors to wait for before reading the page.',
          '#content',
          { wide: true }
        )}
      </SettingsGroup>
      <SettingsGroup title="Media">
        {dropdown(
          'retainImages',
          'Images',
          'Keep images in the page text, keep only their alt text, or remove them.',
          [
            { value: '', label: 'Keep (default)' },
            { value: 'alt', label: 'Alt text only' },
            { value: 'none', label: 'Remove' },
          ]
        )}
        {!draft.respondWith &&
          toggle(
            'withGeneratedAlt',
            'Generate image descriptions',
            'Describe images that have no alt text.'
          )}
      </SettingsGroup>
      <SettingsGroup title="Advanced">
        {toggle(
          'noCache',
          'Bypass cache',
          "Always read a fresh copy instead of Jina's cached one."
        )}
        {!draft.noCache &&
          text(
            'cacheTolerance',
            'Max cache age',
            'Seconds a cached copy may be old.',
            '3600',
            { type: 'number', min: 0 }
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
          'ReaderLM-v2 converts pages to Markdown with a language model.',
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
        {toggle(
          'dnt',
          'Do Not Track',
          'Ask Jina not to cache or log the request.'
        )}
      </SettingsGroup>
    </>
  )
}
