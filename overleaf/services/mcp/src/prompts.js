import * as z from 'zod/v4'

const projectId = z.string().min(1).describe('The Overleaf project id')

/**
 * Register high-signal prompt templates for AI assistants.
 *
 * Prompts guide Claude, ChatGPT, and Gemini to use the tools in the optimal
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
              `5. Compile & Verify: Run compile_project. Treat data.status "success_with_errors" as a failure to fix; list every errors[] item with its file and line. On "success", view the pages with tables, figures or many bad boxes using view_compiled_pdf_page and list any layout problems you see, with the source line from data.sourceMap.\n` +
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
              `1. Diagnose: ${buildId ? `Call get_compile_log for buildId "${buildId}"` : 'Call compile_project'} and read data.errors (file, line, message, context). A status of "success_with_errors" still has errors to fix.\n` +
              '2. Targeted Read: Call read_file on each error file with startLine/endLine a few lines around the reported line (lines are 1-based).\n' +
              '3. Fix: Use edit_lines with those line numbers, or edit_file with an exact oldString. Fix the first error first; later errors are often caused by it.\n' +
              '4. Recompile: Call compile_project. Use clean: true only if errors point at stale .aux/.bbl files.\n' +
              '5. Repeat until data.status is "success", then review warnings (undefined references/citations, rerunNeeded).',
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
              '3. Edit: Apply changes with edit_lines (by line number) or edit_file (exact oldString; several edits at once via edits[]).\n' +
              `4. Recompile: Call compile_project and confirm data.status is "success". Then call view_compiled_pdf_page with the buildId, path "${path}" and the first line you changed, and check the image for content past the margins, overlaps, misplaced floats and ?? references; fix at the line data.sourceMap gives for that height, and compile again.`,
          },
        },
      ],
    })
  )

  server.registerPrompt(
    'review_layout',
    {
      description:
        'Look at the compiled PDF page by page and fix what the log cannot show: overflowing tables, overlapping figures, misplaced floats',
      argsSchema: z.object({
        projectId,
        pages: z
          .string()
          .optional()
          .describe('Pages to check, e.g. "3-5" or "2,7"; defaults to every page'),
      }),
    },
    ({ projectId: id, pages }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Please check the visual layout of Overleaf project "${id}"${pages ? ` on pages ${pages}` : ''}:\n` +
              '1. Build: Call compile_project and fix any errors first (data.status must be "success"). Keep data.buildId and data.clsiServerId.\n' +
              `2. Look: Start with view_compiled_pdf_overview for the page range to see every page at once, then open the pages it flags. Use search_compiled_pdf to find ?? and [?] markers and the pages of captions or headings. Call view_compiled_pdf_page for ${pages ? 'each of those pages' : 'each page, from page 1 to data.pageCount'}. Check the image for text, tables or figures in or past the margins, overlapping text, labels or arrows, floats far from where they are discussed, ?? or [?], missing symbols, and bad page or line breaks. Use region to zoom in on small details.\n` +
              '3. Locate: For each problem, take the data.sourceMap entry nearest its height (data.badBoxes often names the same line) and read_file those lines.\n' +
              '4. Fix: Make the smallest change that fixes the layout (e.g. resize a table, adjust a float placement, break a long line) with edit_lines or edit_file.\n' +
              `5. Verify: compile_project, then view the same page with the new buildId. diff_compiled_pdf against the previous build lists the pages and regions that changed, so you can check the fix touched only what you meant. Repeat until the page looks right, then report what you changed and anything you could not fix.`,
          },
        },
      ],
    })
  )
}
