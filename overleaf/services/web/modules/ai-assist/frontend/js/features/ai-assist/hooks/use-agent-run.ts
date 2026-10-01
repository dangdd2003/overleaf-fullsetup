import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { UserSettingsContext } from '@/shared/context/user-settings-context'
import { ProjectContext } from '@/shared/context/project-context'
import { applyLiveSettingsUpdate } from '../agent/live-settings-updater'
import { debugConsole } from '@/utils/debugging'
import { useTranslation } from 'react-i18next'
import { AiAssistant } from '../assistant'
import {
  hasConsented,
  isWebToolsAvailable,
  readWebSearchSettings,
  recordConsent,
} from '../provider-store'
import { runAgent } from '../agent/run-agent'
import { resolveLimits } from '../providers/types'
import { useProjectHandle } from '../agent/use-project-handle'
import { AgentTool } from '../agent/tools/registry'
import { EditRequest } from '../agent/project-handle'
import { locateAnchorInText } from '../agent/latex-matcher'
import { TranscriptEntry } from '../agent/agent-messages'
import { AgentEvent } from '../agent/agent-events'
import { AgentMode } from '../agent/agent-mode'
import {
  AgentState,
  emptyAgentState,
  reduceAgentEvent,
  cancelPendingToolCalls,
} from '../agent/agent-state'
import {
  startBackgroundRun,
  connectRunStream,
  stopBackgroundRun,
  approveBackgroundEdit,
  submitBackgroundCompile,
  getStoredActiveRunId,
  getStoredActiveRunStartedAt,
  setStoredActiveRunId,
  setBackgroundRunMode,
  sendBackgroundRunMessage,
  takeBackRunMessage,
} from '../agent/background/background-run-client'

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
  const { t } = useTranslation()
  const [state, setState] = useState<AgentState>(() =>
    emptyAgentState(initialTranscript ?? [], initialMode ?? 'manual')
  )
  const [needsConsent, setNeedsConsent] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const currentRunIdRef = useRef<string | null>(null)
  const streamCleanupRef = useRef<(() => void) | null>(null)
  const callMapRef = useRef<Map<string, string>>(new Map())
  const approvalRef = useRef<
    ((decision: { accepted: boolean; note?: string }) => void) | null
  >(null)
  const chatIdRef = useRef(chatId)
  chatIdRef.current = chatId

  const [approvalContext, setApprovalContext] = useState<{
    startLine: number
  } | null>(null)

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

  const requestApproval = useCallback(
    (_edit: EditRequest, context: { startLine: number }) =>
      new Promise<{ accepted: boolean; note?: string }>(resolve => {
        approvalRef.current = resolve
        setApprovalContext(context)
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
    if (event.type === 'toolCallStarted') {
      const e: any = event
      const id = e.id || e.call?.id
      const name = e.name || e.call?.name
      if (id && name) {
        callMapRef.current.set(id, name)
      }
    }
    if (event.type === 'toolCallFinished') {
      const e: any = event
      const name = e.name || e.call?.name || callMapRef.current.get(e.id) || ''
      const result = e.result
      if (result && result.status === 'applied' && result.updatedSettings) {
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
    if (event.type === 'awaitingApproval' && (event as any).edit) {
      const edit = (event as any).edit
      if (typeof edit?.startLine === 'number' && edit.startLine > 0) {
        setApprovalContext({ startLine: edit.startLine })
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
                setApprovalContext({ startLine: line })
                return
              }
            }
            const idx = edit.oldText ? text.indexOf(edit.oldText) : text.length
            if (idx !== -1) {
              const line = text.slice(0, idx).split('\n').length
              setApprovalContext({ startLine: line })
            } else {
              setApprovalContext({ startLine: 1 })
            }
          })
          .catch(() => {
            setApprovalContext({ startLine: 1 })
          })
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

  const onDecision = useCallback(
    async (decision: {
      accepted: boolean
      note?: string
      nextMode?: AgentMode
    }) => {
      if (currentRunIdRef.current) {
        await approveBackgroundEdit(currentRunIdRef.current, decision)
      } else {
        approvalRef.current?.(decision)
        approvalRef.current = null
      }
      setApprovalContext(null)
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
    streamCleanupRef.current?.()
    streamCleanupRef.current = null
    runEndRef.current?.settle()
    setState(current => ({
      ...current,
      transcript: cancelPendingToolCalls(current.transcript),
    }))
  }, [projectId, systemPrompt, whenRunEnded])

  const run = useCallback(
    async (
      transcript: TranscriptEntry[],
      // A one-click fix hands in what it prepared for this run (web tools and
      // the prompt that matches them); everything else uses the hook's own.
      overrides: {
        tools?: Record<string, AgentTool>
        systemPrompt?: string
      } = {}
    ) => {
      const runTools = overrides.tools ?? tools
      const runSystemPrompt = overrides.systemPrompt ?? systemPrompt
      const assistant = AiAssistant.fromStoredSettings()
      if (!assistant) {
        return
      }
      if (!hasConsented()) {
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

      setState(current => ({
        ...current,
        transcript,
        running: true,
        stoppedByUser: false,
        error: null,
      }))

      // If a narrow system prompt was supplied (e.g. compile-log fix), keep in-page
      if (runSystemPrompt) {
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
              const e: any = event
              const id = e.id || e.call?.id
              const name = e.name || e.call?.name
              if (id && name) {
                callMapRef.current.set(id, name)
              }
            }
            if (event.type === 'toolCallFinished') {
              const e: any = event
              const name =
                e.name || e.call?.name || callMapRef.current.get(e.id) || ''
              const result = e.result
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
        const runId = await startBackgroundRun({
          projectId,
          transcript: payload,
          providerSettings: assistant.settings,
          mode: modeRef.current,
          chatId: chatIdRef.current,
          webSearchSettings: isWebToolsAvailable()
            ? readWebSearchSettings()
            : null,
        })
        currentRunIdRef.current = runId
        const runEnded = followRunEnd()

        streamCleanupRef.current?.()
        streamCleanupRef.current = connectRunStream({
          runId,
          projectId,
          onEvent: handleStreamEvent,
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
      } catch (err: any) {
        setState(current => ({
          ...current,
          running: false,
          error: { code: 'runFailed', message: err.message },
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
      t,
      projectContext,
      userSettingsContext,
      stop,
      followRunEnd,
    ]
  )

  /**
   * Stops following the run without stopping it: the server carries on, and
   * `attach` picks it up again. Returns the run's id, or null if none is live.
   */
  const detach = useCallback((): string | null => {
    if (systemPrompt) return null
    const runId = currentRunIdRef.current
    currentRunIdRef.current = null
    streamCleanupRef.current?.()
    streamCleanupRef.current = null
    runEndRef.current?.settle()
    approvalRef.current = null
    setApprovalContext(null)
    setStoredActiveRunId(projectId, null)
    return runId
  }, [projectId, systemPrompt])

  /**
   * Follows a run from its first event, as after a reload: the unfinished
   * assistant turn is dropped and rebuilt from the replay.
   */
  const attach = useCallback(
    (runId: string, startedAt?: number) => {
      if (systemPrompt || currentRunIdRef.current === runId) return
      streamCleanupRef.current?.()
      currentRunIdRef.current = runId
      const runEnded = followRunEnd()
      setStoredActiveRunId(projectId, runId, startedAt)
      setState(current => {
        const last = current.transcript.at(-1)
        const transcript =
          last && last.role === 'assistant'
            ? current.transcript.slice(0, -1)
            : current.transcript
        return {
          ...current,
          transcript,
          running: true,
          error: null,
        }
      })
      const finish = () => {
        runEnded()
        if (currentRunIdRef.current !== runId) return
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
        since: 0,
        onEvent: handleStreamEvent,
        onDone: finish,
        onError: finish,
      })
    },
    [handleStreamEvent, projectId, systemPrompt, followRunEnd]
  )

  // Reconnect on mount if a background run is in progress
  useEffect(() => {
    if (systemPrompt) return
    const activeRunId = getStoredActiveRunId(projectId)
    if (activeRunId) {
      attach(activeRunId, getStoredActiveRunStartedAt(projectId) ?? undefined)
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
    whenRunEnded,
    running: state.running,
    error: state.error,
    handle,
    approvalContext,
    run,
    stop,
    detach,
    attach,
    onDecision,
    needsConsent,
    allowConsent,
  }
}
