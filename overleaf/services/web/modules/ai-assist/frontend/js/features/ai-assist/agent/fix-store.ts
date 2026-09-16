import { useEffect, useState, useCallback, useMemo } from 'react'
import customLocalStorage from '@/infrastructure/local-storage'
import { TranscriptEntry } from './agent-messages'
import { shrink, cleanStoredResult } from './conversation-store'
import { AgentState, reduceAgentEvent } from './agent-state'
import { EditRequest, ProjectHandle } from './project-handle'
import { AiAssistant } from '../assistant'
import { hasConsented } from '../provider-store'
import { runAgent } from './run-agent'
import { resolveLimits } from '../providers/types'
import { FIX_MAX_STEPS, FIX_TOOLS, buildFixTranscript } from './fix-run'
import { FIX_SYSTEM_PROMPT } from './context/fix-system-prompt'

export interface StoredFix {
  entryId: string
  fingerprint: string
  open: boolean
  collapsed?: boolean
  transcript: TranscriptEntry[]
  running?: boolean
  error?: { code: string; message: string } | null
  stoppedForBudget?: boolean
  feedback?: 'up' | 'down' | null
  decidedEdits: Record<string, { path: string; startLine: number; accepted: boolean }>
  approvalContext?: { startLine: number } | null
  pendingApproval?: { id: string; edit: EditRequest } | null
  updatedAt: number
}

interface ActiveRun {
  controller: AbortController
  approvalResolver: ((decision: { accepted: boolean; note?: string }) => void) | null
}

export interface LastFixSummary {
  entryId: string
  fingerprint: string
  file: string
  line: number | null
  message: string
  level: 'error' | 'warning'
}

const MAX_STORED_FIXES = 30
const activeRuns = new Map<string, ActiveRun>()
const inMemoryFixes = new Map<string, Map<string, StoredFix>>()
const listeners = new Map<string, Set<() => void>>()

// Deliberately a plain in-memory map, never written to localStorage: once the
// log entry that triggered a fix disappears from the compile log (because
// recompiling after the fix found nothing left to report), there is no entry
// left to reopen it from. This keeps a pointer to the last one for the rest
// of the browser tab's life so the log pane can still offer it, but a reload
// starts clean rather than resurrecting a banner for a page that has moved on.
const lastCompletedFixByProject = new Map<string, LastFixSummary>()

export function recordLastCompletedFix(
  projectId: string,
  summary: LastFixSummary
): void {
  lastCompletedFixByProject.set(projectId, summary)
}

export function getLastCompletedFix(projectId: string): LastFixSummary | null {
  return lastCompletedFixByProject.get(projectId) ?? null
}

const keyFor = (projectId: string) => `ai-assist:fixes:${projectId}`

export function clearFixStore(): void {
  for (const active of activeRuns.values()) {
    active.controller.abort()
  }
  activeRuns.clear()
  inMemoryFixes.clear()
  listeners.clear()
  lastCompletedFixByProject.clear()
}

export function buildLogEntryFingerprint(logEntry?: any): string {
  if (!logEntry) return ''
  const file = logEntry.file || ''
  const line = logEntry.line != null ? String(logEntry.line) : ''
  const msg = logEntry.message || ''
  return `${file}:${line}:${msg}`
}

function notify(projectId: string, entryId: string): void {
  const k = `${projectId}:${entryId}`
  const entryListeners = listeners.get(k)
  if (entryListeners) {
    for (const listener of entryListeners) {
      listener()
    }
  }
}

function ensureProjectLoaded(projectId: string): Map<string, StoredFix> {
  const raw = customLocalStorage.getItem(keyFor(projectId))
  if (!raw) {
    const empty = new Map<string, StoredFix>()
    inMemoryFixes.set(projectId, empty)
    return empty
  }

  let projectMap = inMemoryFixes.get(projectId)
  if (!projectMap) {
    projectMap = new Map<string, StoredFix>()
    inMemoryFixes.set(projectId, projectMap)
    try {
      if (Array.isArray(raw)) {
        for (const item of raw) {
          if (item && typeof item === 'object' && item.entryId) {
            // Unpack and sanitize any nested result previews
            const cleanedTranscript = (item.transcript ?? []).map((entry: any) => {
              if (entry.role !== 'assistant') return entry
              return {
                ...entry,
                toolCalls: (entry.toolCalls ?? []).map((call: any) => ({
                  ...call,
                  result: cleanStoredResult(call.result),
                })),
                blocks: entry.blocks?.map((block: any) =>
                  block.type === 'tool_call'
                    ? {
                        ...block,
                        call: {
                          ...block.call,
                          result: cleanStoredResult(block.call.result),
                        },
                      }
                    : block
                ),
              }
            })
            projectMap.set(item.entryId, {
              ...item,
              transcript: cleanedTranscript,
              running: false,
            })
          }
        }
      }
    } catch {}
  }
  return projectMap
}

export function commitFixesToStorage(projectId: string): void {
  const projectMap = inMemoryFixes.get(projectId)
  if (!projectMap) return

  const list = Array.from(projectMap.values())
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, MAX_STORED_FIXES)

  // Prune map to match
  projectMap.clear()
  for (const item of list) {
    projectMap.set(item.entryId, item)
  }

  const serializable = list.map(fix => ({
    ...fix,
    running: false,
    transcript: fix.transcript.map(shrink),
  }))

  try {
    customLocalStorage.setItem(keyFor(projectId), serializable)
  } catch {}
}

export function getStoredFix(
  projectId: string,
  entryId: string,
  fingerprint?: string
): StoredFix | null {
  const map = ensureProjectLoaded(projectId)
  const exact = map.get(entryId)
  // Trust the entryId match only while it still points at the same problem.
  // The log pane can reuse a key across recompiles (e.g. positional keys), so
  // an entryId hit alone is not proof this is the same error — comparing
  // fingerprints (file + line + message) is what actually identifies "the
  // same problem" rather than "the same file" or "the same list slot".
  if (exact && (!fingerprint || !exact.fingerprint || exact.fingerprint === fingerprint)) {
    return exact
  }

  if (fingerprint) {
    for (const fix of map.values()) {
      if (fix.fingerprint && fix.fingerprint === fingerprint) {
        // Alias this entryId to the matched fix
        map.set(entryId, fix)
        return fix
      }
    }
  }

  return null
}

export function isFixRunning(projectId: string, entryId: string): boolean {
  return activeRuns.has(`${projectId}:${entryId}`)
}

export function setFixRunning(
  projectId: string,
  entryId: string,
  running: boolean
): void {
  const k = `${projectId}:${entryId}`
  if (running) {
    if (!activeRuns.has(k)) {
      activeRuns.set(k, {
        controller: new AbortController(),
        approvalResolver: null,
      })
    }
  } else {
    activeRuns.delete(k)
  }
  notify(projectId, entryId)
}

export function saveStoredFix(projectId: string, fix: StoredFix): void {
  const map = ensureProjectLoaded(projectId)
  map.set(fix.entryId, fix)
  if (fix.fingerprint) {
    for (const [k, existing] of map.entries()) {
      if (existing.fingerprint === fix.fingerprint && k !== fix.entryId) {
        map.set(k, { ...fix, entryId: k })
      }
    }
  }
  commitFixesToStorage(projectId)
  notify(projectId, fix.entryId)
}

export function stopFixRun(projectId: string, entryId: string): void {
  const k = `${projectId}:${entryId}`
  const active = activeRuns.get(k)
  if (active) {
    active.controller.abort()
    active.approvalResolver?.({ accepted: false })
    activeRuns.delete(k)
  }

  const map = ensureProjectLoaded(projectId)
  const fix = map.get(entryId)
  if (fix) {
    fix.running = false
    fix.approvalContext = null
    fix.pendingApproval = null
    fix.updatedAt = Date.now()
    commitFixesToStorage(projectId)
    notify(projectId, entryId)
  }
}

export function setFixFeedback(
  projectId: string,
  entryId: string,
  feedback: 'up' | 'down' | null
): void {
  const map = ensureProjectLoaded(projectId)
  const fix = map.get(entryId)
  if (fix) {
    fix.feedback = feedback
    fix.updatedAt = Date.now()
    commitFixesToStorage(projectId)
    notify(projectId, entryId)
  }
}

export function setFixOpen(
  projectId: string,
  entryId: string,
  open: boolean
): void {
  const map = ensureProjectLoaded(projectId)
  const fix = map.get(entryId)
  if (fix) {
    fix.open = open
    fix.updatedAt = Date.now()
    notify(projectId, entryId)
  }
}

export function decideFixApproval(
  projectId: string,
  entryId: string,
  decision: { accepted: boolean; note?: string },
  callId?: string,
  edit?: EditRequest,
  startLine?: number
): void {
  const k = `${projectId}:${entryId}`
  const active = activeRuns.get(k)
  if (active?.approvalResolver) {
    active.approvalResolver(decision)
    active.approvalResolver = null
  }

  const map = ensureProjectLoaded(projectId)
  const fix = map.get(entryId)
  if (fix) {
    fix.approvalContext = null
    fix.pendingApproval = null
    if (callId && edit) {
      fix.decidedEdits = {
        ...fix.decidedEdits,
        [callId]: {
          path: edit.path,
          startLine: startLine ?? 1,
          accepted: decision.accepted,
        },
      }
    }
    fix.updatedAt = Date.now()
    commitFixesToStorage(projectId)
    notify(projectId, entryId)
  }
}

export async function executeFixRun({
  projectId,
  entryId,
  fingerprint,
  handle,
  logEntry,
  startApproval: _startApproval,
}: {
  projectId: string
  entryId: string
  fingerprint: string
  handle: ProjectHandle
  logEntry?: any
  startApproval: (
    edit: EditRequest,
    context: { startLine: number }
  ) => Promise<{ accepted: boolean; note?: string }>
}): Promise<void> {
  const assistant = AiAssistant.fromStoredSettings()
  const map = ensureProjectLoaded(projectId)

  if (!assistant) {
    const errorFix: StoredFix = {
      entryId,
      fingerprint,
      open: true,
      running: false,
      transcript: [],
      decidedEdits: {},
      error: {
        code: 'noProvider',
        message: 'Configure an AI provider in Account Settings to use the assistant.',
      },
      updatedAt: Date.now(),
    }
    map.set(entryId, errorFix)
    commitFixesToStorage(projectId)
    notify(projectId, entryId)
    return
  }

  if (!hasConsented()) {
    const consentFix: StoredFix = {
      entryId,
      fingerprint,
      open: true,
      running: false,
      transcript: [],
      decidedEdits: {},
      error: {
        code: 'consentRequired',
        message: 'You need to allow AI features before using this.',
      },
      updatedAt: Date.now(),
    }
    map.set(entryId, consentFix)
    notify(projectId, entryId)
    return
  }

  const runKey = `${projectId}:${entryId}`
  const existingActive = activeRuns.get(runKey)
  if (existingActive) {
    existingActive.controller.abort()
    activeRuns.delete(runKey)
  }

  const controller = new AbortController()
  const activeRun: ActiveRun = {
    controller,
    approvalResolver: null,
  }
  activeRuns.set(runKey, activeRun)

  // Build compile error transcript
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

  const runningFix: StoredFix = {
    entryId,
    fingerprint,
    open: true,
    running: true,
    transcript,
    feedback: null,
    decidedEdits: {},
    approvalContext: null,
    pendingApproval: null,
    error: null,
    stoppedForBudget: false,
    updatedAt: Date.now(),
  }
  map.set(entryId, runningFix)
  notify(projectId, entryId)

  window.dispatchEvent(new CustomEvent('aiAssist:agentReadSelection'))

  let state: AgentState = {
    transcript,
    running: true,
    stoppedForBudget: false,
    stoppedByUser: false,
    pendingApproval: null,
    error: null,
  }

  try {
    for await (const event of runAgent({
      client: assistant.client,
      handle,
      tools: FIX_TOOLS,
      transcript,
      limits: resolveLimits(assistant.settings),
      cacheKey: projectId,
      maxSteps: FIX_MAX_STEPS,
      systemPrompt: FIX_SYSTEM_PROMPT,
      signal: controller.signal,
    })) {
      state = reduceAgentEvent(state, event)

      const currentFix = map.get(entryId) ?? runningFix
      currentFix.transcript = state.transcript
      currentFix.running = state.running
      currentFix.stoppedForBudget = state.stoppedForBudget
      currentFix.pendingApproval = state.pendingApproval
      currentFix.error = state.error
      currentFix.updatedAt = Date.now()

      map.set(entryId, currentFix)
      notify(projectId, entryId)
    }
  } catch (err: any) {
    if (err?.name !== 'AbortError') {
      const currentFix = map.get(entryId) ?? runningFix
      currentFix.running = false
      currentFix.error = {
        code: 'unknown',
        message: err?.message || 'Something went wrong.',
      }
      currentFix.updatedAt = Date.now()
      map.set(entryId, currentFix)
      notify(projectId, entryId)
    }
  } finally {
    activeRuns.delete(runKey)
    const currentFix = map.get(entryId)
    if (currentFix) {
      currentFix.running = false
      currentFix.updatedAt = Date.now()
      commitFixesToStorage(projectId)
      notify(projectId, entryId)
    }
    window.dispatchEvent(
      new CustomEvent('aiAssist:suggestDone', { detail: { entryId } })
    )
  }
}

export function useFix({
  projectId,
  logEntry,
  handle,
  requestApproval,
}: {
  projectId: string
  logEntry?: any
  handle: ProjectHandle
  requestApproval: (
    edit: EditRequest,
    context: { startLine: number }
  ) => Promise<{ accepted: boolean; note?: string }>
}) {
  const entryId = logEntry?.key ?? logEntry?.id ?? ''
  const fingerprint = useMemo(
    () => buildLogEntryFingerprint(logEntry),
    [logEntry]
  )

  const [, setVersion] = useState(0)

  useEffect(() => {
    if (!entryId) return
    const k = `${projectId}:${entryId}`
    let set = listeners.get(k)
    if (!set) {
      set = new Set()
      listeners.set(k, set)
    }
    const listener = () => setVersion(v => v + 1)
    set.add(listener)
    return () => {
      set?.delete(listener)
      if (set?.size === 0) {
        listeners.delete(k)
      }
    }
  }, [projectId, entryId])

  const stored = useMemo(
    () => (entryId ? getStoredFix(projectId, entryId, fingerprint) : null),
    // Re-eval when version bumps
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, entryId, fingerprint, setVersion]
  )

  const startRun = useCallback(async () => {
    if (!entryId) return
    await executeFixRun({
      projectId,
      entryId,
      fingerprint,
      handle,
      logEntry,
      startApproval: requestApproval,
    })
  }, [projectId, entryId, fingerprint, handle, logEntry, requestApproval])

  const stop = useCallback(() => {
    if (!entryId) return
    stopFixRun(projectId, entryId)
  }, [projectId, entryId])

  const onDecision = useCallback(
    (
      decision: { accepted: boolean; note?: string },
      callId?: string,
      edit?: EditRequest,
      startLine?: number
    ) => {
      if (!entryId) return
      decideFixApproval(projectId, entryId, decision, callId, edit, startLine)
    },
    [projectId, entryId]
  )

  const setFeedback = useCallback(
    (f: 'up' | 'down' | null) => {
      if (!entryId) return
      setFixFeedback(projectId, entryId, f)
    },
    [projectId, entryId]
  )

  const setOpen = useCallback(
    (open: boolean) => {
      if (!entryId) return
      setFixOpen(projectId, entryId, open)
    },
    [projectId, entryId]
  )

  return {
    stored,
    open: stored?.open ?? false,
    running: stored?.running ?? isFixRunning(projectId, entryId),
    transcript: stored?.transcript ?? [],
    feedback: stored?.feedback ?? null,
    decidedEdits: stored?.decidedEdits ?? {},
    approvalContext: stored?.approvalContext ?? null,
    pendingApproval: stored?.pendingApproval ?? null,
    error: stored?.error ?? null,
    stoppedForBudget: stored?.stoppedForBudget ?? false,
    startRun,
    stop,
    onDecision,
    setFeedback,
    setOpen,
  }
}
