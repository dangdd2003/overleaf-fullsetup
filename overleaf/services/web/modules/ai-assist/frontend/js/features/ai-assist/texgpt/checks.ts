import { braceBalance, checkLatex } from '../writing-tools/latex-check'
import { maskComments } from './latex-text'

export type TexGptWarning = {
  kind: 'structure' | 'droppedKey' | 'addedKey' | 'math' | 'package'
  message: string
}

function environmentNet(text: string): Map<string, number> {
  const net = new Map<string, number>()
  for (const match of maskComments(text).matchAll(
    /\\(begin|end)\s*\{([^}]+)\}/g
  )) {
    const name = match[2].trim()
    net.set(name, (net.get(name) ?? 0) + (match[1] === 'begin' ? 1 : -1))
  }
  return net
}

/**
 * Environments and braces the result leaves open (or closes twice) compared
 * with the text it replaces — empty text when inserting. A selection that
 * was itself partial (half an itemize) may stay so.
 */
export function structureProblems(original: string, result: string): string[] {
  const problems: string[] = []
  const before = environmentNet(original)
  const after = environmentNet(result)
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const diff = (after.get(name) ?? 0) - (before.get(name) ?? 0)
    if (diff > 0) {
      problems.push(`\\begin{${name}} has no matching \\end{${name}}`)
    } else if (diff < 0) {
      problems.push(`\\end{${name}} has no matching \\begin{${name}}`)
    }
  }
  if (braceBalance(maskComments(result)) !== braceBalance(maskComments(original))) {
    problems.push('Braces { } do not balance')
  }
  return problems
}

/** Commands and environments that need a package, in the order warnings list them. */
const IMPLIED: Array<[RegExp, string]> = [
  [/\\(?:top|mid|bottom|cmid)rule\b/, 'booktabs'],
  [/\\includegraphics\b/, 'graphicx'],
  [/\\begin\{tikzpicture\}/, 'tikz'],
  [/\\begin\{axis\}/, 'pgfplots'],
  [/\\multirow\b/, 'multirow'],
  [/\\begin\{(?:align|gather|multline|flalign|alignat)\*?\}|\\eqref\b/, 'amsmath'],
  [/\\(?:mathbb|mathfrak)\{/, 'amssymb'],
  [/\\(?:SI|si|num|qty|unit)\{/, 'siunitx'],
  [/\\url\{/, 'url'],
  [/\\href\{/, 'hyperref'],
  [/\\begin\{algorithmic\}/, 'algpseudocode'],
  [/\\begin\{algorithm\}/, 'algorithm'],
  [/\\begin\{(?:subfigure|subtable)\}/, 'subcaption'],
  [/\\begin\{tabularx\}/, 'tabularx'],
  [/\\begin\{longtable\}/, 'longtable'],
  [/\\(?:textcolor|color)\{|\\(?:rowcolor|cellcolor)\b/, 'xcolor'],
  [/\\begin\{lstlisting\}|\\lstinline\b/, 'listings'],
  [/\\[cC]ref\{/, 'cleveref'],
]

/** A loaded package that also provides these (so they need not be loaded). */
const PROVIDES: Record<string, string[]> = {
  mathtools: ['amsmath'],
  amssymb: ['amsfonts'],
  newtxmath: ['amssymb', 'amsfonts'],
  'unicode-math': ['amssymb', 'amsfonts'],
  pgfplots: ['tikz', 'xcolor', 'graphicx'],
  tikz: ['xcolor', 'graphicx'],
  hyperref: ['url'],
  algorithm2e: ['algorithm'],
  algorithmic: ['algpseudocode'],
  algorithmicx: ['algpseudocode'],
  color: ['xcolor'],
  colortbl: ['xcolor'],
}

/** Classes that load these themselves; adding some of them again breaks the build (acmart + amssymb). */
const CLASS_PROVIDES: Record<string, string[]> = {
  acmart: ['amsmath', 'amssymb', 'amsfonts', 'graphicx', 'hyperref', 'booktabs', 'url', 'xcolor'],
  beamer: ['amsmath', 'graphicx', 'hyperref', 'url', 'xcolor'],
}

/** Packages the result needs — declared by the model or implied by its commands — that the project does not load. */
export function missingPackages(
  result: string,
  declared: string[],
  loaded: Set<string>,
  docClass: string | null
): string[] {
  const available = new Set<string>()
  for (const name of loaded) {
    available.add(name)
    for (const provided of PROVIDES[name] ?? []) available.add(provided)
  }
  for (const provided of CLASS_PROVIDES[docClass ?? ''] ?? []) {
    available.add(provided)
  }
  const needed = new Set(declared)
  const masked = maskComments(result)
  for (const [pattern, name] of IMPLIED) {
    if (pattern.test(masked)) needed.add(name)
  }
  return [...needed].filter(name => !available.has(name))
}

export function packageWarning(missing: string[]): TexGptWarning | null {
  if (missing.length === 0) return null
  const list =
    missing.length === 1
      ? missing[0]
      : `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}`
  return {
    kind: 'package',
    message: `Uses ${list}, which this project does not load`,
  }
}

/** What an edit of a selection dropped or changed: keys and math. Warnings only — the request may ask for it. */
export function editWarnings(original: string, result: string): TexGptWarning[] {
  const warnings: TexGptWarning[] = []
  for (const warning of checkLatex(original, result)) {
    if (
      warning.kind === 'droppedKey' ||
      warning.kind === 'addedKey' ||
      warning.kind === 'math'
    ) {
      warnings.push({ kind: warning.kind, message: warning.message })
    }
  }
  return warnings
}
