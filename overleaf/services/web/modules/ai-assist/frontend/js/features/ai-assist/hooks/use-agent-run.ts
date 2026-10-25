import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { UserSettingsContext } from '@/shared/context/user-settings-context'
import { ProjectContext } from '@/shared/context/project-context'
import { applyLiveSettingsUpdate } from '../agent/live-settings-updater'
import { debugConsole } from '@/utils/debugging'
import { AiAssistant } from '../assistant'
import {
  hasConsented,
  isWebToolsAvailable,
  readWebSearchSettings,
  recordConsent,
} from '../provider-store'
import { isConnectorsEnabled } from '../connectors/api'
import { getChatConnectorIds } from '../connectors/chat-selection'
import { runAgent } from '../agent/run-agent'
import { resolveLimits } from '../providers/types'
import { useProjectHandle } from '../agent/use-project-handle'
import { AgentTool } from '../agent/tools/registry'
import { EditRequest } from '../agent/project-handle'
import { locateAnchorInText } from '../agent/latex-matcher'
import { TranscriptEntry } from '../agent/agent-messages'
import {
  AgentEvent,
  ApprovalContext,
  dispatchAiEditHighlight,
} from '../agent/agent-events'
import { AgentMode } from '../agent/agent-mode'
import {
  AgentState,
  emptyAgentState,
  reduceAgentEvent,
  cancelPendingToolCalls,
  withoutLiveReply,
} from '../agent/agent-state'
import {
  startBackgroundRun,
  connectRunStream,
  stopBackgroundRun,
  approveBackgroundEdit,
  submitBackgroundCompile,
  getStoredActiveRunChatId,
  getStoredActiveRunId,
  getStoredActiveRunStartedAt,
  setStoredActiveRunId,
  setBackgroundRunMode,
  sendBackgroundRunMessage,
  takeBackRunMessage,
  sendRunMessageNow,
  setDetachedRun,
} from '../agent/background/background-run-client'
import { followDetachedRun } from '../agent/background/detached-run-follower'
import { dispatchPdfResultHighlights } from '../pdf/result-highlights'

const REPLAY_SETTLE_MS = 250
// How long a message a finishing run turned away waits for that run's last
// events before the next run starts anyway
const RUN_END_WAIT_MS = 10_000
// How long a stopped run is followed for the events it sent before it saw
// the stop
const STOP_WAIT_MS = 5_000

export function useAgentRun({
  tools,
  systemPrompt,
  requireTool,
  cacheKey,
  onEvent,
  initialTranscript,
  initialMode,
  chatId,
}: {
  tools: Record<string, AgentTool>
  /** A narrow run (the compile-log fix) supplies its own, smaller prompt. */
  systemPrompt?: string
  /** See runAgent: the tool the run must call before it may finish. */
  requireTool?: string
  cacheKey?: string
  onEvent?: (event: AgentEvent, nextState: AgentState) => void
  initialTranscript?: TranscriptEntry[]
  initialMode?: AgentMode
  chatId?: string
}) {
  const [state, setState] = useState<AgentState>(() =>
    emptyAgentState(initialTranscript ?? [], initialMode ?? 'manual')
  )
  const [needsConsent, setNeedsConsent] = useState(false)
  // A run followed from part-way through is still sending what it had
  // already written, which is shown at once rather than animated again
  const [catchingUp, setCatchingUp] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const currentRunIdRef = useRef<string | null>(null)
  // The last event of the followed run that the transcript holds
  const lastSeqRef = useRef(0)
  const streamCleanupRef = useRef<(() => void) | null>(null)
  const callMapRef = useRef<Map<string, string>>(new Map())
  const approvalRef = useRef<
    ((decision: { accepted: boolean; note?: string }) => void) | null
  >(null)
  const chatIdRef = useRef(chatId)
  chatIdRef.current = chatId

  const [approvalContext, setApprovalContext] =
    useState<ApprovalContext | null>(null)

  const userSettingsContext = useContext(UserSettingsContext)
  const projectContext = useContext(ProjectContext)
  const projectId = cacheKey || 'default'

  const userSettingsContextRef = useRef(userSettingsContext)
  userSettingsContextRef.current = userSettingsContext
  const projectContextRef = useRef(projectContext)
  projectContextRef.current = projectContext
  const projectIdRef = useRef(projectId)
  projectIdRef.current = projectId
  /**
   * `run` is memoised without `state` in its dependencies, so reading
   * `state.mode` inside it returns whichever mode was current when the callback
   * was last rebuilt — usually the default. That is what made Accept edits
   * intermittently still ask for approval: the panel showed the new mode while
   * the run had been started in the old one. The ref is always current.
   */
  const modeRef = useRef(state.mode)
  modeRef.current = state.mode
  const pendingApprovalRef = useRef(state.pendingApproval)
  pendingApprovalRef.current = state.pendingApproval

  const requestApproval = useCallback(
    (_edit: EditRequest, context: { startLine: number }) =>
      new Promise<{ accepted: boolean; note?: string }>(resolve => {
        approvalRef.current = resolve
        setApprovalContext(current => ({ ...current, ...context }))
      }),
    []
  )

  const handle = useProjectHandle({ requestApproval })
  const handleRef = useRef(handle)
  handleRef.current = handle
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent
  const requestedCompileIdsRef = useRef<Set<string>>(new Set())
  const finishedCallIdsRef = useRef<Set<string>>(new Set())

  // Settles once the followed run's stream has delivered its last event. A
  // message the run turned away because it was finishing waits on this, so
  // the run's final reply lands before the next run starts.
  const runEndRef = useRef<{
    promise: Promise<void>
    settle: () => void
  } | null>(null)
  const followRunEnd = useCallback(() => {
    runEndRef.current?.settle()
    let resolve = () => {}
    const record = {
      promise: new Promise<void>(done => {
        resolve = done
      }),
      settle: () => {
        resolve()
        if (runEndRef.current === record) runEndRef.current = null
      },
    }
    runEndRef.current = record
    return record.settle
  }, [])
  const whenRunEnded = useCallback(async (waitMs: number = RUN_END_WAIT_MS) => {
    const ended = runEndRef.current?.promise
    if (!ended) return
    await Promise.race([
      ended,
      new Promise<void>(resolve => window.setTimeout(resolve, waitMs)),
    ])
    // The last events are reduced in a state update; let it render, so a
    // caller reading the transcript next reads them
    await new Promise<void>(resolve => window.setTimeout(resolve, 0))
  }, [])

  const handleStreamEvent = useCallback((event: AgentEvent) => {
    if (event.type === 'modeChanged') {
      modeRef.current = event.mode
    }
    if (event.type === 'toolCallStarted') {
      const { id, name } = event
      if (id && name) {
        callMapRef.current.set(id, name)
      }
    }
    if (event.type === 'toolCallFinished') {
      const name = event.name || callMapRef.current.get(event.id) || ''
      const result = event.result as any
      dispatchPdfResultHighlights(result)
      if (result && result.status === 'applied') {
        const mode = event.mode || modeRef.current || 'manual'
        dispatchAiEditHighlight(name, result, mode)
        if (result.updatedSettings) {
          try {
            applyLiveSettingsUpdate(name, result.updatedSettings, {
              userSettingsContext: userSettingsContextRef.current,
              projectContext: projectContextRef.current,
              projectId: projectIdRef.current,
            })
          } catch (err) {
            debugConsole.warn('Failed to apply live settings update:', err)
          }
        }
      }
    }
    if (event.type === 'awaitingApproval') {
      const callId = event.id
      // Context is tagged with its call, so a late line lookup for an
      // earlier call never relabels the card that is showing now.
      const setForCall = (context: ApprovalContext) =>
        setApprovalContext(current =>
          current?.callId === callId ? { ...current, ...context } : current
        )
      setApprovalContext({ callId })
      if (event.kind === 'connector' || event.kind === 'connectorAuth') {
        setForCall({ kind: event.kind, connector: event.connector })
      } else if (event.edit) {
        const edit = event.edit
        if (typeof edit?.startLine === 'number' && edit.startLine > 0) {
          setForCall({ startLine: edit.startLine })
        } else if (edit?.path) {
          handleRef.current
            .readFile(edit.path)
            .then(res => {
              const lines = res?.lines
              const text = Array.isArray(lines) ? lines.join('\n') : ''
              const match = locateAnchorInText(text, edit.oldText)
              if (match) {
                const anchor = match.anchor
                const idx = text.indexOf(anchor)
                if (idx !== -1) {
                  const line = text.slice(0, idx).split('\n').length
                  setForCall({ startLine: line })
                  return
                }
              }
              const idx = edit.oldText
                ? text.indexOf(edit.oldText)
                : text.length
              if (idx !== -1) {
                const line = text.slice(0, idx).split('\n').length
                setForCall({ startLine: line })
              } else {
                setForCall({ startLine: 1 })
              }
            })
            .catch(() => {
              setForCall({ startLine: 1 })
            })
        }
      }
    }
    if (event.type === 'toolCallFinished') {
      finishedCallIdsRef.current.add(event.id)
    }
    if (event.type === 'awaitingCompile') {
      const { id, clean } = event
      const runId = currentRunIdRef.current
      if (runId && !requestedCompileIdsRef.current.has(id)) {
        requestedCompileIdsRef.current.add(id)
        // A reconnect replays the run from the start, where a request that was
        // already answered is followed by its toolCallFinished. Give that a
        // moment to arrive so an old request does not start a real compile.
        window.setTimeout(() => {
          if (finishedCallIdsRef.current.has(id)) return
          if (currentRunIdRef.current !== runId) return
          // Every open tab of the project watches the run; only one compiles.
          const claimKey = `aiAssist:compileClaim:${runId}:${id}`
          try {
            if (window.localStorage.getItem(claimKey)) return
            window.localStorage.setItem(claimKey, '1')
          } catch {
            // no storage: compile anyway
          }
          // The editor's own compile: it waits for a build already running,
          // shows progress in the PDF pane, and fills the logs the user sees.
          handleRef.current
            .compile({ clean })
            .catch(() => ({ status: 'failure', errors: [], warnings: [] }))
            .then(outcome =>
              submitBackgroundCompile(projectIdRef.current, runId, id, {
                ...outcome,
                rawLog: handleRef.current.lastCompile()?.rawLog ?? null,
              })
            )
            .catch(() => {})
        }, REPLAY_SETTLE_MS)
      }
    }
    setState(current => {
      const next = reduceAgentEvent(current, event)
      onEventRef.current?.(event, next)
      return next
    })
  }, [])

  const onRunEvent = useCallback(
    (event: AgentEvent, seq: number) => {
      if (seq > lastSeqRef.current) lastSeqRef.current = seq
      handleStreamEvent(event)
    },
    [handleStreamEvent]
  )

  const onDecision = useCallback(
    async (decision: {
      accepted: boolean
      always?: boolean
      note?: string
      nextMode?: AgentMode
    }) => {
      const pending = pendingApprovalRef.current
      // The card goes the moment the user chooses: the call drops back into
      // its activity line, which animates while the background applies it.
      // The approval context stays, so that line keeps the edit's lines.
      setState(current =>
        current.pendingApproval && current.pendingApproval === pending
          ? { ...current, pendingApproval: null }
          : current
      )
      try {
        if (currentRunIdRef.current) {
          await approveBackgroundEdit(currentRunIdRef.current, decision)
        } else {
          approvalRef.current?.(decision)
          approvalRef.current = null
        }
      } catch (error) {
        setState(current =>
          current.pendingApproval || !pending
            ? current
            : { ...current, pendingApproval: pending }
        )
        throw error
      }
    },
    []
  )

  /**
   * Sends a message into the run that is already going.
   *
   * Returns false when there is no live run to take it — no run id, an in-page
   * run (which has no message endpoint), or a run that finished between the
   * user typing and pressing send. The caller starts a normal run instead.
   */
  const queueMessage = useCallback(
    async (entry: TranscriptEntry): Promise<boolean> => {
      const runId = currentRunIdRef.current
      if (!runId || systemPrompt || entry.role !== 'user') return false
      const accepted = await sendBackgroundRunMessage(
        projectIdRef.current,
        runId,
        {
          id: entry.id,
          text: entry.text,
          contextText: entry.contextText,
          commandText: entry.commandText,
          command: entry.command,
        }
      ).catch(() => false)
      return accepted
    },
    [systemPrompt]
  )

  /**
   * Takes back a message `queueMessage` handed to the run, as Claude Code lets
   * you take back what you queued. True when the run will not read it: it was
   * removed, or the run has ended. In that case its events have all arrived
   * by the time this returns, so the caller can tell from the entry whether
   * the run read it after all.
   */
  const unqueueMessage = useCallback(
    async (id: string): Promise<boolean> => {
      const runId = currentRunIdRef.current
      if (!runId) return true
      const outcome = await takeBackRunMessage(
        projectIdRef.current,
        runId,
        id
      ).catch(() => 'read' as const)
      if (outcome === 'ended') {
        await whenRunEnded()
        return true
      }
      return outcome === 'removed'
    },
    [whenRunEnded]
  )

  /**
   * Has the run answer a message `queueMessage` handed it now, instead of
   * after the reply it is writing. A message it has read, or a run that has
   * ended, needs nothing more: its events say what became of the message.
   */
  const sendQueuedNow = useCallback(async (id: string): Promise<void> => {
    const runId = currentRunIdRef.current
    if (!runId) return
    await sendRunMessageNow(projectIdRef.current, runId, id).catch(err => {
      debugConsole.warn('Failed to send the queued message now:', err)
    })
  }, [])

  const setMode = useCallback((mode: AgentMode) => {
    // Before the re-render, so a send in the same tick starts in the new mode.
    modeRef.current = mode
    setState(current => ({ ...current, mode }))
    if (currentRunIdRef.current) {
      void setBackgroundRunMode(
        projectIdRef.current,
        currentRunIdRef.current,
        mode
      ).catch(err => {
        debugConsole.warn('Failed to set background run mode:', err)
      })
    }
  }, [])

  const stop = useCallback(async () => {
    const runId = currentRunIdRef.current
    const cleanup = streamCleanupRef.current
    currentRunIdRef.current = null
    abortRef.current?.abort()
    // Only the background path owns this storage key. An in-page run (systemPrompt
    // set) shares the same projectId, and clearing it here would drop the main
    // chat's live run id and break its reconnect.
    if (!systemPrompt) {
      setStoredActiveRunId(projectId, null)
    }
    approvalRef.current?.({ accepted: false })
    approvalRef.current = null
    setApprovalContext(null)
    setState(current => ({
      ...current,
      running: false,
      stoppedByUser: true,
      pendingApproval: null,
      error: null,
    }))
    if (runId) {
      await stopBackgroundRun(runId).catch(() => {})
      // Events the run sent before it saw the stop are still arriving, among
      // them results of tools it had already run and sent to the provider.
      // The next run is rebuilt from this transcript, so it needs them to
      // send the same messages and read them from the cache. The run ends
      // its stream once it has stopped; a send waits on that too.
      await whenRunEnded(STOP_WAIT_MS)
    }
    // A chat opened meanwhile follows a run of its own, which is left alone
    if (streamCleanupRef.current !== cleanup) return
    streamCleanupRef.current?.()
    streamCleanupRef.current = null
    runEndRef.current?.settle()
    setState(current => ({
      ...current,
      transcript: cancelPendingToolCalls(current.transcript),
    }))
  }, [projectId, systemPrompt, whenRunEnded])

  const startMainRun = useCallback(
    (
      runChatId: string | undefined,
      payload: TranscriptEntry[],
      mode: AgentMode,
      assistantSettings: any,
      compact?: { trigger: 'manual' | 'auto'; instructions?: string }
    ) => {
      const connectorIds = isConnectorsEnabled()
        ? getChatConnectorIds(runChatId)
        : null
      return startBackgroundRun({
        projectId,
        transcript: payload,
        providerSettings: assistantSettings,
        mode,
        chatId: runChatId,
        webSearchSettings: isWebToolsAvailable()
          ? readWebSearchSettings()
          : null,
        ...(connectorIds ? { connectorIds } : {}),
        trackActive: false,
        ...(compact
          ? {
              kind: 'compact' as const,
              trigger: compact.trigger,
              instructions: compact.instructions,
            }
          : {}),
      })
    },
    [projectId]
  )

  const run = useCallback(
    async (
      transcript: TranscriptEntry[],
      // A one-click fix hands in what it prepared for this run (web tools and
      // the prompt that matches them); everything else uses the hook's own.
      overrides: {
        tools?: Record<string, AgentTool>
        systemPrompt?: string
        /** A `/compact` run: summarizes the chat, no tools, no reply. */
        compact?: { trigger: 'manual' | 'auto'; instructions?: string }
      } = {}
    ): Promise<boolean | undefined> => {
      const runTools = overrides.tools ?? tools
      const runSystemPrompt = overrides.systemPrompt ?? systemPrompt
      const compact = overrides.compact
      // The chat this run belongs to. The panel may move to another chat while
      // the run is being started; the run then carries on for this one.
      const runChatId = chatIdRef.current
      const leftChat = () => chatIdRef.current !== runChatId
      const assistant = AiAssistant.fromStoredSettings()
      if (!assistant) {
        return
      }
      if (!hasConsented()) {
        if (leftChat()) return
        // Commit the transcript now, replacing the caller's optimistic entry,
        // so allowing consent resumes this exact run rather than re-sending
        // the prompt as a second copy.
        setState(current => ({ ...current, transcript, running: false }))
        setNeedsConsent(true)
        return
      }

      // One run per conversation. A second send is a new intent, not a continuation.
      if (currentRunIdRef.current || abortRef.current) {
        await stop()
      }

      window.dispatchEvent(new CustomEvent('aiAssist:agentReadSelection'))

      // A message still waiting its turn in the panel's send queue is shown
      // but not sent: it goes to the run when the queue reaches it.
      const payload = transcript.filter(
        entry => !(entry.role === 'user' && entry.pending)
      )

      if (!leftChat()) {
        setState(current => ({
          ...current,
          transcript,
          running: true,
          // Shown at once: the run's compactStarted event confirms it
          compacting: compact
            ? { trigger: compact.trigger, phase: 'masking' }
            : null,
          retrying: null,
          stoppedByUser: false,
          error: null,
        }))
      }

      // If a narrow system prompt was supplied (e.g. compile-log fix), keep in-page
      if (runSystemPrompt && !compact) {
        abortRef.current?.abort()
        const controller = new AbortController()
        abortRef.current = controller

        try {
          for await (const event of runAgent({
            client: assistant.client,
            handle,
            tools: runTools,
            transcript: payload,
            limits: resolveLimits(assistant.settings),
            cacheKey,
            systemPrompt: runSystemPrompt,
            requireTool,
            signal: controller.signal,
          })) {
            if (event.type === 'toolCallStarted') {
              const { id, name } = event
              if (id && name) {
                callMapRef.current.set(id, name)
              }
            }
            if (event.type === 'toolCallFinished') {
              const name =
                event.name || callMapRef.current.get(event.id) || ''
              const result = event.result as any
              dispatchPdfResultHighlights(result)
              if (
                result &&
                result.status === 'applied' &&
                result.updatedSettings
              ) {
                try {
                  applyLiveSettingsUpdate(name, result.updatedSettings, {
                    userSettingsContext,
                    projectContext,
                    projectId,
                  })
                } catch (err) {
                  debugConsole.warn(
                    'Failed to apply live settings update:',
                    err
                  )
                }
              }
            }
            setState(current => {
              const next = reduceAgentEvent(current, event)
              onEvent?.(event, next)
              return next
            })
          }
        } catch (err: any) {
          if (
            controller.signal.aborted ||
            err?.code === 'aborted' ||
            err?.name === 'AbortError'
          ) {
            setState(current => ({
              ...current,
              running: false,
              stoppedByUser: true,
              error: null,
            }))
            return
          }
          setState(current => ({
            ...current,
            running: false,
            error: { code: 'runFailed', message: err.message },
          }))
        } finally {
          abortRef.current = null
        }
        return
      }

      // Server-side background execution for main chat
      try {
        const mode = modeRef.current
        const runId = await startMainRun(
          runChatId,
          payload,
          mode,
          assistant.settings,
          compact
        )
        if (leftChat()) {
          // Its chat was left while the request was out: the run goes on in
          // parallel, off screen, and must not stream into the chat now shown
          if (runChatId) {
            const startedAt = Date.now()
            setDetachedRun(projectId, runChatId, { runId, startedAt })
            followDetachedRun({
              projectId,
              chatId: runChatId,
              runId,
              startedAt,
              transcript,
              mode,
            })
          }
          return
        }
        setStoredActiveRunId(projectId, runId, Date.now(), runChatId)
        currentRunIdRef.current = runId
        lastSeqRef.current = 0
        const runEnded = followRunEnd()

        streamCleanupRef.current?.()
        streamCleanupRef.current = connectRunStream({
          runId,
          projectId,
          onEvent: onRunEvent,
          onDone: () => {
            runEnded()
            currentRunIdRef.current = null
            setStoredActiveRunId(projectId, null)
            setState(current => ({
              ...current,
              running: false,
              pendingApproval: null,
            }))
          },
          onError: _err => {
            runEnded()
            if (!currentRunIdRef.current) return
            currentRunIdRef.current = null
            setStoredActiveRunId(projectId, null)
            setState(current => ({
              ...current,
              running: false,
              pendingApproval: null,
              error: current.error ?? {
                code: 'network',
                message: 'Connection to AI background run failed.',
              },
            }))
          },
        })
        // Followed on screen: the caller can wait on its end (whenRunEnded)
        return true
      } catch (err: any) {
        if (leftChat()) return
        setState(current => ({
          ...current,
          running: false,
          compacting: null,
          // A refused compaction says why (chatBusy)
          error: {
            code: compact ? (err?.code ?? 'compactFailed') : 'runFailed',
            message: err.message,
          },
        }))
      }
    },
    [
      handle,
      tools,
      systemPrompt,
      requireTool,
      cacheKey,
      projectId,
      onEvent,
      handleStreamEvent,
      onRunEvent,
      projectContext,
      userSettingsContext,
      stop,
      followRunEnd,
      startMainRun,
    ]
  )

  /**
   * Stops following the run without stopping it: the server carries on, and
   * `attach` picks it up again from `seq`, the last event the transcript
   * holds. Null if no run is live.
   */
  const detach = useCallback((): { runId: string; seq: number } | null => {
    if (systemPrompt) return null
    const runId = currentRunIdRef.current
    currentRunIdRef.current = null
    streamCleanupRef.current?.()
    streamCleanupRef.current = null
    runEndRef.current?.settle()
    approvalRef.current = null
    setApprovalContext(null)
    setCatchingUp(false)
    setStoredActiveRunId(projectId, null)
    return runId ? { runId, seq: lastSeqRef.current } : null
  }, [projectId, systemPrompt])

  /**
   * Follows a run of the chat on screen. From `since`, the last event the
   * transcript holds, it carries on from there. From 0, as after a reload,
   * the run is replayed: the unfinished reply shown is dropped once the
   * replay begins and rebuilt from it, and kept if nothing comes back.
   */
  const attach = useCallback(
    (
      runId: string,
      {
        startedAt,
        since = 0,
        chatId: runChatId = chatIdRef.current,
      }: { startedAt?: number; since?: number; chatId?: string } = {}
    ) => {
      if (systemPrompt || currentRunIdRef.current === runId) return
      streamCleanupRef.current?.()
      currentRunIdRef.current = runId
      lastSeqRef.current = since
      const runEnded = followRunEnd()
      setStoredActiveRunId(projectId, runId, startedAt, runChatId)
      setState(current => ({ ...current, running: true, error: null }))
      setCatchingUp(true)
      let replaying = since === 0
      const finish = () => {
        runEnded()
        if (currentRunIdRef.current !== runId) return
        setCatchingUp(false)
        currentRunIdRef.current = null
        setStoredActiveRunId(projectId, null)
        setState(current => ({
          ...current,
          running: false,
          pendingApproval: null,
        }))
      }
      streamCleanupRef.current = connectRunStream({
        runId,
        projectId,
        since,
        onEvent: (event, seq) => {
          if (replaying) {
            replaying = false
            setState(current => ({
              ...current,
              transcript: withoutLiveReply(current.transcript),
            }))
          }
          onRunEvent(event, seq)
        },
        onCaughtUp: () => {
          if (currentRunIdRef.current === runId) setCatchingUp(false)
        },
        onDone: finish,
        onError: finish,
      })
    },
    [onRunEvent, projectId, systemPrompt, followRunEnd]
  )

  /**
   * Starts a run for a chat that is no longer on screen: a message sent just
   * before its chat was left. The run goes on in parallel with the chat now
   * shown and is followed off screen, so its reply reaches the chat's history.
   */
  const runDetached = useCallback(
    async (
      runChatId: string,
      transcript: TranscriptEntry[],
      mode: AgentMode
    ) => {
      const assistant = AiAssistant.fromStoredSettings()
      if (systemPrompt || !assistant || !hasConsented()) return
      const payload = transcript
      const runId = await startMainRun(
        runChatId,
        payload,
        mode,
        assistant.settings
      )
      const startedAt = Date.now()
      setDetachedRun(projectId, runChatId, { runId, startedAt })
      followDetachedRun({
        projectId,
        chatId: runChatId,
        runId,
        startedAt,
        transcript: payload,
        mode,
      })
    },
    [projectId, systemPrompt, startMainRun]
  )

  // Reconnect on mount if a background run is in progress
  useEffect(() => {
    if (systemPrompt) return
    const activeRunId = getStoredActiveRunId(projectId)
    if (activeRunId) {
      const startedAt = getStoredActiveRunStartedAt(projectId) ?? undefined
      const owner = getStoredActiveRunChatId(projectId)
      if (owner && chatIdRef.current && owner !== chatIdRef.current) {
        // The run of another chat (one left in another tab, say) goes on off
        // screen, never streamed into the chat that is open now
        setStoredActiveRunId(projectId, null)
        setDetachedRun(projectId, owner, {
          runId: activeRunId,
          startedAt: startedAt ?? Date.now(),
        })
      } else {
        attach(activeRunId, { startedAt })
      }
    }
    return () => {
      streamCleanupRef.current?.()
    }
  }, [attach, projectId, systemPrompt])

  const allowConsent = useCallback(() => {
    recordConsent()
    setNeedsConsent(false)
  }, [])

  return {
    state,
    setState,
    mode: state.mode,
    setMode,
    chatTitle: state.chatTitle,
    isTitleGenerated: state.isTitleGenerated,
    queueMessage,
    unqueueMessage,
    sendQueuedNow,
    whenRunEnded,
    running: state.running,
    error: state.error,
    handle,
    approvalContext,
    run,
    runDetached,
    catchingUp,
    stop,
    detach,
    attach,
    onDecision,
    needsConsent,
    allowConsent,
  }
}
