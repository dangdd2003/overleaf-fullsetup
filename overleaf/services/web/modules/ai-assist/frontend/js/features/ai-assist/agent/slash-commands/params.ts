import { neutraliseClosingTags } from '../context/escape'
import {
  SlashCommandDefinition,
  SlashParamSpec,
  SlashParamValues,
} from './types'

/**
 * Reads a command's words into named inputs, and writes them for the model.
 *
 * The model is handed resolved values (`spelling: British`) instead of the raw
 * words, and a stated fallback for every input the user left out, so it never
 * has to guess what `/proofread uk` meant or what applies when nothing was
 * said. Pure and deterministic: the same words give the same block.
 */

/** Language names and codes to the name the model is given. */
const LANGUAGES: Record<string, string> = {}
for (const [name, ...codes] of [
  ['English', 'en'],
  ['British English', 'en-gb'],
  ['American English', 'en-us'],
  ['German', 'de', 'deutsch'],
  ['French', 'fr', 'francais', 'français'],
  ['Spanish', 'es', 'espanol', 'español'],
  ['Italian', 'italiano'],
  ['Portuguese', 'pt', 'portugues', 'português'],
  ['Brazilian Portuguese', 'pt-br'],
  ['Dutch', 'nl'],
  ['Swedish', 'sv'],
  ['Norwegian', 'nb'],
  ['Danish', 'da'],
  ['Finnish', 'fi'],
  ['Polish', 'pl'],
  ['Czech', 'cs'],
  ['Slovak', 'sk'],
  ['Hungarian', 'hu'],
  ['Romanian', 'ro'],
  ['Greek', 'el'],
  ['Russian', 'ru'],
  ['Ukrainian', 'uk-ua'],
  ['Turkish', 'tr'],
  ['Arabic', 'ar'],
  ['Hebrew', 'he'],
  ['Persian', 'fa', 'farsi'],
  ['Hindi', 'hi'],
  ['Bengali', 'bn'],
  ['Chinese', 'zh', 'mandarin'],
  ['Simplified Chinese', 'zh-cn', 'zh-hans'],
  ['Traditional Chinese', 'zh-tw', 'zh-hant'],
  ['Japanese', 'ja'],
  ['Korean', 'ko'],
  ['Vietnamese', 'vi', 'tiếng việt'],
  ['Thai', 'th'],
  ['Indonesian', 'id'],
  ['Malay', 'ms'],
  ['Catalan', 'ca'],
  ['Croatian', 'hr'],
  ['Serbian', 'sr'],
  ['Slovenian', 'sl'],
  ['Bulgarian', 'bg'],
  ['Latin', 'la'],
]) {
  LANGUAGES[name.toLowerCase()] = name
  for (const code of codes) LANGUAGES[code] = name
}

const own = <T>(record: Record<string, T>, key: string): T | undefined =>
  Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined

type Match = { values: string[]; length: number }

/** The first word of `rest`, without a trailing comma. */
function firstWord(rest: string): { word: string; length: number } | null {
  const match = /^(\S+?),?(?=\s|$)/.exec(rest)
  return match ? { word: match[1], length: match[0].length } : null
}

const AMOUNT_PATTERNS: Array<[RegExp, (n: string) => string]> = [
  [/^-?(\d{1,2})\s?%/, n => `${n}% shorter`],
  [/^(\d{1,5})\s?(?:w|words?)\b/i, n => `${n} words`],
  [/^(\d{1,3})\s?(?:sentences?)\b/i, n => `${n} sentences`],
  [/^(\d{1,2})\s?(?:bullets?|points?)\b/i, n => `${n} bullet points`],
]

function matchParam(
  spec: SlashParamSpec,
  rest: string,
  previous: string | null,
  values: SlashParamValues
): Match | null {
  switch (spec.kind) {
    case 'choice': {
      const first = firstWord(rest)
      const value = first ? own(spec.choices, first.word.toLowerCase()) : undefined
      if (!first || !value) return null
      return { values: [value], length: first.length }
    }
    case 'amount': {
      for (const [pattern, format] of AMOUNT_PATTERNS) {
        const match = pattern.exec(rest)
        if (match) return { values: [format(match[1])], length: match[0].length }
      }
      return null
    }
    case 'location': {
      const file = /^([\w./-]+\.(?:tex|bib|sty|cls|ltx)):(\d+)\b/i.exec(rest)
      if (file) {
        return {
          values: [`${file[1].replace(/^\.?\//, '')}:${file[2]}`],
          length: file[0].length,
        }
      }
      const line = /^(?:l|line)\s?(\d+)\b/i.exec(rest)
      return line ? { values: [`line ${line[1]}`], length: line[0].length } : null
    }
    case 'page': {
      const page = /^(?:p|page)\s?(\d{1,4})\b/i.exec(rest)
      return page ? { values: [`page ${page[1]}`], length: page[0].length } : null
    }
    case 'file': {
      const file =
        /^([\w./-]+\.(?:png|jpe?g|pdf|eps|svg|gif|webp|tikz|pgf|tex))(?=\s|,|$)/i.exec(
          rest
        )
      return file
        ? { values: [file[1].replace(/^\.?\//, '')], length: file[1].length }
        : null
    }
    case 'language': {
      // "/translate into French" reads like "/translate French"
      const lead = /^(?:into|to)\s+/i.exec(rest)?.[0].length ?? 0
      const words = rest.slice(lead)
      // Two words first, so "Brazilian Portuguese" is not read as one word
      const two = /^(\S+\s+\S+?),?(?=\s|$)/.exec(words)
      const twoKnown = two ? own(LANGUAGES, two[1].toLowerCase()) : undefined
      if (two && twoKnown) {
        return {
          values: [twoKnown],
          length: lead + two[0].length,
        }
      }
      const first = firstWord(words)
      if (!first) return null
      const known = own(LANGUAGES, first.word.toLowerCase())
      if (known) return { values: [known], length: lead + first.length }
      // A language the list lacks, written as a name: "Tagalog", "Swahili"
      if (spec.required && /^\p{Lu}\p{Ll}{2,}$/u.test(first.word)) {
        return { values: [first.word], length: lead + first.length }
      }
      return null
    }
    case 'package': {
      if (previous !== spec.after || !values[spec.after]) {
        return null
      }
      const pkg = /^([a-zA-Z][a-zA-Z0-9-]*[a-zA-Z0-9])(?=\s|,|$)/.exec(rest)
      return pkg ? { values: [pkg[1]], length: pkg[0].length } : null
    }
    case 'text':
      return null
  }
}

/**
 * The inputs in `args`. Options are taken from the front, in any order, until
 * a word matches none; the rest is the free-text param, if the command has one.
 */
export function parseSlashParams(
  command: SlashCommandDefinition,
  args: string
): SlashParamValues {
  const values: SlashParamValues = {}
  const options = command.params.filter(spec => spec.kind !== 'text')
  const text = command.params.find(spec => spec.kind === 'text')
  let rest = args.trim()
  let previous: string | null = null

  while (rest) {
    let matched = false
    for (const spec of options) {
      const taken = values[spec.name]
      if (taken && !spec.multiple) continue
      const match = matchParam(spec, rest, previous, values)
      if (!match) continue
      const merged = [...(taken ?? [])]
      for (const value of match.values) {
        if (!merged.includes(value)) merged.push(value)
      }
      values[spec.name] = merged
      rest = rest.slice(match.length).replace(/^[\s,]+/, '')
      previous = spec.name
      matched = true
      break
    }
    if (!matched) break
  }

  if (rest && text) values[text.name] = [rest]
  return values
}

/** The required params the words leave out, by name. */
export function missingSlashParams(
  command: SlashCommandDefinition,
  args: string
): string[] {
  const values = parseSlashParams(command, args)
  return command.params
    .filter(spec => spec.required && !values[spec.name]?.length)
    .map(spec => spec.name)
}

/**
 * The `<params>` block: one line per declared input, the given value or
 * `none` with the fallback that applies. Null for a command with no params.
 */
export function renderParamsBlock(
  command: SlashCommandDefinition,
  args: string
): string | null {
  if (command.params.length === 0) return null
  const values = parseSlashParams(command, args)
  const lines = command.params.map(spec => {
    const given = values[spec.name]
    if (given?.length) return `${spec.name}: ${given.join(', ')}`
    return spec.fallback
      ? `${spec.name}: none (${spec.fallback})`
      : `${spec.name}: none`
  })
  return ['<params>', neutraliseClosingTags(lines.join('\n')), '</params>'].join(
    '\n'
  )
}
