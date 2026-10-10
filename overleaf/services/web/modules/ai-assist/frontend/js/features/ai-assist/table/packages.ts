import { missingPackages } from '../texgpt/checks'
import { maskComments } from '../texgpt/latex-text'

/** Table commands TeXGPT's list does not know. */
const TABLE_IMPLIED: Array<[RegExp, string]> = [
  [/\\makecell\b/, 'makecell'],
  [/\\diagbox\b/, 'diagbox'],
  [/\\arraybackslash\b/, 'array'],
  [/\\resizebox\b/, 'graphicx'],
  [/\\begin\{threeparttable\}/, 'threeparttable'],
]
const COLOR = /\\(?:rowcolor|cellcolor|columncolor)\b/
const COLORS = /\\(?:rowcolor|cellcolor|columncolor)\b/g

/** Packages the column spec's letters need. */
function specPackages(spec: string): string[] {
  let bare = spec
  for (let i = 0; i < 3; i++) bare = bare.replace(/\{[^{}]*\}/g, '')
  bare = bare.replace(/\[[^\]]*\]/g, '')
  const names: string[] = []
  if (/[Ss]/.test(bare)) names.push('siunitx')
  if (/X/.test(bare)) names.push('tabularx')
  if (/[mbwW<>]/.test(bare)) names.push('array')
  return names
}

/** Whether `\rowcolor` and friends work: colortbl, or xcolor with the `table` option. */
export function colorTableReady(preamble: string, loaded: Set<string>): boolean {
  if (loaded.has('colortbl')) return true
  return /\\usepackage\s*\[[^\]]*\btable\b[^\]]*\]\s*\{xcolor\}/.test(maskComments(preamble))
}

/** Packages the table needs, declared or implied, that the project (or its class) does not load. */
export function tablePackages(
  latex: string,
  spec: string,
  declared: string[],
  loaded: Set<string>,
  docClass: string | null,
  colorReady: boolean
): string[] {
  const masked = maskComments(latex)
  const colors = COLOR.test(masked)
  // TeXGPT's list reads \rowcolor as xcolor; tables need colortbl (or xcolor's table option)
  const needed = new Set(
    missingPackages(
      masked.replace(COLORS, ''),
      declared.filter(name => !(colors && name === 'xcolor')),
      loaded,
      docClass
    )
  )
  for (const [pattern, name] of TABLE_IMPLIED) {
    if (pattern.test(masked)) needed.add(name)
  }
  for (const name of specPackages(spec)) needed.add(name)
  if (colors && !colorReady) needed.add('colortbl')
  return [...needed].filter(name => missingPackages('', [name], loaded, docClass).length > 0)
}
