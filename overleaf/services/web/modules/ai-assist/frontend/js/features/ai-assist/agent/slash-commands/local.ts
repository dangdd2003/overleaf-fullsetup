import { SLASH_INPUT_RE } from './types'

/**
 * Local slash commands: run by the composer itself, never sent to the model.
 *
 * A model command (catalog.ts) becomes a prompt for the run. A local command
 * only opens something the user can see, such as the context dashboard, so it
 * is kept out of SlashCommandId, the server's scopes and the usage counts.
 */

export type LocalSlashCommandId = 'context' | 'compact'

export type LocalSlashCommand = {
  id: LocalSlashCommandId
  /** Extra names the menu matches and the composer accepts. */
  aliases: string[]
  /** English fallback for the menu label. */
  label: string
  /** English fallback for the one-line menu description. */
  description: string
  /** Shown after the name in the menu, when the command takes words. */
  argumentHint?: string
}

export const LOCAL_SLASH_COMMANDS: LocalSlashCommand[] = [
  {
    id: 'context',
    aliases: ['usage', 'tokens'],
    label: 'Context usage',
    description: "Show what fills this chat's context window",
  },
  {
    id: 'compact',
    aliases: [],
    label: 'Compact conversation',
    description: 'Summarize this chat to free up context',
    argumentHint: '[instructions]',
  },
]

/**
 * A typed local command and the words after its name, or null when the input
 * is not one. The words are trimmed; a command with none gets ''.
 */
export function parseLocalSlashInput(
  text: string
): { command: LocalSlashCommand; args: string } | null {
  const match = SLASH_INPUT_RE.exec(text.trim())
  if (!match) return null
  const command = findLocalSlashCommand(match[1])
  if (!command) return null
  return { command, args: (match[2] ?? '').trim() }
}

/** The local command with this id or alias (case-insensitive), or undefined. */
export function findLocalSlashCommand(
  name: string
): LocalSlashCommand | undefined {
  const q = name.trim().toLowerCase()
  if (!q) return undefined
  return LOCAL_SLASH_COMMANDS.find(
    command => command.id === q || command.aliases.includes(q)
  )
}

/**
 * Local commands the typed name matches: by id or alias prefix, so `/con`
 * finds `context` and `/tok` finds it through `tokens`.
 */
export function filterLocalSlashCommands(query: string): LocalSlashCommand[] {
  const q = query.trim().toLowerCase()
  if (!q) return LOCAL_SLASH_COMMANDS
  return LOCAL_SLASH_COMMANDS.filter(
    command =>
      command.id.startsWith(q) ||
      command.aliases.some(alias => alias.startsWith(q))
  )
}
