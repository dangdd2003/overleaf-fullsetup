import {
  deleteJSON,
  FetchError,
  getJSON,
  patchJSON,
  postJSON,
} from '@/infrastructure/fetch-json'
import getMeta from '@/utils/meta'
import {
  ConnectNext,
  ConnectorInput,
  ConnectorPatch,
  ConnectorsMeta,
  ConnectorView,
  ImportResult,
  ProbeResult,
} from './types'

/** Connectors are part of the assistant: on whenever it is. */
export function isConnectorsEnabled() {
  return Boolean(getMeta('ol-aiAssistEnabled'))
}

/** The server's `{ error }` message when there is one. */
export function connectorErrorMessage(error: unknown, fallback: string) {
  if (error instanceof FetchError) {
    const message = error.data?.error
    if (typeof message === 'string' && message) return message
  }
  return fallback
}

export function listConnectors() {
  return getJSON<{ connectors: ConnectorView[]; meta: ConnectorsMeta }>(
    '/ai-assist/connectors'
  )
}

export function probeConnector(input: ConnectorInput) {
  return postJSON<ProbeResult>('/ai-assist/connectors/probe', { body: input })
}

export function createConnector(input: ConnectorInput) {
  return postJSON<{ connector: ConnectorView; next: ConnectNext }>(
    '/ai-assist/connectors',
    { body: input }
  )
}

/**
 * Adds every remote server in another app's MCP config: Gemini CLI's
 * settings.json, Claude Code's .mcp.json, Claude Desktop, VS Code or Cursor.
 */
export function importConnectors(config: string) {
  return postJSON<ImportResult>('/ai-assist/connectors/import', {
    body: { config },
  })
}

export function updateConnector(id: string, patch: ConnectorPatch) {
  return patchJSON<{ connector: ConnectorView; next?: ConnectNext | null }>(
    `/ai-assist/connectors/${encodeURIComponent(id)}`,
    { body: patch }
  )
}

export function removeConnector(id: string) {
  return deleteJSON<{ ok: true }>(
    `/ai-assist/connectors/${encodeURIComponent(id)}`
  )
}

/** `scope` asks for more than the connector has (a step-up sign-in). */
export function authorizeConnector(id: string, scope?: string) {
  return postJSON<{ authorizationUrl: string }>(
    `/ai-assist/connectors/${encodeURIComponent(id)}/authorize`,
    { body: scope ? { scope } : {} }
  )
}

export function refreshConnector(id: string) {
  return postJSON<{ connector: ConnectorView; next: ConnectNext }>(
    `/ai-assist/connectors/${encodeURIComponent(id)}/refresh`,
    { body: {} }
  )
}

export function disconnectConnector(id: string) {
  return postJSON<{ connector: ConnectorView }>(
    `/ai-assist/connectors/${encodeURIComponent(id)}/disconnect`,
    { body: {} }
  )
}

/** Fired on window whenever this tab changes a connector, so other views refresh. */
export const CONNECTORS_CHANGED_EVENT = 'aiAssist:connectorsChanged'

export function notifyConnectorsChanged() {
  window.dispatchEvent(new CustomEvent(CONNECTORS_CHANGED_EVENT))
}
