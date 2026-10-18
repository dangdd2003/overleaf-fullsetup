import { escapeAttribute } from '../context/escape'
import { SLASH_HARNESS } from './harness'
import { renderParamsBlock } from './params'
import { SlashCommandDefinition } from './types'

/**
 * The `<command>` block a slash command's turn carries: the harness, the
 * inputs read from the words after the name, and the gathered context.
 *
 * Pure: the same command, words and gathered blocks always give the same
 * bytes. The result is stored on the user entry as `commandText` and never
 * rendered again, so a stored transcript rebuilds exactly what was sent.
 *
 * The gathered blocks arrive already escaped by their renderers (file text
 * goes through neutraliseClosingTags), so nothing here re-escapes them: that
 * would mangle the LaTeX the model has to read.
 */
export function renderCommandBlock({
  command,
  args = '',
  gathered,
}: {
  command: SlashCommandDefinition
  args?: string
  gathered: string[]
}): string {
  const lines = [
    `<command name="${escapeAttribute(command.id)}" scope="${escapeAttribute(command.scope)}">`,
    '<instructions>',
    SLASH_HARNESS[command.id],
    '</instructions>',
  ]
  const params = renderParamsBlock(command, args)
  if (params) lines.push(params)
  if (gathered.length > 0) {
    lines.push('<gathered>', gathered.join('\n'), '</gathered>')
  }
  lines.push('</command>')
  return lines.join('\n')
}
