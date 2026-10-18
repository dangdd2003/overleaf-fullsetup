import customLocalStorage from '@/infrastructure/local-storage'

// Which connectors a chat may use. A connector switched off in one chat stays
// on in every other, as on claude.ai; only the switched-off ids are stored,
// so a connector added later is on in existing chats too.
const KEY_PREFIX = 'ai-assist:chat-connectors:'
const NEW_CHAT_KEY = `${KEY_PREFIX}new`

export const CHAT_CONNECTORS_CHANGED_EVENT = 'aiAssist:chatConnectorsChanged'

function keyFor(chatId: string | null | undefined) {
  return chatId ? `${KEY_PREFIX}${chatId}` : NEW_CHAT_KEY
}

export function readDisabledConnectors(
  chatId: string | null | undefined
): string[] {
  const value = customLocalStorage.getItem(keyFor(chatId))
  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === 'string')
    : []
}

export function setConnectorEnabledForChat(
  chatId: string | null | undefined,
  connectorId: string,
  enabled: boolean
) {
  const disabled = new Set(readDisabledConnectors(chatId))
  if (enabled) disabled.delete(connectorId)
  else disabled.add(connectorId)
  if (disabled.size === 0) customLocalStorage.removeItem(keyFor(chatId))
  else customLocalStorage.setItem(keyFor(chatId), [...disabled])
  window.dispatchEvent(
    new CustomEvent(CHAT_CONNECTORS_CHANGED_EVENT, { detail: { chatId } })
  )
}

/**
 * A new chat gets its id with its first message; what was switched off
 * before then carries over to it.
 */
export function adoptNewChatSelection(chatId: string) {
  const pending = readDisabledConnectors(null)
  customLocalStorage.removeItem(NEW_CHAT_KEY)
  if (pending.length > 0) customLocalStorage.setItem(keyFor(chatId), pending)
}

/**
 * The connector ids a run in this chat may use, out of those enabled in the
 * settings.
 */
export function connectorIdsForRun(
  chatId: string | null | undefined,
  enabledConnectorIds: string[]
): string[] {
  const disabled = new Set(readDisabledConnectors(chatId))
  return enabledConnectorIds.filter(id => !disabled.has(id))
}

const KNOWN_CONNECTORS_KEY = 'ai-assist:known-connectors'

export function updateKnownConnectors(ids: string[]) {
  customLocalStorage.setItem(KNOWN_CONNECTORS_KEY, ids)
}

export function getChatConnectorIds(
  chatId: string | null | undefined
): string[] | null {
  const known = customLocalStorage.getItem(KNOWN_CONNECTORS_KEY)
  if (!Array.isArray(known)) return null
  const disabled = new Set(readDisabledConnectors(chatId))
  return known.filter(id => typeof id === 'string' && !disabled.has(id))
}
