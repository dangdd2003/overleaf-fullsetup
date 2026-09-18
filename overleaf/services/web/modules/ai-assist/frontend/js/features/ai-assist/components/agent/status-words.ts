import { AssistantBlock, ToolCallRecord } from '../../agent/agent-messages'
import { estimateTokens } from '../../agent/context/budget'
import { wantsCleanCompile } from '../../agent/tools/compile-args'

/**
 * The vocabulary of the idle / text-generating status line.
 *
 * No entry here may double as a tool verb (Reading, Editing, Searching,
 * Compiling, Creating, Listing, Mapping). Those belong to the activity line,
 * where they describe a call that is genuinely in flight.
 * `agent-status-line.test.tsx` enforces this.
 */
export const STATUS_WORDS = [
  // Overleaf and LaTeX flavour
  'Overleafing',
  'Typesetting',
  'Kerning',
  'Preambling',
  'TeXing',
  'Knuthing',
  'Floating',
  'Hyphenating',
  'Justifying',
  'Glueing',
  'Sectioning',
  'Ligaturing',
  'Paginating',
  'Badboxing',
  // Academic & editorial flavour
  'Pontificating',
  'Peer-reviewing',
  'Proofreading',
  'Annotating',
  'Footnoting',
  'Citing',
  'Drafting',
  'Composing',
  'Articulating',
  'Preparing',
  // General whimsy
  'Brewing',
  'Percolating',
  'Noodling',
  'Pondering',
  'Simmering',
  'Conjuring',
  'Cogitating',
  'Mulling',
  'Puzzling',
  'Tinkering',
  'Whirring',
  'Ruminating',
  'Marinating',
  'Wrangling',
  'Herding',
  'Spelunking',
  'Concocting',
  'Musing',
  'Deliberating',
  'Frolicking',
] as const

export type StatusWord = (typeof STATUS_WORDS)[number]

/**
 * A different word from the one on screen.
 */
export function nextStatusWord(current: string | null): string {
  const choices = STATUS_WORDS.filter(word => word !== current)
  return choices[Math.floor(Math.random() * choices.length)]
}

/**
 * How long the run has been going, in Claude Code's shape: "12s", "1m 7s".
 */
export function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1000)
  if (totalSeconds < 1) return ''
  if (totalSeconds < 60) return `${totalSeconds}s`

  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}m ${seconds}s`
}

/**
 * Format total completed running duration, ensuring sub-second runs show "1s".
 */
export function formatDuration(elapsedMs: number): string {
  const totalSeconds = Math.round(elapsedMs / 1000)
  if (totalSeconds <= 1) return '1s'
  if (totalSeconds < 60) return `${totalSeconds}s`

  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
}

export const PAST_TENSE_WORDS: Record<string, string> = {
  // Overleaf and LaTeX flavour
  Overleafing: 'Overleafed',
  Typesetting: 'Typeset',
  Kerning: 'Kerned',
  Preambling: 'Preambled',
  TeXing: 'TeXed',
  Knuthing: 'Knuthed',
  Floating: 'Floated',
  Hyphenating: 'Hyphenated',
  Justifying: 'Justified',
  Glueing: 'Glued',
  Sectioning: 'Sectioned',
  Ligaturing: 'Ligatured',
  Paginating: 'Paginated',
  Badboxing: 'Badboxed',
  // Academic & editorial flavour
  Pontificating: 'Pontificated',
  'Peer-reviewing': 'Peer-reviewed',
  Proofreading: 'Proofread',
  Annotating: 'Annotated',
  Footnoting: 'Footnoted',
  Citing: 'Cited',
  Drafting: 'Drafted',
  Composing: 'Composed',
  Articulating: 'Articulated',
  Preparing: 'Prepared',
  // General whimsy
  Brewing: 'Brewed',
  Percolating: 'Percolated',
  Noodling: 'Noodled',
  Pondering: 'Pondered',
  Simmering: 'Simmered',
  Conjuring: 'Conjured',
  Cogitating: 'Cogitated',
  Mulling: 'Mulled',
  Puzzling: 'Puzzled',
  Tinkering: 'Tinkered',
  Whirring: 'Whirred',
  Ruminating: 'Ruminated',
  Marinating: 'Marinated',
  Wrangling: 'Wrangled',
  Herding: 'Herded',
  Spelunking: 'Spelunked',
  Concocting: 'Concocted',
  Musing: 'Mused',
  Deliberating: 'Deliberated',
  Frolicking: 'Frolicked',
  Working: 'Worked',
  Thinking: 'Thought',
}

export function toPastTense(word: string): string {
  if (!word) return 'Worked'
  const trimmed = word.replace(/…$/, '').trim()
  if (PAST_TENSE_WORDS[trimmed]) return PAST_TENSE_WORDS[trimmed]
  if (Object.values(PAST_TENSE_WORDS).includes(trimmed)) return trimmed
  if (trimmed.endsWith('ed')) return trimmed
  if (trimmed.endsWith('ing')) {
    const base = trimmed.slice(0, -3)
    if (base.endsWith('e')) return `${base}d`
    return `${base}ed`
  }
  return `${trimmed}ed`
}

/**
 * Generates the completed status text in Claude Code's past-tense style:
 * e.g. "Brewed for 12s", "Worked for 1m 7s", "Typeset for 45s".
 */
export function formatCompletedStatus(word: string, elapsedMs: number): string {
  const pastWord = toPastTense(word)
  const duration = formatDuration(elapsedMs)
  return `${pastWord} for ${duration}`
}

export const THINKING_TOKEN_TIERS = [
  { maxTokens: 250, text: 'Thinking…' },
  { maxTokens: 750, text: 'Still thinking…' },
  { maxTokens: 1500, text: 'Thinking deeply…' },
  { maxTokens: 3000, text: 'Pondering the solution…' },
  { maxTokens: 5000, text: 'Working through complex reasoning…' },
]

export const THINKING_TIERS = THINKING_TOKEN_TIERS

export const DEEP_THINKING_WORDS = [
  'Synthesizing thoughts…',
  'Analyzing multiple angles…',
  'Formulating detailed approach…',
  'Refining logical steps…',
  'Deep in contemplation…',
]

export function getThinkingStatus(tokens: number): string {
  for (const tier of THINKING_TOKEN_TIERS) {
    if (tokens < tier.maxTokens) {
      return tier.text
    }
  }
  const idx = Math.floor((tokens - 5000) / 1000) % DEEP_THINKING_WORDS.length
  return DEEP_THINKING_WORDS[Math.max(0, idx)]
}

export const TOOL_ACTION_LABELS: Record<string, (args: any) => string> = {
  read_file: args => (args?.path ? `Reading ${args.path}…` : 'Reading file…'),
  search_project: args =>
    args?.query ? `Searching for "${args.query}"…` : 'Searching project…',
  search_text: args =>
    args?.query ? `Searching for "${args.query}"…` : 'Searching text…',
  edit_file: args =>
    args?.path ? `Preparing edit to ${args.path}…` : 'Editing file…',
  create_file: args =>
    args?.path ? `Creating ${args.path}…` : 'Creating file…',
  compile_project: args =>
    wantsCleanCompile(args)
      ? 'Clearing build cache and rebuilding…'
      : 'Compiling project…',
  get_compile_result: () => 'Checking compile logs…',
  get_compile_log: () => 'Reading compile log…',
  get_outline: () => 'Reading project outline…',
  outline_project: () => 'Reading project outline…',
  get_references: () => 'Checking references…',
  list_references: () => 'Checking references…',
  get_packages: () => 'Checking packages…',
  list_files: () => 'Listing project files…',
  project_map: () => 'Mapping project…',
}

export function getToolStatusText(call: ToolCallRecord): string {
  if ('result' in call && call.result !== undefined) {
    return 'Analyzing tool results…'
  }
  const formatter = TOOL_ACTION_LABELS[call.name]
  if (formatter) {
    return formatter(call.args)
  }
  const formatted = call.name.replace(/_/g, ' ')
  return `${formatted.charAt(0).toUpperCase() + formatted.slice(1)}…`
}

/**
 * Derives the active status line text from the current state of the agent run.
 */
export function deriveDynamicStatus({
  blocks = [],
  elapsedMs: _elapsedMs,
  fancyWord,
  pendingApproval = null,
}: {
  blocks?: AssistantBlock[]
  elapsedMs: number
  fancyWord: string
  pendingApproval?: any
}): string {
  if (pendingApproval) {
    return 'Waiting for edit approval…'
  }

  if (blocks.length === 0) {
    return `${fancyWord}…`
  }

  const latestBlock = blocks.at(-1)

  if (latestBlock?.type === 'thinking') {
    const tokens = estimateTokens(latestBlock.thinking || '')
    return getThinkingStatus(tokens)
  }

  if (latestBlock?.type === 'tool_call') {
    // Never show transient flickering verbs ("Reading...", "Editing...", "Analyzing tool results...")
    return `${fancyWord}…`
  }

  if (latestBlock?.type === 'text') {
    // When generating response text, keep fancy rotating words
    return `${fancyWord}…`
  }

  return `${fancyWord}…`
}
