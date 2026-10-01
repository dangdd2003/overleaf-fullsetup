import { useCallback, useEffect, useState } from 'react'
import { Globe } from '@phosphor-icons/react'
import OLButton from '@/shared/components/ol/ol-button'
import LinkingStatus from '@/features/settings/components/linking/status'
import WebSearchForm, { WEB_SEARCH_LABELS } from './web-search-form'
import {
  MultiWebSearchSettings,
  WEB_SEARCH_DEFAULTS,
  WebSearchPreferences,
} from '../providers/types'
import {
  clearWebSearchSettings,
  isServerWebSearchAvailable,
  readWebSearchSettings,
  writeWebSearchSettings,
} from '../provider-store'

function plural(count: number, noun: string, nouns = `${noun}s`) {
  return `${count} ${count === 1 ? noun : nouns}`
}

/**
 * What web search is using: a lead-in line, one bullet per enabled provider,
 * and plain lines for how searches are spread and cached. `configured` is
 * whether at least one provider is set up to answer.
 */
function statusSummary(settings: MultiWebSearchSettings) {
  if (settings.sourceMode === 'server') {
    return {
      lead: "Using this server's pre-configured web search.",
      providers: [],
      notes: [],
      configured: true,
    }
  }

  const providers: string[] = []
  const searxng = settings.providers?.searxng
  if (searxng?.enabled && searxng.baseUrls?.length) {
    providers.push(`SearXNG (${plural(searxng.baseUrls.length, 'instance')})`)
  }
  const ollama = settings.providers?.ollama
  if (ollama?.enabled && ollama.apiKeys?.length) {
    providers.push(`Ollama (${plural(ollama.apiKeys.length, 'API key')})`)
  }
  const websearchapi = settings.providers?.websearchapi
  if (websearchapi?.enabled && websearchapi.apiKeys?.length) {
    providers.push(
      `WebSearchAPI.ai (${plural(websearchapi.apiKeys.length, 'API key')})`
    )
  }
  const tavily = settings.providers?.tavily
  if (tavily?.enabled && tavily.apiKeys?.length) {
    providers.push(`Tavily (${plural(tavily.apiKeys.length, 'API key')})`)
  }
  const firecrawl = settings.providers?.firecrawl
  if (firecrawl?.enabled && firecrawl.apiKeys?.length) {
    providers.push(`Firecrawl (${plural(firecrawl.apiKeys.length, 'API key')})`)
  }
  const firecrawlSelfHosted = settings.providers?.firecrawlSelfHosted
  if (firecrawlSelfHosted?.enabled && firecrawlSelfHosted.baseUrls?.length) {
    providers.push(
      `Firecrawl self-hosted (${plural(firecrawlSelfHosted.baseUrls.length, 'instance')})`
    )
  }
  const jina = settings.providers?.jina
  if (jina?.enabled && jina.apiKeys?.length) {
    providers.push(`Jina AI (${plural(jina.apiKeys.length, 'API key')})`)
  }
  const langsearch = settings.providers?.langsearch
  if (langsearch?.enabled && langsearch.apiKeys?.length) {
    providers.push(
      `LangSearch (${plural(langsearch.apiKeys.length, 'API key')})`
    )
  }
  const exa = settings.providers?.exa
  if (exa?.enabled && exa.apiKeys?.length) {
    providers.push(`Exa (${plural(exa.apiKeys.length, 'API key')})`)
  }
  const mcp = settings.providers?.mcp
  if (mcp?.enabled && mcp.serverUrls?.length) {
    providers.push(
      `MCP WebSearch (${plural(mcp.serverUrls.length, 'custom endpoint')})`
    )
  }

  const primary =
    settings.primaryProvider === 'ollama'
      ? 'Ollama'
      : settings.primaryProvider === 'websearchapi'
        ? 'WebSearchAPI.ai'
        : settings.primaryProvider === 'tavily'
          ? 'Tavily'
          : settings.primaryProvider === 'firecrawl'
            ? 'Firecrawl'
            : settings.primaryProvider === 'firecrawlSelfHosted'
              ? 'Firecrawl self-hosted'
              : settings.primaryProvider === 'jina'
                ? 'Jina AI'
                : settings.primaryProvider === 'langsearch'
                  ? 'LangSearch'
                  : settings.primaryProvider === 'exa'
                    ? 'Exa'
                    : settings.primaryProvider === 'mcp'
                      ? 'MCP WebSearch'
                      : 'SearXNG'
  const rotation =
    settings.rotationStrategy === 'provider-priority'
      ? `Searches go to ${primary} first, then the others.`
      : settings.rotationStrategy === 'sticky'
        ? 'Searches stay on one endpoint until it is rate-limited.'
        : 'Searches take turns across all endpoints.'
  return {
    lead: 'Using your own web search:',
    providers,
    notes: [rotation],
    configured: providers.length > 0,
  }
}

function WebSearchStatus({
  lead,
  providers,
  notes,
  configured,
}: {
  lead: string
  providers: string[]
  notes: string[]
  configured: boolean
}) {
  return (
    <div className="web-search-status">
      <p>
        {configured ? (
          <LinkingStatus status="success" description={lead} />
        ) : (
          <span className="small">{lead}</span>
        )}
      </p>
      <ul className="small">
        {providers.map(provider => (
          <li key={provider}>{provider}</li>
        ))}
      </ul>
      {notes.map(note => (
        <p key={note} className="small">
          {note}
        </p>
      ))}
    </div>
  )
}

export default function WebSearchWidget() {
  const [settings, setSettings] = useState<MultiWebSearchSettings | null>(null)
  const [editing, setEditing] = useState(false)
  const serverAvailable = isServerWebSearchAvailable()

  useEffect(() => {
    setSettings(readWebSearchSettings())
  }, [])

  const save = useCallback((values: MultiWebSearchSettings) => {
    writeWebSearchSettings(values)
    setSettings(values)
    setEditing(false)
  }, [])

  const disable = useCallback(() => {
    const disabledSettings: MultiWebSearchSettings = {
      sourceMode: 'disabled',
      providers: {},
    }
    writeWebSearchSettings(disabledSettings)
    setSettings(disabledSettings)
  }, [])

  const useServerSearch = useCallback(() => {
    const serverSettings: MultiWebSearchSettings = {
      sourceMode: 'server',
      providers: {},
    }
    writeWebSearchSettings(serverSettings)
    setSettings(serverSettings)
  }, [])

  const remove = useCallback(() => {
    clearWebSearchSettings()
    setSettings(readWebSearchSettings())
  }, [])

  const isDisabled = settings?.sourceMode === 'disabled'
  const isServer = settings?.sourceMode === 'server'
  const isCustom = settings?.sourceMode === 'custom'

  return (
    <div
      className="settings-widget-container"
      data-testid="web-search-settings"
    >
      <div className="linking-icon-fixed-position">
        <Globe size={40} aria-hidden="true" />
      </div>
      <div className="description-container">
        <div className="title-row">
          <h4 id="ai-web-search">Web search</h4>
        </div>
        <p className="small">
          Enables the AI assistant to fetch the latest data, information and
          documentation.
        </p>
        {settings && !editing && !isDisabled ? (
          <WebSearchStatus {...statusSummary(settings)} />
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
        {editing ? null : settings && !isDisabled ? (
          <div className="d-flex gap-2">
            <OLButton
              variant="secondary"
              onClick={() => setEditing(true)}
              aria-label={isServer ? 'Customize web search' : 'Edit web search'}
            >
              {isServer ? 'Customize' : 'Edit'}
            </OLButton>
            {isCustom ? (
              <OLButton
                variant="secondary"
                onClick={useServerSearch}
                aria-label="Use server default web search"
              >
                Use server default
              </OLButton>
            ) : null}
            <OLButton
              variant="danger-ghost"
              onClick={serverAvailable ? disable : remove}
            >
              {serverAvailable ? 'Disable' : 'Remove'}
            </OLButton>
          </div>
        ) : isDisabled ? (
          <div className="d-flex gap-2">
            <OLButton
              variant="secondary"
              onClick={
                serverAvailable ? useServerSearch : () => setEditing(true)
              }
              aria-label="Enable web search"
            >
              Enable
            </OLButton>
            <OLButton
              variant="secondary"
              onClick={() => setEditing(true)}
              aria-label="Configure custom web search"
            >
              Customize
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
