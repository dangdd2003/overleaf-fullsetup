import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useProjectContext } from '@/shared/context/project-context'
import RailPanelHeader from '@/features/ide-react/components/rail/rail-panel-header'
import OLButton from '@/shared/components/ol/ol-button'
import OLTooltip from '@/shared/components/ol/ol-tooltip'
import useEventListener from '@/shared/hooks/use-event-listener'
import { NotePencil, SidebarSimple } from '@phosphor-icons/react'
import { AiAssistant } from '../../assistant'
import { TranscriptEntry } from '../../agent/agent-messages'
import { ProjectFile, ProjectHandle } from '../../agent/project-handle'
import { MAX_STEPS } from '../../agent/run-agent'
import { TOOLS } from '../../agent/tools/registry'
import { renderEnvelope } from '../../agent/context/project-context'
import { Attachment, AttachmentRef, ContextSnapshot } from '../../agent/context/types'
import { resolveAttachments } from '../../agent/context/attachments'
import {
  clearConversation,
  loadConversation,
  saveConversation,
} from '../../agent/conversation-store'
import { AgentMessageView } from './agent-message'
import { AgentEmptyState, PickedStarter } from './agent-empty-state'
import { AgentComposer, AttachedSelection } from './agent-composer'
import { AgentStatusLine } from './agent-status-line'
import { takePendingHandoff } from '../../agent/chat-handoff'
import { setChatBusy } from '../../agent/chat-activity'
import { useStickToBottom } from '../../hooks/use-stick-to-bottom'
import { useAgentRun } from '../../hooks/use-agent-run'
import { emptyAgentState } from '../../agent/agent-state'
import withErrorBoundary from '@/infrastructure/error-boundary'
import type { FallbackProps } from 'react-error-boundary'
import {
  getStoredActiveRunStartedAt,
  setStoredActiveRunId,
} from '../../agent/background/background-run-client'
import { useAiDock, DockPosition } from '../../hooks/use-ai-dock'

export async function buildUserEntry({
  handle,
  transcript,
  text,
  attachments = [],
  attachedSelection,
  extraContext,
}: {
  handle: ProjectHandle
  transcript: TranscriptEntry[]
  text: string
  attachments?: Attachment[]
  attachedSelection?: { path: string; from: number; to: number; text: string } | null
  /**
   * Context handed over from another panel, appended after the envelope.
   * Kept separate from `attachments` because it is not something the user
   * pinned — the transcript must not render a chip for it.
   */
  extraContext?: string
}): Promise<TranscriptEntry> {
  const id = `u${transcript.length}`
  const previousUser = [...transcript]
    .reverse()
    .find(entry => entry.role === 'user') as
    | Extract<TranscriptEntry, { role: 'user' }>
    | undefined
  const turn = (previousUser?.envelopeState?.turn ?? 0) + 1

  const activeSel = attachedSelection ?? handle.currentSelection()

  const allAttachments: Attachment[] = [...attachments]
  if (
    activeSel &&
    activeSel.text &&
    !allAttachments.some(
      a =>
        a.path === activeSel.path &&
        a.from === activeSel.from &&
        a.to === activeSel.to
    )
  ) {
    allAttachments.unshift({
      path: activeSel.path,
      from: activeSel.from,
      to: activeSel.to,
      text: activeSel.text,
    })
  }

  try {
    const compile = handle.lastCompile()
    const index = await handle.index().catch(() => null)
    const snapshot: ContextSnapshot = {
      rootDocPath: handle.rootDocPath(),
      files: await handle.listFiles(),
      openFile: handle.openFile(),
      selection: activeSel,
      outline: index?.outline ?? null,
      compile: compile
        ? {
            status: compile.status,
            errorCount: compile.errors.length,
            warningCount: compile.warnings.length,
          }
        : null,
    }

    const envelope = renderEnvelope({
      snapshot,
      attachments: allAttachments,
      turn,
      previous: previousUser?.envelopeState ?? null,
    })

    return {
      id,
      role: 'user',
      text,
      contextText: extraContext
        ? `${envelope.text}\n${extraContext}`
        : envelope.text,
      envelopeState: envelope.state,
      attachments: allAttachments,
    }
  } catch {
    // A snapshot that will not load must not stop the user talking to the model.
    return {
      id,
      role: 'user',
      text,
      ...(extraContext ? { contextText: extraContext } : {}),
      attachments: allAttachments,
      ...(activeSel ? { selection: activeSel } : {}),
    }
  }
}

function AgentPanelInner({
  dock: dockProp,
  onClose,
}: {
  dock?: DockPosition
  onClose?: () => void
} = {}) {
  const { t } = useTranslation()
  const { projectId } = useProjectContext()
  const { dock: storedDock, setDock, setIsRightOpen } = useAiDock()
  const activeDock = dockProp ?? storedDock

  const handleToggleDock = useCallback(() => {
    if (activeDock === 'right') {
      setDock('left')
      setIsRightOpen(false)
      window.dispatchEvent(
        new CustomEvent('ui:select-rail-tab', {
          detail: { tab: 'ai-assist', open: true },
        })
      )
    } else {
      setDock('right')
      setIsRightOpen(true)
      window.dispatchEvent(
        new CustomEvent('ui:select-rail-tab', {
          detail: { tab: 'file-tree' },
        })
      )
    }
  }, [activeDock, setDock, setIsRightOpen])

  const {
    state,
    setState,
    handle,
    approvalContext,
    run,
    stop,
    onDecision,
    needsConsent,
    allowConsent,
  } = useAgentRun({
    tools: TOOLS,
    maxSteps: MAX_STEPS,
    cacheKey: projectId,
    initialTranscript: loadConversation(projectId),
  })

  const [pendingPrompt, setPendingPrompt] = useState<{
    text: string
    attachments?: AttachmentRef[]
  } | null>(null)
  const [files, setFiles] = useState<ProjectFile[]>([])
  // Stamped when a run begins so the status line can count from it;
  // persists across page reloads via getStoredActiveRunStartedAt.
  const [runStartedAt, setRunStartedAt] = useState<number | null>(() => {
    return getStoredActiveRunStartedAt(projectId)
  })
  const [completedRun, setCompletedRun] = useState<{
    durationMs: number
    word?: string
  } | null>(() => {
    const initial = loadConversation(projectId)
    const last = initial.at(-1)
    if (last && last.role === 'assistant' && (last as any).durationMs) {
      return {
        durationMs: (last as any).durationMs,
        word: (last as any).statusWord,
      }
    }
    return null
  })

  const prevRunningRef = useRef(state.running)
  const runStartedAtRef = useRef<number | null>(runStartedAt)
  runStartedAtRef.current = runStartedAt
  const activeWordRef = useRef<string | null>(null)

  useEffect(() => {
    if (state.running) {
      setRunStartedAt(current => current ?? Date.now())
      setCompletedRun(null)
    } else if (prevRunningRef.current && !state.running) {
      if (
        !state.stoppedByUser &&
        !state.error &&
        !state.pendingApproval &&
        runStartedAtRef.current
      ) {
        const duration = Math.max(1000, Date.now() - runStartedAtRef.current)
        const word = activeWordRef.current || undefined
        setCompletedRun({ durationMs: duration, word })
        setState(curr => {
          const last = curr.transcript.at(-1)
          if (last && last.role === 'assistant') {
            return {
              ...curr,
              transcript: [
                ...curr.transcript.slice(0, -1),
                { ...last, durationMs: duration, statusWord: word },
              ],
            }
          }
          return curr
        })
      }
      setRunStartedAt(null)
    }
    prevRunningRef.current = state.running
  }, [state.running, state.stoppedByUser, state.error, state.pendingApproval, setState])
  const transcriptRef = useRef<HTMLDivElement>(null)

  const onTranscriptScroll = useStickToBottom(transcriptRef)

  useEffect(() => {
    saveConversation(projectId, state.transcript)
  }, [projectId, state.transcript])

  useEffect(() => {
    let mounted = true
    handle
      .listFiles()
      .then(loaded => {
        if (mounted) setFiles(loaded)
      })
      .catch(() => {})
    return () => {
      mounted = false
    }
  }, [handle, state.running])

  const [attachments, setAttachments] = useState<AttachmentRef[]>([])
  const [attachedSelection, setAttachedSelection] =
    useState<AttachedSelection | null>(null)

  useEventListener('aiAssist:selectionChanged', (event: Event) => {
    const detail = (event as CustomEvent<AttachedSelection | null>).detail
    if (detail && detail.text) {
      setAttachedSelection(detail)
    } else {
      setAttachedSelection(null)
    }
  })

  useEventListener(
    'keydown',
    useCallback(
      (event: Event) => {
        const keyboardEvent = event as KeyboardEvent
        if (keyboardEvent.key === 'Escape' && state.running) {
          keyboardEvent.preventDefault()
          keyboardEvent.stopPropagation()
          void stop()
        }
      },
      [state.running, stop]
    )
  )

  // Builds the user entry from scratch and sends it. Shared by `onSend` and
  // `onAllowConsent` so a prompt blocked on consent resumes through the exact
  // same path once the user allows it.
  const sendPrompt = useCallback(
    async ({
      text,
      attachments: attachmentRefs = [],
      attachedSelection: selectionRef,
      extraContext,
    }: {
      text: string
      attachments?: AttachmentRef[]
      attachedSelection?: AttachedSelection | null
      extraContext?: string
    }) => {
      const attachmentsResolved = await resolveAttachments(attachmentRefs, handle)
      const userEntry = await buildUserEntry({
        handle,
        transcript: state.transcript,
        text,
        attachments: attachmentsResolved,
        attachedSelection: selectionRef,
        extraContext,
      })
      const next: TranscriptEntry[] = [...state.transcript, userEntry]
      void run(next)
    },
    [handle, state.transcript, run]
  )

  const onSend = useCallback(
    async (
      text: string,
      attachmentRefs?: AttachmentRef[],
      selection?: AttachedSelection | null
    ) => {
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

      // If attachments/selection not explicitly provided (e.g. clicked from a suggestion),
      // bundle the user's @mention files and highlighted text together!
      const finalAttachments = attachmentRefs !== undefined ? attachmentRefs : attachments
      const finalSelection =
        selection !== undefined
          ? selection
          : (attachedSelection ?? handle.currentSelection())

      const prompt = {
        text,
        attachments: finalAttachments,
        attachedSelection: finalSelection,
      }
      setPendingPrompt(prompt)
      await sendPrompt(prompt)

      // Clear composer attachments and selection after sending
      setAttachments([])
      setAttachedSelection(null)
    },
    [attachments, attachedSelection, handle, sendPrompt, setState, t]
  )

  const onAllowConsent = useCallback(async () => {
    allowConsent()
    if (pendingPrompt) {
      const prompt = pendingPrompt
      setPendingPrompt(null)
      await sendPrompt(prompt)
    }
  }, [allowConsent, pendingPrompt, sendPrompt])

  // Lets the compile-log panel see that a run is in flight, so its "Continue
  // in chat" button can refuse rather than race this one. Cleared on unmount
  // because an aborted run leaves no event behind to clear it.
  useEffect(() => {
    setChatBusy(projectId, state.running)
  }, [projectId, state.running])

  useEffect(() => {
    return () => {
      setChatBusy(projectId, false)
    }
  }, [projectId])

  // Collects an issue moved over from the compile-log panel and sends it
  // straight away — the point of the handoff is that the work continues, and
  // firing now reuses the conversation prefix the provider still has cached.
  const collectHandoff = useCallback(() => {
    if (state.running) return
    const handoff = takePendingHandoff(projectId)
    if (!handoff) return
    void sendPrompt({ text: handoff.text, extraContext: handoff.contextText })
  }, [projectId, sendPrompt, state.running])

  // Two arrival paths, one consumer. A handoff parked before this panel was
  // ever mounted (the rail mounts it lazily) is waiting in storage and gets
  // picked up here; one that arrives afterwards comes in on the event below.
  // `takePendingHandoff` clears the slot, so whichever fires first wins and
  // the other finds nothing.
  const handoffCollectedRef = useRef(false)
  useEffect(() => {
    if (handoffCollectedRef.current) return
    handoffCollectedRef.current = true
    collectHandoff()
  }, [collectHandoff])

  useEventListener(
    'aiAssist:chatHandoff',
    useCallback(
      (event: Event) => {
        const detail = (event as CustomEvent<{ projectId?: string }>).detail
        if (detail?.projectId && detail.projectId !== projectId) return
        collectHandoff()
      },
      [collectHandoff, projectId]
    )
  )

  const [newChatSeed, setNewChatSeed] = useState(0)

  const onPickStarter = useCallback(
    (picked: PickedStarter | string) => {
      const text = typeof picked === 'string' ? picked : picked.prompt
      void onSend(text)
    },
    [onSend]
  )

  const onNewChat = useCallback(() => {
    clearConversation(projectId)
    setState(emptyAgentState([]))
    setNewChatSeed(s => s + 1)
    setCompletedRun(null)
    setRunStartedAt(null)
  }, [projectId, setState])

  return (
    <div className="ai-assist-panel">
      <RailPanelHeader
        title={t('ai_assist_panel_title', 'AI assistant')}
        actions={
          <div className="d-flex align-items-center gap-1">
            <OLTooltip
              id="ai-assist-new-chat-tooltip"
              description={t('ai_assist_new_chat', 'New chat')}
              overlayProps={{ placement: 'bottom' }}
            >
              <button
                type="button"
                className="btn icon-button-small rail-panel-header-button-subdued d-inline-flex align-items-center justify-content-center"
                aria-label={t('ai_assist_new_chat', 'New chat')}
                onClick={onNewChat}
              >
                <NotePencil size={18} />
              </button>
            </OLTooltip>
            <OLTooltip
              id="ai-assist-dock-tooltip"
              description={
                activeDock === 'right'
                  ? t('ai_assist_dock_left', 'Move to left panel')
                  : t('ai_assist_dock_right', 'Move to right panel')
              }
              overlayProps={{ placement: 'bottom' }}
            >
              <button
                type="button"
                className="btn icon-button-small rail-panel-header-button-subdued d-inline-flex align-items-center justify-content-center"
                aria-label={
                  activeDock === 'right'
                    ? t('ai_assist_dock_left', 'Move to left panel')
                    : t('ai_assist_dock_right', 'Move to right panel')
                }
                onClick={handleToggleDock}
              >
                <SidebarSimple
                  size={18}
                  weight="fill"
                  style={{
                    transform: activeDock !== 'right' ? 'scaleX(-1)' : undefined,
                    transformOrigin: 'center',
                  }}
                />
              </button>
            </OLTooltip>
          </div>
        }
        onClose={onClose}
      />

      <div
        className="ai-assist-transcript"
        ref={transcriptRef}
        onScroll={onTranscriptScroll}
      >
        {state.transcript.length === 0 ? (
          <AgentEmptyState
            onPick={onPickStarter}
            handle={handle}
            files={files}
            projectId={projectId}
            refreshSeed={newChatSeed}
          />
        ) : (
          state.transcript.map((entry, entryIndex) => (
            <AgentMessageView
              key={entry.id}
              entry={entry}
              pendingApprovalId={state.pendingApproval?.id ?? null}
              approvalContext={approvalContext}
              onDecision={onDecision}
              isRunning={
                state.running && entryIndex === state.transcript.length - 1
              }
            />
          ))
        )}

        {/*
          Below the activity rows, never inside one: the rows report what the
          agent did, this reports that it is still going or completed.
        */}
        {runStartedAt !== null && state.running && !state.pendingApproval ? (
          <AgentStatusLine
            startedAt={runStartedAt}
            isRunning={true}
            onWordChange={word => {
              activeWordRef.current = word
            }}
            blocks={
              (() => {
                const last = state.running ? state.transcript.at(-1) : null
                return last?.role === 'assistant' ? last.blocks ?? [] : []
              })()
            }
          />
        ) : completedRun &&
          !state.running &&
          !state.pendingApproval &&
          !state.stoppedByUser &&
          !state.error &&
          state.transcript.length > 0 &&
          state.transcript.at(-1)?.role === 'assistant' ? (
          <AgentStatusLine
            startedAt={Date.now() - completedRun.durationMs}
            durationMs={completedRun.durationMs}
            completedWord={completedRun.word}
            isRunning={false}
          />
        ) : null}

        {state.stoppedByUser && (
          <div className="ai-assist-stopped-notice" role="status">
            <span>{t('ai_assist_stopped_by_user', 'Generation stopped')}</span>
          </div>
        )}

        {needsConsent && (
          <div className="ai-assist-consent" role="alert">
            <p>
              {t(
                'ai_assist_consent_prompt',
                'Using the assistant will send project contents and queries to your configured AI provider.'
              )}
            </p>
            <OLButton type="button" variant="primary" size="sm" onClick={onAllowConsent}>
              {t('allow_and_continue', 'Allow and continue')}
            </OLButton>
          </div>
        )}

        {state.error && (
          <div className="ai-assist-error" role="alert">
            {state.error.code === 'contextExhausted' ? (
              <div className="ai-assist-context-exhausted">
                <p>{state.error.message}</p>
                <OLButton
                  type="button"
                  variant="primary"
                  size="sm"
                  onClick={onNewChat}
                >
                  {t('ai_assist_start_new_chat', 'Start a new chat')}
                </OLButton>
              </div>
            ) : (
              <>
                <div className="ai-assist-error-header">
                  <span className="ai-assist-error-title">
                    {state.error.status
                      ? `Upstream Error (HTTP ${state.error.status})`
                      : state.error.code === 'providerAuth'
                        ? 'Authentication Error'
                        : state.error.code === 'network'
                          ? 'Connection Error'
                          : 'AI Provider Error'}
                  </span>
                  {state.error.upstreamCode && (
                    <span className="ai-assist-error-badge">
                      {state.error.upstreamCode}
                    </span>
                  )}
                </div>
                <div className="ai-assist-error-body">
                  <p className="ai-assist-error-message">{state.error.message}</p>
                  {state.error.hint && (
                    <p className="ai-assist-error-hint">
                      <strong>Where to fix:</strong> {state.error.hint}
                    </p>
                  )}
                </div>
                <div className="ai-assist-error-actions">
                  <OLButton
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => void run(state.transcript)}
                  >
                    Try again
                  </OLButton>
                  {(state.error.code === 'providerAuth' ||
                    state.error.code === 'modelsUnsupported' ||
                    state.error.code === 'noProvider') && (
                    <a
                      href="/user/settings"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn btn-secondary btn-sm"
                    >
                      Account Settings
                    </a>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {state.stoppedForBudget && (
          <OLButton
            type="button"
            variant="secondary"
            size="sm"
            className="ai-assist-continue"
            onClick={() => void run(state.transcript)}
          >
            {t('ai_assist_continue', 'Continue')}
          </OLButton>
        )}
      </div>

      <AgentComposer
        running={state.running}
        paths={files.map(file => file.path)}
        onSend={onSend}
        onStop={stop}
        attachments={attachments}
        setAttachments={setAttachments}
        attachedSelection={attachedSelection}
        setAttachedSelection={setAttachedSelection}
      />
    </div>
  )
}

export const AgentPanelFallback: React.FC<FallbackProps> = ({
  error,
  resetErrorBoundary,
}) => {
  const { t } = useTranslation()
  const { projectId } = useProjectContext()

  const handleReset = () => {
    clearConversation(projectId)
    setStoredActiveRunId(projectId, null)
    if (resetErrorBoundary) {
      resetErrorBoundary()
    } else {
      // eslint-disable-next-line no-restricted-syntax
      window.location.reload()
    }
  }

  return (
    <div className="ai-assist-panel d-flex flex-column align-items-center justify-content-center p-4 text-center">
      <h5 className="mb-2 text-danger">
        {t('ai_assist_error_boundary_title', 'AI Assistant Error')}
      </h5>
      <p className="text-muted small mb-3">
        {error?.message ||
          t(
            'ai_assist_error_boundary_desc',
            'An unexpected error occurred in the assistant.'
          )}
      </p>
      <OLButton variant="primary" size="sm" onClick={handleReset}>
        {t('ai_assist_reset_chat', 'Reset Chat & Reload')}
      </OLButton>
    </div>
  )
}

export const AgentPanel = withErrorBoundary(
  AgentPanelInner,
  AgentPanelFallback
)

export default AgentPanel
