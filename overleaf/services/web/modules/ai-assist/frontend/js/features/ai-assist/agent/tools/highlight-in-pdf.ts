import { AgentTool } from './registry'

/**
 * Lets the agent point the user at a place in their PDF. This is the in-browser
 * copy, used only by runs that drive the loop here (see runAgent); the main chat
 * is served by the backend's copy (AiAssistTools.mjs).
 */
export const highlightInPdfTool: AgentTool = {
  suspends: false,
  mutates: false,
  spec: {
    name: 'highlight_in_pdf',
    description:
      "Show a place in the user's PDF viewer: it highlights the place and scrolls to it. Give path and line (and endLine for a range) to show where a source line lands in the PDF, or boxes in PDF points measured from the top-left of each page. Use it after an edit so the user can see what changed, or to show the passage you are talking about. It changes only the viewer, never the project.",
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Project file path, such as sections/intro.tex. Use with line.',
        },
        line: {
          type: 'integer',
          minimum: 1,
          description: 'Source line in path.',
        },
        endLine: {
          type: 'integer',
          minimum: 1,
          description: 'Last source line of a range that starts at line. Defaults to line.',
        },
        boxes: {
          type: 'array',
          description: 'Boxes to highlight, instead of a source range.',
          items: {
            type: 'object',
            properties: {
              page: { type: 'integer', minimum: 1 },
              h: { type: 'number', description: 'Left edge, PDF points.' },
              v: { type: 'number', description: 'Top edge, PDF points from the top of the page.' },
              width: { type: 'number' },
              height: { type: 'number' },
            },
            required: ['page', 'h', 'v', 'width', 'height'],
          },
        },
      },
      required: [],
    },
  },

  async execute(args, handle) {
    if (!handle.highlightPdf) {
      return { error: 'Highlighting the PDF is not available in this run.' }
    }
    return handle.highlightPdf(args ?? {})
  },
}
