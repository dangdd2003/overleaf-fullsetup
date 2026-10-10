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
import { AgentMode, MODE_LABELS } from '../../agent/agent-mode'
import { ProjectFile, ProjectHandle } from '../../agent/project-handle'
import { TOOLS } from '../../agent/tools/registry'
import {
  formatToday,
  renderEnvelope,
} from '../../agent/context/project-context'
import {
  Attachment,
  AttachmentRef,
  ContextSnapshot,
} from '../../agent/context/types'
import { resolveAttachments } from '../../agent/context/attachments'
import {
  clearConversation,
  loadConversation,
  mergeStoredTranscript,
  saveConversation,
} from '../../agent/conversation-store'
import {
  ChatSummary,
  deleteChat,
  fetchChat,
  getActiveChatId,
  getStoredChatMode,
  newChatId,
  renameChat,
  saveChat,
  setActiveChatId,
  setStoredChatMode,
} from '../../agent/chat-history-client'
import { ChatHistoryMenu } from './chat-history-menu'
import { AgentMessageView } from './agent-message'
import { collectWebSources, WebSources } from '../../agent/web-sources'
import { AgentEmptyState, PickedStarter } from './agent-empty-state'
import {
  AgentComposer,
  AttachedSelection,
  isSameSelection,
} from './agent-composer'
import { AgentStatusLine } from './agent-status-line'
import { takePendingHandoff } from '../../agent/chat-handoff'
import { setChatBusy } from '../../agent/chat-activity'
import { useStickToBottom } from '../../hooks/use-stick-to-bottom'
import { useAgentRun } from '../../hooks/use-agent-run'
import {
  AgentState,
  countTrailingPendingUserEntries,
  emptyAgentState,
} from '../../agent/agent-state'
import withErrorBoundary from '@/infrastructure/error-boundary'
import type { FallbackProps } from 'react-error-boundary'
import {
  getDetachedRuns,
  getStoredActiveRunId,
  getStoredActiveRunStartedAt,
  setDetachedRun,
  setStoredActiveRunId,
  stopBackgroundRun,
  takeDetachedRun,
} from '../../agent/background/background-run-client'
import {
  followDetachedRun,
  stopFollowingRun,
  takeFollowedRun,
} from '../../agent/background/detached-run-follower'
import { useAiDock, DockPosition } from '../../hooks/use-ai-dock'
import { useEditorThemeStyles } from '../../hooks/use-editor-theme-styles'
import { StreamCatchUpContext } from '../../hooks/use-stream-reveal'

export async function buildUserEntry({
  handle,
  transcript,
  text,
  attachments = [],
  attachedSelection,
  extraContext,
  mode,
}: {
  handle: ProjectHandle
  transcript: TranscriptEntry[]
  text: string
  attachments?: Attachment[]
  attachedSelection?: {
    path: string
    from: number
    to: number
    text: string
  } | null
  /**
   * Context handed over from another panel, appended after the envelope.
   * Kept separate from `attachments` because it is not something the user
   * pinned — the transcript must not render a chip for it.
   */
  extraContext?: string
  /** The composer's mode, frozen into the envelope. */
  mode?: AgentMode
}): Promise<TranscriptEntry> {
  const id = `u${transcript.length}`
  const previousUser = [...transcript]
    .reverse()
    .find(entry => entry.role === 'user') as
    | Extract<TranscriptEntry, { role: 'user' }>
    | undefined
  const turn = (previousUser?.envelopeState?.turn ?? 0) + 1

  const activeSel =
    attachedSelection !== undefined
      ? attachedSelection
      : handle.currentSelection()

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
      today: formatToday(),
      ...(mode ? { mode: MODE_LABELS[mode] } : {}),
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
  const { editorVars } = useEditorThemeStyles()
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

  const [chatId, setChatId] = useState(() => getActiveChatId(projectId))
  const chatIdRef = useRef(chatId)
  chatIdRef.current = chatId
  // Chats started in this panel and not yet sent anything: the server has
  // no copy of them to fetch
  const unsavedChatIdsRef = useRef<Set<string>>(new Set())
  // Read from storage once, on mount: the hook only uses it to seed its state
  const [initialTranscript] = useState(() =>
    loadConversation(projectId, chatId)
  )
  const [chatTitle, setChatTitle] = useState<string>('')
  const initialMode = useMemo(
    () => getStoredChatMode(projectId, chatId) || 'manual',
    [projectId, chatId]
  )

  const {
    state,
    setState,
    setMode,
    chatTitle: eventChatTitle,
    isTitleGenerated,
    handle,
    approvalContext,
    run,
    runDetached,
    catchingUp,
    stop,
    detach,
    attach,
    onDecision,
    queueMessage,
    unqueueMessage,
    whenRunEnded,
    needsConsent,
    allowConsent,
  } = useAgentRun({
    tools: TOOLS,
    cacheKey: projectId,
    initialTranscript,
    initialMode,
    chatId,
  })

  useEffect(() => {
    if (!chatId || unsavedChatIdsRef.current.has(chatId)) return
    let active = true
    fetchChat(projectId, chatId)
      .then(chat => {
        if (!active || !chat) return
        if (
          chat.title &&
          chat.title !== 'New chat' &&
          chat.title !== 'Untitled chat'
        ) {
          setChatTitle(chat.title)
        }
        if (chat.mode) {
          setMode(chat.mode)
          setStoredChatMode(projectId, chatId, chat.mode)
        }
        if (Array.isArray(chat.transcript) && chat.transcript.length > 0) {
          setState(curr => {
            // Lined up by id with what is shown. While a run is followed it
            // writes the reply, so the server's copy only puts back the top
            // turns this browser dropped: never the reply again, nor the
            // question it answers a second time.
            const merged = mergeStoredTranscript(
              curr.transcript,
              chat.transcript,
              { live: curr.running }
            )
            if (merged === curr.transcript) return curr
            lastSavedRef.current = {
              transcript: merged,
              mode: chat.mode || curr.mode,
            }
            saveConversation(projectId, chatId, merged)
            return {
              ...curr,
              transcript: merged,
              chatTitle: chat.title || curr.chatTitle,
            }
          })
        }
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [projectId, chatId, setMode, setState])

  // Whether the next title change sweeps in over the old one: a freshly
  // generated title, or the title of a chat opened from history
  const [animateTitle, setAnimateTitle] = useState(false)

  useEffect(() => {
    if (eventChatTitle) {
      setChatTitle(eventChatTitle)
      setAnimateTitle(Boolean(isTitleGenerated))
    }
  }, [eventChatTitle, isTitleGenerated])

  const [files, setFiles] = useState<ProjectFile[]>([])
  // Stamped when a run begins so the status line can count from it;
  // persists across page reloads via getStoredActiveRunStartedAt.
  const [runStartedAt, setRunStartedAt] = useState<number | null>(() => {
    return getStoredActiveRunStartedAt(projectId)
  })
  // The line under a finished reply, saying how long it took: stamped on the
  // reply when its run ended, whether on screen or off it, so it is there
  // whenever the chat is opened again
  const completedRun = useMemo(() => {
    const last = state.transcript.at(-1)
    return last?.role === 'assistant' && last.durationMs
      ? { durationMs: last.durationMs, word: last.statusWord }
      : null
  }, [state.transcript])

  const prevRunningRef = useRef(state.running)
  // Read by sendPrompt, which is memoised and would otherwise see the
  // transcript as it was when the callback was last built.
  const liveTranscriptRef = useRef(state.transcript)
  liveTranscriptRef.current = state.transcript
  // All the panel holds for the chat, handed on with its run when it is left
  const stateRef = useRef(state)
  stateRef.current = state
  // Ids this session handed to a live run. A `pending` entry restored from
  // storage is not in here, so reopening the project never resends an old
  // message — only one this tab queued and watched fail can be revived.
  const queuedIdsRef = useRef<Set<string>>(new Set())
  // Sends go out one at a time, in the order they were typed. Each is built
  // against the turn before it (its envelope is a delta on that one) and
  // reaches the run in that order, so the transcript stores what the run is
  // sent, in the order it is sent, and the next run's rebuilt prefix reads the
  // provider's cache instead of missing it.
  const sendChainRef = useRef<Promise<void>>(Promise.resolve())
  // Tasks in that line. A message typed behind any of them is queued, and
  // goes to whichever run is live when its turn comes.
  const sendsInFlightRef = useRef(0)
  // Queued sends not yet handed to a run, and those taken back before they were
  const waitingIdsRef = useRef<Set<string>>(new Set())
  const takenBackIdsRef = useRef<Set<string>>(new Set())
  // Moves on with the chat; a send still on its way leaves the new chat alone
  const chatEpochRef = useRef(0)
  // The chat each epoch was spent in, as it was left: a send still on its way
  // when its chat was left goes to that chat, not to the one now shown
  const leftChatsRef = useRef(
    new Map<
      number,
      { chatId: string; transcript: TranscriptEntry[]; mode: AgentMode }
    >()
  )
  const runningRef = useRef(state.running)
  runningRef.current = state.running
  const runStartedAtRef = useRef<number | null>(runStartedAt)
  runStartedAtRef.current = runStartedAt
  // Time the run spent waiting on the user, left out of its duration
  const waitedMsRef = useRef(0)
  const waitStartRef = useRef<number | null>(null)
  const awaitingUser = Boolean(state.pendingApproval)
  useEffect(() => {
    if (awaitingUser) {
      waitStartRef.current ??= Date.now()
    } else if (waitStartRef.current !== null) {
      waitedMsRef.current += Date.now() - waitStartRef.current
      waitStartRef.current = null
    }
  }, [awaitingUser])
  const activeWordRef = useRef<string | null>(null)
  const handleWordChange = useCallback((word: string) => {
    activeWordRef.current = word
  }, [])

  useEffect(() => {
    if (state.running) {
      if (runStartedAtRef.current === null) waitedMsRef.current = 0
      setRunStartedAt(current => current ?? Date.now())
    } else if (prevRunningRef.current && !state.running) {
      if (
        !state.stoppedByUser &&
        !state.error &&
        !state.pendingApproval &&
        runStartedAtRef.current
      ) {
        const duration = Math.max(
          1000,
          Date.now() - runStartedAtRef.current - waitedMsRef.current
        )
        const word = activeWordRef.current || undefined
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
  }, [
    state.running,
    state.stoppedByUser,
    state.error,
    state.pendingApproval,
    setState,
  ])
  const transcriptRef = useRef<HTMLDivElement>(null)

  const {
    onScroll: onTranscriptScroll,
    isAtBottom,
    scrollToBottom,
  } = useStickToBottom(transcriptRef)

  // The entry the run is streaming into: the last one, or the one above the
  // messages still queued after it
  const liveEntryIndex = state.running
    ? state.transcript.length -
      1 -
      countTrailingPendingUserEntries(state.transcript)
    : -1

  const promptHistory = useMemo(
    () =>
      state.transcript
        .filter(entry => entry.role === 'user' && Boolean(entry.text?.trim()))
        .map(entry => entry.text.trim()),
    [state.transcript]
  )

  // The transcript changes on every streamed token; the sources rarely do.
  // Keeping the same Map until they change stops every message re-rendering
  // its Markdown for each token.
  const webSourcesRef = useRef<WebSources>(new Map())
  const webSources = useMemo(() => {
    const next = collectWebSources(state.transcript)
    const prev = webSourcesRef.current
    const unchanged =
      next.size === prev.size &&
      [...next].every(
        ([n, source]) =>
          prev.get(n)?.url === source.url && prev.get(n)?.title === source.title
      )
    if (!unchanged) webSourcesRef.current = next
    return webSourcesRef.current
  }, [state.transcript])

  useEffect(() => {
    saveConversation(projectId, chatId, state.transcript)
  }, [projectId, chatId, state.transcript])

  // Mirror the conversation to a JSON file on the server once a run settles or mode changes.
  // The ref skips re-saving a chat that was just opened from history, which
  // would otherwise bump its timestamp without any change.
  const lastSavedRef = useRef({
    transcript: state.transcript,
    mode: state.mode,
  })
  useEffect(() => {
    if (state.running || state.transcript.length === 0) return
    if (
      lastSavedRef.current.transcript === state.transcript &&
      lastSavedRef.current.mode === state.mode
    ) {
      return
    }
    const transcript = state.transcript
    const mode = state.mode
    const timer = window.setTimeout(() => {
      lastSavedRef.current = { transcript, mode }
      saveChat(
        projectId,
        chatId,
        transcript,
        mode,
        chatTitle || undefined
      ).catch(() => {})
    }, 800)
    return () => window.clearTimeout(timer)
  }, [
    projectId,
    chatId,
    state.running,
    state.transcript,
    state.mode,
    chatTitle,
  ])

  useEffect(() => {
    setStoredChatMode(projectId, chatId, state.mode)
  }, [projectId, chatId, state.mode])

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
  const dismissedSelectionRef = useRef<AttachedSelection | null>(null)

  const handleSetAttachedSelection = useCallback(
    (action: React.SetStateAction<AttachedSelection | null>) => {
      setAttachedSelection(prev => {
        const next = typeof action === 'function' ? action(prev) : action
        if (next === null) {
          if (prev !== null) {
            dismissedSelectionRef.current = prev
          }
        } else {
          dismissedSelectionRef.current = null
        }
        return next
      })
    },
    []
  )

  useEventListener('aiAssist:selectionChanged', (event: Event) => {
    const detail = (event as CustomEvent<AttachedSelection | null>).detail
    if (detail && detail.text) {
      if (
        dismissedSelectionRef.current &&
        isSameSelection(detail, dismissedSelectionRef.current)
      ) {
        return
      }
      dismissedSelectionRef.current = null
      setAttachedSelection(detail)
    } else {
      dismissedSelectionRef.current = null
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

  const enqueueSend = useCallback((task: () => Promise<void>) => {
    // Each chat has a line of its own, started afresh when the chat is left:
    // a send still on its way in the chat left never holds up, or queues, the
    // first message of the next one
    const epoch = chatEpochRef.current
    sendsInFlightRef.current += 1
    const next = sendChainRef.current
      .then(task)
      .catch(() => {})
      .finally(() => {
        if (chatEpochRef.current === epoch) sendsInFlightRef.current -= 1
      })
    sendChainRef.current = next
    return next
  }, [])

  // Applied to the ref at once as well, so the next send in the line builds
  // against it before React has rendered it
  const updateTranscript = useCallback(
    (update: (transcript: TranscriptEntry[]) => TranscriptEntry[]) => {
      liveTranscriptRef.current = update(liveTranscriptRef.current)
      setState(current => ({
        ...current,
        transcript: update(current.transcript),
      }))
    },
    [setState]
  )

  /**
   * Starts a run on the transcript together with the messages no run has
   * read: `ids`, and any a run took but ended without reading. Sends still
   * waiting their turn stay queued behind it. A `pending` entry that is
   * neither was left by an earlier session and is dropped, as before.
   */
  const startRunWith = useCallback(
    async (ids: string[] = []) => {
      const epoch = chatEpochRef.current
      // A run still stopping is followed to its end first: the transcript
      // read below is what the new run is rebuilt from, and has to hold
      // everything the stopped run sent the provider
      await whenRunEnded()
      // The chat was left meanwhile: what it holds was saved as it was left
      if (chatEpochRef.current !== epoch) return
      const include = new Set([...ids, ...queuedIdsRef.current])
      queuedIdsRef.current.clear()
      const next = liveTranscriptRef.current.flatMap(entry => {
        if (entry.role !== 'user' || !entry.pending) return [entry]
        if (include.has(entry.id)) {
          const { pending: _pending, ...unqueued } = entry
          return [unqueued]
        }
        return waitingIdsRef.current.has(entry.id) ? [entry] : []
      })
      await run(next)
    },
    [run, whenRunEnded]
  )

  // Builds the user entry from scratch and sends it. Shared by `onSend` and
  // the compile-log handoff, so every prompt takes the same path.
  const sendPrompt = useCallback(
    ({
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
      // While a run is going, or sends ahead of this one are still on their
      // way, this does not start a second run. It is shown as queued and handed
      // to the run in flight, which reads it as soon as its current tool calls
      // finish, or once its reply ends, as Claude Code does.
      const queueing = state.running || sendsInFlightRef.current > 0
      const entryId = queueing
        ? `q${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        : `u${liveTranscriptRef.current.length}`
      const optimisticEntry: TranscriptEntry = {
        id: entryId,
        role: 'user',
        text,
        attachments: initialAttachments,
        ...(queueing ? { pending: true } : {}),
      }
      const epoch = chatEpochRef.current
      const takenBack = () => takenBackIdsRef.current.has(entryId)
      const chatLeft = () => chatEpochRef.current !== epoch
      const abandoned = () => takenBack() || chatLeft()
      if (queueing) waitingIdsRef.current.add(entryId)

      updateTranscript(transcript => [...transcript, optimisticEntry])
      setState(current => ({
        ...current,
        running: true,
        stoppedByUser: false,
        error: null,
      }))
      // Sending from anywhere in the history jumps to the latest point and
      // follows the reply, as the ↓ button does. Instant rather than smooth: a
      // smooth scroll's own scroll events would switch following back off
      // before it reached the new message.
      scrollToBottom({ smooth: false })

      return enqueueSend(async () => {
        try {
          if (takenBack()) return
          // A message queued behind a run of a chat since left stays saved in
          // that chat; only one that would have started a run still goes
          if (chatLeft() && (queueing || !leftChatsRef.current.has(epoch))) {
            return
          }
          let attachmentsResolved: Attachment[] = []
          try {
            attachmentsResolved = await resolveAttachments(
              attachmentRefs,
              handle
            )
          } catch {
            // Never fail prompt send if attachment resolution fails
            attachmentsResolved = attachmentRefs.map(r => ({
              path: r.path,
              text: null,
            }))
          }
          // Against the turns before it, the queued ones included, so the
          // envelope is a delta on the one sent just before
          const live = chatLeft()
            ? (leftChatsRef.current.get(epoch)?.transcript ?? [])
            : liveTranscriptRef.current
          const position = live.findIndex(entry => entry.id === entryId)
          const built = await buildUserEntry({
            handle,
            transcript: position === -1 ? live : live.slice(0, position),
            text,
            attachments: attachmentsResolved,
            attachedSelection: selectionRef,
            extraContext,
            mode: state.mode,
          })
          if (takenBack()) return
          const userEntry: TranscriptEntry = { ...built, id: entryId }
          if (chatLeft()) {
            // Its chat was left while the message was being prepared. It is
            // sent all the same, to a run of that chat's own going on in
            // parallel with the chat now on screen.
            const left = leftChatsRef.current.get(epoch)
            if (queueing || !left) return
            const transcript = left.transcript.map(entry =>
              entry.id === entryId ? userEntry : entry
            )
            saveConversation(projectId, left.chatId, transcript)
            await runDetached(left.chatId, transcript, left.mode)
            return
          }
          // The transcript keeps what the run is sent, envelope and all, so a
          // later run rebuilds the same bytes
          updateTranscript(transcript =>
            transcript.map(entry =>
              entry.id === entryId
                ? {
                    ...userEntry,
                    ...(entry.role === 'user' && entry.pending
                      ? { pending: true }
                      : {}),
                  }
                : entry
            )
          )

          if (queueing) {
            if (await queueMessage(userEntry)) {
              // Taken back while it was on its way: ask the run for it back
              if (takenBackIdsRef.current.has(entryId)) {
                void unqueueMessage(entryId)
              } else if (chatEpochRef.current === epoch) {
                // The run's `userMessage` event clears `pending` once it has
                // actually read it
                queuedIdsRef.current.add(entryId)
              }
              return
            }
            // No run took it: the one going was finishing. Let its last
            // events land, so its reply is whole before the next run starts.
            await whenRunEnded()
            if (abandoned()) return
          }
          await startRunWith([entryId])
        } catch (err: any) {
          if (chatEpochRef.current !== epoch) return
          setState(current => ({
            ...current,
            running: false,
            error: {
              code: 'runFailed',
              message: err?.message || 'Failed to prepare prompt',
            },
          }))
        } finally {
          waitingIdsRef.current.delete(entryId)
          takenBackIdsRef.current.delete(entryId)
        }
      })
    },
    [
      handle,
      state.running,
      state.mode,
      enqueueSend,
      updateTranscript,
      queueMessage,
      unqueueMessage,
      whenRunEnded,
      startRunWith,
      setState,
      scrollToBottom,
      projectId,
      runDetached,
    ]
  )

  const onSend = useCallback(
    (
      text: string,
      attachmentRefs?: AttachmentRef[],
      selection?: AttachedSelection | null
    ) => {
      const assistant = AiAssistant.fromStoredSettings()
      if (!assistant) {
        return
      }

      // If attachments/selection not explicitly provided (e.g. clicked from a suggestion),
      // bundle the user's @mention files and highlighted text together!
      const finalAttachments =
        attachmentRefs !== undefined ? attachmentRefs : attachments
      const finalSelection =
        selection !== undefined
          ? selection
          : attachedSelection

      void sendPrompt({
        text,
        attachments: finalAttachments,
        attachedSelection: finalSelection,
      })

      // Clear composer attachments and selection after sending
      setAttachments([])
      setAttachedSelection(null)
    },
    [attachments, attachedSelection, handle, sendPrompt]
  )

  /**
   * Sends on the messages a run took but ended without reading: it was
   * stopped, it failed, or a message slipped past a run on another server
   * instance as it finished. As in Claude Code, stopping a run sends what was
   * queued next. Through the send line, so it cannot race a send on its way.
   */
  useEffect(() => {
    if (state.running) return
    const unread = () =>
      liveTranscriptRef.current.some(
        entry =>
          entry.role === 'user' &&
          entry.pending &&
          queuedIdsRef.current.has(entry.id)
      )
    if (!unread()) return
    void enqueueSend(async () => {
      // A send ahead of this one may have started a run that took them
      if (runningRef.current || !unread()) return
      await startRunWith()
    })
  }, [state.running, enqueueSend, startRunWith])

  // A queued message taken back lands in the composer to be edited
  const [restoredDraft, setRestoredDraft] = useState<{ text: string } | null>(
    null
  )

  /**
   * Takes a queued message back into the composer, as Claude Code does, as
   * long as no run has read it. One not yet handed to a run just leaves the
   * line; one a run holds is asked back from that run first.
   */
  const takeBack = useCallback(
    (entryId: string) => {
      const queued = () => {
        const entry = liveTranscriptRef.current.find(e => e.id === entryId)
        return entry?.role === 'user' && entry.pending ? entry : null
      }
      const restore = (text: string) => {
        updateTranscript(transcript =>
          transcript.filter(entry => entry.id !== entryId)
        )
        setRestoredDraft({ text })
      }

      const entry = queued()
      if (!entry) return
      if (!queuedIdsRef.current.has(entryId)) {
        if (waitingIdsRef.current.has(entryId)) {
          takenBackIdsRef.current.add(entryId)
        }
        restore(entry.text)
        return
      }
      void enqueueSend(async () => {
        if (!queued() || !(await unqueueMessage(entryId))) return
        // A run that ended may still have read it just before
        const unread = queued()
        if (!unread) return
        queuedIdsRef.current.delete(entryId)
        restore(unread.text)
      })
    },
    [enqueueSend, unqueueMessage, updateTranscript]
  )

  // The blocked run already committed its transcript, user entry included, so
  // resume it as-is; sending the prompt again would duplicate the message.
  const onAllowConsent = useCallback(() => {
    allowConsent()
    void run(liveTranscriptRef.current)
  }, [allowConsent, run])

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
  const [hasProvider, setHasProvider] = useState(() =>
    Boolean(AiAssistant.fromStoredSettings())
  )

  useEffect(() => {
    const updateProviderStatus = () => {
      setHasProvider(Boolean(AiAssistant.fromStoredSettings()))
    }
    window.addEventListener('storage', updateProviderStatus)
    window.addEventListener('focus', updateProviderStatus)
    window.addEventListener('aiAssist:providerChanged', updateProviderStatus)
    return () => {
      window.removeEventListener('storage', updateProviderStatus)
      window.removeEventListener('focus', updateProviderStatus)
      window.removeEventListener(
        'aiAssist:providerChanged',
        updateProviderStatus
      )
    }
  }, [])

  const onPickStarter = useCallback(
    (picked: PickedStarter | string) => {
      const text = typeof picked === 'string' ? picked : picked.prompt
      void onSend(text)
    },
    [onSend]
  )

  const handleModeChange = useCallback(
    (newMode: AgentMode) => {
      setMode(newMode)
      setStoredChatMode(projectId, chatId, newMode)
      if (state.transcript.length > 0) {
        saveChat(
          projectId,
          chatId,
          state.transcript,
          newMode,
          chatTitle || undefined
        ).catch(() => {})
      }
    },
    [chatId, chatTitle, projectId, setMode, state.transcript]
  )

  /**
   * Leaving a chat does not stop its run. The panel stops following it, so its
   * events cannot land in the next chat, and the chat is saved as it stands —
   * with or without a run, so a message whose reply has not come yet is never
   * lost. Its run goes on in parallel, followed off screen from where the
   * panel was until its reply is saved; reopening the chat picks it up there.
   *
   * `save: false` is for a chat being deleted, which must not be written back
   * and whose run has nowhere to go: it is stopped.
   */
  const leaveChat = useCallback(
    ({ save = true }: { save?: boolean } = {}) => {
      // Sends still on their way belong to the chat being left
      const epoch = chatEpochRef.current
      chatEpochRef.current += 1
      queuedIdsRef.current.clear()
      sendChainRef.current = Promise.resolve()
      sendsInFlightRef.current = 0
      const now = Date.now()
      // Moved forward by the time spent waiting on the user, which the clock
      // leaves out when the chat is reopened
      const waited =
        waitedMsRef.current +
        (waitStartRef.current !== null ? now - waitStartRef.current : 0)
      waitedMsRef.current = 0
      waitStartRef.current = null
      const live = detach()
      if (!save) {
        if (live) void stopBackgroundRun(live.runId).catch(() => {})
        return
      }

      const transcript = liveTranscriptRef.current
      const mode = state.mode
      leftChatsRef.current.set(epoch, { chatId, transcript, mode })
      // Only a send prepared in the last moments of a chat looks it up
      for (const old of leftChatsRef.current.keys()) {
        if (old < epoch - 4) leftChatsRef.current.delete(old)
      }
      if (transcript.length > 0) {
        unsavedChatIdsRef.current.delete(chatId)
        saveConversation(projectId, chatId, transcript)
        // Skipped for a chat opened and left untouched, which would only move
        // up the history for having been looked at
        if (
          lastSavedRef.current.transcript !== transcript ||
          lastSavedRef.current.mode !== mode
        ) {
          lastSavedRef.current = { transcript, mode }
          saveChat(
            projectId,
            chatId,
            transcript,
            mode,
            chatTitle || undefined
          ).catch(() => {})
        }
      }
      if (live) {
        const startedAt = (runStartedAtRef.current ?? now) + waited
        setDetachedRun(projectId, chatId, { runId: live.runId, startedAt })
        followDetachedRun({
          projectId,
          chatId,
          runId: live.runId,
          startedAt,
          transcript,
          mode,
          state: { ...stateRef.current, transcript },
          since: live.seq,
        })
      }
    },
    [chatId, chatTitle, detach, projectId, state.mode]
  )

  /** Shows a chat: a new one, or one opened from the history. */
  const showChat = useCallback(
    (
      id: string,
      {
        transcript = [],
        mode = 'manual',
        title = '',
        state: shown,
      }: {
        transcript?: TranscriptEntry[]
        mode?: AgentMode
        title?: string
        /** What a run followed off screen holds for the chat. */
        state?: AgentState
      }
    ) => {
      lastSavedRef.current = { transcript, mode }
      setActiveChatId(projectId, id)
      setChatId(id)
      setChatTitle(title)
      setStoredChatMode(projectId, id, mode)
      setState(
        shown
          ? { ...shown, transcript, mode }
          : emptyAgentState(transcript, mode, title)
      )
      setRunStartedAt(null)
    },
    [projectId, setState]
  )

  const startNewChat = useCallback(() => {
    const id = newChatId()
    unsavedChatIdsRef.current.add(id)
    showChat(id, {})
    setAnimateTitle(false)
    setNewChatSeed(s => s + 1)
  }, [showChat])

  const onNewChat = useCallback(() => {
    leaveChat()
    startNewChat()
  }, [leaveChat, startNewChat])

  /**
   * Switches at once. A chat whose run is followed off screen is shown as
   * that run has got it and followed on from there; any other from this
   * browser's copy, while the server's copy is fetched by the effect on
   * `chatId`, in parallel with the save of the chat being left.
   */
  const onOpenChat = useCallback(
    (id: string, summary?: ChatSummary) => {
      if (id === chatId) return
      leaveChat()
      const title =
        summary?.title &&
        summary.title !== 'New chat' &&
        summary.title !== 'Untitled chat'
          ? summary.title
          : ''
      const followed = takeFollowedRun(projectId, id)
      // A run left going when this chat was last open carries on from here
      const detached = takeDetachedRun(projectId, id)
      if (followed) {
        showChat(id, {
          transcript: followed.state.transcript,
          mode: followed.state.mode,
          title: followed.state.chatTitle || title,
          state: followed.state,
        })
      } else {
        showChat(id, {
          transcript: loadConversation(projectId, id),
          mode: getStoredChatMode(projectId, id) || 'manual',
          title,
        })
      }
      setAnimateTitle(true)
      const run = followed ?? detached
      if (run) {
        setRunStartedAt(run.startedAt)
        attach(run.runId, {
          startedAt: run.startedAt,
          since: followed?.seq ?? 0,
          chatId: id,
        })
      }
    },
    [attach, chatId, leaveChat, projectId, showChat]
  )

  const onRenameChat = useCallback(
    async (id: string, newTitle: string) => {
      const clean = newTitle.trim()
      if (!clean) return
      if (id === chatId) {
        setChatTitle(clean)
      }
      await renameChat(projectId, id, clean).catch(() => {})
    },
    [chatId, projectId]
  )

  // A deleted chat's run has nowhere to go, so it is stopped, and the chat
  // is not saved on the way out, which would write it back
  const onDeleteChat = useCallback(
    async (id: string) => {
      if (id === chatId) {
        leaveChat({ save: false })
        startNewChat()
      } else {
        stopFollowingRun(projectId, id)
        const detached = takeDetachedRun(projectId, id)
        if (detached) void stopBackgroundRun(detached.runId).catch(() => {})
      }
      clearConversation(projectId, id)
      await deleteChat(projectId, id)
    },
    [chatId, leaveChat, projectId, startNewChat]
  )

  // Runs of other chats left going when the page was last open are followed
  // again, so their replies reach the history without opening each chat
  useEffect(() => {
    for (const [id, detached] of Object.entries(getDetachedRuns(projectId))) {
      if (id === chatIdRef.current) {
        // The open chat's own run, unless it was reconnected already
        if (!getStoredActiveRunId(projectId)) {
          takeDetachedRun(projectId, id)
          setRunStartedAt(detached.startedAt)
          attach(detached.runId, { startedAt: detached.startedAt, chatId: id })
        }
        continue
      }
      followDetachedRun({
        projectId,
        chatId: id,
        runId: detached.runId,
        startedAt: detached.startedAt,
        transcript: loadConversation(projectId, id),
        mode: getStoredChatMode(projectId, id) || 'manual',
      })
    }
    // Once, on mount: later runs are handed over as their chats are left
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  return (
    <div className="ai-assist-panel" style={editorVars}>
      <AgentPanelHeader
        title={chatTitle || t('ai_assist_panel_title', 'AI assistant')}
        isGeneratingTitle={animateTitle}
        onTitleAnimationEnd={() => setAnimateTitle(false)}
        onRenameTitle={newTitle => void onRenameChat(chatId, newTitle)}
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
              onOpen={onOpenChat}
              onDelete={onDeleteChat}
              onRename={onRenameChat}
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
                    transform:
                      activeDock !== 'right' ? 'scaleX(-1)' : undefined,
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
              disabled={!hasProvider}
            />
          ) : (
            // A chat opened mid-run shows what the run has written so far at
            // once, and animates only what it writes from there
            <StreamCatchUpContext.Provider value={catchingUp}>
              {state.transcript.map((entry, entryIndex) => (
                <AgentMessageView
                  key={entry.id}
                  entry={entry}
                  pendingApprovalId={state.pendingApproval?.id ?? null}
                  approvalContext={approvalContext}
                  onDecision={onDecision}
                  isRunning={state.running && entryIndex === liveEntryIndex}
                  webSources={webSources}
                  onTakeBack={takeBack}
                />
              ))}
            </StreamCatchUpContext.Provider>
          )}

          {/*
          Below the activity rows, never inside one: the rows report what the
          agent did, this reports that it is still going or completed.
        */}
          {runStartedAt !== null && state.running ? (
            <AgentStatusLine
              startedAt={runStartedAt}
              isRunning={true}
              isPaused={Boolean(state.pendingApproval)}
              onWordChange={handleWordChange}
              blocks={(() => {
                const live = state.transcript[liveEntryIndex]
                return live?.role === 'assistant' ? (live.blocks ?? []) : []
              })()}
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
              <span>
                {t('ai_assist_stopped_by_user', 'Generation stopped')}
              </span>
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
              <OLButton
                type="button"
                variant="primary"
                size="sm"
                onClick={onAllowConsent}
              >
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
                    <p className="ai-assist-error-message">
                      {state.error.message}
                    </p>
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
                      onClick={() => void enqueueSend(() => startRunWith())}
                    >
                      {t('try_again', 'Try again')}
                    </OLButton>
                    {(state.error.code === 'providerAuth' ||
                      state.error.code === 'modelsUnsupported') && (
                      <OLButton
                        href="/user/settings"
                        target="_blank"
                        rel="noopener noreferrer"
                        variant="secondary"
                        size="sm"
                      >
                        {t('ai_assist_account_settings', 'Account Settings')}
                      </OLButton>
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
        disabled={!hasProvider}
        mode={state.mode}
        onModeChange={handleModeChange}
        paths={files.map(file => file.path)}
        onSend={onSend}
        onStop={stop}
        attachments={attachments}
        setAttachments={setAttachments}
        attachedSelection={attachedSelection}
        setAttachedSelection={handleSetAttachedSelection}
        history={promptHistory}
        restoredDraft={restoredDraft}
      />
    </div>
  )
}

export const AgentPanelFallback: React.FC<FallbackProps> = ({
  // debug

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

export const AgentPanel = withErrorBoundary(AgentPanelInner, AgentPanelFallback)

export default AgentPanel
