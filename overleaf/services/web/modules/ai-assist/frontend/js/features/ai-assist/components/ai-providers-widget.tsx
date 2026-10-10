import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { postJSON } from '@/infrastructure/fetch-json'
import getMeta from '@/utils/meta'
import OLBadge from '@/shared/components/ol/ol-badge'
import OLButton from '@/shared/components/ol/ol-button'
import Notification from '@/shared/components/notification'
import ProviderForm from './provider-form'
import ProviderIcon from './provider-icon'
import WebSearchWidget from './web-search-widget'
import {
  PROVIDER_TYPE_LABELS,
  ProviderSettings,
} from '../providers/types'
import {
  clearFastSettings,
  clearSettings,
  hasConsented,
  isAiAssistEnabled,
  isWebToolsAvailable,
  readFastSettings,
  readSettings,
  setAiAssistEnabled,
  writeFastSettings,
  writeSettings,
} from '../provider-store'
import '../../../../stylesheets/ai-assist.scss'

/** One model slot: where it is stored and how its card reads. */
type SlotConfig = {
  id: 'main' | 'fast'
  title: string
  description: string
  emptyText: string
  addLabel: string
  changeLabel: string
  removeLabel?: string
  testId: string
  read: () => ProviderSettings | null
  write: (settings: ProviderSettings) => void
  clear: () => void
  idPrefix: string
  /** Whether the data-sharing consent notice is shown for this slot. */
  needsConsent: boolean
}

const SLOTS: SlotConfig[] = [
  {
    id: 'main',
    title: 'Main model',
    description: 'Used by the AI assistant and the AI tools in the editor.',
    emptyText: 'No provider configured. Add one to turn on the assistant.',
    addLabel: 'Add provider',
    changeLabel: 'Change provider',
    testId: 'provider-current',
    read: readSettings,
    write: writeSettings,
    clear: clearSettings,
    idPrefix: 'ai-provider',
    needsConsent: true,
  },
  {
    id: 'fast',
    title: 'Fast model',
    description:
      'A smaller, lower-cost model for code completion and language suggestions. Leave empty to use the main model.',
    emptyText: 'No fast model configured.',
    addLabel: 'Add fast model',
    changeLabel: 'Change fast model',
    removeLabel: 'Remove fast model',
    testId: 'fast-provider-current',
    read: readFastSettings,
    write: writeFastSettings,
    clear: clearFastSettings,
    idPrefix: 'ai-fast-provider',
    needsConsent: false,
  },
]

export default function AiProvidersWidget() {
  const { t } = useTranslation()
  const enabled = Boolean(getMeta('ol-aiAssistEnabled'))

  const [aiEnabled, setAiEnabled] = useState(() => isAiAssistEnabled())
  const [consented, setConsented] = useState(false)

  useEffect(() => {
    if (!enabled) return
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

  if (!enabled) return null

  return (
    <div className="linking-ai-assist">
      <div className="unboxed-setting-row">
        <div className="unboxed-setting-description">
          <p>
            Our AI features explain compile errors and propose fixes directly
            from your browser. Your API key is stored in this browser only and
            is never sent to this Overleaf server.
          </p>
        </div>
        <div>
          {aiEnabled ? (
            <OLButton
              variant="danger-ghost"
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

      {SLOTS.map(slot => (
        <ProviderSlot
          key={slot.id}
          slot={slot}
          aiEnabled={aiEnabled}
          consented={consented}
        />
      ))}

      {/* Web search is the one addition to the upstream AI features
          section, so it gets its own bordered box like the other
          linking widgets. */}
      {isWebToolsAvailable() ? (
        <div className="settings-widgets-container linking-ai-assist-web-search">
          <WebSearchWidget />
        </div>
      ) : null}
    </div>
  )
}

function ProviderSlot({
  slot,
  aiEnabled,
  consented,
}: {
  slot: SlotConfig
  aiEnabled: boolean
  consented: boolean
}) {
  const [settings, setSettings] = useState<ProviderSettings | null>(null)
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    setSettings(slot.read())
    const eventName =
      slot.id === 'main'
        ? 'aiAssist:providerChanged'
        : 'aiAssist:fastProviderChanged'
    const handleUpdate = () => {
      setSettings(slot.read())
    }
    window.addEventListener(eventName, handleUpdate)
    return () => {
      window.removeEventListener(eventName, handleUpdate)
    }
  }, [slot])

  const save = useCallback(
    (values: ProviderSettings) => {
      slot.write(values)
      setSettings(values)
      setEditing(false)
    },
    [slot]
  )

  const remove = useCallback(() => {
    slot.clear()
    setSettings(null)
  }, [slot])

  return (
    <div className="linking-ai-assist-slot">
      <div className="linking-ai-assist-slot-header">
        <span className="fw-bold">{slot.title}</span>
        <span className="small linking-ai-assist-secondary-text">
          {slot.description}
        </span>
      </div>

      {settings && !editing ? (
        <div
          className="linking-ai-assist-provider-card"
          data-testid={slot.testId}
        >
          <div className="d-flex align-items-center gap-3">
            <ProviderIcon type={settings.type} size={28} />
            <div className="linking-ai-assist-provider-details">
              <span className="fw-bold">
                {PROVIDER_TYPE_LABELS[settings.type] ?? settings.type}
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
              variant="secondary"
              type="button"
              aria-label={slot.changeLabel}
              onClick={() => setEditing(true)}
            >
              Edit
            </OLButton>
            <OLButton
              variant="danger-ghost"
              type="button"
              aria-label={slot.removeLabel}
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
            {slot.emptyText}
          </p>
          {aiEnabled && (
            <OLButton
              variant="secondary"
              type="button"
              onClick={() => setEditing(true)}
            >
              {slot.addLabel}
            </OLButton>
          )}
        </div>
      ) : null}

      {slot.needsConsent &&
      !consented &&
      settings &&
      !editing &&
      aiEnabled ? (
        <div className="notification-list">
          <Notification
            type="info"
            content="You will be asked to allow sending part of your document the first time you use the assistant."
          />
        </div>
      ) : null}

      {editing ? (
        <ProviderForm
          initial={settings ?? undefined}
          onSave={save}
          onCancel={() => setEditing(false)}
          idPrefix={slot.idPrefix}
        />
      ) : null}
    </div>
  )
}
