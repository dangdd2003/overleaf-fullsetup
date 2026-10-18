import { useCallback, useEffect, useState } from 'react'
import {
  isConnectorsEnabled,
  listConnectors,
  CONNECTORS_CHANGED_EVENT,
} from './api'
import {
  readDisabledConnectors,
  setConnectorEnabledForChat,
  updateKnownConnectors,
  CHAT_CONNECTORS_CHANGED_EVENT,
} from './chat-selection'
import { ConnectorView } from './types'

/**
 * The connected connectors and which of them this chat may use.
 *
 * Every run reads the known connector ids that this hook records, so keep it
 * mounted for as long as the composer is. `active` gates the fetching for
 * views that only need the list while they are open.
 */
export function useChatConnectors(
  chatId: string | null | undefined,
  { active = true }: { active?: boolean } = {}
) {
  const enabled = isConnectorsEnabled()
  const [connectors, setConnectors] = useState<ConnectorView[]>([])
  const [disabledIds, setDisabledIds] = useState<string[]>(() =>
    readDisabledConnectors(chatId)
  )

  useEffect(() => {
    setDisabledIds(readDisabledConnectors(chatId))
  }, [chatId])

  useEffect(() => {
    if (!enabled || !active) return

    let cancelled = false
    const load = () => {
      listConnectors()
        .then(({ connectors: list }) => {
          if (cancelled) return
          const connected = list.filter(
            c => c.enabled && c.status === 'connected'
          )
          setConnectors(connected)
          setDisabledIds(readDisabledConnectors(chatId))
          updateKnownConnectors(connected.map(c => c.id))
        })
        .catch(() => {
          if (!cancelled) setConnectors([])
        })
    }
    const onChatChanged = () => setDisabledIds(readDisabledConnectors(chatId))

    load()
    window.addEventListener(CONNECTORS_CHANGED_EVENT, load)
    window.addEventListener(CHAT_CONNECTORS_CHANGED_EVENT, onChatChanged)
    return () => {
      cancelled = true
      window.removeEventListener(CONNECTORS_CHANGED_EVENT, load)
      window.removeEventListener(CHAT_CONNECTORS_CHANGED_EVENT, onChatChanged)
    }
  }, [chatId, enabled, active])

  const setEnabled = useCallback(
    (connectorId: string, on: boolean) => {
      setConnectorEnabledForChat(chatId, connectorId, on)
      setDisabledIds(readDisabledConnectors(chatId))
    },
    [chatId]
  )

  return { enabled, connectors, disabledIds, setEnabled }
}
