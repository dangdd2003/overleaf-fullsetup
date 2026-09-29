import ToggleSetting from '@/features/ide-settings/components/toggle-setting'
import DropdownSetting from '@/features/ide-settings/components/dropdown-setting'
import { ApiHeading, SettingsGroup, TextSetting } from './web-search-settings'
import {
  ExaLivecrawl,
  ExaProviderConfig,
  ExaReadOptions,
  ExaSearchCategory,
  ExaSearchOptions,
  ExaSearchType,
} from '../providers/types'

/**
 * The Exa options as the form edits them: text as typed, and '' for "use the
 * API's default". exaOptionsFromDraft turns it back into stored options.
 */
export type ExaDraft = {
  // Search options
  maxResults: string
  type: '' | ExaSearchType
  category: '' | ExaSearchCategory
  includeDomains: string
  excludeDomains: string
  startPublishedDate: string
  endPublishedDate: string
  includeText: string
  excludeText: string
  moderation: boolean
  includeContent: boolean
  maxCharacters: string
  includeHtmlTags: boolean
  highlights: boolean
  numSentences: string
  highlightsPerUrl: string
  highlightsQuery: string
  summary: boolean
  summaryQuery: string
  livecrawl: '' | ExaLivecrawl
  livecrawlTimeout: string
  subpages: string
  subpageTarget: string

  // Read options
  readMaxCharacters: string
  readIncludeHtmlTags: boolean
  readHighlights: boolean
  readNumSentences: string
  readHighlightsPerUrl: string
  readHighlightsQuery: string
  readSummary: boolean
  readSummaryQuery: string
  readLivecrawl: '' | ExaLivecrawl
  readLivecrawlTimeout: string
  readSubpages: string
  readSubpageTarget: string
}

type FlagKey = {
  [K in keyof ExaDraft]: ExaDraft[K] extends boolean ? K : never
}[keyof ExaDraft]

export function draftFromExa(config?: ExaProviderConfig): ExaDraft {
  const search = config?.search ?? {}
  const read = config?.read ?? {}
  const number = (value?: number) => (value === undefined ? '' : String(value))
  const strings = (list?: string[]) => (list ?? []).join(', ')

  return {
    maxResults: number(search.maxResults),
    type: search.type ?? '',
    category: search.category ?? '',
    includeDomains: strings(search.includeDomains),
    excludeDomains: strings(search.excludeDomains),
    startPublishedDate: search.startPublishedDate ?? '',
    endPublishedDate: search.endPublishedDate ?? '',
    includeText: strings(search.includeText),
    excludeText: strings(search.excludeText),
    moderation: search.moderation ?? false,
    includeContent: search.includeContent ?? false,
    maxCharacters: number(search.maxCharacters),
    includeHtmlTags: search.includeHtmlTags ?? false,
    highlights: search.highlights ?? false,
    numSentences: number(search.numSentences),
    highlightsPerUrl: number(search.highlightsPerUrl),
    highlightsQuery: search.highlightsQuery ?? '',
    summary: search.summary ?? false,
    summaryQuery: search.summaryQuery ?? '',
    livecrawl: search.livecrawl ?? '',
    livecrawlTimeout: number(search.livecrawlTimeout),
    subpages: number(search.subpages),
    subpageTarget: search.subpageTarget ?? '',

    readMaxCharacters: number(read.maxCharacters),
    readIncludeHtmlTags: read.includeHtmlTags ?? false,
    readHighlights: read.highlights ?? false,
    readNumSentences: number(read.numSentences),
    readHighlightsPerUrl: number(read.highlightsPerUrl),
    readHighlightsQuery: read.highlightsQuery ?? '',
    readSummary: read.summary ?? false,
    readSummaryQuery: read.summaryQuery ?? '',
    readLivecrawl: read.livecrawl ?? '',
    readLivecrawlTimeout: number(read.livecrawlTimeout),
    readSubpages: number(read.subpages),
    readSubpageTarget: read.subpageTarget ?? '',
  }
}

function commaSeparated(text: string) {
  return text
    .split(/[\n,]+/)
    .map(item => item.trim())
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

export function exaOptionsFromDraft(draft: ExaDraft): {
  search?: ExaSearchOptions
  read?: ExaReadOptions
} {
  const search = withoutEmpty({
    maxResults: inRange(draft.maxResults, 1, 100),
    type: draft.type || undefined,
    category: draft.category || undefined,
    includeDomains: commaSeparated(draft.includeDomains),
    excludeDomains: commaSeparated(draft.excludeDomains),
    startPublishedDate: draft.startPublishedDate.trim() || undefined,
    endPublishedDate: draft.endPublishedDate.trim() || undefined,
    includeText: commaSeparated(draft.includeText),
    excludeText: commaSeparated(draft.excludeText),
    moderation: draft.moderation,
    includeContent: draft.includeContent,
    maxCharacters: draft.includeContent
      ? inRange(draft.maxCharacters, 100, 100000)
      : undefined,
    includeHtmlTags: draft.includeContent ? draft.includeHtmlTags : undefined,
    highlights: draft.highlights,
    numSentences: draft.highlights
      ? inRange(draft.numSentences, 1, 10)
      : undefined,
    highlightsPerUrl: draft.highlights
      ? inRange(draft.highlightsPerUrl, 1, 10)
      : undefined,
    highlightsQuery: draft.highlights
      ? draft.highlightsQuery.trim() || undefined
      : undefined,
    summary: draft.summary,
    summaryQuery: draft.summary
      ? draft.summaryQuery.trim() || undefined
      : undefined,
    livecrawl: draft.livecrawl || undefined,
    livecrawlTimeout: draft.livecrawl
      ? inRange(draft.livecrawlTimeout, 1000, 60000)
      : undefined,
    subpages: inRange(draft.subpages, 1, 10),
    subpageTarget: draft.subpageTarget.trim() || undefined,
  }) as ExaSearchOptions

  const read = withoutEmpty({
    maxCharacters: inRange(draft.readMaxCharacters, 100, 100000),
    includeHtmlTags: draft.readIncludeHtmlTags,
    highlights: draft.readHighlights,
    numSentences: draft.readHighlights
      ? inRange(draft.readNumSentences, 1, 10)
      : undefined,
    highlightsPerUrl: draft.readHighlights
      ? inRange(draft.readHighlightsPerUrl, 1, 10)
      : undefined,
    highlightsQuery: draft.readHighlights
      ? draft.readHighlightsQuery.trim() || undefined
      : undefined,
    summary: draft.readSummary,
    summaryQuery: draft.readSummary
      ? draft.readSummaryQuery.trim() || undefined
      : undefined,
    livecrawl: draft.readLivecrawl || undefined,
    livecrawlTimeout: draft.readLivecrawl
      ? inRange(draft.readLivecrawlTimeout, 1000, 60000)
      : undefined,
    subpages: inRange(draft.readSubpages, 1, 10),
    subpageTarget: draft.readSubpageTarget.trim() || undefined,
  }) as ExaReadOptions

  return {
    ...(Object.keys(search).length > 0 ? { search } : {}),
    ...(Object.keys(read).length > 0 ? { read } : {}),
  }
}

type Choice = { value: string; label: string }

export default function ExaOptions({
  draft,
  onChange,
}: {
  draft: ExaDraft
  onChange: (next: ExaDraft) => void
}) {
  const set = <K extends keyof ExaDraft>(key: K, value: ExaDraft[K]) =>
    onChange({ ...draft, [key]: value })

  const id = (key: keyof ExaDraft) => `ai-web-search-exa-${key}`

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
    key: Exclude<keyof ExaDraft, FlagKey>,
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
      onChange={value => set(key, value as ExaDraft[typeof key])}
    />
  )

  const text = (
    key: Exclude<keyof ExaDraft, FlagKey>,
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
      onChange={value => set(key, value as ExaDraft[typeof key])}
      {...extra}
    />
  )

  return (
    <>
      <ApiHeading
        title="Search API"
        description="Used for every web_search. Blank fields use the default each one names."
      />
      <SettingsGroup title="Search parameters">
        {text(
          'maxResults',
          'Results per search',
          'Number of results to return, from 1 to 100. Default 10.',
          '10',
          { type: 'number', min: 1, max: 100 }
        )}
        {dropdown(
          'type',
          'Search type',
          'Neural (embeddings-based), keyword (exact lexical), auto, fast, or deep.',
          [
            { value: '', label: 'Auto (default)' },
            { value: 'neural', label: 'Neural (Semantic)' },
            { value: 'keyword', label: 'Keyword (Lexical)' },
            { value: 'fast', label: 'Fast' },
            { value: 'deep', label: 'Deep' },
          ]
        )}
        {dropdown(
          'category',
          'Category filter',
          'Narrow results to specific categories of web pages.',
          [
            { value: '', label: 'All categories (default)' },
            { value: 'research paper', label: 'Research papers' },
            { value: 'company', label: 'Companies' },
            { value: 'news', label: 'News articles' },
            { value: 'pdf', label: 'PDF documents' },
            { value: 'github', label: 'GitHub repositories' },
            { value: 'tweet', label: 'Tweets' },
            { value: 'personal site', label: 'Personal sites' },
            { value: 'linkedin profile', label: 'LinkedIn profiles' },
            { value: 'financial report', label: 'Financial reports' },
          ]
        )}
        {toggle(
          'moderation',
          'Content moderation',
          'Filter out unsafe or adult content from search results.'
        )}
      </SettingsGroup>

      <SettingsGroup title="Date filters">
        {text(
          'startPublishedDate',
          'Start published date',
          'Only results published after this date (ISO 8601 format, e.g. 2025-01-01T00:00:00.000Z).',
          'YYYY-MM-DD',
          { wide: true }
        )}
        {text(
          'endPublishedDate',
          'End published date',
          'Only results published before this date (ISO 8601 format).',
          'YYYY-MM-DD',
          { wide: true }
        )}
      </SettingsGroup>

      <SettingsGroup title="Domain and text filters">
        {text(
          'includeDomains',
          'Include domains',
          'Only return results from these domains, separated by commas.',
          'arxiv.org, nature.com',
          { wide: true }
        )}
        {text(
          'excludeDomains',
          'Exclude domains',
          'Exclude results from these domains, separated by commas.',
          'pinterest.com',
          { wide: true }
        )}
        {text(
          'includeText',
          'Include text phrases',
          'Must contain these text strings, separated by commas.',
          'siunitx, latex',
          { wide: true }
        )}
        {text(
          'excludeText',
          'Exclude text phrases',
          'Must not contain these text strings, separated by commas.',
          'advertisement',
          { wide: true }
        )}
      </SettingsGroup>

      <SettingsGroup title="Content extraction">
        {toggle(
          'includeContent',
          'Extract webpage text',
          'Retrieve webpage text directly with search results.'
        )}
        {draft.includeContent &&
          text(
            'maxCharacters',
            'Max characters per page',
            'Maximum characters of page text to extract per result (100–100,000).',
            'Unlimited',
            { type: 'number', min: 100, max: 100000 }
          )}
        {draft.includeContent &&
          toggle(
            'includeHtmlTags',
            'Include HTML tags',
            'Preserve HTML tags in the extracted text.'
          )}
        {toggle(
          'highlights',
          'Extract sentence highlights',
          'Extract the most relevant sentences matching the search query.'
        )}
        {draft.highlights &&
          text(
            'numSentences',
            'Sentences per highlight',
            'Number of sentences in each highlight (1–10). Default 1.',
            '1',
            { type: 'number', min: 1, max: 10 }
          )}
        {draft.highlights &&
          text(
            'highlightsPerUrl',
            'Highlights per URL',
            'Number of highlights to extract per result (1–10). Default 1.',
            '1',
            { type: 'number', min: 1, max: 10 }
          )}
        {draft.highlights &&
          text(
            'highlightsQuery',
            'Highlights query override',
            'Optional custom query to guide sentence highlight extraction.',
            'Custom highlights focus',
            { wide: true }
          )}
        {toggle(
          'summary',
          'Generate summary',
          'Generate an AI summary for each result.'
        )}
        {draft.summary &&
          text(
            'summaryQuery',
            'Summary query override',
            'Optional custom query to guide summary generation.',
            'Custom summary prompt',
            { wide: true }
          )}
        {dropdown(
          'livecrawl',
          'Livecrawl mode',
          'Fetch live web pages rather than Exa cache.',
          [
            { value: '', label: 'Auto (default)' },
            { value: 'always', label: 'Always crawl live' },
            { value: 'fallback', label: 'Fallback to live crawl' },
            { value: 'never', label: 'Never crawl live (cache only)' },
          ]
        )}
        {draft.livecrawl &&
          text(
            'livecrawlTimeout',
            'Livecrawl timeout (ms)',
            'Maximum time in milliseconds for live crawling (1,000–60,000).',
            '10000',
            { type: 'number', min: 1000, max: 60000 }
          )}
        {text(
          'subpages',
          'Subpages per result',
          'Crawl and extract subpages linked from each result (1–10).',
          'None',
          { type: 'number', min: 1, max: 10 }
        )}
        {draft.subpages &&
          text(
            'subpageTarget',
            'Subpage target keyword',
            'Keyword guiding which subpages to crawl (e.g. docs, pricing).',
            'docs',
            { wide: true }
          )}
      </SettingsGroup>

      <ApiHeading
        title="Reader (Contents) API"
        description="Used when web_fetch reads a page via Exa."
      />
      <SettingsGroup title="Extraction settings">
        {text(
          'readMaxCharacters',
          'Max characters',
          'Maximum characters of page text to extract (100–100,000).',
          'Unlimited',
          { type: 'number', min: 100, max: 100000 }
        )}
        {toggle(
          'readIncludeHtmlTags',
          'Include HTML tags',
          'Preserve HTML tags in the extracted page text.'
        )}
        {toggle(
          'readHighlights',
          'Extract sentence highlights',
          'Extract key sentence highlights from the page.'
        )}
        {draft.readHighlights &&
          text(
            'readNumSentences',
            'Sentences per highlight',
            'Number of sentences in each highlight (1–10). Default 1.',
            '1',
            { type: 'number', min: 1, max: 10 }
          )}
        {draft.readHighlights &&
          text(
            'readHighlightsPerUrl',
            'Highlights count',
            'Number of highlights to return (1–10). Default 1.',
            '1',
            { type: 'number', min: 1, max: 10 }
          )}
        {draft.readHighlights &&
          text(
            'readHighlightsQuery',
            'Highlights query',
            'Query guiding sentence highlight selection.',
            'Key points',
            { wide: true }
          )}
        {toggle(
          'readSummary',
          'Generate summary',
          'Generate an AI summary of the read page.'
        )}
        {draft.readSummary &&
          text(
            'readSummaryQuery',
            'Summary query',
            'Custom prompt or question to guide page summary.',
            'Summary focus',
            { wide: true }
          )}
        {dropdown(
          'readLivecrawl',
          'Livecrawl mode',
          'Fetch live web pages rather than Exa cache.',
          [
            { value: '', label: 'Auto (default)' },
            { value: 'always', label: 'Always crawl live' },
            { value: 'fallback', label: 'Fallback to live crawl' },
            { value: 'never', label: 'Never crawl live (cache only)' },
          ]
        )}
        {draft.readLivecrawl &&
          text(
            'readLivecrawlTimeout',
            'Livecrawl timeout (ms)',
            'Maximum time in milliseconds for live crawling (1,000–60,000).',
            '10000',
            { type: 'number', min: 1000, max: 60000 }
          )}
        {text(
          'readSubpages',
          'Subpages',
          'Crawl and extract subpages linked from the URL (1–10).',
          'None',
          { type: 'number', min: 1, max: 10 }
        )}
        {draft.readSubpages &&
          text(
            'readSubpageTarget',
            'Subpage target keyword',
            'Keyword guiding which subpages to crawl (e.g. docs, api).',
            'docs',
            { wide: true }
          )}
      </SettingsGroup>
    </>
  )
}
