import customLocalStorage from '@/infrastructure/local-storage'
import { TranscriptEntry } from './agent-messages'
import { shrink, cleanStoredResult } from './conversation-store'
import { EditRequest } from './project-handle'

export interface StoredFix {
  entryId: string
  fingerprint: string
  open: boolean
  collapsed?: boolean
  transcript: TranscriptEntry[]
  running?: boolean
  error?: { code: string; message: string } | null
  feedback?: 'up' | 'down' | null
  decidedEdits: Record<string, { path: string; startLine: number; accepted: boolean }>
  approvalContext?: { startLine: number } | null
  pendingApproval?: { id: string; edit: EditRequest } | null
  updatedAt: number
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
