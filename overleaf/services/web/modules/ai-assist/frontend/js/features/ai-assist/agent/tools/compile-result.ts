import { AgentTool } from './registry'
import { LogEntrySummary } from '../project-handle'

const DEFAULT_LIMIT = 20
const EXCERPT_RADIUS = 3

/** Finds a log line and returns it with `radius` lines either side. */
export function excerptAround(
  rawLog: string,
  needle: string,
  radius: number
): string | null {
  const lines = rawLog.split('\n')
  const index = lines.findIndex(line => line.includes(needle))
  if (index === -1) return null

  return lines
    .slice(Math.max(0, index - radius), index + radius + 1)
    .join('\n')
}

const MAX_EXCERPT_LINES = 8

/**
 * The log lines TeX printed for one parsed error, from the entry's own `raw`
 * text. Searching the whole log by message instead gives every repeated
 * message ("Undefined control sequence.") the first one's context. The first
 * raw line is the message itself, which is already shown.
 */
export function errorExcerpt(entry: { raw?: unknown }): string | null {
  if (!entry || typeof entry.raw !== 'string') return null
  const lines = entry.raw
    .split('\n')
    .slice(1)
    .filter(line => line.trim() !== '')
    .slice(0, MAX_EXCERPT_LINES)
  return lines.length > 0 ? lines.join('\n') : null
}

function decorate(
  entries: LogEntrySummary[],
  rawLog: string | null,
  includeRaw: boolean
) {
  if (!includeRaw) {
    return entries.map(entry => {
      if (!entry.excerpt) return entry
      const copy = { ...entry }
      delete copy.excerpt
      return copy
    })
  }
  if (!rawLog) return entries
  return entries.map(entry => {
    if (entry.excerpt) return entry
    const excerpt = excerptAround(rawLog, entry.message, EXCERPT_RADIUS)
    return excerpt ? { ...entry, excerpt } : entry
  })
}

export const compileResultTool: AgentTool = {
  suspends: false,
  mutates: false,
  spec: {
    name: 'get_compile_result',
    description:
      'The result of the last build: errors, warnings and raw log excerpts, without rebuilding. Pass severity to narrow and limit to cap the count.',
    parameters: {
      type: 'object',
      properties: {
        severity: {
          type: 'string',
          enum: ['errors', 'warnings', 'all'],
          description: 'Which entries to return. Defaults to all.',
        },
        limit: {
          type: 'number',
          description: `Cap per severity. Defaults to ${DEFAULT_LIMIT}.`,
        },
        includeRaw: {
          type: 'boolean',
          description: 'Include the TeX log lines of each error. Defaults to true.',
        },
      },
      required: [],
    },
  },

  async execute(
    {
      severity = 'all',
      limit,
      maxEntries,
      includeRaw = true,
    }: {
      severity?: 'errors' | 'warnings' | 'all'
      limit?: number
      maxEntries?: number
      includeRaw?: boolean
    } = {},
    handle
  ) {
    const cap = limit ?? maxEntries ?? DEFAULT_LIMIT
    const compile = handle.lastCompile()

    if (!compile) {
      return {
        status: 'none',
        message:
          'The project has not been compiled in this session. Call compile_project to build it.',
      }
    }

    const rawErrors = compile.errors.slice(0, cap)
    const rawWarnings = compile.warnings.slice(0, cap)

    const decoratedErrors = decorate(rawErrors, compile.rawLog, includeRaw)
    // Warnings carry no excerpt: the message is the whole log entry.
    const decoratedWarnings = rawWarnings

    const primaryError = decoratedErrors.length > 0 ? decoratedErrors[0] : null
    const cascadingErrorsCount = Math.max(0, compile.errors.length - 1)

    const result: Record<string, unknown> = {
      status: compile.status,
      errorCount: compile.errors.length,
      warningCount: compile.warnings.length,
      primaryError,
      cascadingErrorsCount,
      truncated:
        compile.errors.length > rawErrors.length ||
        compile.warnings.length > rawWarnings.length,
    }

    if (severity === 'all' || severity === 'errors') {
      result.errors = decoratedErrors
    }

    if (severity === 'all' || severity === 'warnings') {
      result.warnings = decoratedWarnings
    }

    return result
  },

  render(result: any) {
    if (result?.status === 'none') return result.message

    const section = (title: string, entries: any[] = []) => {
      if (entries.length === 0) return []
      return [
        `${title}:`,
        ...entries.map(entry => {
          const where = entry.file
            ? `${entry.file}:${entry.line ?? '?'}`
            : 'unknown location'
          const excerpt = entry.excerpt ? `\n    ${entry.excerpt.split('\n').join('\n    ')}` : ''
          return `  ${where}  ${entry.message}${excerpt}`
        }),
      ]
    }

    return [
      `Last compile: ${result.status} - ${result.errorCount} error(s), ${result.warningCount} warning(s)`,
      ...section('Errors', result.errors),
      ...section('Warnings', result.warnings),
    ].join('\n')
  },
}
