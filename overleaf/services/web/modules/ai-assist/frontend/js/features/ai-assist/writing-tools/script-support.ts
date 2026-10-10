import { maskComments } from '../texgpt/latex-text'

export type ScriptWarning = { kind: 'script'; message: string }

type Script = {
  /** Translate targets, as in `LANGUAGES`. */
  languages: string[]
  /** Packages that typeset the script. */
  packages: string[]
  /** babel, polyglossia or fontenc options that do. */
  options: string[]
  /** fontspec or polyglossia alone is enough (XeLaTeX, LuaLaTeX). */
  unicodeEnough: boolean
  hint: string
}

/** Scripts pdfLaTeX's default setup cannot typeset. */
const SCRIPTS: Script[] = [
  {
    languages: ['Chinese (Simplified)', 'Chinese (Traditional)', 'Japanese', 'Korean'],
    packages: ['xeCJK', 'ctex', 'CJKutf8', 'CJK', 'luatexja', 'luatexja-fontspec', 'kotex'],
    options: [],
    unicodeEnough: false,
    hint: 'xeCJK or ctex',
  },
  {
    languages: ['Russian', 'Ukrainian', 'Bulgarian', 'Serbian'],
    packages: [],
    options: ['T2A', 'russian', 'ukrainian', 'bulgarian', 'serbian', 'serbianc'],
    unicodeEnough: true,
    hint: 'babel with T2A fonts, or fontspec',
  },
  {
    languages: ['Greek'],
    packages: [],
    options: ['LGR', 'greek'],
    unicodeEnough: true,
    hint: 'babel with greek, or fontspec',
  },
  {
    languages: ['Vietnamese'],
    packages: ['vietnam'],
    options: ['T5', 'vietnamese', 'vietnam'],
    unicodeEnough: true,
    hint: 'babel with vietnamese and T5 fonts, or fontspec',
  },
  {
    languages: ['Arabic', 'Persian', 'Urdu', 'Hebrew'],
    packages: ['arabxetex', 'bidi', 'arabtex'],
    options: ['arabic', 'persian', 'farsi', 'urdu', 'hebrew'],
    unicodeEnough: true,
    hint: 'polyglossia or bidi with a right-to-left font',
  },
  {
    languages: ['Hindi', 'Bengali', 'Tamil', 'Thai'],
    packages: ['thaispec'],
    options: ['hindi', 'bengali', 'tamil', 'thai'],
    unicodeEnough: true,
    hint: 'fontspec with a font for the script, with XeLaTeX or LuaLaTeX',
  },
]

/** Classes that set up CJK themselves. */
const CJK_CLASSES = /^(?:ctex|ltjs|bxjs|ujarticle|ujbook|ujreport|jarticle|jbook|jreport)/

/**
 * A warning when a translation into `targetLanguage` needs a script the
 * open file's setup cannot typeset. Null when it can, or when the file has
 * no \documentclass: then its setup lives elsewhere and is unknown.
 */
export function scriptWarning(
  targetLanguage: string | undefined,
  doc: string
): ScriptWarning | null {
  const script = SCRIPTS.find(candidate =>
    candidate.languages.includes(targetLanguage ?? '')
  )
  if (!script) return null
  const masked = maskComments(doc)
  const docClass = /\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/.exec(masked)
  if (!docClass) return null
  if (!script.unicodeEnough && CJK_CLASSES.test(docClass[1].trim())) return null

  const packages = new Set<string>()
  const options = new Set<string>()
  const uses = /\\(?:usepackage|RequirePackage)\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}/g
  for (const match of masked.matchAll(uses)) {
    for (const name of match[2].split(',')) packages.add(name.trim())
    for (const option of (match[1] ?? '').split(',')) {
      options.add(option.trim().replace(/^main=/, ''))
    }
  }
  const languages = /\\set(?:main|other)languages?\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g
  for (const match of masked.matchAll(languages)) {
    for (const name of match[1].split(',')) options.add(name.trim())
  }

  if (script.unicodeEnough && (packages.has('fontspec') || packages.has('polyglossia'))) {
    return null
  }
  if (script.packages.some(name => packages.has(name))) return null
  if (script.options.some(option => options.has(option))) return null
  return {
    kind: 'script',
    message: `${targetLanguage} text may not compile here: the document loads nothing for its script (for example ${script.hint}).`,
  }
}
