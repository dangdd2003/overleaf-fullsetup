import { AgentEvent } from '../agent-events'
import { TranscriptEntry } from '../agent-messages'
import { ProviderSettings } from '../../providers/types'
import customLocalStorage from '@/infrastructure/local-storage'
import getMeta from '@/utils/meta'

function getCsrfHeaders(): Record<string, string> {
  const token =
    (typeof window !== 'undefined' && (window as any).csrfToken) ||
    getMeta('ol-csrfToken') ||
    ''
  return token ? { 'X-Csrf-Token': token } : {}
}

const ACTIVE_RUN_KEY = (projectId: string) => `ai-assist:active-run:${projectId}`
const ACTIVE_RUN_START_KEY = (projectId: string) => `ai-assist:active-run-start:${projectId}`

export function getStoredActiveRunId(projectId: string): string | null {
  return customLocalStorage.getItem(ACTIVE_RUN_KEY(projectId))
}

export function getStoredActiveRunStartedAt(projectId: string): number | null {
  const val = customLocalStorage.getItem(ACTIVE_RUN_START_KEY(projectId))
  return val ? Number(val) : null
}

export function setStoredActiveRunId(
  projectId: string,
  runId: string | null,
  startedAt?: number
) {
  if (runId) {
    customLocalStorage.setItem(ACTIVE_RUN_KEY(projectId), runId)
    const startTime = startedAt ?? Date.now()
    customLocalStorage.setItem(ACTIVE_RUN_START_KEY(projectId), String(startTime))
  } else {
    customLocalStorage.removeItem(ACTIVE_RUN_KEY(projectId))
    customLocalStorage.removeItem(ACTIVE_RUN_START_KEY(projectId))
  }
}

export async function startBackgroundRun({
  projectId,
  transcript,
  providerSettings,
}: {
  projectId: string
  transcript: TranscriptEntry[]
  providerSettings: ProviderSettings
}): Promise<string> {
  const res = await fetch(`/ai-assist/projects/${projectId}/runs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...getCsrfHeaders(),
    },
    body: JSON.stringify({ transcript, providerSettings }),
  })
  if (!res.ok) {
    throw new Error(`Failed to start AI run (${res.status})`)
  }
  const data = await res.json()
  setStoredActiveRunId(projectId, data.runId, Date.now())
  return data.runId
}

export function connectRunStream({
  runId,
  projectId,
  since = 0,
  onEvent,
  onDone,
  onError,
}: {
  runId: string
  projectId: string
  since?: number
  onEvent: (event: AgentEvent) => void
  onDone: () => void
  onError: (err: any) => void
}): () => void {
  const eventSource = new EventSource(
    `/ai-assist/projects/${projectId}/runs/${runId}/stream?since=${since}`
  )

  eventSource.onmessage = msg => {
    try {
      const data = JSON.parse(msg.data)
      if (data.event) {
        onEvent(data.event)
        if (data.event.type === 'turnFinished' || data.event.type === 'error') {
          setStoredActiveRunId(projectId, null)
          eventSource.close()
          onDone()
        }
      }
    } catch (err) {
      setStoredActiveRunId(projectId, null)
      eventSource.close()
      onError(err)
    }
  }

  eventSource.onerror = err => {
    setStoredActiveRunId(projectId, null)
    eventSource.close()
    onError(err)
  }

  return () => {
    eventSource.close()
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

export async function approveBackgroundEdit(
  runId: string,
  decision: { accepted: boolean; note?: string }
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
