import { useCallback, useState } from 'react'
import OLButton from '@/shared/components/ol/ol-button'
import OLFormControl from '@/shared/components/ol/ol-form-control'
import OLFormGroup from '@/shared/components/ol/ol-form-group'
import OLFormLabel from '@/shared/components/ol/ol-form-label'
import OLFormSelect from '@/shared/components/ol/ol-form-select'
import OLFormText from '@/shared/components/ol/ol-form-text'
import OLRow from '@/shared/components/ol/ol-row'
import OLCol from '@/shared/components/ol/ol-col'
import Notification from '@/shared/components/notification'
import { testWebSearch } from '../providers/server-client'
import {
  ProviderError,
  WEB_SEARCH_DEFAULTS,
  WebSearchPreferences,
  WebSearchProviderType,
  WebSearchSettings,
} from '../providers/types'

export const WEB_SEARCH_LABELS: Record<WebSearchProviderType, string> = {
  ollama: 'Ollama web search',
  searxng: 'SearXNG',
}

/** What each backend is, so the choice can be made without the docs. */
const WEB_SEARCH_NOTES: Record<WebSearchProviderType, string> = {
  ollama:
    'Hosted by Ollama: searches and page reads both go through ollama.com. Needs a free API key.',
  searxng:
    'Your own SearXNG instance, no key needed. This server searches through it and reads pages itself, and the assistant can limit results to recent or news pages.',
}

type PreferenceKey = keyof WebSearchPreferences

const PREFERENCE_FIELDS: {
  key: PreferenceKey
  label: string
  unit?: string
}[] = [
  { key: 'resultsPerSearch', label: 'Max results per search' },
  { key: 'cacheHours', label: 'Keep results for', unit: 'hours' },
  { key: 'maxCachedSearches', label: 'Searches to keep' },
  { key: 'maxCachedPages', label: 'Pages to keep' },
]

/**
 * A field left blank is omitted, so the recommended value applies and keeps
 * applying if the recommendation changes. Anything out of range is clamped
 * the way the server would clamp it.
 */
function preferenceValue(key: PreferenceKey, raw: string): number | undefined {
  if (raw.trim() === '') return undefined
  const parsed = Math.trunc(Number(raw))
  if (!Number.isFinite(parsed)) return undefined
  const { min, max } = WEB_SEARCH_DEFAULTS[key]
  return Math.min(max, Math.max(min, parsed))
}

type Probe =
  | { state: 'idle' }
  | { state: 'busy' }
  | { state: 'ok'; message: string }
  | { state: 'failed'; message: string }

export default function WebSearchForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: WebSearchSettings
  onSave: (values: WebSearchSettings) => void
  onCancel: () => void
}) {
  const [type, setType] = useState<WebSearchProviderType>(
    initial?.type ?? 'ollama'
  )
  const [apiKey, setApiKey] = useState(
    initial?.type === 'ollama' ? initial.apiKey : ''
  )
  const [baseUrl, setBaseUrl] = useState(
    initial?.type === 'searxng' ? initial.baseUrl : ''
  )
  const [preferences, setPreferences] = useState<Record<PreferenceKey, string>>(
    () =>
      Object.fromEntries(
        PREFERENCE_FIELDS.map(({ key }) => [
          key,
          initial?.[key] === undefined ? '' : String(initial[key]),
        ])
      ) as Record<PreferenceKey, string>
  )
  const [probe, setProbe] = useState<Probe>({ state: 'idle' })

  const current = (): WebSearchSettings => {
    const chosen: WebSearchPreferences = {}
    for (const { key } of PREFERENCE_FIELDS) {
      const value = preferenceValue(key, preferences[key])
      if (value !== undefined) chosen[key] = value
    }
    return type === 'ollama'
      ? { type, apiKey: apiKey.trim(), ...chosen }
      : { type, baseUrl: baseUrl.trim(), ...chosen }
  }

  const complete =
    type === 'ollama' ? Boolean(apiKey.trim()) : Boolean(baseUrl.trim())

  const onTest = useCallback(async () => {
    setProbe({ state: 'busy' })
    try {
      const { latencyMs } = await testWebSearch(current())
      setProbe({ state: 'ok', message: `Search answered in ${latencyMs} ms.` })
    } catch (error: any) {
      setProbe({
        state: 'failed',
        message: (error as ProviderError)?.message || 'The search test failed.',
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, apiKey, baseUrl, preferences])

  return (
    <form
      className="linking-ai-assist-form"
      onSubmit={event => {
        event.preventDefault()
        onSave(current())
      }}
    >
      <OLFormGroup controlId="ai-web-search-type">
        <OLFormLabel>Search provider</OLFormLabel>
        <OLFormSelect
          value={type}
          onChange={e => {
            setType(e.target.value as WebSearchProviderType)
            setProbe({ state: 'idle' })
          }}
        >
          <option value="ollama">{WEB_SEARCH_LABELS.ollama}</option>
          <option value="searxng">{WEB_SEARCH_LABELS.searxng}</option>
        </OLFormSelect>
        <OLFormText>{WEB_SEARCH_NOTES[type]}</OLFormText>
      </OLFormGroup>

      {type === 'ollama' ? (
        <OLFormGroup controlId="ai-web-search-api-key">
          <OLFormLabel>Ollama API key</OLFormLabel>
          <OLFormControl
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
          />
          <OLFormText>
            Create one at ollama.com/settings/keys. Stored in this browser only.
          </OLFormText>
        </OLFormGroup>
      ) : (
        <OLFormGroup controlId="ai-web-search-base-url">
          <OLFormLabel>SearXNG URL</OLFormLabel>
          <OLFormControl
            value={baseUrl}
            onChange={e => setBaseUrl(e.target.value)}
            placeholder="http://searxng:8080"
          />
          <OLFormText>
            Your instance must allow the JSON format: add json to search.formats
            in its settings.yml. Pages are read by this Overleaf server.
          </OLFormText>
        </OLFormGroup>
      )}

      <OLRow>
        {PREFERENCE_FIELDS.map(({ key, label, unit }) => {
          const { value, min, max } = WEB_SEARCH_DEFAULTS[key]
          return (
            <OLCol key={key} xs={12} sm={6}>
              <OLFormGroup controlId={`ai-web-search-${key}`}>
                <OLFormLabel>
                  {label}
                  {unit ? ` (${unit})` : ''}
                </OLFormLabel>
                <OLFormControl
                  type="number"
                  min={min}
                  max={max}
                  step={1}
                  value={preferences[key]}
                  placeholder={String(value)}
                  onChange={e =>
                    setPreferences(prev => ({ ...prev, [key]: e.target.value }))
                  }
                />
              </OLFormGroup>
            </OLCol>
          )
        })}
      </OLRow>
      <OLFormText>
        Leave a field blank to use the recommended value shown in it. Results
        are cached on this Overleaf server for your account; 0 hours turns
        caching off, and searches limited to recent results are reused for an
        hour at most.
      </OLFormText>

      {probe.state === 'ok' ? (
        <div className="notification-list">
          <Notification type="success" content={probe.message} />
        </div>
      ) : null}
      {probe.state === 'failed' ? (
        <div className="notification-list">
          <Notification type="error" content={probe.message} />
        </div>
      ) : null}

      <div className="linking-ai-assist-form-actions">
        <OLButton variant="primary" type="submit" disabled={!complete}>
          Save
        </OLButton>
        <OLButton
          variant="secondary"
          type="button"
          onClick={onTest}
          isLoading={probe.state === 'busy'}
          loadingLabel="Testing search…"
          disabled={probe.state === 'busy' || !complete}
        >
          Test search
        </OLButton>
        <OLButton variant="secondary" type="button" onClick={onCancel}>
          Cancel
        </OLButton>
      </div>
    </form>
  )
}
