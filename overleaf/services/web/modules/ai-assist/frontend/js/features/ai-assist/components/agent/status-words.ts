import { AssistantBlock } from '../../agent/agent-messages'
import { estimateTokens } from '../../agent/context/budget'

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
  'Lamporting',
  'BibTeXing',
  'TikZing',
  'Beamering',
  'XeLaTeXing',
  'LuaTeXing',
  'Metafonting',
  'Microtyping',
  'Backslashing',
  'Brace-balancing',
  'Macro-expanding',
  'Ampersanding',
  'Tabulating',
  'Itemizing',
  'Enumerating',
  'Cross-referencing',
  'Captioning',
  'Figuring',
  'Theoremizing',
  'Lemmatizing',
  'Subscripting',
  'Superscripting',
  'Italicizing',
  'Emboldening',
  'Small-capping',
  'Em-dashing',
  'Quadding',
  'Hfilling',
  'Vspacing',
  'Clearpaging',
  'Overfulling',
  'Underfulling',
  'Unboxing',
  'Widow-hunting',
  'Orphan-rescuing',
  'Penalizing',
  'Documentclassing',
  'Usepackaging',
  'Newcommanding',
  'Mathmoding',
  'Dollar-signing',
  'Align-starring',
  'Labeling',
  'Hyperreffing',
  'PDFLaTeXing',
  'Latexmking',
  'SyncTeXing',
  'ChkTeXing',
  'Biblatexing',
  'Natbibbing',
  'Fontspeccing',
  'Baselineskipping',
  'Line-breaking',
  'Indenting',
  'Minipaging',
  'Parboxing',
  'Twocolumning',
  'Multicolumning',
  'Booktabbing',
  'Pgfplotting',
  'Tcolorboxing',
  'Verbatimming',
  'Escaping',
  'Table-of-contenting',
  'CTANing',
  'Lion-taming',
  'Pi-approaching',
  // Print shop flavour
  'Gutenberging',
  'Letterpressing',
  'Typecasting',
  'Inking',
  'Serifing',
  'Font-fiddling',
  'Margin-nudging',
  'Galley-proofing',
  'Glyphing',
  'River-fording',
  'Drop-capping',
  'Dingbatting',
  'Fleuron-sprinkling',
  // Overleaf itself
  'Leafing',
  'Page-turning',
  'Track-changing',
  'Collaborating',
  'Rich-texting',
  'Git-bridging',
  'Dropboxing',
  'Templating',
  'Word-counting',
  // Academic & editorial flavour
  'arXiving',
  'Reviewer-2-appeasing',
  'Rebutting',
  'Camera-readying',
  'Deadline-dodging',
  'Citation-hunting',
  'Paraphrasing',
  'Caveating',
  'Abstracting',
  'Appendixing',
  'Acknowledging',
  'Hypothesizing',
  'Postulating',
  'Theorizing',
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
  'Et-al-ing',
  'Ibid-ing',
  'QED-ing',
  'Corollarizing',
  'Axiomatizing',
  'Tenure-tracking',
  'H-indexing',
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
  Lamporting: 'Lamported',
  BibTeXing: 'BibTeXed',
  TikZing: 'TikZed',
  Beamering: 'Beamered',
  XeLaTeXing: 'XeLaTeXed',
  LuaTeXing: 'LuaTeXed',
  Metafonting: 'Metafonted',
  Microtyping: 'Microtyped',
  Backslashing: 'Backslashed',
  'Brace-balancing': 'Brace-balanced',
  'Macro-expanding': 'Macro-expanded',
  Ampersanding: 'Ampersanded',
  Tabulating: 'Tabulated',
  Itemizing: 'Itemized',
  Enumerating: 'Enumerated',
  'Cross-referencing': 'Cross-referenced',
  Captioning: 'Captioned',
  Figuring: 'Figured',
  Theoremizing: 'Theoremized',
  Lemmatizing: 'Lemmatized',
  Subscripting: 'Subscripted',
  Superscripting: 'Superscripted',
  Italicizing: 'Italicized',
  Emboldening: 'Emboldened',
  'Small-capping': 'Small-capped',
  'Em-dashing': 'Em-dashed',
  Quadding: 'Quadded',
  Hfilling: 'Hfilled',
  Vspacing: 'Vspaced',
  Clearpaging: 'Clearpaged',
  Overfulling: 'Overfulled',
  Underfulling: 'Underfulled',
  Unboxing: 'Unboxed',
  'Widow-hunting': 'Widow-hunted',
  'Orphan-rescuing': 'Orphan-rescued',
  Penalizing: 'Penalized',
  Documentclassing: 'Documentclassed',
  Usepackaging: 'Usepackaged',
  Newcommanding: 'Newcommanded',
  Mathmoding: 'Mathmoded',
  'Dollar-signing': 'Dollar-signed',
  'Align-starring': 'Align-starred',
  Labeling: 'Labeled',
  Hyperreffing: 'Hyperreffed',
  PDFLaTeXing: 'PDFLaTeXed',
  Latexmking: 'Latexmked',
  SyncTeXing: 'SyncTeXed',
  ChkTeXing: 'ChkTeXed',
  Biblatexing: 'Biblatexed',
  Natbibbing: 'Natbibbed',
  Fontspeccing: 'Fontspecced',
  Baselineskipping: 'Baselineskipped',
  'Line-breaking': 'Line-broken',
  Indenting: 'Indented',
  Minipaging: 'Minipaged',
  Parboxing: 'Parboxed',
  Twocolumning: 'Twocolumned',
  Multicolumning: 'Multicolumned',
  Booktabbing: 'Booktabbed',
  Pgfplotting: 'Pgfplotted',
  Tcolorboxing: 'Tcolorboxed',
  Verbatimming: 'Verbatimmed',
  Escaping: 'Escaped',
  'Table-of-contenting': 'Table-of-contented',
  CTANing: 'CTANed',
  'Lion-taming': 'Lion-tamed',
  'Pi-approaching': 'Pi-approached',
  // Print shop flavour
  Gutenberging: 'Gutenberged',
  Letterpressing: 'Letterpressed',
  Typecasting: 'Typecast',
  Inking: 'Inked',
  Serifing: 'Serifed',
  'Font-fiddling': 'Font-fiddled',
  'Margin-nudging': 'Margin-nudged',
  'Galley-proofing': 'Galley-proofed',
  Glyphing: 'Glyphed',
  'River-fording': 'River-forded',
  'Drop-capping': 'Drop-capped',
  Dingbatting: 'Dingbatted',
  'Fleuron-sprinkling': 'Fleuron-sprinkled',
  // Overleaf itself
  Leafing: 'Leafed',
  'Page-turning': 'Page-turned',
  'Track-changing': 'Track-changed',
  Collaborating: 'Collaborated',
  'Rich-texting': 'Rich-texted',
  'Git-bridging': 'Git-bridged',
  Dropboxing: 'Dropboxed',
  Templating: 'Templated',
  'Word-counting': 'Word-counted',
  // Academic & editorial flavour
  arXiving: 'arXived',
  'Reviewer-2-appeasing': 'Reviewer-2-appeased',
  Rebutting: 'Rebutted',
  'Camera-readying': 'Camera-readied',
  'Deadline-dodging': 'Deadline-dodged',
  'Citation-hunting': 'Citation-hunted',
  Paraphrasing: 'Paraphrased',
  Caveating: 'Caveated',
  Abstracting: 'Abstracted',
  Appendixing: 'Appendixed',
  Acknowledging: 'Acknowledged',
  Hypothesizing: 'Hypothesized',
  Postulating: 'Postulated',
  Theorizing: 'Theorized',
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
  'Et-al-ing': 'Et-al-ed',
  'Ibid-ing': 'Ibid-ed',
  'QED-ing': 'QED-ed',
  Corollarizing: 'Corollarized',
  Axiomatizing: 'Axiomatized',
  'Tenure-tracking': 'Tenure-tracked',
  'H-indexing': 'H-indexed',
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

/**
 * What the model is doing right now, read off the live stream the way Claude
 * Code's spinner reads it:
 * - requesting: waiting on the provider (no block yet, or a finished block
 *   the model has not followed up on)
 * - thinking: a thinking block is still streaming
 * - responding: reply text is streaming
 * - tool: a tool call has no result yet
 */
export type LiveStatusMode = 'requesting' | 'thinking' | 'responding' | 'tool'

export function deriveStatusMode(blocks: AssistantBlock[]): LiveStatusMode {
  const last = blocks.at(-1)
  if (!last) return 'requesting'
  if (last.type === 'thinking') {
    return last.elapsedMs == null ? 'thinking' : 'requesting'
  }
  if (last.type === 'tool_call') {
    return last.call.result === undefined ? 'tool' : 'requesting'
  }
  return 'responding'
}

/**
 * Tokens the model has streamed back this run: thinking, reply text and tool
 * arguments. An estimate, like every other count in the panel.
 */
export function countOutputTokens(blocks: AssistantBlock[]): number {
  let total = 0
  for (const block of blocks) {
    if (block.type === 'thinking') {
      total += estimateTokens(block.thinking ?? '')
    } else if (block.type === 'text') {
      total += estimateTokens(block.text ?? '')
    } else {
      total += estimateTokens(JSON.stringify(block.call.args ?? ''))
    }
  }
  return total
}

/**
 * "840", "1.2k", "12.4k" — Claude Code's token counter shape.
 */
export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return `${tokens}`
  return `${(tokens / 1000).toFixed(1)}k`
}

/**
 * Claude Code's thinking ladder: the phrase climbs with how long the current
 * thinking burst has run. It says how long, never how close to done.
 */
const THINKING_LADDER: [number, string][] = [
  [45000, 'Deep in thought'],
  [30000, 'Thinking some more'],
  [20000, 'Thinking more'],
  [10000, 'Still thinking'],
]

export function thinkingPhrase(thinkingMs: number): string {
  for (const [after, phrase] of THINKING_LADDER) {
    if (thinkingMs >= after) return phrase
  }
  return 'Thinking'
}
