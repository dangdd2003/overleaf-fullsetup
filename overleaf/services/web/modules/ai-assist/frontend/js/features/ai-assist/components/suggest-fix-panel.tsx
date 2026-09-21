import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import getMeta from '@/utils/meta'
import useEventListener from '@/shared/hooks/use-event-listener'
import OLButton from '@/shared/components/ol/ol-button'
import MaterialIcon from '@/shared/components/material-icon'
import { ProjectContext } from '@/shared/context/project-context'
import { useAgentRun } from '../hooks/use-agent-run'
import { FIX_TOOLS, buildFixTranscript } from '../agent/fix-run'
import { FIX_SYSTEM_PROMPT } from '../agent/context/fix-system-prompt'
import {
  getStoredFix,
  saveStoredFix,
  buildLogEntryFingerprint,
  recordLastCompletedFix,
} from '../agent/fix-store'
import { readSettings } from '../provider-store'
import { EditRequest } from '../agent/project-handle'
import {
  TranscriptEntry,
  AssistantBlock,
  blocksForEntry,
} from '../agent/agent-messages'
import { renderFixHandoff } from '../agent/context/fix-handoff'
import { requestChatHandoff } from '../agent/chat-handoff'
import { useChatBusy } from '../agent/chat-activity'
import { useAiDock } from '../hooks/use-ai-dock'
import { partitionBlocks } from './agent/agent-message'
import { SubresultGroup } from './agent/subresult-group'
import { ThinkingBlock } from './agent/thinking-block'
import { AgentStatusLine } from './agent/agent-status-line'
import { EditApprovalCard } from './agent/edit-approval-card'
import { MarkdownContent } from './agent/markdown-content'
import { isFixableLevel } from '../log-entry-levels'
import '../../../../stylesheets/ai-assist.scss'

/** The host the document window would be sent to, for the consent prompt. */
function providerHost() {
  const settings = readSettings()
  if (!settings?.baseUrl) return null
  try {
    return new URL(settings.baseUrl).host
  } catch {
    return settings.baseUrl
  }
}

const ERROR_MESSAGES: Record<string, string> = {
  providerAuth:
    'Your AI provider rejected the API key. Check it in Account Settings.',
  providerError:
    'The AI provider could not complete this request. Please try again.',
  providerTimeout: 'The AI provider did not respond in time. Please try again.',
  consentRequired: 'You need to allow AI features before using this.',
  noProvider: 'No AI provider is configured. Add one in Account Settings.',
  quotaExhausted: 'You have reached your AI usage limit for today.',
  forbidden: 'You do not have access to this project.',
  badRequest:
    'This request could not be sent. Check your project and try again.',
  contextExhausted: 'The project is too large for the AI provider to process.',
  network: 'Could not reach the server.',
  unknown: 'Something went wrong.',
}

function errorMessage(code?: string | null, message?: string | null) {
  if (message && message !== 'The provider request failed.') return message
  if (code && ERROR_MESSAGES[code]) return ERROR_MESSAGES[code]
  return message || ERROR_MESSAGES.unknown
}

export default function SuggestFixPanel({
  logEntry,
  forceCollapsed,
}: {
  logEntry?: any
  /**
   * Always start folded, ignoring whatever `collapsed` value the run last
   * persisted. The global "Last suggested fix" banner reopens a fix whose
   * live panel may have been left expanded when its entry disappeared —
   * without this it would resurrect showing the whole conversation instead
   * of the folded summary a stale history entry should start as.
   */
  forceCollapsed?: boolean
}) {
  const enabled =
    Boolean(getMeta('ol-aiAssistEnabled')) &&
    getMeta('ol-showAiFeatures') !== false &&
    isFixableLevel(logEntry?.level)

  const projectContext = useContext(ProjectContext)
  const projectId = projectContext?.projectId || 'default'

  const entryId = logEntry?.key ?? logEntry?.id
  const fileName = logEntry?.file || 'main.tex'
  const displayFileName = fileName.split('/').pop() || fileName

  const fingerprint = useMemo(
    () => buildLogEntryFingerprint(logEntry),
    [logEntry]
  )

  const stored = useMemo(
    () => (entryId ? getStoredFix(projectId, entryId, fingerprint) : null),
    [projectId, entryId, fingerprint]
  )

  const [open, setOpen] = useState(() => Boolean(stored?.open))
  const [collapsed, setCollapsed] = useState(() => {
    if (forceCollapsed) return true
    if (stored?.collapsed !== undefined) return stored.collapsed
    // Reopening a fix that already finished in a previous session starts
    // folded, matching Overleaf Cloud's "Last suggested fix" summary; a fix
    // that is still running (or has no history yet) starts expanded.
    return Boolean(
      stored?.transcript && stored.transcript.length > 0 && !stored.running
    )
  })
  const [feedback, setFeedback] = useState<'up' | 'down' | null>(
    () => stored?.feedback ?? null
  )
  const [decidedEdits, setDecidedEdits] = useState<
    Record<string, { path: string; startLine: number; accepted: boolean }>
  >(() => stored?.decidedEdits ?? {})
  // The gap between clicking "Suggest fix" and the request actually going out
  // (building the fix transcript reads the project first) has no signal of
  // its own in AgentState, so it gets a dedicated flag rather than being
  // folded into `running`.
  const [requesting, setRequesting] = useState(false)
  // Set when the user asks to move this entry to the chat while the chat is
  // mid-run. Clears itself the moment the chat frees up, so the warning never
  // outlives the condition it describes.
  const [chatBusyWarning, setChatBusyWarning] = useState(false)

  const { dock, setIsRightOpen } = useAiDock()
  const chatBusy = useChatBusy(projectId)

  useEffect(() => {
    if (!chatBusy) setChatBusyWarning(false)
  }, [chatBusy])

  const onAgentEvent = useCallback(
    (_event: any, nextState: any) => {
      if (!entryId) return
      saveStoredFix(projectId, {
        entryId,
        fingerprint,
        open: true,
        collapsed: false,
        transcript: nextState.transcript,
        running: nextState.running,
        error: nextState.error,
        feedback,
        decidedEdits,
        updatedAt: Date.now(),
      })
    },
    [projectId, entryId, fingerprint, feedback, decidedEdits]
  )

  const {
    state,
    setState,
    running,
    error,
    handle,
    approvalContext,
    run,
    stop,
    onDecision,
    needsConsent,
    allowConsent,
  } = useAgentRun({
    tools: FIX_TOOLS,
    systemPrompt: FIX_SYSTEM_PROMPT,
    requireTool: 'edit_file',
    cacheKey: projectId,
    onEvent: onAgentEvent,
  })

  // The panel lives inside a compile-log entry. A recompile that fixes the
  // error removes the entry and unmounts this panel with a run still in
  // flight — there is no consumer left for its output, so cancel it.
  useEffect(() => {
    return () => {
      void stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Stamped when a run begins so the status line can count from it; the
  // agent state carries no start time of its own.
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null)

  useEffect(() => {
    if ((requesting || running) && !state.pendingApproval) {
      setRunStartedAt(current => current ?? Date.now())
    } else {
      setRunStartedAt(null)
    }
  }, [requesting, running, state.pendingApproval])

  // Seed state on mount from stored conversation if available
  const seededRef = useRef(false)
  if (!seededRef.current && stored?.transcript && stored.transcript.length > 0) {
    seededRef.current = true
    setState({
      transcript: stored.transcript,
      running: false,
      stoppedByUser: false,
      pendingApproval: null,
      error: stored.error ?? null,
    })
  }

  // Persist whenever transcript, feedback, decidedEdits, or open state changes
  useEffect(() => {
    if (!entryId) return
    if (state.transcript.length > 0 || open) {
      saveStoredFix(projectId, {
        entryId,
        fingerprint,
        open,
        collapsed,
        transcript: state.transcript,
        running,
        error,
        feedback,
        decidedEdits,
        updatedAt: Date.now(),
      })
    }
  }, [
    projectId,
    entryId,
    fingerprint,
    open,
    collapsed,
    state.transcript,
    running,
    error,
    feedback,
    decidedEdits,
  ])

  const startRun = useCallback(async () => {
    const compile = handle.lastCompile()
    const others = [
      ...(compile?.errors ?? []).map(e => ({
        level: 'error' as const,
        file: e.file,
        line: e.line,
      })),
      ...(compile?.warnings ?? []).map(w => ({
        level: 'warning' as const,
        file: w.file,
        line: w.line,
      })),
    ].filter(
      entry => !(entry.file === logEntry?.file && entry.line === logEntry?.line)
    )

    const transcript = await buildFixTranscript({
      handle,
      focused: {
        level: logEntry?.level ?? 'error',
        message: logEntry?.message ?? '',
        raw: logEntry?.raw ?? null,
        file: logEntry?.file ?? null,
        line: logEntry?.line ?? null,
      },
      others,
    })

    await run(transcript)
  }, [handle, logEntry, run])

  const onSuggestFix = useCallback(
    async (event: Event) => {
      const detail = (event as CustomEvent<{ entryId?: string }>).detail ?? {}
      // A hidden panel must never start a run the user cannot see.
      if (!enabled || !entryId || detail.entryId !== entryId) return
      setOpen(true)
      setCollapsed(false)
      setFeedback(null)
      setDecidedEdits({})
      setRequesting(true)
      await startRun()
    },
    [enabled, entryId, startRun]
  )

  useEventListener('aiAssist:suggestFix', onSuggestFix)

  // Clears itself once the run actually starts streaming (running flips true)
  // or fails before it gets that far (error / consent prompt).
  useEffect(() => {
    if (requesting && (running || error || needsConsent)) {
      setRequesting(false)
    }
  }, [requesting, running, error, needsConsent])

  const handleRetry = useCallback(async () => {
    setCollapsed(false)
    setFeedback(null)
    setDecidedEdits({})
    setRequesting(true)
    await startRun()
  }, [startRun])

  const onAllow = useCallback(async () => {
    allowConsent()
    await startRun()
  }, [allowConsent, startRun])

  const recordDecision = useCallback(
    (
      callId: string,
      edit: EditRequest,
      decision: { accepted: boolean; note?: string }
    ) => {
      const startLine = approvalContext?.startLine ?? 1
      const nextDecided = {
        ...decidedEdits,
        [callId]: {
          path: edit.path,
          startLine,
          accepted: decision.accepted,
        },
      }
      setDecidedEdits(nextDecided)
      if (entryId) {
        saveStoredFix(projectId, {
          entryId,
          fingerprint,
          open,
          collapsed,
          transcript: state.transcript,
          running,
          error,
          feedback,
          decidedEdits: nextDecided,
          updatedAt: Date.now(),
        })
      }
    },
    [
      approvalContext,
      decidedEdits,
      entryId,
      fingerprint,
      open,
      collapsed,
      projectId,
      running,
      error,
      state.transcript,
      feedback,
    ]
  )

  const pendingEdit = state.pendingApproval?.edit

  const assistantEntries = useMemo(() => {
    return state.transcript.filter(
      (e): e is Extract<TranscriptEntry, { role: 'assistant' }> =>
        e.role === 'assistant'
    )
  }, [state.transcript])

  // Running out of steps after the answer is already written is not a failure
  // to report: the user can read the explanation and the diff above. Claiming
  // "I could not pin this down" underneath a finished suggestion is the panel
  // calling its own work useless.
  const producedSuggestion = useMemo(
    () =>
      assistantEntries.some(
        entry =>
          Boolean(entry.text?.trim()) ||
          entry.toolCalls.some(
            call => call.name === 'edit_file' || call.name === 'create_file'
          )
      ),
    [assistantEntries]
  )

  // The pane opens for warnings as often as errors; calling an overfull hbox
  // an "error" overstates what the build said.
  const entryKind = logEntry?.level === 'warning' ? 'warning' : 'error'

  // Everything the run produced is already in `state.transcript` — including
  // the original fix context frozen onto its first turn — so the handoff is a
  // pure read. Nothing is re-derived from the live document, which is what
  // lets the history banner hand off a run whose file has since changed.
  const canHandOff =
    !requesting && !running && !needsConsent && state.transcript.length > 0

  const onContinueInChat = useCallback(() => {
    // run() rebuilds the request from the whole transcript, so starting a
    // second one underneath a live run would race it. Refuse and say why
    // rather than silently dropping the click.
    if (chatBusy) {
      setChatBusyWarning(true)
      return
    }

    const location =
      logEntry?.line != null ? `${fileName}, line ${logEntry.line}` : fileName
    const message = (logEntry?.message ?? '').trim().slice(0, 140)

    requestChatHandoff(projectId, {
      entryId: entryId ?? fileName,
      level: entryKind,
      file: logEntry?.file ?? null,
      line: logEntry?.line ?? null,
      message: logEntry?.message ?? '',
      text:
        `Let's keep working on the compile ${entryKind} in ${location}` +
        (message ? ` — "${message}".` : '.'),
      contextText: renderFixHandoff({
        transcript: state.transcript,
        decidedEdits,
        error,
      }),
    })

    if (dock === 'right') {
      setIsRightOpen(true)
    } else {
      window.dispatchEvent(
        new CustomEvent('ui:select-rail-tab', {
          detail: { tab: 'ai-assist', open: true },
        })
      )
    }

    // The conversation has moved; leaving the card open here would invite the
    // user to keep working in the panel they just left.
    setCollapsed(true)
  }, [
    chatBusy,
    decidedEdits,
    dock,
    entryId,
    entryKind,
    error,
    fileName,
    logEntry,
    projectId,
    setIsRightOpen,
    state.transcript,
  ])

  // An OLButton rather than a bespoke one: it sits directly beside Re-open in
  // the folded card, and the panel's other real actions ("Try again",
  // "Account Settings") are all secondary/sm too. Only the pill radius is
  // overridden, exactly as .ai-suggest-fix-reopen-btn does.
  const handoffButton = canHandOff ? (
    <OLButton
      type="button"
      variant="secondary"
      size="sm"
      className="ai-suggest-chat-btn"
      leadingIcon="forum"
      onClick={onContinueInChat}
    >
      Continue in chat
    </OLButton>
  ) : null

  const busyWarning =
    chatBusyWarning && chatBusy ? (
      <p className="ai-suggest-chat-busy" role="alert">
        The AI assistant is busy with another request. Wait for it to finish,
        then try again.
      </p>
    ) : null

  // Notify when run completes. A successful run also gets remembered for the
  // rest of this tab's life: if the fix resolves the error, recompiling makes
  // its log entry vanish, and this panel unmounts with it — without this,
  // there would be no way left to look at what the assistant did. The global
  // "Last suggested fix" banner reads this to stay available after that.
  const wasRunningRef = useRef(false)
  useEffect(() => {
    if (running) {
      wasRunningRef.current = true
    } else if (wasRunningRef.current) {
      wasRunningRef.current = false
      if (entryId && producedSuggestion) {
        recordLastCompletedFix(projectId, {
          entryId,
          fingerprint,
          file: fileName,
          line: logEntry?.line ?? null,
          message: logEntry?.message ?? '',
          level: entryKind,
        })
      }
      window.dispatchEvent(
        new CustomEvent('aiAssist:suggestDone', { detail: { entryId } })
      )
    }
  }, [
    entryId,
    running,
    producedSuggestion,
    projectId,
    fingerprint,
    fileName,
    logEntry,
    entryKind,
  ])

  useEffect(() => {
    if (error && !running) {
      window.dispatchEvent(
        new CustomEvent('aiAssist:suggestDone', { detail: { entryId } })
      )
    }
  }, [entryId, error, running])

  // The title only tracks the coarse stage of the run — requesting, working,
  // done — not the granular activity ("Reading main.tex…", "Searching
  // project…") the work row already shows underneath it. Mirroring that
  // activity in both places said the same thing twice.
  const cardTitle = requesting
    ? 'Sending request…'
    : running
      ? `Analyzing ${entryKind} in ${displayFileName}`
      : `Suggested fix for ${entryKind} in ${displayFileName}`

  if (!enabled || !open) return null

  return (
    <div className="ai-suggest-fix-panel">
      {/* Consent prompt */}
      {needsConsent ? (
        <div className="ai-assist-consent" role="alert">
          <p>
            Sending this error to your AI provider will also send about forty lines
            of your document to <strong>{providerHost() || 'the provider'}</strong>.
          </p>
          <OLButton type="button" variant="primary" size="sm" onClick={onAllow}>
            Allow and continue
          </OLButton>
        </div>
      ) : null}

      {/* Error alert */}
      {error && !needsConsent ? (
        <div className="ai-assist-error" role="alert">
          <div className="ai-assist-error-header">
            <span className="ai-assist-error-title">
              {error.status
                ? `Upstream Error (HTTP ${error.status})`
                : error.code === 'providerAuth'
                  ? 'Authentication Error'
                  : error.code === 'network'
                    ? 'Connection Error'
                    : 'AI Provider Error'}
            </span>
            {error.upstreamCode && (
              <span className="ai-assist-error-badge">{error.upstreamCode}</span>
            )}
          </div>
          <div className="ai-assist-error-body">
            <p className="ai-assist-error-message">
              {errorMessage(error.code, error.message)}
            </p>
            {error.hint && (
              <p className="ai-assist-error-hint">
                <strong>Where to fix:</strong> {error.hint}
              </p>
            )}
          </div>
          <div className="ai-assist-error-actions">
            <OLButton type="button" variant="secondary" size="sm" onClick={handleRetry}>
              Try again
            </OLButton>
            {(error.code === 'providerAuth' ||
              error.code === 'modelsUnsupported' ||
              error.code === 'noProvider') && (
              <OLButton
                href="/user/settings"
                target="_blank"
                rel="noopener noreferrer"
                variant="secondary"
                size="sm"
              >
                Account Settings
              </OLButton>
            )}
          </div>
        </div>
      ) : null}

      {/* Folded summary of a previously finished fix */}
      {!error && !needsConsent && collapsed && !running ? (
        <div className="ai-suggest-fix-card ai-suggest-fix-folded">
          <span className="ai-suggest-fix-folded-icon" aria-hidden="true">
            <MaterialIcon type="history" />
          </span>
          <div className="ai-suggest-fix-folded-text">
            <div className="ai-suggest-fix-folded-title">
              Last suggested fix
            </div>
            <div className="ai-suggest-fix-folded-subtitle">
              ./{fileName}
              {logEntry?.line != null ? `, ${logEntry.line}` : ''}
            </div>
          </div>
          <div className="ai-suggest-fix-folded-actions">
            {handoffButton}
            <OLButton
              type="button"
              variant="secondary"
              size="sm"
              className="ai-suggest-fix-reopen-btn"
              onClick={() => setCollapsed(false)}
            >
              Re-open
            </OLButton>
          </div>
          {busyWarning}
        </div>
      ) : null}

      {/* Main card */}
      {!error && !needsConsent && !collapsed ? (
        <div className="ai-suggest-fix-card">
          <div className="ai-suggest-fix-header">
            <MaterialIcon
              type="auto_awesome"
              className={`ai-suggest-fix-icon ${requesting || running ? 'is-loading' : ''}`}
            />
            <h4 className="ai-suggest-fix-title">{cardTitle}</h4>
            {!requesting && !running && (
              <button
                type="button"
                className="icon-button ai-suggest-fix-collapse-btn"
                onClick={() => setCollapsed(true)}
                aria-label="Collapse"
                title="Collapse"
              >
                <MaterialIcon type="expand_less" />
              </button>
            )}
          </div>

          {assistantEntries.map((entry, entryIdx) => {
            const entryBlocks = blocksForEntry(entry)

            const segments = partitionBlocks(entryBlocks)
            const isLastEntry = entryIdx === assistantEntries.length - 1

            return (
              <div key={entry.id || `entry-${entryIdx}`} className="ai-suggest-entry">
                {segments.map((segment, idx) => {
                  if (segment.type === 'text') {
                    return (
                      <div key={`text-${idx}`} className="ai-suggest-explanation">
                        <MarkdownContent content={segment.text} />
                      </div>
                    )
                  }

                  const isLastSegment = isLastEntry && idx === segments.length - 1
                  const editCalls = segment.items.filter(
                    (item): item is Extract<AssistantBlock, { type: 'tool_call' }> =>
                      item.type === 'tool_call' &&
                      (item.call.name === 'edit_file' ||
                        item.call.name === 'create_file')
                  )

                  return (
                    <div
                      key={`subresults-${idx}`}
                      className="ai-suggest-segment-group"
                    >
                      {/*
                        The same component the main chat renders its activity
                        with. `pendingApprovalId` is deliberately not passed:
                        this panel renders its own approval card and decision
                        receipts just below, and handing the id over as well
                        would draw the card twice.
                      */}
                      <SubresultGroup
                        items={segment.items}
                        isLive={running && isLastSegment}
                        onDecision={onDecision}
                      />

                      {editCalls.map(editItem => {
                        const callId = editItem.call.id
                        const isPending =
                          callId === state.pendingApproval?.id &&
                          pendingEdit &&
                          approvalContext

                        if (isPending) {
                          return (
                            <EditApprovalCard
                              key={`pending-${callId}`}
                              edit={pendingEdit}
                              startLine={approvalContext.startLine}
                              onDecision={decision => {
                                recordDecision(callId, pendingEdit, decision)
                                onDecision(decision)
                              }}
                            />
                          )
                        }

                        const result = editItem.call.result as any
                        const isAccepted =
                          result?.status === 'applied' ||
                          decidedEdits[callId]?.accepted === true
                        const isRejected =
                          result?.status === 'rejected' ||
                          decidedEdits[callId]?.accepted === false

                        if (isAccepted || isRejected) {
                          const editPath =
                            (editItem.call.args as any)?.path ?? fileName
                          const startLine =
                            (editItem.call.args as any)?.from ??
                            approvalContext?.startLine ??
                            1
                          return (
                            <div
                              key={`receipt-${callId}`}
                              className={`ai-assist-edit-receipt ${isAccepted ? 'is-accepted' : 'is-rejected'}`}
                            >
                              {editPath}:{startLine}{' '}
                              {isAccepted ? '✓ applied' : '✗ rejected'}
                            </div>
                          )
                        }

                        return null
                      })}
                    </div>
                  )
                })}
              </div>
            )
          })}

          {/* Fallback for pending approval if not yet assigned to an entry */}
          {pendingEdit &&
            approvalContext &&
            !assistantEntries.some(e =>
              (e.blocks ?? []).some(
                b =>
                  b.type === 'tool_call' &&
                  b.call.id === state.pendingApproval?.id
              )
            ) && (
              <EditApprovalCard
                key="pending-fallback"
                edit={pendingEdit}
                startLine={approvalContext.startLine}
                onDecision={decision => {
                  if (state.pendingApproval?.id) {
                    recordDecision(
                      state.pendingApproval.id,
                      pendingEdit,
                      decision
                    )
                  }
                  onDecision(decision)
                }}
              />
            )}

          {/*
            Below the activity rows, never inside one: the rows report what
            the agent did, this reports that it is still going.
          */}
          {runStartedAt !== null && !state.pendingApproval && (
            <AgentStatusLine
              startedAt={runStartedAt}
              isRunning={state.running}
              blocks={
                (() => {
                  const last = state.running ? state.transcript.at(-1) : null
                  return last?.role === 'assistant' ? last.blocks ?? [] : []
                })()
              }
            />
          )}

          {/* Footer with disclaimer and actions */}
          <div className="ai-suggest-fix-footer">
            <p className="ai-suggest-mistake-disclaimer">
              AI can make mistakes. Review fixes before you apply them.
            </p>

            <div className="ai-suggest-fix-actions-row">
              <div className="ai-suggest-feedback-actions">
                <button
                  type="button"
                  className={`icon-button ai-feedback-btn ${feedback === 'up' ? 'active' : ''}`}
                  onClick={() => setFeedback(f => (f === 'up' ? null : 'up'))}
                  aria-label="Good suggestion"
                  title="Good suggestion"
                >
                  <MaterialIcon type="thumb_up" unfilled={feedback !== 'up'} />
                </button>

                <button
                  type="button"
                  className={`icon-button ai-feedback-btn ${feedback === 'down' ? 'active' : ''}`}
                  onClick={() => setFeedback(f => (f === 'down' ? null : 'down'))}
                  aria-label="Poor suggestion"
                  title="Poor suggestion"
                >
                  <MaterialIcon type="thumb_down" unfilled={feedback !== 'down'} />
                </button>

                <button
                  type="button"
                  className="icon-button ai-retry-btn"
                  onClick={handleRetry}
                  aria-label="Suggest a different fix"
                  title="Suggest a different fix"
                >
                  <MaterialIcon type="refresh" />
                </button>
              </div>

              <div className="ai-suggest-apply-action">
                {running ? (
                  <button
                    type="button"
                    className="ai-suggest-stop-btn"
                    onClick={stop}
                  >
                    Stop
                  </button>
                ) : (
                  handoffButton
                )}
              </div>
            </div>

            {busyWarning}
          </div>
        </div>
      ) : null}
    </div>
  )
}
