import { Expect } from './parse-output'
import {
  findCommandArgument,
  findEnvironmentBody,
  maskComments,
  TextRange,
  trimRange,
} from './latex-text'

export type GeneratorId = 'title' | 'abstract' | 'keywords'

/** Menu order, as in the official popup. */
export const GENERATORS: GeneratorId[] = ['title', 'abstract', 'keywords']

export const GENERATOR_EXPECT: Record<GeneratorId, Expect> = {
  title: 'titles',
  abstract: 'latex',
  keywords: 'keywords',
}

/** An existing title, abstract or keyword list in the open file: the text inside its command or environment. */
export type ExistingBlock = TextRange & {
  /** Only whitespace across lines inside: a replacement goes on its own line. */
  pad: boolean
  /** Keywords: how the existing list separates its items. */
  separator?: string
}

/** Keyword environments, with the separator each class documents. */
const KEYWORD_ENVIRONMENTS: Array<[string, string]> = [
  ['IEEEkeywords', ', '],
  ['keyword', ' \\sep '],
  ['keywords', ', '],
]

/** The plain-class fallback this module writes: `\textbf{Keywords:} a, b`. */
const BOLD_KEYWORDS = /\\textbf\s*\{\s*Keywords\s*:?\s*\}[ \t]*:?[ \t]*/i

function separatorIn(list: string, fallback: string): string {
  if (/\\sep\b/.test(list)) return ' \\sep '
  if (/\\and\b/.test(list)) return ' \\and '
  if (list.includes(';')) return '; '
  if (list.includes(',')) return ', '
  return fallback
}

function locate(
  id: GeneratorId,
  text: string,
  docClass: string | null
): { range: TextRange; separator?: string } | null {
  if (id === 'title') {
    const range = findCommandArgument(text, 'title')
    return range && { range }
  }
  if (id === 'abstract') {
    const range = findEnvironmentBody(text, 'abstract')
    return range && { range }
  }
  for (const [env, fallback] of KEYWORD_ENVIRONMENTS) {
    const range = findEnvironmentBody(text, env)
    if (range) {
      return {
        range,
        separator: separatorIn(text.slice(range.from, range.to), fallback),
      }
    }
  }
  const command = findCommandArgument(text, 'keywords')
  if (command) {
    return {
      range: command,
      separator: separatorIn(
        text.slice(command.from, command.to),
        docClass === 'llncs' ? ' \\and ' : ', '
      ),
    }
  }
  const bold = BOLD_KEYWORDS.exec(maskComments(text))
  if (bold) {
    const from = bold.index + bold[0].length
    const lineEnd = text.indexOf('\n', from)
    const range = { from, to: lineEnd === -1 ? text.length : lineEnd }
    return { range, separator: separatorIn(text.slice(from, range.to), ', ') }
  }
  return null
}

/** The existing block for `id` in the open file, trimmed to its text. */
export function findExisting(
  id: GeneratorId,
  text: string,
  docClass: string | null
): ExistingBlock | null {
  const found = locate(id, text, docClass)
  if (!found) return null
  const { from, to, empty } = trimRange(text, found.range)
  return {
    from,
    to,
    pad: empty && text.slice(from, to).includes('\n'),
    separator: found.separator,
  }
}

function keywordList(value: string | string[]): string[] {
  return Array.isArray(value)
    ? value
    : value
        .split(/\s*(?:,|;|\\sep\b|\\and\b)\s*/)
        .map(keyword => keyword.trim())
        .filter(Boolean)
}

function single(value: string | string[]): string {
  return (Array.isArray(value) ? (value[0] ?? '') : value).trim()
}

/** The text that replaces an existing block's contents. */
export function blockReplacement(
  id: GeneratorId,
  value: string | string[],
  block: ExistingBlock
): string {
  const text =
    id === 'keywords'
      ? keywordList(value).join(block.separator ?? ', ')
      : single(value)
  return block.pad ? `\n${text}\n` : text
}

/** A keyword block for a document that has none, in its class's convention. */
export function newKeywordsBlock(
  keywords: string[],
  docClass: string | null
): string {
  switch (docClass) {
    case 'IEEEtran':
      return `\\begin{IEEEkeywords}\n${keywords.join(', ')}\n\\end{IEEEkeywords}`
    case 'elsarticle':
      return `\\begin{keyword}\n${keywords.join(' \\sep ')}\n\\end{keyword}`
    case 'llncs':
      return `\\keywords{${keywords.join(' \\and ')}}`
    case 'acmart':
    case 'sn-jnl':
    case 'svjour3':
    case 'svjour':
      return `\\keywords{${keywords.join(', ')}}`
    default:
      // `article` and most classes have no \keywords command
      return `\\noindent\\textbf{Keywords:} ${keywords.join(', ')}`
  }
}

/** A whole new block, for a document that has none (or to insert at the cursor). */
export function newBlock(
  id: GeneratorId,
  value: string | string[],
  docClass: string | null
): string {
  if (id === 'keywords') return newKeywordsBlock(keywordList(value), docClass)
  const text = single(value)
  return id === 'title'
    ? `\\title{${text}}`
    : `\\begin{abstract}\n${text}\n\\end{abstract}`
}

/** The fixed task a generator sends instead of the author's words. */
export function generatorTask(id: GeneratorId): string {
  switch (id) {
    case 'title':
      return [
        'Suggest 5 titles for the paper in <paper>, best first.',
        'Each title is specific and informative: it names the main contribution or finding, avoids unexplained acronyms and filler such as "A study of", "Towards" or "Novel", and is in the language of the paper. Use LaTeX markup only where it is needed, for math or special characters.',
        'Make them real alternatives in style: for example one that states the main finding, one that names the method with a subtitle after a colon, and one short descriptive title.',
        'Reply with <titles><t>title</t><t>title</t>…</titles> only.',
      ].join('\n')
    case 'abstract':
      return [
        'Write the abstract of the paper in <paper>: one paragraph of 150–250 words that states the problem, the approach, the main results and why they matter.',
        "Base it on the body of the paper (introduction, method, results, conclusion), not on an abstract it may already have. Use only what the paper says: no claims, numbers, citations or references it does not contain, and keep the paper's own terms and numbers exactly. Write in the language of the paper.",
        'Reply with <latex>…</latex> holding only the abstract text, without \\begin{abstract} or \\end{abstract}.',
      ].join('\n')
    case 'keywords':
      return [
        'Suggest 4 to 6 keywords for the paper in <paper>: terms a reader would search for, specific to its topic and methods, not only the words of its title.',
        'Write them in the language of the paper, lower case except proper nouns and acronyms.',
        'Reply with <keywords><k>keyword</k><k>keyword</k>…</keywords> only.',
      ].join('\n')
  }
}
