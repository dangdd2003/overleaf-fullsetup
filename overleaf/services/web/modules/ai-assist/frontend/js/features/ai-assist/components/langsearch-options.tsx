import ToggleSetting from '@/features/ide-settings/components/toggle-setting'
import DropdownSetting from '@/features/ide-settings/components/dropdown-setting'
import { ApiHeading, SettingsGroup, TextSetting } from './web-search-settings'
import {
  LangsearchFreshness,
  LangsearchProviderConfig,
  LangsearchSearchOptions,
} from '../providers/types'

/**
 * The LangSearch options as the form edits them: text as typed, and '' for "use
 * the API's default". langsearchOptionsFromDraft turns it back into stored options.
 */
export type LangsearchDraft = {
  maxResults: string
  freshness: '' | LangsearchFreshness
  includeDomains: string
  excludeDomains: string
  includeContent: boolean
  maxCharacters: string
}

type FlagKey = {
  [K in keyof LangsearchDraft]: LangsearchDraft[K] extends boolean ? K : never
}[keyof LangsearchDraft]

export function draftFromLangsearch(
  config?: LangsearchProviderConfig
): LangsearchDraft {
  const search = config?.search ?? {}
  const number = (value?: number) => (value === undefined ? '' : String(value))
  return {
    maxResults: number(search.maxResults),
    freshness: search.freshness ?? '',
    includeDomains: (search.includeDomains ?? []).join(', '),
    excludeDomains: (search.excludeDomains ?? []).join(', '),
    includeContent: search.includeContent ?? false,
    maxCharacters: number(search.maxCharacters),
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

export function langsearchOptionsFromDraft(draft: LangsearchDraft): {
  search?: LangsearchSearchOptions
} {
  const search = withoutEmpty({
    maxResults: inRange(draft.maxResults, 1, 50),
    freshness: draft.freshness || undefined,
    includeDomains: domains(draft.includeDomains),
    excludeDomains: domains(draft.excludeDomains),
    includeContent: draft.includeContent,
    maxCharacters: draft.includeContent
      ? inRange(draft.maxCharacters, 100, 100000)
      : undefined,
  }) as LangsearchSearchOptions
  return {
    ...(Object.keys(search).length > 0 ? { search } : {}),
  }
}

type Choice = { value: string; label: string }

export default function LangsearchOptions({
  draft,
  onChange,
}: {
  draft: LangsearchDraft
  onChange: (next: LangsearchDraft) => void
}) {
  const set = <K extends keyof LangsearchDraft>(
    key: K,
    value: LangsearchDraft[K]
  ) => onChange({ ...draft, [key]: value })

  const id = (key: keyof LangsearchDraft) => `ai-web-search-langsearch-${key}`

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
    key: Exclude<keyof LangsearchDraft, FlagKey>,
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
      onChange={value => set(key, value as LangsearchDraft[typeof key])}
    />
  )

  const text = (
    key: Exclude<keyof LangsearchDraft, FlagKey>,
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
      onChange={value => set(key, value as LangsearchDraft[typeof key])}
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
          'Number of results to return, from 1 to 50. Default 10.',
          '10',
          { type: 'number', min: 1, max: 50 }
        )}
        {dropdown(
          'freshness',
          'Freshness',
          'Filter search results by publication date.',
          [
            { value: '', label: 'No limit (default)' },
            { value: 'oneDay', label: 'Past 24 hours' },
            { value: 'oneWeek', label: 'Past week' },
            { value: 'oneMonth', label: 'Past month' },
            { value: 'oneYear', label: 'Past year' },
          ]
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
        {toggle(
          'includeContent',
          'Extract full webpage content',
          'Retrieve full webpage text directly with search results.'
        )}
        {draft.includeContent &&
          text(
            'maxCharacters',
            'Max characters per page',
            'Maximum characters of page text to extract per result (100–100,000).',
            'Unlimited',
            { type: 'number', min: 100, max: 100000 }
          )}
      </SettingsGroup>
    </>
  )
}
