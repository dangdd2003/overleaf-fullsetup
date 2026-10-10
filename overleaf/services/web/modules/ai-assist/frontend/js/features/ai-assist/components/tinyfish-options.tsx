import ToggleSetting from '@/features/ide-settings/components/toggle-setting'
import DropdownSetting from '@/features/ide-settings/components/dropdown-setting'
import { ApiHeading, SettingsGroup, TextSetting } from './web-search-settings'
import {
  TinyfishDomainType,
  TinyfishProviderConfig,
  TinyfishSearchOptions,
} from '../providers/types'

/**
 * The TinyFish options as the form edits them: text as typed, and '' for "use
 * the API's default". tinyfishOptionsFromDraft turns it back into stored options.
 * See https://docs.tinyfish.ai/search-api/reference
 */
export type TinyfishDraft = {
  maxResults: string
  domainType: '' | TinyfishDomainType
  location: string
  language: string
  includeDomains: string
  excludeDomains: string
  recencyMinutes: string
  afterDate: string
  beforeDate: string
  pubYearMin: string
  pubYearMax: string
}

type FlagKey = {
  [K in keyof TinyfishDraft]: TinyfishDraft[K] extends boolean ? K : never
}[keyof TinyfishDraft]

export function draftFromTinyfish(
  config?: TinyfishProviderConfig
): TinyfishDraft {
  const search = config?.search ?? {}
  const number = (value?: number) => (value === undefined ? '' : String(value))
  return {
    maxResults: number(search.maxResults),
    domainType: search.domainType ?? '',
    location: search.location ?? '',
    language: search.language ?? '',
    includeDomains: (search.includeDomains ?? []).join(', '),
    excludeDomains: (search.excludeDomains ?? []).join(', '),
    recencyMinutes: number(search.recencyMinutes),
    afterDate: search.afterDate ?? '',
    beforeDate: search.beforeDate ?? '',
    pubYearMin: number(search.pubYearMin),
    pubYearMax: number(search.pubYearMax),
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

function cleanDate(raw: string) {
  const text = raw.trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : undefined
}

export function tinyfishOptionsFromDraft(draft: TinyfishDraft): {
  search?: TinyfishSearchOptions
} {
  const isPaper = draft.domainType === 'research_paper'
  const recencyMinutes = !isPaper
    ? inRange(draft.recencyMinutes, 1, 5256000)
    : undefined
  const search = withoutEmpty({
    maxResults: inRange(draft.maxResults, 1, 20),
    domainType: draft.domainType || undefined,
    location: draft.location.trim().toUpperCase().slice(0, 2) || undefined,
    language: draft.language.trim().toLowerCase().slice(0, 5) || undefined,
    includeDomains: domains(draft.includeDomains),
    excludeDomains: domains(draft.excludeDomains),
    ...(isPaper
      ? {
          pubYearMin: inRange(draft.pubYearMin, 0, 9999),
          pubYearMax: inRange(draft.pubYearMax, 0, 9999),
        }
      : {
          recencyMinutes,
          afterDate: recencyMinutes ? undefined : cleanDate(draft.afterDate),
          beforeDate: recencyMinutes ? undefined : cleanDate(draft.beforeDate),
        }),
  }) as TinyfishSearchOptions
  return {
    ...(Object.keys(search).length > 0 ? { search } : {}),
  }
}

type Choice = { value: string; label: string }

export default function TinyfishOptions({
  draft,
  onChange,
}: {
  draft: TinyfishDraft
  onChange: (next: TinyfishDraft) => void
}) {
  const set = <K extends keyof TinyfishDraft>(
    key: K,
    value: TinyfishDraft[K]
  ) => onChange({ ...draft, [key]: value })

  const id = (key: keyof TinyfishDraft) => `ai-web-search-tinyfish-${key}`

  const toggle = (key: FlagKey, label: string, description: string) => (
    <ToggleSetting
      id={id(key)}
      label={label}
      description={description}
      checked={draft[key]}
      onChange={value => set(key, value as TinyfishDraft[typeof key])}
    />
  )

  void toggle

  const dropdown = (
    key: Exclude<keyof TinyfishDraft, FlagKey>,
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
      onChange={value => set(key, value as TinyfishDraft[typeof key])}
    />
  )

  const text = (
    key: Exclude<keyof TinyfishDraft, FlagKey>,
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
      onChange={value => set(key, value as TinyfishDraft[typeof key])}
      {...extra}
    />
  )

  const isPaper = draft.domainType === 'research_paper'

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
          'Number of results to keep, from 1 to 20. Default 10.',
          '10',
          { type: 'number', min: 1, max: 20 }
        )}
        {dropdown(
          'domainType',
          'Content type',
          'Web, news articles with publisher and date, or research papers with authors and citations.',
          [
            { value: '', label: 'Web (default)' },
            { value: 'web', label: 'Web' },
            { value: 'news', label: 'News' },
            { value: 'research_paper', label: 'Research papers' },
          ]
        )}
        {text(
          'location',
          'Country',
          'Two-letter country code for geo-targeting, e.g. US. Blank uses API default.',
          'US'
        )}
        {text(
          'language',
          'Language',
          'Result language code, e.g. en. Blank uses API default.',
          'en'
        )}
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
      </SettingsGroup>

      {isPaper ? (
        <SettingsGroup title="Publication years (research papers only)">
          {text(
            'pubYearMin',
            'Earliest year',
            'Only papers from this year on (0–9999).',
            '2019',
            { type: 'number', min: 0, max: 9999 }
          )}
          {text(
            'pubYearMax',
            'Latest year',
            'Only papers up to this year (0–9999).',
            '2026',
            { type: 'number', min: 0, max: 9999 }
          )}
        </SettingsGroup>
      ) : (
        <SettingsGroup title="Freshness (web and news only)">
          {text(
            'recencyMinutes',
            'Freshness (minutes)',
            'Only results from the last N minutes (1–5256000). Takes precedence over dates below.',
            '60',
            { type: 'number', min: 1, max: 5256000 }
          )}
          {text(
            'afterDate',
            'After date',
            'Only results after this date (YYYY-MM-DD). Ignored when freshness is set.',
            '2026-01-01',
            { wide: true }
          )}
          {text(
            'beforeDate',
            'Before date',
            'Only results before this date (YYYY-MM-DD). Ignored when freshness is set.',
            '2026-10-09',
            { wide: true }
          )}
        </SettingsGroup>
      )}
    </>
  )
}
