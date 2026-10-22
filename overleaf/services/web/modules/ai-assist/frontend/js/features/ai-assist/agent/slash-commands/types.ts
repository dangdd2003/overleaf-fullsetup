/**
 * Slash commands: the shared vocabulary.
 *
 * A slash command is a faster way to type a prompt in the middle of a chat,
 * not a separate chat. Typing `/rewrite formal the intro` sends one ordinary
 * user turn whose text is the user's words and whose frozen `<command>` block
 * carries the command's own harness: the steps to follow, the inputs parsed
 * from the words (`<params>`), the context gathered for it at send time, and
 * the tool scope the server enforces for that turn.
 *
 * Nothing here touches the system prompt or the tool list. Both stay byte-for-
 * byte the same whatever command runs, so the provider's cached prefix (tools,
 * system, every earlier turn) survives a command exactly as it survives a
 * plain message. Claude Code expands its commands into the user turn for the
 * same reason.
 */

/**
 * What the server lets a command's turn do, on top of the mode. A scope only
 * ever narrows what the mode allows; it never approves anything the mode
 * would ask about. Mirrored by SLASH_COMMAND_SCOPES in
 * app/src/AiAssistSlashCommands.mjs, which is what actually enforces it.
 *
 * - `read`: the read-only tools (index queries, search, read, compile result,
 *   PDF views, web tools). Edits, file creation, compiling and settings are
 *   refused.
 * - `edit`: `read` plus edit_file and create_file, and compile_project.
 * - `full`: whatever the mode allows.
 */
export type SlashCommandScope = 'read' | 'edit' | 'full'

/** Whether the command needs highlighted text to make sense. */
export type SelectionNeed = 'preferred' | 'none'

/**
 * Context a command reads at send time and freezes into its block, so the
 * model starts already holding what it would otherwise spend tool calls (and
 * provider round trips) fetching. Each gatherer is best-effort: a failure
 * leaves its section out, never the turn.
 */
export type SlashCommandGatherer =
  /** The errors of the last compile, each with its source window. */
  | 'compileErrors'
  /** Box, float and page warnings of the last compile, with source windows. */
  | 'layoutWarnings'
  /** The root document's preamble. */
  | 'preamble'
  /** The lines of the section around the selection or cursor. */
  | 'currentSection'
  /** A small numbered window around the selection or cursor. */
  | 'cursorWindow'
  /** The section tree with files and lines. */
  | 'outline'
  /** Citation keys defined in the project's .bib files, and which are cited. */
  | 'bibKeys'
  /** Labels and refs: defined, referenced, undefined, unused. */
  | 'labels'
  /** Packages loaded and the document class. */
  | 'packages'
  /** \newcommand, \DeclareMathOperator and similar definitions. */
  | 'macros'

export type SlashCommandId =
  | 'fix'
  | 'layout'
  | 'preamble'
  | 'rewrite'
  | 'proofread'
  | 'translate'
  | 'cite'
  | 'bib'
  | 'table'
  | 'figure'
  | 'equation'
  | 'explain'
  | 'summarize'
  | 'review'
  | 'check'

/**
 * How one input is read from the words after the command name.
 *
 * Options are read from the front of the words, in any order, until a word
 * matches none of them; whatever is left is the command's free text. So
 * `/rewrite formal concise keep the second sentence` gives style
 * `formal, concise` and the text `keep the second sentence`, while a word
 * like "web" in the middle of a claim is never taken for an option.
 *
 * - `choice`: one word from `choices` (alias -> canonical value).
 * - `amount`: a length such as `30%`, `150 words`, `3 sentences`, `5 bullets`.
 * - `location`: `file.tex:42` or `line 42`.
 * - `page`: `page 3` or `p3`.
 * - `file`: a project path with an image or TeX extension.
 * - `language`: a language name or code; required ones also take any
 *   capitalised word, so a language missing from the list still works.
 * - `package`: a package name; only read right after a `choice` it follows.
 * - `text`: the rest of the words. At most one per command, always last.
 */
export type SlashParamKind =
  | 'choice'
  | 'amount'
  | 'location'
  | 'page'
  | 'file'
  | 'language'
  | 'package'
  | 'text'

type SlashParamSpecBase = {
  name: string
  /** `choice` only: more than one value may be given. */
  multiple?: boolean
  /** The send is held until it is given. */
  required?: boolean
  /** What applies when it is not given, as the model reads it; '' for nothing. */
  fallback: string
}

export type SlashChoiceParamSpec = SlashParamSpecBase & {
  kind: 'choice'
  /** Every accepted word, lower case, to its canonical value. */
  choices: Record<string, string>
}

export type SlashPackageParamSpec = SlashParamSpecBase & {
  kind: 'package'
  /** The param it must directly follow. */
  after: string
}

export type SlashSimpleParamSpec = SlashParamSpecBase & {
  kind: 'amount' | 'location' | 'page' | 'file' | 'language' | 'text'
}

export type SlashParamSpec =
  | SlashChoiceParamSpec
  | SlashPackageParamSpec
  | SlashSimpleParamSpec

/** The inputs read from a command's words. Values are canonical. */
export type SlashParamValues = Record<string, string[]>

export type SlashCommandDefinition = {
  id: SlashCommandId
  /** Extra names the menu matches and the parser accepts. */
  aliases?: string[]
  /** English fallback for the menu label. */
  label: string
  /** English fallback for the one-line menu description. */
  description: string
  /** Shown greyed after the name while typing, e.g. `<language> [notes]`. */
  argumentHint?: string
  /** The inputs the words after the name are read into, in hint order. */
  params: SlashParamSpec[]
  selection: SelectionNeed
  scope: SlashCommandScope
  gather: SlashCommandGatherer[]
}

/** What a user entry records about the command it was sent with. */
export type SlashCommandInvocation = {
  id: SlashCommandId
  /** The text typed after the command name, trimmed; '' when none. */
  args: string
}

/** The composer's parse of its input. */
export type ParsedSlashInput = {
  command: SlashCommandDefinition
  args: string
}

/** Matches a slash command input: `/name` or `/name words`. */
export const SLASH_INPUT_RE = /^\/([a-z][a-z-]*)(?:\s+([\s\S]*))?$/i
