import { AgentTool } from './registry'

const MAX_REPORTED = 20

// Module-level so a second call during the same run sees the first one. The
// guard is per page, which is exactly the scope that matters: one editor tab
// drives one project.
let compileInFlight = false

export const compileProjectTool: AgentTool = {
  suspends: false,
  mutates: false,
  spec: {
    name: 'compile_project',
    description:
      'Build the project and report errors and warnings. Use after edits that could affect the build. Not to see what already failed — get_compile_log shows the last result without rebuilding.',
    parameters: { type: 'object', properties: {}, required: [] },
  },

  async execute(_args, handle) {
    if (compileInFlight) {
      return { error: 'A compile is already in progress. Wait for it to finish.' }
    }

    compileInFlight = true
    try {
      const outcome = await handle.compile()
      return {
        status: outcome.status,
        errorCount: outcome.errors.length,
        warningCount: outcome.warnings.length,
        errors: outcome.errors.slice(0, MAX_REPORTED),
        warnings: outcome.warnings.slice(0, MAX_REPORTED),
        message:
          outcome.errors.length === 0
            ? 'The project compiled without errors.'
            : `The project compiled with ${outcome.errors.length} error(s).`,
      }
    } catch (error: any) {
      return { error: error?.message ?? 'The compile failed to start.' }
    } finally {
      // Always released, or one failure would wedge the tool for the session.
      compileInFlight = false
    }
  },
}
