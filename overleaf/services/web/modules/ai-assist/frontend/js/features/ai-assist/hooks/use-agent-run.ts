import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { UserSettingsContext } from '@/shared/context/user-settings-context'
import { ProjectContext } from '@/shared/context/project-context'
import { applyLiveSettingsUpdate } from '../agent/live-settings-updater'
import { useTranslation } from 'react-i18next'
import { AiAssistant } from '../assistant'
import { hasConsented, recordConsent } from '../provider-store'
import { runAgent } from '../agent/run-agent'
import { resolveLimits } from '../providers/types'
import { useProjectHandle } from '../agent/use-project-handle'
import { AgentTool } from '../agent/tools/registry'
import { EditRequest } from '../agent/project-handle'
import { TranscriptEntry } from '../agent/agent-messages'
import { AgentEvent } from '../agent/agent-events'
import {
  AgentState,
  emptyAgentState,
  reduceAgentEvent,
} from '../agent/agent-state'
import {
  startBackgroundRun,
  connectRunStream,
  stopBackgroundRun,
  approveBackgroundEdit,
  getStoredActiveRunId,
  setStoredActiveRunId,
} from '../agent/background/background-run-client'

export function useAgentRun({
  tools,
  maxSteps,
  systemPrompt,
  cacheKey,
  onEvent,
  initialTranscript,
}: {
  tools: Record<string, AgentTool>
  maxSteps: number
  /** A narrow run (the compile-log fix) supplies its own, smaller prompt. */
  systemPrompt?: string
  cacheKey?: string
  onEvent?: (event: AgentEvent, nextState: AgentState) => void
  initialTranscript?: TranscriptEntry[]
}) {
  const { t } = useTranslation()
  const [state, setState] = useState<AgentState>(() =>
    emptyAgentState(initialTranscript ?? [])
  )
  const [needsConsent, setNeedsConsent] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const currentRunIdRef = useRef<string | null>(null)
  const streamCleanupRef = useRef<(() => void) | null>(null)
  const callMapRef = useRef<Map<string, string>>(new Map())
  const approvalRef = useRef<
    ((decision: { accepted: boolean; note?: string }) => void) | null
  >(null)
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
          console.warn('Failed to apply live settings update:', err)
        }
      }
    }
    if (event.type === 'awaitingApproval' && (event as any).edit) {
      const edit = (event as any).edit
      if (edit?.path) {
        handleRef.current
          .readFile(edit.path)
          .then(res => {
            const lines = res?.lines
            const text = Array.isArray(lines) ? lines.join('\n') : ''
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
    setState(current => {
      const next = reduceAgentEvent(current, event)
      onEventRef.current?.(event, next)
      return next
    })
  }, [])

  const onDecision = useCallback(
    async (decision: { accepted: boolean; note?: string }) => {
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

  const run = useCallback(
    async (transcript: TranscriptEntry[]) => {
      const assistant = AiAssistant.fromStoredSettings()
      if (!assistant) {
        setState(current => ({
          ...current,
          error: {
            code: 'noProvider',
            message: t(
              'ai_assist_configure_provider',
              'Configure an AI provider in Account Settings to use the assistant.'
            ),
          },
        }))
        return
      }
      if (!hasConsented()) {
        setNeedsConsent(true)
        return
      }

      window.dispatchEvent(new CustomEvent('aiAssist:agentReadSelection'))

      setState(current => ({
        ...current,
        transcript,
        running: true,
        stoppedForBudget: false,
        stoppedByUser: false,
        error: null,
      }))

      // If a narrow system prompt was supplied (e.g. compile-log fix), keep in-page
      if (systemPrompt) {
        const controller = new AbortController()
        abortRef.current = controller

        try {
          for await (const event of runAgent({
            client: assistant.client,
            handle,
            tools,
            transcript,
            limits: resolveLimits(assistant.settings),
            cacheKey,
            maxSteps,
            systemPrompt,
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
              const name = e.name || e.call?.name || callMapRef.current.get(e.id) || ''
              const result = e.result
              if (result && result.status === 'applied' && result.updatedSettings) {
                try {
                  applyLiveSettingsUpdate(name, result.updatedSettings, {
                    userSettingsContext,
                    projectContext,
                    projectId,
                  })
                } catch (err) {
                  console.warn('Failed to apply live settings update:', err)
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
          if (controller.signal.aborted || err?.code === 'aborted' || err?.name === 'AbortError') {
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
          transcript,
          providerSettings: assistant.settings,
        })
        currentRunIdRef.current = runId

        streamCleanupRef.current?.()
        streamCleanupRef.current = connectRunStream({
          runId,
          projectId,
          onEvent: handleStreamEvent,
          onDone: () => {
            currentRunIdRef.current = null
            setStoredActiveRunId(projectId, null)
            setState(current => ({ ...current, running: false, pendingApproval: null }))
          },
          onError: _err => {
            if (!currentRunIdRef.current) return
            currentRunIdRef.current = null
            setStoredActiveRunId(projectId, null)
            setState(current => ({
              ...current,
              running: false,
              pendingApproval: null,
              error: current.error ?? { code: 'network', message: 'Connection to AI background run failed.' },
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
    [handle, tools, maxSteps, systemPrompt, cacheKey, projectId, onEvent, handleStreamEvent, t, projectContext, userSettingsContext]
  )

  const stop = useCallback(async () => {
    const runId = currentRunIdRef.current
    currentRunIdRef.current = null
    abortRef.current?.abort()
    streamCleanupRef.current?.()
    setStoredActiveRunId(projectId, null)
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
    }
  }, [projectId])

  // Reconnect on mount if a background run is in progress
  useEffect(() => {
    if (systemPrompt) return
    const activeRunId = getStoredActiveRunId(projectId)
    if (!activeRunId || currentRunIdRef.current === activeRunId) {
      return
    }

    currentRunIdRef.current = activeRunId
    setState(current => {
      // Strip unfinished assistant turn so the catch-up events from sequence 0 replay cleanly
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
    streamCleanupRef.current = connectRunStream({
      runId: activeRunId,
      projectId,
      since: 0,
      onEvent: handleStreamEvent,
      onDone: () => {
        currentRunIdRef.current = null
        setStoredActiveRunId(projectId, null)
        setState(current => ({ ...current, running: false, pendingApproval: null }))
      },
      onError: () => {
        currentRunIdRef.current = null
        setStoredActiveRunId(projectId, null)
        setState(current => ({ ...current, running: false, pendingApproval: null }))
      },
    })
    return () => {
      streamCleanupRef.current?.()
    }
  }, [projectId, systemPrompt])

  const allowConsent = useCallback(() => {
    recordConsent()
    setNeedsConsent(false)
  }, [])

  return {
    state,
    setState,
    running: state.running,
    error: state.error,
    handle,
    approvalContext,
    run,
    stop,
    onDecision,
    needsConsent,
    allowConsent,
  }
}
