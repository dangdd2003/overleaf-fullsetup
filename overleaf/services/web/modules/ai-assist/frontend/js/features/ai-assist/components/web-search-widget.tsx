import { useCallback, useEffect, useState } from 'react'
import { Globe } from '@phosphor-icons/react'
import OLButton from '@/shared/components/ol/ol-button'
import LinkingStatus from '@/features/settings/components/linking/status'
import WebSearchForm, { WEB_SEARCH_LABELS } from './web-search-form'
import { WEB_SEARCH_DEFAULTS, WebSearchSettings } from '../providers/types'
import {
  clearWebSearchSettings,
  readWebSearchSettings,
  writeWebSearchSettings,
} from '../provider-store'

/**
 * Account Settings row for the agent's web search backend, laid out like the
 * other linking widgets: logo, title and description, action on the right.
 */
function cacheSummary(settings: WebSearchSettings) {
  const hours = settings.cacheHours ?? WEB_SEARCH_DEFAULTS.cacheHours.value
  return hours === 0
    ? 'results not cached'
    : `results cached for ${hours} hour${hours === 1 ? '' : 's'}`
}

export default function WebSearchWidget() {
  const [settings, setSettings] = useState<WebSearchSettings | null>(null)
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    setSettings(readWebSearchSettings())
  }, [])

  const save = useCallback((values: WebSearchSettings) => {
    writeWebSearchSettings(values)
    setSettings(values)
    setEditing(false)
  }, [])

  const remove = useCallback(() => {
    clearWebSearchSettings()
    setSettings(null)
  }, [])

  return (
    <div
      className="settings-widget-container"
      data-testid="web-search-settings"
    >
      <div className={editing ? 'linking-icon-fixed-position' : undefined}>
        <Globe size={40} aria-hidden="true" />
      </div>
      <div className="description-container">
        <div className="title-row">
          <h4 id="ai-web-search">Web search</h4>
        </div>
        <p className="small">
          Lets the AI assistant search the web and read pages for package
          documentation, command syntax and templates. Searches are sent from
          this Overleaf server through Ollama web search or your own SearXNG
          instance.
        </p>
        {settings && !editing ? (
          <LinkingStatus
            status="success"
            description={`${
              settings.type === 'searxng'
                ? `Using ${WEB_SEARCH_LABELS.searxng} at ${settings.baseUrl}`
                : `Using ${WEB_SEARCH_LABELS.ollama}`
            } · ${cacheSummary(settings)}`}
          />
        ) : null}
        {editing ? (
          <WebSearchForm
            initial={settings ?? undefined}
            onSave={save}
            onCancel={() => setEditing(false)}
          />
        ) : null}
      </div>
      <div>
        {editing ? null : settings ? (
          <div className="d-flex gap-2">
            <OLButton
              variant="secondary"
              onClick={() => setEditing(true)}
              aria-label="Edit web search"
            >
              Edit
            </OLButton>
            <OLButton variant="danger-ghost" onClick={remove}>
              Remove
            </OLButton>
          </div>
        ) : (
          <OLButton
            variant="secondary"
            onClick={() => setEditing(true)}
            aria-label="Set up web search"
          >
            Set up
          </OLButton>
        )}
      </div>
    </div>
  )
}
