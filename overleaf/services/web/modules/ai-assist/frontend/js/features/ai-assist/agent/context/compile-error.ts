import { escapeAttribute, neutraliseClosingTags } from './escape'

export type FocusedLogEntry = {
  level: string
  message: string
  raw: string | null
  file: string | null
  line: number | null
}

export type LogIndexEntry = {
  level: string
  file: string | null
  line: number | null
}

const MAX_LOCATIONS = 20

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function location(entry: LogIndexEntry): string {
  if (!entry.file) return 'unknown location'
  return entry.line === null ? entry.file : `${entry.file}:${entry.line}`
}

function renderIndex(focusedLevel: string, others: LogIndexEntry[]): string {
  if (others.length === 0) {
    return '<compile-log-index>no other entries</compile-log-index>'
  }

  const sameLevel = others.filter(entry => entry.level === focusedLevel)
  const lines: string[] = []

  if (sameLevel.length > 0) {
    const shown = sameLevel.slice(0, MAX_LOCATIONS).map(location)
    const overflow = sameLevel.length - shown.length
    lines.push(
      `${plural(sameLevel.length, `more ${focusedLevel}`)}: ${shown.join(', ')}` +
        (overflow > 0 ? `, +${overflow} more` : '')
    )
  }

  // Other levels collapse to a count. Their locations are rarely what a reader
  // of this error needs, and get_compile_log is one call away if they are.
  const byLevel = new Map<string, number>()
  for (const entry of others) {
    if (entry.level === focusedLevel) continue
    byLevel.set(entry.level, (byLevel.get(entry.level) ?? 0) + 1)
  }
  for (const [level, count] of byLevel) {
    lines.push(plural(count, level))
  }

  return ['<compile-log-index>', ...lines, '</compile-log-index>'].join('\n')
}

/**
 * Renders the error the user clicked, plus a thin index of everything else.
 *
 * The index exists so the model can tell a root cause from a downstream
 * symptom: one unclosed brace produces a cascade of entries, and a fix aimed at
 * the last of them patches a symptom. It costs about thirty tokens; detail is
 * pulled lazily with get_compile_log when the index looks suspicious.
 */
export function renderCompileError({
  focused,
  others,
}: {
  focused: FocusedLogEntry
  others: LogIndexEntry[]
}): string {
  const attributes = [
    focused.file ? ` file="${escapeAttribute(focused.file)}"` : '',
    focused.line !== null ? ` line="${focused.line}"` : '',
    ` level="${escapeAttribute(focused.level)}"`,
  ].join('')

  const body = [`<compile-error${attributes}>`, neutraliseClosingTags(focused.message)]

  if (focused.raw) {
    body.push('<raw>', neutraliseClosingTags(focused.raw), '</raw>')
  }

  body.push('</compile-error>')

  return [...body, renderIndex(focused.level, others)].join('\n')
}
