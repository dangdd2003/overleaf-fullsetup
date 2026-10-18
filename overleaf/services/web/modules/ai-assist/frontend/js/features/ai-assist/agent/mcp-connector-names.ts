import { useEffect, useState } from 'react'
import {
  CONNECTORS_CHANGED_EVENT,
  isConnectorsEnabled,
  listConnectors,
} from '../connectors/api'
import { ConnectorView } from '../connectors/types'
import {
  mcpServerSegment,
  isMcpToolName,
  sanitizeIdentifier,
} from './mcp-tool-output'

/**
 * The connector a `mcp__<server>__<tool>` name belongs to. The name only
 * carries the connector's name sanitised, so the real name comes from the
 * connectors list, matched the way the backend builds the name.
 */
export function connectorNameFor(
  connectors: ConnectorView[],
  segment: string
): string | undefined {
  const exact = connectors.find((c) => sanitizeIdentifier(c.name) === segment)
  if (exact) return exact.name
  // A second connector with the same name is named with the end of its id
  const suffixed = connectors.find(
    (c) => segment === `${sanitizeIdentifier(c.name)}_${c.id.slice(-6)}`
  )
  return suffixed?.name
}

// One request serves every card on the page; a change to the connectors
// empties it and tells the cards to ask again
let loaded: ConnectorView[] | null = null
let inflight: Promise<ConnectorView[]> | null = null
let listening = false
const subscribers = new Set<() => void>()

function loadConnectors(): Promise<ConnectorView[]> {
  if (loaded) return Promise.resolve(loaded)
  if (!inflight) {
    inflight = listConnectors()
      .then(({ connectors }) => {
        loaded = connectors
        return connectors
      })
      .catch((): ConnectorView[] => [])
      .finally(() => {
        inflight = null
      })
  }
  return inflight
}

function listenForChanges() {
  if (listening || typeof window === 'undefined') return
  listening = true
  window.addEventListener(CONNECTORS_CHANGED_EVENT, () => {
    loaded = null
    subscribers.forEach((refresh) => refresh())
  })
}

/**
 * The real name of the connector behind a connector tool call, or undefined
 * when it is not a connector call or the name is not known. Falls back to
 * the humanised name, so the card reads well before the list arrives.
 */
export function useMcpConnectorName(
  name: string | undefined
): string | undefined {
  const segment = isMcpToolName(name) ? mcpServerSegment(name) : undefined
  const [connectors, setConnectors] = useState<ConnectorView[] | null>(
    () => loaded
  )

  useEffect(() => {
    if (!segment || !isConnectorsEnabled()) return
    let cancelled = false
    const refresh = () => {
      loadConnectors().then((list) => {
        if (!cancelled) setConnectors(list)
      })
    }
    listenForChanges()
    subscribers.add(refresh)
    refresh()
    return () => {
      cancelled = true
      subscribers.delete(refresh)
    }
  }, [segment])

  return segment && connectors
    ? connectorNameFor(connectors, segment)
    : undefined
}
