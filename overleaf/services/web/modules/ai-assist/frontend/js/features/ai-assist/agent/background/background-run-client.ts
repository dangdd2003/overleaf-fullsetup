import { AgentEvent } from '../agent-events'
import { TranscriptEntry } from '../agent-messages'
import { ProviderSettings, WebSearchSettings } from '../../providers/types'
import { prepareTranscriptForRun } from '../conversation-store'
import { AgentMode } from '../agent-mode'
import customLocalStorage from '@/infrastructure/local-storage'
import getMeta from '@/utils/meta'

function getCsrfHeaders(): Record<string, string> {
  const token =
    (typeof window !== 'undefined' && (window as any).csrfToken) ||
    getMeta('ol-csrfToken') ||
    ''
  return token ? { 'X-Csrf-Token': token } : {}
}

const ACTIVE_RUN_KEY = (projectId: string) =>
  `ai-assist:active-run:${projectId}`
const ACTIVE_RUN_START_KEY = (projectId: string) =>
  `ai-assist:active-run-start:${projectId}`
const ACTIVE_RUN_CHAT_KEY = (projectId: string) =>
  `ai-assist:active-run-chat:${projectId}`

export function getStoredActiveRunId(projectId: string): string | null {
  return customLocalStorage.getItem(ACTIVE_RUN_KEY(projectId))
}

export function getStoredActiveRunStartedAt(projectId: string): number | null {
  const val = customLocalStorage.getItem(ACTIVE_RUN_START_KEY(projectId))
  return val ? Number(val) : null
}

/** The chat the active run belongs to, when it was recorded with one. */
export function getStoredActiveRunChatId(projectId: string): string | null {
  return customLocalStorage.getItem(ACTIVE_RUN_CHAT_KEY(projectId))
}

export function setStoredActiveRunId(
  projectId: string,
  runId: string | null,
  startedAt?: number,
  chatId?: string
) {
  if (runId) {
    customLocalStorage.setItem(ACTIVE_RUN_KEY(projectId), runId)
    const startTime = startedAt ?? Date.now()
    customLocalStorage.setItem(
      ACTIVE_RUN_START_KEY(projectId),
      String(startTime)
    )
    // A reload reconnects the run to this chat only, never to whichever
    // chat happens to be open by then
    if (chatId) {
      customLocalStorage.setItem(ACTIVE_RUN_CHAT_KEY(projectId), chatId)
    } else {
      customLocalStorage.removeItem(ACTIVE_RUN_CHAT_KEY(projectId))
    }
  } else {
    customLocalStorage.removeItem(ACTIVE_RUN_KEY(projectId))
    customLocalStorage.removeItem(ACTIVE_RUN_START_KEY(projectId))
    customLocalStorage.removeItem(ACTIVE_RUN_CHAT_KEY(projectId))
  }
}

/** A run still going on the server for a chat that is not on screen. */
export type DetachedRun = { runId: string; startedAt: number }

const DETACHED_RUNS_KEY = (projectId: string) =>
  `ai-assist:detached-runs:${projectId}`

function readDetachedRuns(projectId: string): Record<string, DetachedRun> {
  const stored = customLocalStorage.getItem(DETACHED_RUNS_KEY(projectId))
  return stored && typeof stored === 'object' ? stored : {}
}

/** Every chat's detached run, by chat id. */
export function getDetachedRuns(
  projectId: string
): Record<string, DetachedRun> {
  return { ...readDetachedRuns(projectId) }
}

export function setDetachedRun(
  projectId: string,
  chatId: string,
  run: DetachedRun | null
) {
  const runs = readDetachedRuns(projectId)
  if (run) {
    runs[chatId] = run
  } else {
    delete runs[chatId]
  }
  customLocalStorage.setItem(DETACHED_RUNS_KEY(projectId), runs)
}

/** The chat's detached run, forgotten here since its chat now follows it. */
export function takeDetachedRun(
  projectId: string,
  chatId: string
): DetachedRun | null {
  const run = readDetachedRuns(projectId)[chatId] ?? null
  if (run) setDetachedRun(projectId, chatId, null)
  return run
}

export async function startBackgroundRun({
  projectId,
  transcript,
  providerSettings,
  mode = 'manual',
  chatId,
  webSearchSettings,
  trackActive = true,
}: {
  projectId: string
  transcript: TranscriptEntry[]
  providerSettings: ProviderSettings
  mode?: AgentMode
  chatId?: string
  webSearchSettings?: WebSearchSettings | null
  /**
   * Whether this is the run of the chat on screen, which a reload reconnects
   * to. A run started for a chat already left is recorded as detached instead.
   */
  trackActive?: boolean
}): Promise<string> {
  const preparedTranscript = prepareTranscriptForRun(transcript)
  const res = await fetch(`/ai-assist/projects/${projectId}/runs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...getCsrfHeaders(),
    },
    body: JSON.stringify({
      transcript: preparedTranscript,
      providerSettings,
      mode,
      ...(chatId ? { chatId } : {}),
      ...(webSearchSettings ? { webSearchSettings } : {}),
    }),
  })
  if (!res.ok) {
    let errorMsg = `Failed to start AI run (${res.status})`
    try {
      const data = await res.json()
      if (data && typeof data === 'object' && data.error) {
        errorMsg = data.error
      }
    } catch {}
    throw new Error(errorMsg)
  }
  const data = await res.json()
  if (trackActive) setStoredActiveRunId(projectId, data.runId, Date.now())
  return data.runId
}

const DEFAULT_MAX_RECONNECTS = 5
const DEFAULT_RECONNECT_DELAY_MS = 1000

export function connectRunStream({
  runId,
  projectId,
  since = 0,
  onEvent,
  onCaughtUp,
  onDone,
  onError,
  maxReconnects = DEFAULT_MAX_RECONNECTS,
  reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS,
  passive = false,
}: {
  runId: string
  projectId: string
  since?: number
  /** `seq` is the event's place in the run, to carry on from after it. */
  onEvent: (event: AgentEvent, seq: number) => void
  /** Every event the run sent before this stream opened has arrived. */
  onCaughtUp?: () => void
  onDone: () => void
  onError: (err: any) => void
  maxReconnects?: number
  reconnectDelayMs?: number
  /**
   * Following a chat that is not on screen: the run does not count it as an
   * editor that can compile, and the on-screen chat's active run is left alone.
   */
  passive?: boolean
}): () => void {
  const clearActiveRun = () => {
    if (!passive) setStoredActiveRunId(projectId, null)
  }
  // The run lives on the server and keeps going when this connection drops
  // (proxy idle timeout, network blip, laptop sleep). Resume from the last
  // event seen instead of abandoning a run that is still producing output.
  let lastSeq = since
  let failures = 0
  let finished = false
  let current: EventSource | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  const finish = () => {
    finished = true
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    current?.close()
  }

  const open = () => {
    const eventSource = new EventSource(
      `/ai-assist/projects/${projectId}/runs/${runId}/stream?since=${lastSeq}${passive ? '&watch=0' : ''}`
    )
    current = eventSource

    eventSource.onmessage = msg => {
      // A message already queued when the stream was closed must not land:
      // its chat may no longer be the one on screen
      if (finished) return
      try {
        const data = JSON.parse(msg.data)
        failures = 0
        if (data.caughtUp) {
          onCaughtUp?.()
          return
        }
        if (typeof data.seq === 'number' && data.seq > lastSeq) {
          lastSeq = data.seq
        }
        if (data.event) {
          onEvent(data.event, lastSeq)
          if (
            data.event.type === 'turnFinished' ||
            data.event.type === 'error'
          ) {
            clearActiveRun()
            finish()
            onDone()
          }
        }
      } catch (err) {
        clearActiveRun()
        finish()
        onError(err)
      }
    }

    eventSource.onerror = err => {
      eventSource.close()
      if (finished) return
      if (failures >= maxReconnects) {
        clearActiveRun()
        finish()
        onError(err)
        return
      }
      failures += 1
      retryTimer = setTimeout(() => {
        retryTimer = null
        if (!finished) open()
      }, reconnectDelayMs * failures)
    }
  }

  open()

  return () => {
    finish()
  }
}

export async function stopBackgroundRun(runId: string): Promise<void> {
  await fetch(`/ai-assist/runs/${runId}/stop`, {
    method: 'POST',
    headers: {
      ...getCsrfHeaders(),
    },
  })
}

const MAX_REPORTED_LOG_CHARS = 1_000_000

export async function submitBackgroundCompile(
  projectId: string,
  runId: string,
  id: string,
  outcome: {
    status: string
    errors: unknown[]
    warnings: unknown[]
    rawLog?: string | null
  }
): Promise<void> {
  const rawLog = outcome.rawLog
    ? outcome.rawLog.slice(-MAX_REPORTED_LOG_CHARS)
    : ''
  await fetch(`/ai-assist/projects/${projectId}/runs/${runId}/compile`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...getCsrfHeaders(),
    },
    body: JSON.stringify({ id, outcome: { ...outcome, rawLog } }),
  })
}

export async function approveBackgroundEdit(
  runId: string,
  decision: { accepted: boolean; note?: string; nextMode?: AgentMode }
): Promise<void> {
  await fetch(`/ai-assist/runs/${runId}/approve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...getCsrfHeaders(),
    },
    body: JSON.stringify(decision),
  })
}

export async function setBackgroundRunMode(
  projectId: string,
  runId: string,
  mode: AgentMode
): Promise<void> {
  const res = await fetch(
    `/ai-assist/projects/${projectId}/runs/${runId}/mode`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getCsrfHeaders(),
      },
      body: JSON.stringify({ mode }),
    }
  )
  if (!res.ok) {
    throw new Error(`Failed to change mode: ${res.status}`)
  }
}

/**
 * Sends a message into a run that is already going.
 *
 * Resolves true when the run took it, false when the run had already finished
 * (409) — the caller then starts a fresh run instead, so nothing the user typed
 * is lost to the race between them pressing send and the run ending.
 */
export async function sendBackgroundRunMessage(
  projectId: string,
  runId: string,
  message: { id: string; text: string; contextText?: string }
): Promise<boolean> {
  const res = await fetch(
    `/ai-assist/projects/${projectId}/runs/${runId}/message`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getCsrfHeaders(),
      },
      body: JSON.stringify(message),
    }
  )
  if (res.status === 409 || res.status === 404) return false
  if (!res.ok) {
    throw new Error(`Failed to send message: ${res.status}`)
  }
  return true
}

/**
 * Takes back a message sent into a run, before the run reads it.
 *
 * 'removed' when the run will not read it, 'read' when it already has, and
 * 'ended' when the run is over: whether it read the message is then known
 * from its events, not from the server.
 */
export async function takeBackRunMessage(
  projectId: string,
  runId: string,
  messageId: string
): Promise<'removed' | 'read' | 'ended'> {
  const res = await fetch(
    `/ai-assist/projects/${projectId}/runs/${runId}/message/${encodeURIComponent(messageId)}`,
    {
      method: 'DELETE',
      headers: { ...getCsrfHeaders() },
    }
  )
  if (res.ok) return 'removed'
  if (res.status === 404) return 'ended'
  if (res.status === 409) {
    const data = await res.json().catch(() => null)
    return data?.reason === 'ended' ? 'ended' : 'read'
  }
  throw new Error(`Failed to take the message back: ${res.status}`)
}
