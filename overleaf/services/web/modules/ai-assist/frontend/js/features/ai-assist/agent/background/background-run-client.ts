import { AgentEvent, RunTrigger } from '../agent-events'
import { TranscriptEntry } from '../agent-messages'
import { ProviderSettings, WebSearchSettings } from '../../providers/types'
import { prepareTranscriptForRun } from '../conversation-store'
import { AgentMode } from '../agent-mode'
import { SlashCommandInvocation } from '../slash-commands/types'
import customLocalStorage from '@/infrastructure/local-storage'
import { getCsrfHeaders } from '../../utils/csrf'
import { debugConsole } from '@/utils/debugging'

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

function writeDetachedRuns(
  projectId: string,
  runs: Record<string, DetachedRun>
) {
  customLocalStorage.setItem(DETACHED_RUNS_KEY(projectId), runs)
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
  writeDetachedRuns(projectId, runs)
}

/** The chat's detached run, forgotten here since its chat now follows it. */
export function takeDetachedRun(
  projectId: string,
  chatId: string
): DetachedRun | null {
  const runs = readDetachedRuns(projectId)
  const run = runs[chatId] ?? null
  if (run) {
    delete runs[chatId]
    writeDetachedRuns(projectId, runs)
  }
  return run
}

export async function startBackgroundRun({
  projectId,
  transcript,
  providerSettings,
  mode = 'manual',
  chatId,
  webSearchSettings,
  connectorIds,
  trackActive = true,
  kind,
  instructions,
  trigger,
}: {
  projectId: string
  transcript: TranscriptEntry[]
  providerSettings: ProviderSettings
  mode?: AgentMode
  chatId?: string
  webSearchSettings?: WebSearchSettings | null
  connectorIds?: string[]
  /** `compact` runs a summary of the chat instead of a reply (see `/compact`). */
  kind?: 'compact'
  /** The words after `/compact`, appended to the summary request. */
  instructions?: string
  trigger?: RunTrigger
  /**
   * Whether this is the run of the chat on screen, which a reload reconnects
   * to. A run started for a chat already left is recorded as detached instead.
   */
  trackActive?: boolean
}): Promise<string> {
  const preparedTranscript = prepareTranscriptForRun(transcript)
  const res = await fetch(`/ai-assist/projects/${encodeURIComponent(projectId)}/runs`, {
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
      ...(connectorIds ? { connectorIds } : {}),
      ...(kind
        ? {
            kind,
            ...(instructions ? { instructions } : {}),
            ...(trigger ? { trigger } : {}),
          }
        : {}),
    }),
  })
  if (!res.ok) {
    let errorMsg = `Failed to start AI run (${res.status})`
    let code: string | undefined
    try {
      const data = await res.json()
      if (data && typeof data === 'object' && data.error) {
        errorMsg = data.error
      }
      if (data && typeof data.code === 'string') code = data.code
    } catch {}
    // The server's reason (e.g. chatBusy) travels as `code`
    throw Object.assign(new Error(errorMsg), code ? { code } : {})
  }
  const data = await res.json()
  if (trackActive) setStoredActiveRunId(projectId, data.runId, Date.now(), chatId)
  return data.runId
}

const DEFAULT_RECONNECT_DELAY_MS = 1000
/** The server sends a heartbeat every 15s; a stream silent this long is dead. */
const HEARTBEAT_WATCHDOG_MS = 45_000
/** Reconnect delays grow from the base up to this cap. */
const RECONNECT_MAX_DELAY_MS = 30_000
/**
 * Failures this long in a row are reported. A run keeps going on the server
 * meanwhile, so a short outage is never shown as a failed run.
 */
const RECONNECT_BUDGET_MS = 10 * 60_000

export function connectRunStream({
  runId,
  projectId,
  since = 0,
  onEvent,
  onCaughtUp,
  onDone,
  onError,
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
  /**
   * Only once the run is gone, or the stream has failed for
   * RECONNECT_BUDGET_MS. `gone` is false in the second case: the run may
   * still be going, so its stored id is kept for a reload to reattach.
   */
  onError: (err: unknown, info: { gone: boolean }) => void
  /** The first reconnect delay; later ones double, up to RECONNECT_MAX_DELAY_MS. */
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
  const streamPath = (from: number) =>
    `/ai-assist/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/stream?since=${from}`
  // The run lives on the server and keeps going when this connection drops
  // (proxy idle timeout, network blip, laptop sleep). Resume from the last
  // event seen instead of abandoning a run that is still producing output.
  let lastSeq = since
  let failures = 0
  let failingSince: number | null = null
  let finished = false
  let current: EventSource | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null
  let probeController: AbortController | null = null
  // Only a server that sends heartbeats is watched for silence. The watchdog
  // starts with the first one, so an older server never looks dead.
  let watchdogArmed = false

  const clearTimers = () => {
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    if (watchdogTimer) {
      clearTimeout(watchdogTimer)
      watchdogTimer = null
    }
  }

  const finish = () => {
    finished = true
    clearTimers()
    probeController?.abort()
    probeController = null
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', reconnectNow)
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
    current?.close()
    current = null
  }

  const giveUp = (err: unknown, gone: boolean) => {
    if (gone) clearActiveRun()
    finish()
    safely(() => onError(err, { gone }))
  }

  const armWatchdog = () => {
    if (watchdogTimer) clearTimeout(watchdogTimer)
    watchdogTimer = setTimeout(() => {
      watchdogTimer = null
      dropConnection(new Error('The run stream went quiet'))
    }, HEARTBEAT_WATCHDOG_MS)
  }

  const markAlive = () => {
    failures = 0
    failingSince = null
    if (watchdogArmed) armWatchdog()
  }

  /**
   * Whether the run is gone for good: its stream endpoint answers 404/410,
   * auth is rejected/redirected to login. Transient errors keep trying.
   */
  const runIsGone = async (): Promise<boolean> => {
    probeController?.abort()
    const controller =
      typeof AbortController !== 'undefined' ? new AbortController() : null
    probeController = controller
    try {
      const res = await fetch(`${streamPath(lastSeq)}&watch=0`, {
        credentials: 'same-origin',
        ...(controller ? { signal: controller.signal } : {}),
      })
      // Only the status is wanted: the stream is not read
      void Promise.resolve(res?.body?.cancel()).catch(() => {})
      if (
        res?.status === 404 ||
        res?.status === 410 ||
        res?.status === 401 ||
        res?.status === 403
      ) {
        return true
      }
      if (res?.redirected && typeof res.url === 'string' && /\/login\b/.test(res.url)) {
        return true
      }
      return false
    } catch {
      return false
    } finally {
      if (probeController === controller) probeController = null
    }
  }

  /**
   * The current connection is lost. Schedules a reconnect from `lastSeq` with
   * a capped, jittered backoff, and gives up only once the run is gone or the
   * failure has lasted RECONNECT_BUDGET_MS.
   */
  const dropConnection = (err: unknown) => {
    if (finished) return
    current?.close()
    current = null
    if (watchdogTimer) {
      clearTimeout(watchdogTimer)
      watchdogTimer = null
    }
    if (retryTimer) return
    const now = Date.now()
    failingSince ??= now
    if (now - failingSince >= RECONNECT_BUDGET_MS) {
      giveUp(err, false)
      return
    }
    failures += 1
    const backoff = Math.min(
      RECONNECT_MAX_DELAY_MS,
      reconnectDelayMs * 2 ** (failures - 1)
    )
    // Jitter spreads out the tabs that all lost the same connection
    const delay = Math.round(backoff * (0.8 + 0.2 * Math.random()))
    retryTimer = setTimeout(() => {
      retryTimer = null
      if (!finished) open()
    }, delay)
    void runIsGone().then(gone => {
      if (gone && !finished) giveUp(err, true)
    })
  }

  // Back online, or the tab is shown again: do not wait out the backoff
  const reconnectNow = () => {
    if (
      finished ||
      current?.readyState === EventSource.OPEN ||
      current?.readyState === EventSource.CONNECTING
    ) {
      return
    }
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    open()
  }
  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible') reconnectNow()
  }

  const onMessage = (msg: MessageEvent) => {
    // A message already queued when the stream was closed must not land:
    // its chat may no longer be the one on screen
    if (finished) return
    let data: any
    try {
      data = JSON.parse(msg.data)
    } catch (err) {
      // A frame that cannot be read ends this connection. Resuming from the
      // last seq sends it again.
      debugConsole.warn('Unreadable run stream frame:', err)
      dropConnection(err)
      return
    }
    if (data.caughtUp) {
      if (watchdogArmed) armWatchdog()
      safely(() => onCaughtUp?.())
      return
    }
    if (typeof data.seq === 'number') {
      // Already handled before a reconnect: the stream replays from the last seq
      if (data.seq <= lastSeq) return
      lastSeq = data.seq
    }
    markAlive()
    if (data.event) {
      try {
        onEvent(data.event, lastSeq)
      } catch (err) {
        // A failing handler must not cut the stream short
        debugConsole.error('Run event handler failed:', err)
      }
      if (
        data.event.type === 'turnFinished' ||
        data.event.type === 'error'
      ) {
        clearActiveRun()
        finish()
        safely(() => onDone())
      }
    }
  }

  const onHeartbeat = () => {
    if (finished) return
    watchdogArmed = true
    markAlive()
  }

  const open = () => {
    current?.close()
    const eventSource = new EventSource(
      streamPath(lastSeq) + (passive ? '&watch=0' : '')
    )
    current = eventSource
    if (watchdogArmed) armWatchdog()

    eventSource.onmessage = onMessage
    eventSource.addEventListener('heartbeat', onHeartbeat)
    eventSource.onerror = err => {
      if (current !== eventSource) {
        eventSource.close()
        return
      }
      current = null
      eventSource.close()
      dropConnection(err)
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('online', reconnectNow)
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange)
  }

  open()

  return () => {
    finish()
  }
}

/** Runs a caller's callback; an error in it is logged, never thrown into the stream. */
function safely(fn: () => void) {
  try {
    fn()
  } catch (err) {
    debugConsole.error('Run stream callback failed:', err)
  }
}

export async function stopBackgroundRun(runId: string): Promise<void> {
  await fetch(`/ai-assist/runs/${encodeURIComponent(runId)}/stop`, {
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
    buildId?: string | null
    clsiServerId?: string | null
  }
): Promise<void> {
  const rawLog = outcome.rawLog
    ? outcome.rawLog.slice(-MAX_REPORTED_LOG_CHARS)
    : ''
  await fetch(`/ai-assist/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/compile`, {
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
  decision: {
    id?: string
    accepted: boolean
    always?: boolean
    note?: string
    nextMode?: AgentMode
  }
): Promise<void> {
  const res = await fetch(`/ai-assist/runs/${encodeURIComponent(runId)}/approve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...getCsrfHeaders(),
    },
    body: JSON.stringify(decision),
  })
  if (!res.ok) {
    throw new Error(`Failed to approve edit: ${res.status}`)
  }
}

export async function setBackgroundRunMode(
  projectId: string,
  runId: string,
  mode: AgentMode
): Promise<void> {
  const res = await fetch(
    `/ai-assist/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/mode`,
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
  message: {
    id: string
    text: string
    contextText?: string
    commandText?: string
    command?: SlashCommandInvocation
  }
): Promise<boolean> {
  const res = await fetch(
    `/ai-assist/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/message`,
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

/** The 409 of a message route: 'ended' when the run is over, else 'read'. */
async function conflictOutcome(res: Response): Promise<'ended' | 'read'> {
  const data = await res.json().catch(() => null)
  return data?.reason === 'ended' ? 'ended' : 'read'
}

/**
 * Has the run answer a message sent into it now, cutting short the reply it
 * is streaming, as Claude Code's "send now" does.
 *
 * 'sent' when the run holds it, 'read' when it has read it already, and
 * 'ended' when the run is over.
 */
export async function sendRunMessageNow(
  projectId: string,
  runId: string,
  messageId: string
): Promise<'sent' | 'read' | 'ended'> {
  const res = await fetch(
    `/ai-assist/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/message/${encodeURIComponent(messageId)}/now`,
    {
      method: 'POST',
      headers: { ...getCsrfHeaders() },
    }
  )
  if (res.ok) return 'sent'
  if (res.status === 404) return 'ended'
  if (res.status === 409) return conflictOutcome(res)
  throw new Error(`Failed to send the message now: ${res.status}`)
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
    `/ai-assist/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/message/${encodeURIComponent(messageId)}`,
    {
      method: 'DELETE',
      headers: { ...getCsrfHeaders() },
    }
  )
  if (res.ok) return 'removed'
  if (res.status === 404) return 'ended'
  if (res.status === 409) return conflictOutcome(res)
  throw new Error(`Failed to take the message back: ${res.status}`)
}
