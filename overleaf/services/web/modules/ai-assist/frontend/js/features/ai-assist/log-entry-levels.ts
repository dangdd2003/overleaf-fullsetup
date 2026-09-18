import type { LogEntry } from '@/features/pdf-preview/util/types'

/**
 * The compile logs pane only offers "Suggest fix" for errors and warnings.
 * Every other surface must use this same rule.
 */
export function isFixableLevel(level?: string | null) {
  return level === 'error' || level === 'warning'
}

// Editor diagnostics cannot answer "is this fixable?" on their own: core maps
// every non-error log entry (including info/typesetting) to severity
// 'warning' (pdf-preview/util/output-files.ts). So keep the real level of each
// entry, keyed the same way the logs pane keys its entries (logEntry.key).
const levels = new Map<string, LogEntry['level']>()

export function setCompileLogEntries(entries?: LogEntry[]) {
  levels.clear()
  for (const entry of entries ?? []) {
    if (entry.key) levels.set(entry.key, entry.level)
  }
}

export function isFixableLogEntry(id?: string) {
  return Boolean(id) && isFixableLevel(levels.get(id!))
}
