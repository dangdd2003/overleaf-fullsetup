const PENDING_TTL_MS = 10_000

let pending: { entryId: string; at: number } | null = null

export function markPendingSuggestFix(entryId: string): void {
  pending = { entryId, at: Date.now() }
}

export function takePendingSuggestFix(entryId: string): boolean {
  if (!pending || pending.entryId !== entryId) return false
  const fresh = Date.now() - pending.at <= PENDING_TTL_MS
  pending = null
  return fresh
}
