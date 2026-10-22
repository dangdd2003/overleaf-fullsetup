import { SlashCommandId } from './types'

type CommandUsage = {
  count: number
  lastUsed: number
}

const STORAGE_KEY = 'ol_ai_assist_slash_usage'

function isCommandUsage(value: unknown): value is CommandUsage {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.count === 'number' &&
    Number.isFinite(candidate.count) &&
    typeof candidate.lastUsed === 'number' &&
    Number.isFinite(candidate.lastUsed)
  )
}

function readStorage(): Record<string, CommandUsage> {
  if (typeof window === 'undefined') return {}
  try {
    const storage = window.localStorage
    if (!storage) return {}
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const valid: Record<string, CommandUsage> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (isCommandUsage(value)) {
        valid[key] = value
      }
    }
    return valid
  } catch {
    return {}
  }
}

function writeStorage(data: Record<string, CommandUsage>): void {
  if (typeof window === 'undefined') return
  try {
    const storage = window.localStorage
    if (!storage) return
    storage.setItem(STORAGE_KEY, JSON.stringify(data))
  } catch {
    // Ignore storage quota or disabled storage
  }
}

/** Read all valid slash command usage records from storage. */
export function readSlashCommandUsage(): Record<string, CommandUsage> {
  return readStorage()
}

/** Record that a slash command was used by the user. */
export function recordSlashCommandUsage(id: SlashCommandId): void {
  const data = readStorage()
  const existing = data[id] ?? { count: 0, lastUsed: 0 }
  data[id] = {
    count: existing.count + 1,
    lastUsed: Date.now(),
  }
  writeStorage(data)
}

/** Get usage stats for a command. */
export function getSlashCommandUsage(id: SlashCommandId): CommandUsage | null {
  const data = readStorage()
  return data[id] ?? null
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000
const ONE_WEEK_MS = 7 * ONE_DAY_MS

/**
 * Compute an engineering-level ranking score for a command based on
 * frequency (mostly used) and recency (recently used).
 */
export function computeUsageScore(usage: CommandUsage | null): number {
  if (!usage || usage.count <= 0) return 0
  const now = Date.now()
  const elapsed = now - usage.lastUsed

  let recencyBonus = 0
  if (elapsed < ONE_DAY_MS) {
    recencyBonus = 60
  } else if (elapsed < ONE_WEEK_MS) {
    recencyBonus = 25
  }

  // Count score capped at 100
  const countScore = Math.min(usage.count * 15, 100)
  return countScore + recencyBonus
}

/**
 * Returns command IDs that have been used, sorted by mostly used and recently used.
 * Stale or unknown IDs from corrupted storage or removed commands are filtered out
 * when a set of known IDs is provided.
 */
export function getTopUsedCommandIds(
  limit = 3,
  known?: Set<string>
): SlashCommandId[] {
  const data = readStorage()
  const scored = Object.entries(data)
    .filter(([id, usage]) => usage.count > 0 && (!known || known.has(id)))
    .map(([id, usage]) => ({
      id: id as SlashCommandId,
      score: computeUsageScore(usage),
    }))
    .sort((a, b) => b.score - a.score)

  return scored.slice(0, limit).map(item => item.id)
}
