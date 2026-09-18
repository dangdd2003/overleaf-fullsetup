import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import OLButton from '@/shared/components/ol/ol-button'
import OLFormControl from '@/shared/components/ol/ol-form-control'
import OLFormGroup from '@/shared/components/ol/ol-form-group'
import OLFormLabel from '@/shared/components/ol/ol-form-label'
import OLFormSelect from '@/shared/components/ol/ol-form-select'
import OLFormText from '@/shared/components/ol/ol-form-text'
import Notification from '@/shared/components/notification'
import ProviderIcon from './provider-icon'
import { AiAssistant } from '../assistant'
import {
  DEFAULT_BASE_URLS,
  DEFAULT_LIMITS,
  ProviderError,
  ProviderModel,
  ProviderSettings,
  ProviderType,
} from '../providers/types'

/**
 * Parses a form field into a positive number, or `undefined` when the field
 * should be omitted entirely. Omitting (rather than storing `0` or `NaN`) is
 * what lets a cleared field fall back to the provider default: `resolveLimits`
 * only overrides the default for values it considers positive numbers.
 */
function numeric(value: string): number | undefined {
  const parsed = Number(value)
  return value.trim() !== '' && Number.isFinite(parsed) && parsed > 0
    ? parsed
    : undefined
}

const TYPES: { value: ProviderType; label: string }[] = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'google', label: 'Google Gemini' },
  { value: 'ollama', label: 'Ollama' },
]

type Probe =
  | { state: 'idle' }
  | { state: 'busy' }
  | { state: 'ok'; message: string }
  | { state: 'failed'; message: string }

export default function ProviderForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: ProviderSettings
  onSave: (values: ProviderSettings) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const [type, setType] = useState<ProviderType>(initial?.type ?? 'openai')
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '')
  const [model, setModel] = useState(initial?.model ?? '')
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? '')
  const [contextWindow, setContextWindow] = useState(
    initial?.contextWindow != null ? String(initial.contextWindow) : ''
  )
  const [maxOutputTokens, setMaxOutputTokens] = useState(
    initial?.maxOutputTokens != null ? String(initial.maxOutputTokens) : ''
  )
  // `type` is typed as `ProviderType`, but a value loaded from storage isn't
  // checked at runtime — a corrupted or stale entry can hold a type outside
  // the three-member union, and indexing `DEFAULT_LIMITS` with it would
  // otherwise be `undefined` and throw when rendering the placeholders below.
  const defaultLimits = DEFAULT_LIMITS[type] ?? DEFAULT_LIMITS.openai

  const [models, setModels] = useState<ProviderModel[]>(
    initial?.model && initial?.modelName
      ? [{ id: initial.model, label: initial.modelName }]
      : []
  )
  const [manualModel, setManualModel] = useState(
    !(initial?.model && initial?.modelName)
  )
  const [loadingModels, setLoadingModels] = useState(false)
  const [modelsMessage, setModelsMessage] = useState<string | null>(null)
  const [probe, setProbe] = useState<Probe>({ state: 'idle' })

  // Some endpoints report each model's own context window / output cap
  // alongside its listing. That's a better default than the hardcoded
  // fallback, so picking such a model fills the fields with its real values
  // (still editable, still overridable) instead of leaving them blank.
  const applyModelLimits = useCallback((entry?: ProviderModel) => {
    if (entry?.contextWindow) setContextWindow(String(entry.contextWindow))
    if (entry?.maxOutputTokens)
      setMaxOutputTokens(String(entry.maxOutputTokens))
  }, [])

  const current = (): ProviderSettings => {
    const trimmedModel = model.trim()
    let selected = models.find(entry => entry.id === trimmedModel)
    let effectiveModel = trimmedModel

    if (!selected && trimmedModel && models.length > 0) {
      const matchedByLabel = models.find(
        entry =>
          entry.label.trim().toLowerCase() === trimmedModel.toLowerCase() ||
          entry.label.replace(/\s*\([^)]*\)$/, '').trim().toLowerCase() ===
            trimmedModel.replace(/\s*\([^)]*\)$/, '').trim().toLowerCase()
      )
      if (matchedByLabel) {
        selected = matchedByLabel
        effectiveModel = matchedByLabel.id
      }
    }

    const realName =
      selected?.label && selected.label !== effectiveModel
        ? selected.label
        : effectiveModel === initial?.model
        ? initial?.modelName
        : undefined
    const parsedContextWindow = numeric(contextWindow)
    const parsedMaxOutputTokens = numeric(maxOutputTokens)
    return {
      type,
      baseUrl: baseUrl.trim() || DEFAULT_BASE_URLS[type],
      apiKey,
      model: effectiveModel,
      ...(realName ? { modelName: realName } : {}),
      ...(parsedContextWindow !== undefined
        ? { contextWindow: parsedContextWindow }
        : {}),
      ...(parsedMaxOutputTokens !== undefined
        ? { maxOutputTokens: parsedMaxOutputTokens }
        : {}),
    }
  }

  const onLoadModels = useCallback(async () => {
    setLoadingModels(true)
    setModelsMessage(null)
    setProbe({ state: 'idle' })
    try {
      const loaded = await new AiAssistant(current()).listModels()
      setModels(loaded)
      if (loaded.length > 0) {
        setManualModel(false)
        const selected = loaded.find(
          entry =>
            entry.id === model ||
            entry.label.trim().toLowerCase() === model.trim().toLowerCase() ||
            entry.label.replace(/\s*\([^)]*\)$/, '').trim().toLowerCase() ===
              model.replace(/\s*\([^)]*\)$/, '').trim().toLowerCase()
        )
        if (selected) {
          setModel(selected.id)
          applyModelLimits(selected)
        } else {
          setModel(loaded[0].id)
          applyModelLimits(loaded[0])
        }
      } else {
        setModelsMessage('The provider returned no models.')
      }
    } catch (error: any) {
      setModels([])
      const providerError = error as ProviderError
      setModelsMessage(
        providerError?.code === 'modelsUnsupported'
          ? 'This endpoint does not list models — type the model name yourself.'
          : providerError?.message || 'Could not load the model list.'
      )
    } finally {
      setLoadingModels(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, baseUrl, apiKey, model])

  const onTest = useCallback(async () => {
    setProbe({ state: 'busy' })
    try {
      const { latencyMs } = await new AiAssistant(current()).test()
      setProbe({ state: 'ok', message: `Connected in ${latencyMs} ms.` })
    } catch (error: any) {
      const providerError = error as ProviderError
      setProbe({
        state: 'failed',
        message: providerError?.message || 'The connection test failed.',
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, baseUrl, apiKey, model])

  const onChangeType = useCallback((next: ProviderType) => {
    setType(next)
    // The old list belongs to the old endpoint.
    setModels([])
    setManualModel(true)
    setModelsMessage(null)
    setProbe({ state: 'idle' })
  }, [])

  return (
    <form
      className="linking-ai-assist-form"
      onSubmit={event => {
        event.preventDefault()
        onSave(current())
      }}
    >
      <OLFormGroup controlId="ai-provider-type">
        <OLFormLabel>Provider type</OLFormLabel>
        <div className="d-flex align-items-center gap-2">
          <OLFormSelect
            value={type}
            onChange={e => onChangeType(e.target.value as ProviderType)}
          >
            {TYPES.map(entry => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </OLFormSelect>
          <ProviderIcon type={type} size={24} />
        </div>
      </OLFormGroup>

      <OLFormGroup controlId="ai-provider-base-url">
        <OLFormLabel>Base URL</OLFormLabel>
        <OLFormControl
          value={baseUrl}
          onChange={e => setBaseUrl(e.target.value)}
          placeholder={DEFAULT_BASE_URLS[type]}
        />
        <OLFormText>
          Leave blank to use the default ({DEFAULT_BASE_URLS[type]}), or enter
          a custom compatible endpoint.
        </OLFormText>
      </OLFormGroup>

      <OLFormGroup controlId="ai-provider-api-key">
        <OLFormLabel>
          API key{type === 'ollama' ? ' (optional)' : ''}
        </OLFormLabel>
        <OLFormControl
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={e => setApiKey(e.target.value)}
          placeholder={type === 'ollama' ? 'Optional for local Ollama' : undefined}
        />
        <OLFormText>
          Stored in this browser only. Anyone who can run scripts on this page
          can read it.
        </OLFormText>
      </OLFormGroup>

      <OLFormGroup controlId="ai-provider-model">
        <OLFormLabel>Model</OLFormLabel>
        {manualModel ? (
          <OLFormControl
            value={model}
            onChange={e => setModel(e.target.value)}
            placeholder="gpt-4o-mini"
          />
        ) : (
          <OLFormSelect
            value={model}
            onChange={e => {
              setModel(e.target.value)
              applyModelLimits(models.find(entry => entry.id === e.target.value))
            }}
            data-testid="ai-provider-model-select"
          >
            {models.map(entry => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </OLFormSelect>
        )}

        <div className="linking-ai-assist-form-actions">
          <OLButton
            variant="secondary"
            size="sm"
            type="button"
            onClick={onLoadModels}
            isLoading={loadingModels}
            loadingLabel="Loading models…"
            disabled={loadingModels}
          >
            Load models
          </OLButton>

          {models.length > 0 ? (
            <OLButton
              variant="secondary"
              size="sm"
              type="button"
              className="ai-provider-toggle-model-mode"
              onClick={() => setManualModel(current => !current)}
            >
              {manualModel ? 'Choose from list' : 'Enter manually'}
            </OLButton>
          ) : null}

          <OLButton
            variant="secondary"
            size="sm"
            type="button"
            onClick={onTest}
            isLoading={probe.state === 'busy'}
            loadingLabel="Testing connection…"
            disabled={probe.state === 'busy' || !model}
          >
            Test connection
          </OLButton>
        </div>

        {modelsMessage ? <OLFormText>{modelsMessage}</OLFormText> : null}
      </OLFormGroup>

      <OLFormGroup controlId="ai-provider-context-window">
        <OLFormLabel>
          {t('ai_assist_context_window', 'Context window (tokens)')}
        </OLFormLabel>
        <OLFormControl
          type="number"
          min={1}
          value={contextWindow}
          placeholder={String(defaultLimits.contextWindow)}
          onChange={e => setContextWindow(e.target.value)}
        />
      </OLFormGroup>

      <OLFormGroup controlId="ai-provider-max-output-tokens">
        <OLFormLabel>
          {t('ai_assist_max_output_tokens', 'Max output tokens')}
        </OLFormLabel>
        <OLFormControl
          type="number"
          min={1}
          value={maxOutputTokens}
          placeholder={String(defaultLimits.maxOutputTokens)}
          onChange={e => setMaxOutputTokens(e.target.value)}
        />
      </OLFormGroup>

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
        <OLButton variant="primary" type="submit" disabled={!model}>
          Save
        </OLButton>
        <OLButton variant="secondary" type="button" onClick={onCancel}>
          Cancel
        </OLButton>
      </div>
    </form>
  )
}
