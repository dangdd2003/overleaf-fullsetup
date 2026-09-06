import * as z from 'zod/v4'

const projectId = z.string().min(1).describe('The Overleaf project id')

/**
 * Register high-signal prompt templates for AI assistants.
 *
 * Prompts guide Claude, ChatGPT, and Gemini to use the 20 tools in the optimal
 * sequence (outline -> line-sliced read -> surgical edit -> compile).
 *
 * @param {import('@modelcontextprotocol/server').McpServer} server
 */
export function registerAllPrompts(server) {
  server.registerPrompt(
    'review_project',
    {
      description:
        'Inspect project structure, scan citations and references, check word count, and verify clean compilation',
      argsSchema: z.object({ projectId }),
    },
    ({ projectId: id }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Please review Overleaf project "${id}":\n` +
              '1. Structure: Call list_files to see the document layout.\n' +
              '2. Outline: Call get_doc_outline on the root .tex document to understand section structure and line ranges.\n' +
              '3. Semantic Check: Call scan_latex with aspect: "labels_refs" to detect broken references or unused labels, ' +
              'and aspect: "citations" to verify citation consistency.\n' +
              '4. Word Count: Call get_word_count to inspect document length and section sizes.\n' +
              '5. Compile & Verify: Run compile_project to ensure the document builds cleanly. If errors occur, inspect with get_compile_log.\n' +
              '6. Report: Summarize project health, detected issues, and recommended improvements.',
          },
        },
      ],
    })
  )

  server.registerPrompt(
    'fix_compile_errors',
    {
      description: 'Diagnose and surgically fix LaTeX compile errors from build logs',
      argsSchema: z.object({
        projectId,
        buildId: z.string().optional().describe('Build ID from a failed compile run'),
      }),
    },
    ({ projectId: id, buildId }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Please diagnose and fix LaTeX compile errors in Overleaf project "${id}":\n` +
              `1. Inspect Log: Retrieve compiler output with get_compile_log${buildId ? ` for buildId "${buildId}"` : ''}.\n` +
              '2. Identify Offending Lines: Locate line numbers, missing packages, syntax errors, or undefined macros.\n' +
              '3. Targeted Read: Call read_file with startLine and endLine around the error site.\n' +
              '4. Surgical Edit: Use edit_file with exact string matching to fix the issue.\n' +
              '5. Recompile: Call compile_project. If errors were caused by stale auxiliary files or corrupted cache, set clearCache: true.\n' +
              '6. Verify: Confirm the build succeeds and review any remaining warnings.',
          },
        },
      ],
    })
  )

  server.registerPrompt(
    'edit_section',
    {
      description:
        'Locate a section using outline line ranges, read its content, and prepare targeted edits',
      argsSchema: z.object({
        projectId,
        path: z.string().min(1).describe('Path to LaTeX document, e.g. /main.tex'),
        title: z.string().min(1).describe('Section heading title to inspect and edit'),
      }),
    },
    ({ projectId: id, path, title }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Please help edit section "${title}" in "${path}" of Overleaf project "${id}":\n` +
              `1. Locate Section: Call get_doc_outline on "${path}" to find "${title}" and retrieve its startLine and endLine.\n` +
              `2. Fetch Section: Call read_file with the section's startLine and endLine to read only this section.\n` +
              '3. Edit: Propose and apply changes using edit_file with exact verbatim string matching.\n' +
              '4. Recompile: Call compile_project to verify that formatting and references remain intact.',
          },
        },
      ],
    })
  )
}
