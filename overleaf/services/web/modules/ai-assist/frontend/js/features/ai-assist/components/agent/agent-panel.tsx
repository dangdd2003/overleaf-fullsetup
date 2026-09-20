import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useProjectContext } from '@/shared/context/project-context'
import AgentPanelHeader from './agent-panel-header'
import OLButton from '@/shared/components/ol/ol-button'
import OLTooltip from '@/shared/components/ol/ol-tooltip'
import useEventListener from '@/shared/hooks/use-event-listener'
import { ArrowDown, NotePencil, SidebarSimple } from '@phosphor-icons/react'
import { AiAssistant } from '../../assistant'
import { TranscriptEntry } from '../../agent/agent-messages'
import { ProjectFile, ProjectHandle } from '../../agent/project-handle'
import { TOOLS } from '../../agent/tools/registry'
import { renderEnvelope } from '../../agent/context/project-context'
import { Attachment, AttachmentRef, ContextSnapshot } from '../../agent/context/types'
import { resolveAttachments } from '../../agent/context/attachments'
import {
  clearConversation,
  loadConversation,
  saveConversation,
} from '../../agent/conversation-store'
import {
  deleteChat,
  fetchChat,
  getActiveChatId,
  newChatId,
  saveChat,
  setActiveChatId,
} from '../../agent/chat-history-client'
import { ChatHistoryMenu } from './chat-history-menu'
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
  getStoredActiveRunId,
  getStoredActiveRunStartedAt,
  setStoredActiveRunId,
  stopBackgroundRun,
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
      files: await handle.listFiles().catch(() => []),
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
          detail: { tab: 'file-tree', open: true },
        })
      )
    }
  }, [activeDock, setDock, setIsRightOpen])

  const {
    state,
    setState,
    setMode,
    handle,
    approvalContext,
    run,
    stop,
    onDecision,
    queueMessage,
    needsConsent,
    allowConsent,
  } = useAgentRun({
    tools: TOOLS,
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
  // Read by sendPrompt, which is memoised and would otherwise see the
  // transcript as it was when the callback was last built.
  const liveTranscriptRef = useRef(state.transcript)
  liveTranscriptRef.current = state.transcript
  // Ids this session handed to a live run. A `pending` entry restored from
  // storage is not in here, so reopening the project never resends an old
  // message — only one this tab queued and watched fail can be revived.
  const queuedIdsRef = useRef<Set<string>>(new Set())
  const runStartedAtRef = useRef<number | null>(runStartedAt)
  runStartedAtRef.current = runStartedAt
  const activeWordRef = useRef<string | null>(null)
  const handleWordChange = useCallback((word: string) => {
    activeWordRef.current = word
  }, [])

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

  const { onScroll: onTranscriptScroll, isAtBottom, scrollToBottom } =
    useStickToBottom(transcriptRef)

  const promptHistory = useMemo(
    () =>
      state.transcript
        .filter(entry => entry.role === 'user' && Boolean(entry.text?.trim()))
        .map(entry => entry.text.trim()),
    [state.transcript]
  )

  useEffect(() => {
    saveConversation(projectId, state.transcript)
  }, [projectId, state.transcript])

  // Mirror the conversation to a JSON file on the server once a run settles.
  // The ref skips re-saving a chat that was just opened from history, which
  // would otherwise bump its timestamp without any change.
  const [chatId, setChatId] = useState(() => getActiveChatId(projectId))
  const lastSavedTranscriptRef = useRef(state.transcript)
  useEffect(() => {
    if (state.running || state.transcript.length === 0) return
    if (lastSavedTranscriptRef.current === state.transcript) return
    const transcript = state.transcript
    const timer = window.setTimeout(() => {
      lastSavedTranscriptRef.current = transcript
      saveChat(projectId, chatId, transcript, state.mode).catch(() => {})
    }, 800)
    return () => window.clearTimeout(timer)
  }, [projectId, chatId, state.running, state.transcript, state.mode])

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
      // Instantly show user entry in transcript so chat feels immediate and never hangs/freezes
      const initialAttachments: Attachment[] = [
        ...attachmentRefs.map(r => ({ path: r.path, text: null })),
        ...(selectionRef
          ? [
              {
                path: selectionRef.path,
                from: selectionRef.from,
                to: selectionRef.to,
                text: selectionRef.text,
              },
            ]
          : []),
      ]
      // A send while a run is going does not start a second run: it is handed
      // to the one already in flight, which reads it the next time it is
      // between provider requests.
      const queueing = state.running
      // The live transcript, not the one this callback closed over: two sends
      // in quick succession must not compute the same id or delta-encode the
      // envelope against the wrong previous turn.
      const baseTranscript = liveTranscriptRef.current
      const entryId = queueing
        ? `q${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        : `u${baseTranscript.length}`
      const optimisticEntry: TranscriptEntry = {
        id: entryId,
        role: 'user',
        text,
        attachments: initialAttachments,
        ...(queueing ? { pending: true } : {}),
      }

      setState(current => ({
        ...current,
        transcript: [...current.transcript, optimisticEntry],
        running: true,
        stoppedByUser: false,
        error: null,
      }))

      try {
        let attachmentsResolved: Attachment[] = []
        try {
          attachmentsResolved = await resolveAttachments(
            attachmentRefs,
            handle
          )
        } catch {
          // Never fail prompt send if attachment resolution fails
          attachmentsResolved = attachmentRefs.map(r => ({ path: r.path, text: null }))
        }
        const built = await buildUserEntry({
          handle,
          transcript: baseTranscript,
          text,
          attachments: attachmentsResolved,
          attachedSelection: selectionRef,
          extraContext,
        })
        const userEntry: TranscriptEntry = { ...built, id: entryId }

        if (queueing && (await queueMessage(userEntry))) {
          // The run took it. Its `userMessage` event clears `pending` once it
          // has actually been read.
          queuedIdsRef.current.add(entryId)
          return
        }

        // Either nothing was running, or the run ended while we were building
        // the envelope. Send it as a new run, replacing the optimistic entry.
        const next: TranscriptEntry[] = [...baseTranscript, userEntry]
        void run(next)
      } catch (err: any) {
        setState(current => ({
          ...current,
          running: false,
          error: {
            code: 'runFailed',
            message: err?.message || 'Failed to prepare prompt',
          },
        }))
      }
    },
    [handle, state.running, run, queueMessage, setState]
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

  /**
   * Rescues a queued message the run never read.
   *
   * The endpoint refuses a run that has already finished, but a message can
   * still arrive in the gap between the loop's last check of its queue and the
   * run being marked done. Those entries are still `pending` when the run ends,
   * and are resent here as a run of their own rather than silently lost.
   */
  useEffect(() => {
    if (state.running || state.stoppedByUser) return
    const transcript = liveTranscriptRef.current
    const lost = (entry: TranscriptEntry) =>
      entry.role === 'user' && entry.pending && queuedIdsRef.current.has(entry.id)
    if (!transcript.some(lost)) return
    const revived = transcript.map(entry => {
      if (!lost(entry)) return entry
      queuedIdsRef.current.delete(entry.id)
      const { pending: _pending, ...rest } = entry as Extract<
        TranscriptEntry,
        { role: 'user' }
      >
      return rest
    })
    setState(current => ({ ...current, transcript: revived }))
    void run(revived)
  }, [state.running, state.stoppedByUser, run, setState])

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
    // Stop first: the EventSource is still live, so clearing the transcript
    // without cancelling would let the old run's events reduce into the new
    // empty conversation and get saved over it.
    // Unawaited: stop's setState runs before its first await, so React 18 batches
    // both updates and emptyAgentState wins. If an await is ever moved before
    // setState in stop(), onNewChat must be revisited.
    void stop()
    clearConversation(projectId)
    const id = newChatId()
    setActiveChatId(projectId, id)
    setChatId(id)
    // The mode is the user's standing choice about how much they want to be
    // asked, not a property of the conversation. Resetting it here is how
    // Accept edits quietly became Manual again on every new chat.
    setState(current => emptyAgentState([], current.mode))
    setNewChatSeed(s => s + 1)
    setCompletedRun(null)
    setRunStartedAt(null)
  }, [projectId, setState, stop])

  const onOpenChat = useCallback(
    async (id: string) => {
      if (id === chatId) return
      const chat = await fetchChat(projectId, id).catch(() => null)
      if (!chat) return
      // Same ordering as onNewChat: cancel the live run before swapping in
      // the stored transcript so its events cannot land in the opened chat.
      void stop()
      lastSavedTranscriptRef.current = chat.transcript
      saveConversation(projectId, chat.transcript)
      setActiveChatId(projectId, id)
      setChatId(id)
      setState(emptyAgentState(chat.transcript, chat.mode || 'manual'))
      setCompletedRun(null)
      setRunStartedAt(null)
    },
    [chatId, projectId, setState, stop]
  )

  const onDeleteChat = useCallback(
    async (id: string) => {
      await deleteChat(projectId, id)
      if (id === chatId) onNewChat()
    },
    [chatId, onNewChat, projectId]
  )

  return (
    <div className="ai-assist-panel">
      <AgentPanelHeader
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
            <ChatHistoryMenu
              projectId={projectId}
              activeChatId={chatId}
              onOpen={id => void onOpenChat(id)}
              onDelete={onDeleteChat}
            />
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

      <div className="ai-assist-transcript-wrapper">
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
            onWordChange={handleWordChange}
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
                          : state.error.code === 'runFailed'
                            ? 'Failed to Start Run'
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

      </div>

      {!isAtBottom && (
        <button
          type="button"
          className="ai-assist-scroll-bottom-btn"
          onClick={() => scrollToBottom({ smooth: true })}
          aria-label={t('ai_assist_scroll_to_bottom', 'Jump to latest')}
          title={t('ai_assist_scroll_to_bottom', 'Jump to latest')}
        >
          <ArrowDown size={16} weight="bold" />
        </button>
      )}
    </div>

    <AgentComposer
      running={state.running}
      mode={state.mode}
      onModeChange={setMode}
      paths={files.map(file => file.path)}
      onSend={onSend}
      onStop={stop}
      attachments={attachments}
      setAttachments={setAttachments}
      attachedSelection={attachedSelection}
      setAttachedSelection={setAttachedSelection}
      history={promptHistory}
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
    const activeRunId = getStoredActiveRunId(projectId)
    if (activeRunId) {
      void stopBackgroundRun(activeRunId).catch(() => {})
    }
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
