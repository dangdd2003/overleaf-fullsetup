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

function decorate(
  entries: LogEntrySummary[],
  rawLog: string | null,
  includeRaw: boolean
) {
  if (!includeRaw || !rawLog) return entries
  return entries.map(entry => {
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
          description: 'Include raw log lines around each entry',
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
      includeRaw = false,
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

    const errors = compile.errors.slice(0, cap)
    const warnings = compile.warnings.slice(0, cap)

    const result: Record<string, unknown> = {
      status: compile.status,
      errorCount: compile.errors.length,
      warningCount: compile.warnings.length,
      truncated:
        compile.errors.length > errors.length ||
        compile.warnings.length > warnings.length,
    }

    if (severity === 'all' || severity === 'errors') {
      result.errors = decorate(errors, compile.rawLog, includeRaw)
    }
    if (severity === 'all' || severity === 'warnings') {
      result.warnings = decorate(warnings, compile.rawLog, includeRaw)
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
