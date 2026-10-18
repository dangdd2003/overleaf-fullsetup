import { postJSON } from '@/infrastructure/fetch-json'

export type RewindCheckResponse = {
  canRewind: boolean
  filesChanged?: string[]
  insertions?: number
  deletions?: number
  error?: string
}

export type RewindExecuteParams = {
  userMessageId: string
  /** Ids of the user messages from the target onward, in transcript order */
  userMessageIds?: string[]
  restoreCode: boolean
  restoreConversation: boolean
}

export type RewindExecuteResponse = {
  success?: boolean
  canRewind?: boolean
  restoredFiles?: string[]
  failedFiles?: { path: string; error: string }[]
  error?: string
  [key: string]: any
}

export type ForkCheckpointsResponse = {
  copied: string[]
}

/**
 * Checks what code changes would be reverted if rewound to `userMessageId`.
 * Calls POST /ai-assist/projects/${projectId}/chats/${chatId}/rewind/check with { userMessageId, userMessageIds }.
 */
export async function checkRewind(
  projectId: string,
  chatId: string,
  userMessageId: string,
  userMessageIds?: string[]
): Promise<RewindCheckResponse> {
  return postJSON<RewindCheckResponse>(
    `/ai-assist/projects/${projectId}/chats/${chatId}/rewind/check`,
    {
      body: { userMessageId, userMessageIds },
    }
  )
}

/**
 * Executes code and/or conversation rewind for `userMessageId`.
 * Calls POST /ai-assist/projects/${projectId}/chats/${chatId}/rewind with params.
 */
export async function executeRewind(
  projectId: string,
  chatId: string,
  params: RewindExecuteParams
): Promise<RewindExecuteResponse> {
  return postJSON<RewindExecuteResponse>(
    `/ai-assist/projects/${projectId}/chats/${chatId}/rewind`,
    {
      body: params,
    }
  )
}

/**
 * Copies the code checkpoints of `userMessageIds` from `chatId` into the forked
 * chat `targetChatId`, so code can be rewound inside the fork.
 * Calls POST /ai-assist/projects/${projectId}/chats/${chatId}/checkpoints/fork.
 */
export async function forkCheckpoints(
  projectId: string,
  chatId: string,
  targetChatId: string,
  userMessageIds: string[]
): Promise<ForkCheckpointsResponse> {
  return postJSON<ForkCheckpointsResponse>(
    `/ai-assist/projects/${projectId}/chats/${chatId}/checkpoints/fork`,
    {
      body: { targetChatId, userMessageIds },
    }
  )
}
