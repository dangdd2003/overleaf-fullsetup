import { TranscriptEntry } from '../agent-messages'
import { AgentMode } from '../agent-mode'
import {
  AgentState,
  emptyAgentState,
  reduceAgentEvent,
  withoutLiveReply,
} from '../agent-state'
import { saveConversation } from '../conversation-store'
import { saveChat } from '../chat-history-client'
import { nextStatusWord } from '../../components/agent/status-words'
import { connectRunStream, setDetachedRun } from './background-run-client'
import { dispatchAiEditHighlight } from '../agent-events'

/**
 * Runs of chats the panel is not showing keep going on the server, in
 * parallel with the chat on screen. Each is followed here, off screen, into
 * a state of its own: its reply is saved to the chat's history when it lands,
 * and opening the chat again picks the run up from where it has got to.
 *
 * Browsers open six HTTP/1.1 connections per host and every follower holds
 * one, so only a few are followed at once. The rest wait their turn and are
 * followed as soon as a connection is free.
 */
export const MAX_FOLLOWED_RUNS = 3

// How often the progress of a run followed off screen is written to this
// browser's copy of its chat, which is what opening it shows if the run is
// not followed any more by then
const LOCAL_SAVE_MS = 1000

type Follower = {
  projectId: string
  chatId: string
  runId: string
  startedAt: number
  state: AgentState
  /** The last event of the run this state holds. */
  seq: number
  /** Followed from the run's first event: the reply as left is rebuilt. */
  replaying: boolean
  close: (() => void) | null
  saveTimer: ReturnType<typeof setTimeout> | null
}

/** What a chat opened again carries on from. */
export type FollowedRun = {
  runId: string
  startedAt: number
  state: AgentState
  seq: number
}

const followers = new Map<string, Follower>()

const keyOf = (projectId: string, chatId: string) => `${projectId}:${chatId}`

const connected = () =>
  [...followers.values()].filter(follower => follower.close).length

function forget(follower: Follower) {
  const key = keyOf(follower.projectId, follower.chatId)
  if (followers.get(key) !== follower) return false
  followers.delete(key)
  follower.close?.()
  follower.close = null
  if (follower.saveTimer) clearTimeout(follower.saveTimer)
  follower.saveTimer = null
  connectWaiting()
  return true
}

/** Stops following a chat's run, as when the chat is deleted. */
export function stopFollowingRun(projectId: string, chatId: string) {
  const follower = followers.get(keyOf(projectId, chatId))
  if (follower) forget(follower)
}

/**
 * Stops following a chat's run and hands over what it holds, for the chat
 * being opened again to carry on from. Null when it is not followed.
 */
export function takeFollowedRun(
  projectId: string,
  chatId: string
): FollowedRun | null {
  const follower = followers.get(keyOf(projectId, chatId))
  if (!follower || !forget(follower)) return null
  const { runId, startedAt, state, seq } = follower
  return { runId, startedAt, state, seq }
}

function saveLocally(follower: Follower) {
  if (follower.saveTimer) return
  follower.saveTimer = setTimeout(() => {
    follower.saveTimer = null
    if (followers.get(keyOf(follower.projectId, follower.chatId)) !== follower)
      return
    saveConversation(
      follower.projectId,
      follower.chatId,
      follower.state.transcript
    )
  }, LOCAL_SAVE_MS)
}

function settle(follower: Follower, finished: boolean) {
  const { projectId, chatId, startedAt } = follower
  const received = !follower.replaying
  if (!forget(follower)) return

  const { state } = follower
  let entries = state.transcript
  const last = entries.at(-1)
  if (
    finished &&
    last?.role === 'assistant' &&
    !state.error &&
    !state.stoppedByUser
  ) {
    // What the status line shows under a finished reply: how long it took
    entries = [
      ...entries.slice(0, -1),
      {
        ...last,
        durationMs: Math.max(1000, Date.now() - startedAt),
        statusWord: nextStatusWord(null),
      },
    ]
  }

  // A run that ended is saved and forgotten. One whose stream was lost stays
  // detached, to be replayed when its chat is opened. One that sent nothing
  // at all is gone from the server: it is forgotten, and the chat is kept as
  // it was left rather than saved without the reply it showed.
  if (finished || !received) setDetachedRun(projectId, chatId, null)
  if (!received) return
  saveConversation(projectId, chatId, entries)
  if (finished) {
    saveChat(
      projectId,
      chatId,
      entries,
      state.mode,
      state.chatTitle || undefined
    ).catch(() => {})
  }
}

function connect(follower: Follower) {
  follower.close = connectRunStream({
    runId: follower.runId,
    projectId: follower.projectId,
    since: follower.seq,
    passive: true,
    onEvent: (event, seq) => {
      if (follower.replaying) {
        // The run's events from the first rebuild the reply as it was left
        follower.replaying = false
        follower.state = {
          ...follower.state,
          transcript: withoutLiveReply(follower.state.transcript),
        }
      }
      follower.seq = Math.max(follower.seq, seq)
      follower.state = reduceAgentEvent(follower.state, event)
      if (event.type === 'toolCallFinished') {
        const e: any = event
        const name = e.name || e.call?.name || ''
        const result = e.result
        if (result && result.status === 'applied') {
          dispatchAiEditHighlight(name, result, follower.state.mode, true)
        }
      }
      saveLocally(follower)

    },
    onDone: () => settle(follower, true),
    onError: () => settle(follower, false),
  })
}

function connectWaiting() {
  for (const follower of followers.values()) {
    if (connected() >= MAX_FOLLOWED_RUNS) return
    if (!follower.close) connect(follower)
  }
}

/**
 * Follows the run of a chat that is not on screen. `since` is the last event
 * the chat holds, as when the panel leaves a chat it was following: the run
 * carries on from there. From 0, the run is replayed onto the chat as it was
 * stored, its reply rebuilt from the run's first event.
 */
export function followDetachedRun({
  projectId,
  chatId,
  runId,
  startedAt,
  transcript,
  mode,
  state,
  since = 0,
}: {
  projectId: string
  chatId: string
  runId: string
  startedAt: number
  /** The chat as it was left. */
  transcript: TranscriptEntry[]
  mode: AgentMode
  /** All the panel held for the chat, approvals and title included. */
  state?: AgentState
  since?: number
}): boolean {
  const key = keyOf(projectId, chatId)
  if (followers.get(key)?.runId === runId) return true
  stopFollowingRun(projectId, chatId)
  // Without the chat's turns before it, the reply would be saved alone
  if (transcript.length === 0) {
    setDetachedRun(projectId, chatId, null)
    return false
  }

  const follower: Follower = {
    projectId,
    chatId,
    runId,
    startedAt,
    state: {
      ...(state ?? emptyAgentState(transcript, mode)),
      transcript,
      mode,
      running: true,
    },
    seq: since,
    replaying: since === 0,
    close: null,
    saveTimer: null,
  }
  followers.set(key, follower)
  connectWaiting()
  return true
}
