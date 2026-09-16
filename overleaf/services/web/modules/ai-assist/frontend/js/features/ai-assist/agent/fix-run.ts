import { ProjectHandle } from './project-handle'
import { TranscriptEntry } from './agent-messages'
import { AgentTool, TOOLS } from './tools/registry'
import {
  FocusedLogEntry,
  LogIndexEntry,
  renderCompileError,
} from './context/compile-error'
import {
  PREAMBLE_MAX_LINES,
  renderPreamble,
  renderSourceWindow,
  windowFor,
} from './context/fix-source'

/**
 * The tools a fix run may use.
 *
 * compile_project is excluded because it cannot help: the edit is pending the
 * user's approval while the model is deciding what to say, so a compile would
 * rebuild the unchanged document and verify nothing. create_file is excluded
 * because a compile error is a fix, not a new file.
 */
const FIX_ALLOWED = new Set([
  'edit_file',
  'get_compile_result',
  'get_outline',
  'get_packages',
  'get_references',
  'list_files',
  'read_file',
  'search_text',
])

export const FIX_TOOLS: Record<string, AgentTool> = Object.fromEntries(
  Object.entries(TOOLS).filter(([name]) => FIX_ALLOWED.has(name))
)

/**
 * The step budget for a fix run, counted in tool calls (see run-agent.ts).
 *
 * This is not the number of assistant turns: every read, search and edit
 * spends one. Six was too few to finish the job the task block asks for.
 * Orienting costs a project_map and one or two reads, a cascade of log
 * entries can cost a get_compile_log, the edit itself costs one, and an
 * anchor that comes back `noMatch` or `ambiguous` costs a re-read plus a
 * second edit. A run that spends its last step on the edit_file it was
 * building towards leaves the user with an explanation and no fix — the
 * worst of both. Fourteen covers that path with room for one retry, and
 * still stops well short of the rail's 30.
 */
export const FIX_MAX_STEPS = 14

/**
 * The task block for a fix run.
 *
 * The level is the one interpolated value: calling a warning an "error" would
 * push the model at an overfull hbox to "fix" something the build merely
 * remarked on. Everything else is constant.
 */
export function buildFixTaskBlock(level: string): string {
  const kind = level === 'warning' ? 'warning' : 'error'
  return [
    '<task>',
    `The user clicked "Suggest fix" on the compile ${kind} above. This panel`,
    'has no reply box: nobody can answer you, so never end with a question or',
    'an offer to investigate. Finish the whole job in this run.',
    '',
    '1. Investigate silently: make every tool call first, with no text between',
    '   them. The entry\'s line is where LaTeX noticed the problem, not always',
    '   where it is: a missing \\usepackage in the preamble surfaces at the',
    '   first command that needs it, and an unclosed brace surfaces far below',
    '   itself. Check the preamble and the compile log index before you assume',
    '   the fix is local.',
    '2. If you are confident, call edit_file with the smallest change that',
    '   fixes this entry — one anchor, no drive-by cleanup; the fix may belong',
    '   in a different file from the one the entry names — then write one text',
    '   block: the cause in two or three sentences of plain language, and one',
    '   sentence on what you changed. Prefer the least invasive fix that',
    '   works: change an argument before you add a package, and add a package',
    '   before you restructure the author\'s content.',
    '3. If you are not confident, make no edit and write one text block: the',
    '   cause, then the exact change you recommend as a short before/after',
    '   snippet with the file and line it belongs at, and the one reason you',
    '   did not apply it yourself. A checklist of things the user might check',
    '   is not a suggestion.',
    '4. If nothing is actually broken — a cosmetic warning the author can',
    '   live with — say so in one or two sentences and make no edit. Still',
    '   give the before/after snippet if a safe change exists, marked as',
    '   optional, so the user has something concrete to accept or ignore.',
    '',
    'compile_project and create_file are not available for this task. Do not',
    'offer to compile; the user will rebuild when they apply your fix.',
    '</task>',
  ].join('\n')
}

/** The block for an error-level entry; warnings get their own wording. */
export const FIX_TASK_BLOCK = buildFixTaskBlock('error')

/**
 * Reads the code a fix run should start from already knowing.
 *
 * Two small reads — the lines around the entry, and the preamble — replace the
 * project-wide envelope the rail sends. That envelope described the project
 * without quoting a line of it, so every run began by spending tool calls (and
 * whole provider round trips) rediscovering the one or two lines the entry was
 * about. Neither read is allowed to fail the run: without them the model still
 * has the entry, and its tools.
 */
async function readFixSource(
  handle: ProjectHandle,
  focused: FocusedLogEntry
): Promise<string[]> {
  const rootPath = handle.rootDocPath()
  const entryPath = focused.file ?? rootPath
  const blocks: string[] = []

  let windowFrom: number | null = null
  if (entryPath && focused.line !== null) {
    const range = windowFor(focused.line)
    try {
      const { lines } = await handle.readFile(entryPath, range)
      const block = renderSourceWindow({
        path: entryPath,
        from: range.from,
        lines,
        caret: focused.line,
      })
      if (block) {
        blocks.push(block)
        windowFrom = range.from
      }
    } catch {
      // Unreadable file: the model can still reach for read_file itself.
    }
  }

  // The preamble answers the most common class of entry outright — a command
  // whose package was never loaded. Skipped when the window already covers it,
  // which happens for entries near the top of the root document.
  const coversPreamble =
    entryPath === rootPath && windowFrom !== null && windowFrom <= 1
  if (rootPath && !coversPreamble) {
    try {
      const { lines } = await handle.readFile(rootPath, {
        from: 1,
        to: PREAMBLE_MAX_LINES,
      })
      const block = renderPreamble({ path: rootPath, lines })
      if (block) blocks.push(block)
    } catch {
      // Same: absence is survivable, a thrown error is not.
    }
  }

  return blocks
}

/**
 * Builds the single-turn transcript a fix run starts from.
 *
 * Frozen onto the entry like the rail's envelope, but deliberately not the
 * same content: a fix is a local question, so this carries the entry, the code
 * around it and the preamble, rather than a summary of the whole project.
 */
export async function buildFixTranscript({
  handle,
  focused,
  others,
}: {
  handle: ProjectHandle
  focused: FocusedLogEntry
  others: LogIndexEntry[]
}): Promise<TranscriptEntry[]> {
  const errorBlock = renderCompileError({ focused, others })
  const source = await readFixSource(handle, focused)
  const contextText = [...source, errorBlock].join('\n')

  return [
    {
      id: 'u0',
      role: 'user',
      text: buildFixTaskBlock(focused.level),
      contextText,
      attachments: [],
    },
  ]
}
