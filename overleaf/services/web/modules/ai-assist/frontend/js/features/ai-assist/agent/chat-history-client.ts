import { deleteJSON, getJSON, putJSON } from '@/infrastructure/fetch-json'
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
const base = (projectId: string) => `/ai-assist/projects/${projectId}/chats`

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
  mode: AgentMode = 'manual'
) {
  return putJSON<ChatSummary>(`${base(projectId)}/${chatId}`, {
    body: {
      transcript: prepareTranscriptForRun(transcript),
      mode,
    },
  })
}

export function deleteChat(projectId: string, chatId: string) {
  return deleteJSON(`${base(projectId)}/${chatId}`)
}
