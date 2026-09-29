import ToggleSetting from '@/features/ide-settings/components/toggle-setting'
import DropdownSetting from '@/features/ide-settings/components/dropdown-setting'
import {
  ApiHeading,
  DateSetting,
  SettingsGroup,
  TextSetting,
} from './web-search-settings'
import {
  TavilyExtractOptions,
  TavilyProviderConfig,
  TavilySearchOptions,
} from '../providers/types'

/**
 * The Tavily options as the form edits them: text as typed, and '' for "use
 * the API's default". tavilyOptionsFromDraft turns it back into the stored
 * options, leaving out everything left at the default.
 */
export type TavilyDraft = {
  projectId: string
  maxResults: string
  searchDepth: '' | 'advanced' | 'fast' | 'ultra-fast'
  chunksPerSource: '' | '1' | '2'
  topic: '' | 'news' | 'finance'
  timeRange: '' | 'day' | 'week' | 'month' | 'year'
  startDate: string
  endDate: string
  includePublishedDate: boolean
  filterByPublishedDate: boolean
  includeAnswer: '' | 'basic' | 'advanced'
  includeRawContent: '' | 'markdown' | 'text'
  includeDomains: string
  includeDomainsMode: '' | 'prefer'
  excludeDomains: string
  country: string
  language: string
  filterByLanguage: boolean
  autoParameters: boolean
  exactMatch: boolean
  safeSearch: boolean
  extractDepth: '' | 'advanced'
  format: '' | 'text'
  timeout: string
}

type FlagKey = {
  [K in keyof TavilyDraft]: TavilyDraft[K] extends boolean ? K : never
}[keyof TavilyDraft]

/** The countries Tavily's Search API can boost, as its reference lists them. */
const COUNTRIES = [
  'afghanistan',
  'albania',
  'algeria',
  'andorra',
  'angola',
  'argentina',
  'armenia',
  'australia',
  'austria',
  'azerbaijan',
  'bahamas',
  'bahrain',
  'bangladesh',
  'barbados',
  'belarus',
  'belgium',
  'belize',
  'benin',
  'bhutan',
  'bolivia',
  'bosnia and herzegovina',
  'botswana',
  'brazil',
  'brunei',
  'bulgaria',
  'burkina faso',
  'burundi',
  'cambodia',
  'cameroon',
  'canada',
  'cape verde',
  'central african republic',
  'chad',
  'chile',
  'china',
  'colombia',
  'comoros',
  'congo',
  'costa rica',
  'croatia',
  'cuba',
  'cyprus',
  'czech republic',
  'denmark',
  'djibouti',
  'dominican republic',
  'ecuador',
  'egypt',
  'el salvador',
  'equatorial guinea',
  'eritrea',
  'estonia',
  'ethiopia',
  'fiji',
  'finland',
  'france',
  'gabon',
  'gambia',
  'georgia',
  'germany',
  'ghana',
  'greece',
  'guatemala',
  'guinea',
  'haiti',
  'honduras',
  'hungary',
  'iceland',
  'india',
  'indonesia',
  'iran',
  'iraq',
  'ireland',
  'israel',
  'italy',
  'jamaica',
  'japan',
  'jordan',
  'kazakhstan',
  'kenya',
  'kuwait',
  'kyrgyzstan',
  'latvia',
  'lebanon',
  'lesotho',
  'liberia',
  'libya',
  'liechtenstein',
  'lithuania',
  'luxembourg',
  'madagascar',
  'malawi',
  'malaysia',
  'maldives',
  'mali',
  'malta',
  'mauritania',
  'mauritius',
  'mexico',
  'moldova',
  'monaco',
  'mongolia',
  'montenegro',
  'morocco',
  'mozambique',
  'myanmar',
  'namibia',
  'nepal',
  'netherlands',
  'new zealand',
  'nicaragua',
  'niger',
  'nigeria',
  'north korea',
  'north macedonia',
  'norway',
  'oman',
  'pakistan',
  'panama',
  'papua new guinea',
  'paraguay',
  'peru',
  'philippines',
  'poland',
  'portugal',
  'qatar',
  'romania',
  'russia',
  'rwanda',
  'saudi arabia',
  'senegal',
  'serbia',
  'singapore',
  'slovakia',
  'slovenia',
  'somalia',
  'south africa',
  'south korea',
  'south sudan',
  'spain',
  'sri lanka',
  'sudan',
  'sweden',
  'switzerland',
  'syria',
  'taiwan',
  'tajikistan',
  'tanzania',
  'thailand',
  'togo',
  'trinidad and tobago',
  'tunisia',
  'turkey',
  'turkmenistan',
  'uganda',
  'ukraine',
  'united arab emirates',
  'united kingdom',
  'united states',
  'uruguay',
  'uzbekistan',
  'venezuela',
  'vietnam',
  'yemen',
  'zambia',
  'zimbabwe',
]

export function draftFromTavily(config?: TavilyProviderConfig): TavilyDraft {
  const search = config?.search ?? {}
  const extract = config?.extract ?? {}
  const chunks = search.chunksPerSource
  return {
    projectId: config?.projectId ?? '',
    maxResults:
      search.maxResults === undefined ? '' : String(search.maxResults),
    searchDepth:
      search.searchDepth && search.searchDepth !== 'basic'
        ? search.searchDepth
        : '',
    chunksPerSource: chunks === 1 || chunks === 2 ? `${chunks}` : '',
    topic: search.topic && search.topic !== 'general' ? search.topic : '',
    timeRange: search.timeRange ?? '',
    startDate: search.startDate ?? '',
    endDate: search.endDate ?? '',
    includePublishedDate: search.includePublishedDate ?? false,
    filterByPublishedDate: search.filterByPublishedDate ?? false,
    includeAnswer: search.includeAnswer ?? '',
    includeRawContent: search.includeRawContent ?? '',
    includeDomains: (search.includeDomains ?? []).join(', '),
    includeDomainsMode: search.includeDomainsMode === 'prefer' ? 'prefer' : '',
    excludeDomains: (search.excludeDomains ?? []).join(', '),
    country: search.country ?? '',
    language: search.language ?? '',
    filterByLanguage: search.filterByLanguage ?? false,
    autoParameters: search.autoParameters ?? false,
    exactMatch: search.exactMatch ?? false,
    safeSearch: search.safeSearch ?? false,
    extractDepth: extract.extractDepth === 'advanced' ? 'advanced' : '',
    format: extract.format === 'text' ? 'text' : '',
    timeout: extract.timeout === undefined ? '' : String(extract.timeout),
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

function inRange(raw: string, min: number, max: number, integer = true) {
  const parsed = integer ? Math.trunc(Number(raw)) : Number(raw)
  return raw.trim() && Number.isFinite(parsed)
    ? Math.min(max, Math.max(min, parsed))
    : undefined
}

/** Leaves out what is hidden in the form, such as options the depth ignores. */
export function tavilyOptionsFromDraft(draft: TavilyDraft): {
  projectId?: string
  search?: TavilySearchOptions
  extract?: TavilyExtractOptions
} {
  const quick =
    draft.searchDepth === 'fast' || draft.searchDepth === 'ultra-fast'
  const includeDomains = domains(draft.includeDomains)
  const language = draft.language.trim().toLowerCase()
  const search = withoutEmpty({
    maxResults: inRange(draft.maxResults, 1, 20),
    searchDepth: draft.searchDepth || undefined,
    chunksPerSource:
      draft.chunksPerSource && draft.searchDepth !== 'ultra-fast'
        ? Number(draft.chunksPerSource)
        : undefined,
    topic: draft.topic || undefined,
    timeRange: draft.timeRange || undefined,
    startDate: draft.startDate.trim(),
    endDate: draft.endDate.trim(),
    includePublishedDate: draft.includePublishedDate,
    filterByPublishedDate: draft.filterByPublishedDate,
    includeAnswer: draft.includeAnswer || undefined,
    includeRawContent: draft.includeRawContent || undefined,
    includeDomains,
    includeDomainsMode:
      includeDomains.length > 0 ? draft.includeDomainsMode : undefined,
    excludeDomains: domains(draft.excludeDomains),
    country: draft.topic ? undefined : draft.country,
    language,
    filterByLanguage: language ? draft.filterByLanguage : undefined,
    autoParameters: draft.autoParameters,
    exactMatch: draft.exactMatch,
    safeSearch: quick ? undefined : draft.safeSearch,
  }) as TavilySearchOptions
  const extract = withoutEmpty({
    extractDepth: draft.extractDepth || undefined,
    format: draft.format || undefined,
    timeout: inRange(draft.timeout, 1, 60, false),
  }) as TavilyExtractOptions
  const projectId = draft.projectId.trim()
  return {
    ...(projectId ? { projectId } : {}),
    ...(Object.keys(search).length > 0 ? { search } : {}),
    ...(Object.keys(extract).length > 0 ? { extract } : {}),
  }
}

type Choice = { value: string; label: string }

const COUNTRY_CHOICES: Choice[] = [
  { value: '', label: 'None (default)' },
  ...COUNTRIES.map(country => ({
    value: country,
    label: country.replace(/\b\w/g, letter => letter.toUpperCase()),
  })),
]

/**
 * The options in the order Tavily's reference lists them: the Search API's
 * parameters, then the Extract API's.
 */
export default function TavilyOptions({
  draft,
  onChange,
}: {
  draft: TavilyDraft
  onChange: (next: TavilyDraft) => void
}) {
  const set = <K extends keyof TavilyDraft>(key: K, value: TavilyDraft[K]) =>
    onChange({ ...draft, [key]: value })

  const id = (key: keyof TavilyDraft) => `ai-web-search-tavily-${key}`

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
    key: Exclude<keyof TavilyDraft, FlagKey>,
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
      onChange={value => set(key, value as TavilyDraft[typeof key])}
    />
  )

  const text = (
    key: Exclude<keyof TavilyDraft, FlagKey>,
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
      onChange={value => set(key, value as TavilyDraft[typeof key])}
      {...extra}
    />
  )

  const date = (
    key: 'startDate' | 'endDate',
    label: string,
    description: string
  ) => (
    <DateSetting
      id={id(key)}
      label={label}
      description={description}
      value={draft[key]}
      onChange={value => set(key, value)}
    />
  )

  const quick =
    draft.searchDepth === 'fast' || draft.searchDepth === 'ultra-fast'

  return (
    <>
      <ApiHeading
        title="Search API"
        description="Used for every web_search. Blank fields use the default each one names, and a time filter the assistant sets for one search wins over yours."
      />
      <SettingsGroup title="Essentials">
        {text(
          'maxResults',
          'Max results',
          'Results per search, from 1 to 20. Default 10.',
          '10',
          { type: 'number', min: 1, max: 20 }
        )}
        {dropdown(
          'searchDepth',
          'Search depth',
          'Advanced is the most relevant and costs 2 credits; the others cost 1.',
          [
            { value: '', label: 'Basic (default)' },
            { value: 'advanced', label: 'Advanced' },
            { value: 'fast', label: 'Fast' },
            { value: 'ultra-fast', label: 'Ultra-fast' },
          ]
        )}
        {draft.searchDepth !== 'ultra-fast' &&
          dropdown(
            'chunksPerSource',
            'Snippets per result',
            'How many short passages each result brings back.',
            [
              { value: '', label: '3 (default)' },
              { value: '2', label: '2' },
              { value: '1', label: '1' },
            ]
          )}
        {dropdown(
          'topic',
          'Topic',
          'News and finance search mainstream news and financial sources.',
          [
            { value: '', label: 'General (default)' },
            { value: 'news', label: 'News' },
            { value: 'finance', label: 'Finance' },
          ]
        )}
      </SettingsGroup>
      <SettingsGroup title="Content">
        {dropdown(
          'includeAnswer',
          'Generate an answer',
          'Add an AI-written answer based on the results.',
          [
            { value: '', label: 'Off (default)' },
            { value: 'basic', label: 'Basic' },
            { value: 'advanced', label: 'Advanced' },
          ]
        )}
        {dropdown(
          'includeRawContent',
          'Include page content',
          "Get each result's full page text and choose snippets from it.",
          [
            { value: '', label: 'Off (default)' },
            { value: 'markdown', label: 'Markdown' },
            { value: 'text', label: 'Plain text' },
          ]
        )}
        {toggle(
          'autoParameters',
          'Auto parameters',
          'Let Tavily tune the search to each query, which can cost 2 credits.'
        )}
        {toggle(
          'exactMatch',
          'Exact match',
          'Only return results containing the quoted phrases of a query.'
        )}
      </SettingsGroup>
      <SettingsGroup title="Dates">
        {dropdown(
          'timeRange',
          'Time range',
          'Only results published or updated in this window.',
          [
            { value: '', label: 'Any time (default)' },
            { value: 'day', label: 'Past day' },
            { value: 'week', label: 'Past week' },
            { value: 'month', label: 'Past month' },
            { value: 'year', label: 'Past year' },
          ]
        )}
        {date(
          'startDate',
          'Start date',
          'Only results published or updated after this date.'
        )}
        {date(
          'endDate',
          'End date',
          'Only results published or updated before this date.'
        )}
        {toggle(
          'includePublishedDate',
          'Include published dates',
          'Show when each result was published or last updated.'
        )}
        {toggle(
          'filterByPublishedDate',
          'Drop undated results',
          'Remove results outside the date window, including ones with no date.'
        )}
      </SettingsGroup>
      <SettingsGroup title="Region and language">
        {!draft.topic &&
          dropdown(
            'country',
            'Country',
            'Boost results from this country.',
            COUNTRY_CHOICES
          )}
        {text(
          'language',
          'Language',
          'Boost results in this language, such as en, fr or zh-cn.',
          'en'
        )}
        {draft.language.trim() &&
          toggle(
            'filterByLanguage',
            'Only this language',
            'Remove results in other languages instead of ranking them lower.'
          )}
        {!quick &&
          toggle(
            'safeSearch',
            'Safe search',
            'Filter out adult or unsafe results. Off by default.'
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
        {domains(draft.includeDomains).length > 0 &&
          dropdown(
            'includeDomainsMode',
            'Domain mode',
            'Prefer also searches the rest of the web.',
            [
              { value: '', label: 'Restrict (default)' },
              { value: 'prefer', label: 'Prefer' },
            ]
          )}
        {text(
          'excludeDomains',
          'Never these domains',
          'Leave out results from these domains, separated by commas.',
          'pinterest.com',
          { wide: true }
        )}
      </SettingsGroup>

      <ApiHeading
        title="Extract API"
        description="Used when web_fetch reads a page."
      />
      <SettingsGroup title="Essentials">
        {dropdown(
          'extractDepth',
          'Extract depth',
          'Advanced also reads tables and embedded content, at 2 credits per 5 pages.',
          [
            { value: '', label: 'Basic (default)' },
            { value: 'advanced', label: 'Advanced' },
          ]
        )}
        {dropdown(
          'format',
          'Format',
          'The format of the page text the assistant reads.',
          [
            { value: '', label: 'Markdown (default)' },
            { value: 'text', label: 'Plain text' },
          ]
        )}
        {text(
          'timeout',
          'Timeout',
          'Seconds to wait for a page, from 1 to 60. Default 10, or 30 for advanced.',
          draft.extractDepth === 'advanced' ? '30' : '10',
          { type: 'number', min: 1, max: 60 }
        )}
      </SettingsGroup>
    </>
  )
}
