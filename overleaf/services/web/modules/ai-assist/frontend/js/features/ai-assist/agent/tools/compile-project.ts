import { AgentTool } from './registry'
import { wantsCleanCompile } from './compile-args'
import { CompileOptions, LogEntrySummary } from '../project-handle'

const MAX_REPORTED = 20
let compileInFlight = false

export function computeErrorDelta(
  currentErrors: LogEntrySummary[],
  previousErrors: LogEntrySummary[]
): {
  countDelta: number
  newErrors: LogEntrySummary[]
  newErrorsCount: number
  resolvedErrorsCount: number
  regressed: boolean
} {
  const previousSignatures = new Set(
    previousErrors.map(e => `${e.file || ''}::${e.message}`)
  )
  const currentSignatures = new Set(
    currentErrors.map(e => `${e.file || ''}::${e.message}`)
  )

  const newErrors = currentErrors.filter(
    e => !previousSignatures.has(`${e.file || ''}::${e.message}`)
  )
  const resolvedErrors = previousErrors.filter(
    e => !currentSignatures.has(`${e.file || ''}::${e.message}`)
  )

  const countDelta = currentErrors.length - previousErrors.length
  return {
    countDelta,
    newErrors,
    newErrorsCount: newErrors.length,
    resolvedErrorsCount: resolvedErrors.length,
    regressed: countDelta > 0 || newErrors.length > 0,
  }
}

export const compileProjectTool: AgentTool = {
  suspends: false,
  mutates: false,
  spec: {
    name: 'compile_project',
    description:
      'Build the project and report errors and warnings. Use after edits that could affect the build. Not to see what already failed — get_compile_result shows the last result without rebuilding. Set clean to true to clear the cached build first (the .aux/.fls/.fdb_latexmk files and the previous output), which forces a full rebuild from scratch. Clean when a build returned no output, reported no-output, timed out, or behaved inconsistently with the source, or after changing the root document, bibliography or a package that caches state.',
    parameters: {
      type: 'object',
      properties: {
        clean: {
          type: 'boolean',
          description:
            'Clear the cached build output and auxiliary files before compiling, forcing a full rebuild. Defaults to false. Slower than an incremental build, so reach for it when the incremental one is untrustworthy rather than as a habit.',
        },
      },
      required: [],
    },
  },

  async execute(args, handle, options?: { signal?: AbortSignal }) {
    if (compileInFlight) {
      return { error: 'A compile is already in progress. Wait for it to finish.' }
    }

    compileInFlight = true
    try {
      const clean = wantsCleanCompile(args)
      const previous = handle.lastCompile()
      const previousErrors = previous?.errors ?? []

      const compileOptions: CompileOptions = { signal: options?.signal }
      if (clean) compileOptions.clean = true

      const outcome = await handle.compile(compileOptions)
      const currentErrors = outcome.errors ?? []
      const currentWarnings = outcome.warnings ?? []

      const delta = computeErrorDelta(currentErrors, previousErrors)
      const primaryError = currentErrors.length > 0 ? currentErrors[0] : null
      const cascadingErrorsCount = Math.max(0, currentErrors.length - 1)

      let message: string
      if (
        ['no-output', 'skipped', 'timedout'].includes(outcome.status) ||
        (currentErrors.length === 0 && outcome.status !== 'success')
      ) {
        message = describe(outcome, clean)
      } else if (currentErrors.length === 0) {
        message = currentWarnings.length > 0
          ? `${clean ? 'The cache was cleared and the project was rebuilt' : 'The project compiled'} with 0 errors and ${currentWarnings.length} warning(s).`
          : `${clean ? 'The cache was cleared and the project was rebuilt' : 'The project compiled'} without errors.`
      } else if (previous && delta.regressed) {
        message = `WARNING: Compilation worsened. Error count changed by ${delta.countDelta >= 0 ? `+${delta.countDelta}` : delta.countDelta} (${delta.newErrorsCount} new error(s) introduced, ${delta.resolvedErrorsCount} resolved). Recent edits likely introduced invalid LaTeX syntax. Focus on fixing the primary error first.`
      } else if (previous && delta.resolvedErrorsCount > 0) {
        message = `${clean ? 'The cache was cleared and the project was rebuilt' : 'The project compiled'} with ${currentErrors.length} error(s) (${delta.resolvedErrorsCount} error(s) resolved).`
      } else {
        message = describe(outcome, clean)
      }

      return {
        status: outcome.status,
        clean,
        errorCount: currentErrors.length,
        warningCount: currentWarnings.length,
        errorDelta: previous ? delta.countDelta : 0,
        newErrorsCount: previous ? delta.newErrorsCount : currentErrors.length,
        resolvedErrorsCount: previous ? delta.resolvedErrorsCount : 0,
        regressed: previous ? delta.regressed : false,
        primaryError,
        cascadingErrorsCount,
        errors: currentErrors.slice(0, MAX_REPORTED),
        warnings: currentWarnings.slice(0, MAX_REPORTED),
        message,
      }
    } catch (error: any) {
      return { error: error?.message ?? 'The compile failed to start.' }
    } finally {
      compileInFlight = false
    }
  },
}

/**
 * Says what happened, including when what happened is that nothing did.
 *
 * A status the log cannot explain gets named rather than folded into
 * "compiled without errors", because that reading is exactly what sends a model
 * on to claim a fix works.
 */
function describe(
  outcome: { status: string; errors: unknown[]; warnings: unknown[] },
  clean: boolean
): string {
  const rebuilt = clean ? 'The cache was cleared and the project was rebuilt' : 'The project compiled'

  switch (outcome.status) {
    case 'no-output':
      return clean
        ? 'The cache was cleared and the rebuild produced no parsable output. The build did not complete normally.'
        : 'The compile produced no parsable output. Call compile_project with clean set to true to clear the cached build and rebuild from scratch.'
    case 'skipped':
      return 'No compile ran: another build was still in progress and did not finish in time. Try again.'
    case 'timedout':
      return 'The compile timed out. Call compile_project with clean set to true to clear the cached build and rebuild from scratch.'
  }

  if (outcome.errors.length > 0) {
    return `${rebuilt} with ${outcome.errors.length} error(s) and ${outcome.warnings.length} warning(s).`
  }
  if (outcome.status !== 'success') {
    // clsi-unavailable, rate-limited, project-too-large, and the rest. The
    // status string is the honest description available.
    return `${rebuilt}, but the build ended as "${outcome.status}" with no errors in the log. Nothing was verified.`
  }
  if (outcome.warnings.length > 0) {
    return `${rebuilt} with 0 errors and ${outcome.warnings.length} warning(s).`
  }
  return `${rebuilt} without errors.`
}
