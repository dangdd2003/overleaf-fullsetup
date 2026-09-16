import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { postJSON } from '@/infrastructure/fetch-json'
import getMeta from '@/utils/meta'
import OLBadge from '@/shared/components/ol/ol-badge'
import OLButton from '@/shared/components/ol/ol-button'
import OLNotification from '@/shared/components/ol/ol-notification'
import ProviderForm from './provider-form'
import ProviderIcon from './provider-icon'
import { ProviderSettings } from '../providers/types'
import {
  clearSettings,
  hasConsented,
  isAiAssistEnabled,
  readSettings,
  setAiAssistEnabled,
  writeSettings,
} from '../provider-store'

const TYPE_LABELS: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google Gemini',
  ollama: 'Ollama',
}

export default function AiProvidersWidget() {
  const { t } = useTranslation()
  const enabled = Boolean(getMeta('ol-aiAssistEnabled'))

  const [aiEnabled, setAiEnabled] = useState(() => isAiAssistEnabled())
  const [settings, setSettings] = useState<ProviderSettings | null>(null)
  const [editing, setEditing] = useState(false)
  const [consented, setConsented] = useState(false)

  useEffect(() => {
    if (!enabled) return
    setSettings(readSettings())
    setConsented(hasConsented())
    setAiEnabled(isAiAssistEnabled())
  }, [enabled])

  const toggleAiEnabled = useCallback(async () => {
    const next = !aiEnabled
    setAiEnabled(next)
    setAiAssistEnabled(next)
    try {
      await postJSON('/user/settings', {
        body: {
          aiFeatures: {
            enabled: next,
          },
        },
      })
    } catch {
      // Ignore network errors in test/offline environments
    }
  }, [aiEnabled])

  const save = useCallback((values: ProviderSettings) => {
    writeSettings(values)
    setSettings(values)
    setEditing(false)
  }, [])

  const remove = useCallback(() => {
    clearSettings()
    setSettings(null)
  }, [])

  if (!enabled) return null

  return (
    <div className="linking-ai-assist mb-4">
      <div className="unboxed-setting-row align-items-center mb-3">
        <div className="unboxed-setting-description">
          <p className="linking-ai-assist-description mb-0">
            Our AI features explain compile errors and propose fixes directly
            from your browser. Your API key is stored in this browser only and is
            never sent to this Overleaf server.
          </p>
        </div>
        <div className="d-flex align-items-center gap-2">
          {aiEnabled ? (
            <OLButton
              variant="secondary"
              className="btn-ai-disable"
              type="button"
              onClick={toggleAiEnabled}
            >
              {t('disable_ai_features', 'Disable AI features')}
            </OLButton>
          ) : (
            <OLButton
              variant="secondary"
              type="button"
              onClick={toggleAiEnabled}
            >
              {t('enable_ai_features', 'Enable AI features')}
            </OLButton>
          )}
        </div>
      </div>

      {settings && !editing ? (
        <div
          className="linking-ai-assist-provider-card"
          data-testid="provider-current"
        >
          <div className="d-flex align-items-center gap-3">
            <ProviderIcon type={settings.type} size={28} />
            <div className="linking-ai-assist-provider-details">
              <span className="fw-bold">
                {TYPE_LABELS[settings.type] ?? settings.type}
              </span>
              <span
                className="small linking-ai-assist-secondary-text"
                title={settings.model}
              >
                {settings.modelName || settings.model} · {settings.baseUrl}
              </span>
            </div>
          </div>
          <div className="linking-ai-assist-provider-actions">
            <OLBadge bg={!aiEnabled ? 'danger' : consented ? 'info' : 'warning'}>
              {!aiEnabled ? 'Disabled' : consented ? 'Ready' : 'Consent pending'}
            </OLBadge>
            <OLButton
              variant="link"
              size="sm"
              type="button"
              aria-label="Change provider"
              onClick={() => setEditing(true)}
            >
              Edit
            </OLButton>
            <OLButton
              variant="link"
              size="sm"
              type="button"
              onClick={remove}
            >
              Remove
            </OLButton>
          </div>
        </div>
      ) : null}

      {!settings && !editing ? (
        <div className="linking-ai-assist-empty">
          <p className="small linking-ai-assist-secondary-text mb-2">
            No provider configured. Add one to turn on the assistant.
          </p>
          {aiEnabled && (
            <OLButton
              variant="secondary"
              type="button"
              onClick={() => setEditing(true)}
            >
              Add provider
            </OLButton>
          )}
        </div>
      ) : null}

      {!consented && settings && !editing && aiEnabled ? (
        <OLNotification
          type="info"
          content="You will be asked to allow sending part of your document the first time you use the assistant."
        />
      ) : null}

      {editing ? (
        <ProviderForm
          initial={settings ?? undefined}
          onSave={save}
          onCancel={() => setEditing(false)}
        />
      ) : null}
    </div>
  )
}

