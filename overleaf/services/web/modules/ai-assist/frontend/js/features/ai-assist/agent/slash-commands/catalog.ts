import {
  ParsedSlashInput,
  SlashCommandDefinition,
  SlashCommandId,
  SlashParamSpec,
} from './types'
import {
  computeUsageScore,
  getSlashCommandUsage,
} from './usage-store'

/** The free-text param most commands end on, worded the same everywhere. */
function notes(fallback: string): SlashParamSpec {
  return { name: 'notes', kind: 'text', fallback }
}

/**
 * Every slash command the composer offers, in menu order.
 *
 * Metadata only. The harness each command sends lives in ./harness.ts, the
 * context it gathers in ./gather.ts, how its words are read in ./params.ts,
 * and the server's copy of the scopes in app/src/AiAssistSlashCommands.mjs.
 * Adding a command means adding it to the catalog, the harness and the
 * server; the tests on both sides check the ids agree.
 */
export const SLASH_COMMANDS: SlashCommandDefinition[] = [
  {
    id: 'fix',
    aliases: ['debug', 'error'],
    category: 'build',
    labelKey: 'ai_assist_slash_fix',
    label: 'Fix errors',
    descriptionKey: 'ai_assist_slash_fix_desc',
    description: 'Fix the errors of the last compile, cause first',
    argumentHint: '[all] [file.tex:line] [notes]',
    params: [
      {
        name: 'scope',
        kind: 'choice',
        choices: { all: 'all errors', every: 'all errors' },
        fallback: 'the first error, plus any error with the same cause',
      },
      {
        name: 'location',
        kind: 'location',
        fallback: 'where the first error points',
      },
      notes(''),
    ],
    selection: 'none',
    scope: 'edit',
    gather: ['compileErrors', 'preamble'],
  },
  {
    id: 'layout',
    aliases: ['overfull', 'badbox', 'float'],
    category: 'build',
    labelKey: 'ai_assist_slash_layout',
    label: 'Fix layout',
    descriptionKey: 'ai_assist_slash_layout_desc',
    description: 'Fix overfull boxes, stray floats and bad page breaks',
    argumentHint: '[page N] [boxes|floats|breaks] [notes]',
    params: [
      { name: 'page', kind: 'page', fallback: 'every page the warnings name' },
      {
        name: 'focus',
        kind: 'choice',
        multiple: true,
        choices: {
          boxes: 'overfull boxes',
          box: 'overfull boxes',
          overfull: 'overfull boxes',
          floats: 'float placement',
          float: 'float placement',
          figures: 'float placement',
          breaks: 'page breaks',
          pages: 'page breaks',
          widows: 'page breaks',
        },
        fallback: 'overfull boxes, float placement and page breaks',
      },
      notes(''),
    ],
    selection: 'none',
    scope: 'edit',
    gather: ['layoutWarnings', 'packages'],
  },
  {
    id: 'preamble',
    aliases: ['packages', 'usepackage'],
    category: 'build',
    labelKey: 'ai_assist_slash_preamble',
    label: 'Preamble',
    descriptionKey: 'ai_assist_slash_preamble_desc',
    description: 'Add, remove, explain or audit packages safely',
    argumentHint: '[add|remove|explain|audit] [package] [notes]',
    params: [
      {
        name: 'action',
        kind: 'choice',
        choices: {
          add: 'add',
          load: 'add',
          remove: 'remove',
          drop: 'remove',
          explain: 'explain',
          audit: 'audit',
          tidy: 'audit',
          clean: 'audit',
        },
        fallback: 'audit',
      },
      { name: 'package', kind: 'package', after: 'action', fallback: 'none named' },
      notes(''),
    ],
    selection: 'none',
    scope: 'edit',
    gather: ['preamble', 'packages'],
  },
  {
    id: 'rewrite',
    aliases: ['improve', 'refine', 'shorten', 'polish'],
    category: 'write',
    labelKey: 'ai_assist_slash_rewrite',
    label: 'Rewrite',
    descriptionKey: 'ai_assist_slash_rewrite_desc',
    description: 'Rewrite prose in a chosen style; LaTeX stays intact',
    argumentHint: '[clearer|formal|concise|simpler|active|flow] [30%] [notes]',
    params: [
      {
        name: 'style',
        kind: 'choice',
        multiple: true,
        choices: {
          clear: 'clearer',
          clearer: 'clearer',
          formal: 'formal',
          academic: 'formal',
          concise: 'concise',
          shorter: 'concise',
          short: 'concise',
          simple: 'simpler',
          simpler: 'simpler',
          plain: 'simpler',
          active: 'active voice',
          flow: 'better flow',
          fluent: 'better flow',
        },
        fallback: 'clearer, in the same register',
      },
      {
        name: 'length',
        kind: 'amount',
        fallback: 'about the same; about 25% shorter when style is concise',
      },
      notes(''),
    ],
    selection: 'preferred',
    scope: 'edit',
    gather: ['currentSection'],
  },
  {
    id: 'proofread',
    aliases: ['grammar', 'spellcheck', 'typo'],
    category: 'write',
    labelKey: 'ai_assist_slash_proofread',
    label: 'Proofread',
    descriptionKey: 'ai_assist_slash_proofread_desc',
    description: 'Fix grammar, spelling and punctuation, nothing else',
    argumentHint: '[us|uk] [section|file] [focus]',
    params: [
      {
        name: 'spelling',
        kind: 'choice',
        choices: {
          us: 'American',
          american: 'American',
          'en-us': 'American',
          uk: 'British',
          gb: 'British',
          british: 'British',
          'en-gb': 'British',
        },
        fallback: 'match the spelling the document already uses',
      },
      {
        name: 'target',
        kind: 'choice',
        choices: { section: 'the current section', file: 'the open file' },
        fallback: 'the selection, else the paragraph at the cursor',
      },
      notes(''),
    ],
    selection: 'preferred',
    scope: 'edit',
    gather: ['currentSection', 'packages'],
  },
  {
    id: 'translate',
    category: 'write',
    labelKey: 'ai_assist_slash_translate',
    label: 'Translate',
    descriptionKey: 'ai_assist_slash_translate_desc',
    description: 'Translate prose; commands, math and keys stay as they are',
    argumentHint: '<language> [notes]',
    params: [
      { name: 'language', kind: 'language', required: true, fallback: 'required' },
      notes(''),
    ],
    selection: 'preferred',
    scope: 'edit',
    gather: ['currentSection', 'packages'],
  },
  {
    id: 'cite',
    aliases: ['citation', 'source'],
    category: 'insert',
    labelKey: 'ai_assist_slash_cite',
    label: 'Cite',
    descriptionKey: 'ai_assist_slash_cite_desc',
    description: 'Cite a claim from your .bib; add web for new sources',
    argumentHint: '[web] [claim]',
    params: [
      {
        name: 'sources',
        kind: 'choice',
        choices: {
          web: 'the bibliography, then the web',
          new: 'the bibliography, then the web',
        },
        fallback: 'the bibliography only',
      },
      {
        name: 'claim',
        kind: 'text',
        fallback: 'the selection, else the sentence at the cursor',
      },
    ],
    selection: 'preferred',
    scope: 'edit',
    gather: ['cursorWindow', 'bibKeys'],
  },
  {
    id: 'bib',
    aliases: ['bibtex', 'bibliography'],
    category: 'insert',
    labelKey: 'ai_assist_slash_bib',
    label: 'Bibliography',
    descriptionKey: 'ai_assist_slash_bib_desc',
    description: 'Tidy .bib entries: duplicates, missing fields, casing',
    argumentHint: '[duplicates|fields|casing|unused] [key or file]',
    params: [
      {
        name: 'focus',
        kind: 'choice',
        multiple: true,
        choices: {
          duplicates: 'duplicates',
          dupes: 'duplicates',
          fields: 'missing fields',
          missing: 'missing fields',
          casing: 'title casing',
          caps: 'title casing',
          unused: 'unused entries',
        },
        fallback: 'duplicates, missing fields and title casing',
      },
      notes('every .bib file the document uses'),
    ],
    selection: 'none',
    scope: 'edit',
    gather: ['bibKeys'],
  },
  {
    id: 'table',
    aliases: ['tabular'],
    category: 'insert',
    labelKey: 'ai_assist_slash_table',
    label: 'Table',
    descriptionKey: 'ai_assist_slash_table_desc',
    description: 'Build or fix a table from values the document states',
    argumentHint: '[what it should show]',
    params: [
      notes('the values in the selection, else in the paragraph at the cursor'),
    ],
    selection: 'preferred',
    scope: 'edit',
    gather: ['cursorWindow', 'packages', 'labels'],
  },
  {
    id: 'figure',
    aliases: ['tikz', 'diagram', 'image'],
    category: 'insert',
    labelKey: 'ai_assist_slash_figure',
    label: 'Figure',
    descriptionKey: 'ai_assist_slash_figure_desc',
    description: 'Insert a project image or draw a TikZ diagram',
    argumentHint: '[image path] [what to draw]',
    params: [
      { name: 'image', kind: 'file', fallback: 'none, so draw it in TikZ' },
      notes('what the paragraph at the cursor describes'),
    ],
    selection: 'preferred',
    scope: 'edit',
    gather: ['cursorWindow', 'packages', 'labels'],
  },
  {
    id: 'equation',
    aliases: ['math', 'formula'],
    category: 'insert',
    labelKey: 'ai_assist_slash_equation',
    label: 'Equation',
    descriptionKey: 'ai_assist_slash_equation_desc',
    description: "Write an equation in the document's own notation",
    argumentHint: '[inline|display|align] [the equation in words]',
    params: [
      {
        name: 'form',
        kind: 'choice',
        choices: {
          inline: 'inline',
          display: 'display',
          align: 'aligned, multi-line',
          aligned: 'aligned, multi-line',
          multiline: 'aligned, multi-line',
        },
        fallback: 'display',
      },
      notes('the selection, else the sentence at the cursor'),
    ],
    selection: 'preferred',
    scope: 'edit',
    gather: ['cursorWindow', 'macros', 'packages', 'labels'],
  },
  {
    id: 'explain',
    aliases: ['what'],
    category: 'review',
    labelKey: 'ai_assist_slash_explain',
    label: 'Explain',
    descriptionKey: 'ai_assist_slash_explain_desc',
    description: 'Explain a passage, equation, command or error',
    argumentHint: '[what to explain]',
    params: [notes('the selection, else the lines at the cursor')],
    selection: 'preferred',
    scope: 'read',
    gather: ['cursorWindow', 'macros'],
  },
  {
    id: 'summarize',
    aliases: ['summary', 'tldr'],
    category: 'review',
    labelKey: 'ai_assist_slash_summarize',
    label: 'Summarize',
    descriptionKey: 'ai_assist_slash_summarize_desc',
    description: 'Summarize the selection, a section or the paper',
    argumentHint: '[150 words|5 bullets] [section or file]',
    params: [
      {
        name: 'length',
        kind: 'amount',
        fallback:
          '2-3 sentences for a selection, 120 words for a section, 200 for the paper',
      },
      notes('the selection, else the whole paper'),
    ],
    selection: 'preferred',
    scope: 'read',
    gather: ['outline'],
  },
  {
    id: 'review',
    aliases: ['critique', 'feedback'],
    category: 'review',
    labelKey: 'ai_assist_slash_review',
    label: 'Review',
    descriptionKey: 'ai_assist_slash_review_desc',
    description: 'Peer-review the paper or a section; changes nothing',
    argumentHint: '[logic|methods|clarity|structure] [section]',
    params: [
      {
        name: 'focus',
        kind: 'choice',
        multiple: true,
        choices: {
          logic: 'argument and evidence',
          claims: 'argument and evidence',
          methods: 'methods and reproducibility',
          method: 'methods and reproducibility',
          clarity: 'clarity of writing',
          writing: 'clarity of writing',
          structure: 'structure and flow',
          flow: 'structure and flow',
        },
        fallback: 'argument, methods, clarity and structure',
      },
      notes('the whole paper'),
    ],
    selection: 'none',
    scope: 'read',
    gather: ['outline'],
  },
  {
    id: 'check',
    aliases: ['lint', 'consistency'],
    category: 'review',
    labelKey: 'ai_assist_slash_check',
    label: 'Check consistency',
    descriptionKey: 'ai_assist_slash_check_desc',
    description: 'Find broken refs, missing citations and notation drift',
    argumentHint: '[refs|cites|notation|terms]',
    params: [
      {
        name: 'categories',
        kind: 'choice',
        multiple: true,
        choices: {
          refs: 'references and labels',
          labels: 'references and labels',
          cites: 'citations',
          citations: 'citations',
          notation: 'notation and units',
          units: 'notation and units',
          terms: 'terms and acronyms',
          acronyms: 'terms and acronyms',
        },
        fallback:
          'references and labels, citations, notation and units, terms and acronyms',
      },
      notes('the whole project'),
    ],
    selection: 'none',
    scope: 'read',
    gather: ['labels', 'bibKeys', 'macros'],
  },
]

const BY_NAME = new Map<string, SlashCommandDefinition>()
for (const command of SLASH_COMMANDS) {
  BY_NAME.set(command.id, command)
  for (const alias of command.aliases ?? []) BY_NAME.set(alias, command)
}

export function findSlashCommand(
  name: string
): SlashCommandDefinition | undefined {
  return BY_NAME.get(name.toLowerCase())
}

export function slashCommandById(
  id: SlashCommandId
): SlashCommandDefinition | undefined {
  return SLASH_COMMANDS.find(command => command.id === id)
}

const INPUT_RE = /^\/([a-z][a-z-]*)(?:\s+([\s\S]*))?$/i

/**
 * Aliases that name a style of their command, so `/shorten 30%` reads as
 * `/rewrite concise 30%`. The style is put in front of the typed words.
 */
const ALIAS_PREFIX: Record<string, string> = {
  shorten: 'concise',
}

/**
 * The command a composer input starts with, or null.
 *
 * Only a known name at the very start counts, so a message that merely begins
 * with a path (`/usr/share/...`) or an unknown word is sent as typed.
 */
export function parseSlashInput(text: string): ParsedSlashInput | null {
  const match = INPUT_RE.exec(text.trimStart())
  if (!match) return null
  const command = findSlashCommand(match[1])
  if (!command) return null
  const typed = (match[2] ?? '').trim()
  const prefix = ALIAS_PREFIX[match[1].toLowerCase()]
  return { command, args: prefix ? `${prefix} ${typed}`.trim() : typed }
}

/**
 * Normal engineering-level search based on text typing, recent use, and mostly use.
 *
 * Scored by text match (id exact/prefix, alias, label, description) boosted by
 * historical usage frequency and recency.
 */
export function filterSlashCommands(
  query: string,
  options: { includeUsageBoost?: boolean } = { includeUsageBoost: true }
): SlashCommandDefinition[] {
  const q = query.trim().toLowerCase()

  // When query is empty (user just typed /), return catalog ordered with
  // recently and mostly used commands prioritized at the top
  if (!q) {
    if (!options.includeUsageBoost) return SLASH_COMMANDS
    return [...SLASH_COMMANDS].sort((a, b) => {
      const scoreA = computeUsageScore(getSlashCommandUsage(a.id))
      const scoreB = computeUsageScore(getSlashCommandUsage(b.id))
      if (scoreA !== scoreB) return scoreB - scoreA
      return 0
    })
  }

  const scored: { command: SlashCommandDefinition; score: number }[] = []
  SLASH_COMMANDS.forEach((command, index) => {
    let matchScore = -1
    const id = command.id.toLowerCase()
    const aliases = (command.aliases ?? []).map(a => a.toLowerCase())
    const label = command.label.toLowerCase()
    const desc = command.description.toLowerCase()

    if (id === q) {
      matchScore = 600
    } else if (id.startsWith(q)) {
      matchScore = 400
    } else if (aliases.some(a => a === q)) {
      matchScore = 350
    } else if (aliases.some(a => a.startsWith(q))) {
      matchScore = 250
    } else if (id.includes(q)) {
      matchScore = 200
    } else if (aliases.some(a => a.includes(q))) {
      matchScore = 150
    } else if (label.startsWith(q) || label.split(/\s+/).some(w => w.startsWith(q))) {
      matchScore = 120
    } else if (label.includes(q)) {
      matchScore = 90
    } else if (desc.includes(q)) {
      matchScore = 50
    }

    if (matchScore >= 0) {
      const usageBoost = options.includeUsageBoost
        ? computeUsageScore(getSlashCommandUsage(command.id))
        : 0
      const totalScore = matchScore + usageBoost - index / 100
      scored.push({ command, score: totalScore })
    }
  })

  return scored.sort((a, b) => b.score - a.score).map(s => s.command)
}
