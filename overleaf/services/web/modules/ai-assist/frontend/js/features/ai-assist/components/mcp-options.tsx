import OLButton from '@/shared/components/ol/ol-button'
import OLFormControl from '@/shared/components/ol/ol-form-control'
import OLIconButton from '@/shared/components/ol/ol-icon-button'
import OLTooltip from '@/shared/components/ol/ol-tooltip'
import Setting from '@/features/ide-settings/components/setting'
import { ListSetting, SettingsGroup } from './web-search-settings'
import { McpHeader, McpProviderConfig } from '../providers/types'

export interface DraftMcpConfig {
  serverUrls: string[]
  headers: McpHeader[]
  toolName?: string
  queryParam?: string
}

export function draftFromMcp(config?: McpProviderConfig): DraftMcpConfig {
  const serverUrls =
    config?.serverUrls && config.serverUrls.length > 0
      ? [...config.serverUrls]
      : ['']
  const headers =
    config?.headers && config.headers.length > 0
      ? config.headers.map(h => ({ ...h }))
      : []

  return {
    serverUrls,
    headers,
    toolName: config?.toolName || '',
    queryParam: config?.queryParam || '',
  }
}

export function mcpOptionsFromDraft(draft: DraftMcpConfig): {
  serverUrls: string[]
  headers?: McpHeader[]
  toolName?: string
  queryParam?: string
} {
  const serverUrls = draft.serverUrls
    .map(url => url.trim())
    .filter(Boolean)

  const headers = draft.headers
    .map(h => ({ key: h.key.trim(), value: h.value.trim() }))
    .filter(h => h.key && h.value)

  const toolName = draft.toolName?.trim() || undefined
  const queryParam = draft.queryParam?.trim() || undefined

  return {
    serverUrls,
    ...(headers.length > 0 ? { headers } : {}),
    ...(toolName ? { toolName } : {}),
    ...(queryParam ? { queryParam } : {}),
  }
}

export default function McpOptions({
  value,
  onChange,
}: {
  value: DraftMcpConfig
  onChange: (value: DraftMcpConfig) => void
}) {
  const setServerUrls = (serverUrls: string[]) => {
    onChange({ ...value, serverUrls })
  }

  const setHeaders = (headers: McpHeader[]) => {
    onChange({ ...value, headers })
  }

  const addHeader = () => {
    setHeaders([...value.headers, { key: '', value: '' }])
  }

  const updateHeader = (
    index: number,
    field: 'key' | 'value',
    newVal: string
  ) => {
    const next = value.headers.map((header, idx) => {
      if (idx === index) {
        return { ...header, [field]: newVal }
      }
      return header
    })
    setHeaders(next)
  }

  const removeHeader = (index: number) => {
    setHeaders(value.headers.filter((_, idx) => idx !== index))
  }

  return (
    <>
      <SettingsGroup title="Custom endpoints">
        <ListSetting
          id="ai-web-search-mcp-url"
          label="Custom URLs"
          description="Model Context Protocol (MCP) server endpoints (HTTP or SSE) supporting search tools"
          itemLabel="URL"
          values={value.serverUrls}
          placeholder="https://<url>/mcp"
          onChange={setServerUrls}
        />
      </SettingsGroup>

      <SettingsGroup title="Tool settings (Optional)">
        <Setting
          controlId="ai-web-search-mcp-tool-name"
          label="Tool name"
          description="Name of the MCP tool to invoke. Leave blank to auto-detect from tools/list (e.g. brave_web_search, search)."
        >
          <OLFormControl
            id="ai-web-search-mcp-tool-name"
            size="sm"
            type="text"
            autoComplete="off"
            value={value.toolName || ''}
            placeholder="Auto-detect (e.g. brave_web_search)"
            onChange={e => onChange({ ...value, toolName: e.target.value })}
          />
        </Setting>

        <Setting
          controlId="ai-web-search-mcp-query-param"
          label="Query argument name"
          description="Argument name for the search query. Leave blank to auto-detect from the tool's schema (e.g. query, q)."
        >
          <OLFormControl
            id="ai-web-search-mcp-query-param"
            size="sm"
            type="text"
            autoComplete="off"
            value={value.queryParam || ''}
            placeholder="Auto-detect (e.g. query)"
            onChange={e => onChange({ ...value, queryParam: e.target.value })}
          />
        </Setting>
      </SettingsGroup>

      <SettingsGroup title="Custom headers">
        <Setting
          controlId="ai-web-search-mcp-headers-add"
          label="Request headers"
          description="Custom headers sent with every search request (e.g. Authorization, X-Api-Key)"
        >
          <OLButton
            variant="secondary"
            size="sm"
            type="button"
            onClick={addHeader}
          >
            Add Header
          </OLButton>
        </Setting>

        {value.headers.length > 0 && (
          <div className="web-search-setting-list">
            {value.headers.map((header, idx) => (
              <div key={idx} className="d-flex gap-2 align-items-center">
                <OLFormControl
                  id={`ai-web-search-mcp-header-key-${idx}`}
                  size="sm"
                  type="text"
                  autoComplete="off"
                  value={header.key}
                  placeholder="Header name (e.g. Authorization)"
                  onChange={e => updateHeader(idx, 'key', e.target.value)}
                />
                <OLFormControl
                  id={`ai-web-search-mcp-header-value-${idx}`}
                  size="sm"
                  type="password"
                  autoComplete="off"
                  value={header.value}
                  placeholder="Header value"
                  onChange={e => updateHeader(idx, 'value', e.target.value)}
                />
                <OLTooltip
                  id={`ai-web-search-mcp-header-remove-${idx}`}
                  description="Remove header"
                >
                  <span>
                    <OLIconButton
                      variant="danger-ghost"
                      size="sm"
                      type="button"
                      onClick={() => removeHeader(idx)}
                      accessibilityLabel={`Remove header ${idx + 1}`}
                      icon="delete"
                    />
                  </span>
                </OLTooltip>
              </div>
            ))}
          </div>
        )}
      </SettingsGroup>
    </>
  )
}
