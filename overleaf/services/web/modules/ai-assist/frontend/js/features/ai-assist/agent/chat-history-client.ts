import {
  deleteJSON,
  getJSON,
  putJSON,
  patchJSON,
} from '@/infrastructure/fetch-json'
import customLocalStorage from '@/infrastructure/local-storage'
import { TranscriptEntry } from './agent-messages'
import { prepareTranscriptForRun } from './conversation-store'
import { AgentMode } from './agent-mode'

export type ChatSummary = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
}

export type StoredChat = ChatSummary & {
  transcript: TranscriptEntry[]
  mode?: AgentMode
}

const activeKeyFor = (projectId: string) => `ai-assist:chat-id:${projectId}`
const modeKeyFor = (projectId: string, chatId: string) =>
  `ai-assist:chat-mode:${projectId}:${chatId}`
const base = (projectId: string) => `/ai-assist/projects/${projectId}/chats`

export function getStoredChatMode(
  projectId: string,
  chatId: string
): AgentMode | null {
  const stored = customLocalStorage.getItem(modeKeyFor(projectId, chatId))
  if (stored === 'manual' || stored === 'acceptEdits' || stored === 'plan') {
    return stored
  }
  return null
}

export function setStoredChatMode(
  projectId: string,
  chatId: string,
  mode: AgentMode
) {
  customLocalStorage.setItem(modeKeyFor(projectId, chatId), mode)
}

export function clearStoredChatMode(projectId: string, chatId: string) {
  customLocalStorage.removeItem(modeKeyFor(projectId, chatId))
}

export function newChatId() {
  const random = Math.random().toString(36).slice(2, 10)
  return `chat_${Date.now().toString(36)}_${random}`
}

/** The chat the panel is currently writing to; created on first use. */
export function getActiveChatId(projectId: string): string {
  const stored = customLocalStorage.getItem(activeKeyFor(projectId))
  if (typeof stored === 'string' && stored) return stored
  const id = newChatId()
  setActiveChatId(projectId, id)
  return id
}

export function setActiveChatId(projectId: string, chatId: string) {
  customLocalStorage.setItem(activeKeyFor(projectId), chatId)
}

export async function listChats(projectId: string): Promise<ChatSummary[]> {
  const { chats } = await getJSON<{ chats: ChatSummary[] }>(base(projectId))
  return chats
}

export function fetchChat(projectId: string, chatId: string) {
  return getJSON<StoredChat>(`${base(projectId)}/${chatId}`)
}

export function saveChat(
  projectId: string,
  chatId: string,
  transcript: TranscriptEntry[],
  mode: AgentMode = 'manual',
  title?: string
) {
  return putJSON<ChatSummary>(`${base(projectId)}/${chatId}`, {
    body: {
      transcript: prepareTranscriptForRun(transcript),
      mode,
      ...(title ? { title } : {}),
    },
  })
}

export function renameChat(projectId: string, chatId: string, title: string) {
  return patchJSON<ChatSummary>(`${base(projectId)}/${chatId}`, {
    body: { title },
  })
}

export function deleteChat(projectId: string, chatId: string) {
  clearStoredChatMode(projectId, chatId)
  return deleteJSON(`${base(projectId)}/${chatId}`)
}
