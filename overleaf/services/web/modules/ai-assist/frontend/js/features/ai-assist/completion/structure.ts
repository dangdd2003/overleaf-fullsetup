import { maskComments } from '../texgpt/latex-text'

/**
 * What an environment holds, which decides what its next line is:
 * - list: items (`\item`, the exam class's `\question` `\part` `\choice`);
 * - rows: table or aligned-math rows ending in `\\`;
 * - math: one display formula, written on over lines;
 * - code: verbatim, listings, pseudocode statements;
 * - drawing: TikZ, PGFPlots and other picture code;
 * - float: a figure or table's parts (`\centering`, `\includegraphics`,
 *   `\caption`, `\label`);
 * - prose: paragraphs (abstract, quote, theorem, proof, minipage, frame…),
 *   which is also what an unknown environment is taken to hold;
 * - skip: never written by a suggestion: a bibliography (references would
 *   be invented), a `comment` block, a file written out by `filecontents`.
 *
 * The names start from those Overleaf's own LaTeX parser knows (its
 * tabular, equation, equation-array, verbatim, TikZ, figure, table and list
 * environments) and add the common package families; environments the
 * document defines itself are recognised from their definitions.
 */
export type EnvRole = 'list' | 'rows' | 'math' | 'code' | 'drawing' | 'float' | 'prose' | 'skip'

const LIST = [
  'itemize', 'enumerate', 'description',
  // enumitem's starred inline lists, paralist, mdwlist, tasks
  'itemize*', 'enumerate*', 'description*',
  'compactitem', 'compactenum', 'compactdesc', 'inparaitem', 'inparaenum', 'inparadesc',
  'asparaitem', 'asparaenum', 'asparadesc', 'tasks', 'checklist', 'todolist',
  'dinglist', 'dingautolist', 'outline', 'steplist',
  // the exam class
  'questions', 'parts', 'subparts', 'subsubparts', 'choices', 'oneparchoices',
  'checkboxes', 'oneparcheckboxes',
]

const ROWS = [
  'tabular', 'tabular*', 'tabularx', 'tabulary', 'xltabular', 'longtable', 'longtable*',
  'supertabular', 'supertabular*', 'xtabular', 'mpsupertabular', 'tabu', 'longtabu',
  'tblr', 'longtblr', 'talltblr', 'NiceTabular', 'NiceTabular*', 'NiceTabularX',
  'array', 'NiceArray', 'darray',
  'eqnarray', 'eqnarray*', 'align', 'align*', 'alignat', 'alignat*', 'flalign', 'flalign*',
  'gather', 'gather*', 'multline', 'multline*', 'split', 'split*',
  'aligned', 'aligned*', 'alignedat', 'alignedat*', 'gathered', 'gathered*',
  'multlined', 'IEEEeqnarray', 'IEEEeqnarray*', 'subeqnarray', 'subeqnarray*',
  'dgroup', 'dgroup*', 'numcases', 'subnumcases',
  'cases', 'cases*', 'dcases', 'dcases*', 'rcases', 'rcases*', 'drcases',
  'matrix', 'matrix*', 'pmatrix', 'pmatrix*', 'bmatrix', 'bmatrix*', 'Bmatrix', 'Bmatrix*',
  'vmatrix', 'vmatrix*', 'Vmatrix', 'Vmatrix*', 'smallmatrix', 'smallmatrix*',
  'psmallmatrix', 'bsmallmatrix', 'NiceMatrix', 'pNiceMatrix', 'bNiceMatrix',
  'vNiceMatrix', 'VNiceMatrix', 'BNiceMatrix',
]

const MATH = [
  'equation', 'equation*', 'displaymath', 'displaymath*', 'math', 'math*',
  'dmath', 'dmath*', 'dseries', 'dseries*', 'subequations', 'empheq',
]

const CODE = [
  'verbatim', 'verbatim*', 'Verbatim', 'Verbatim*', 'BVerbatim', 'LVerbatim',
  'boxedverbatim', 'spverbatim', 'alltt', 'lstlisting', 'minted', 'tcblisting',
  'codeexample', 'pycode', 'pyblock', 'pyconsole', 'pyverbatim', 'sageblock',
  'sagesilent', 'sagecommandline', 'jllisting', 'knitrout', 'asy', 'asydef', 'gnuplot',
  // pseudocode: one statement per line
  'algorithmic', 'algorithmicx', 'algpseudocode', 'pseudocode', 'codebox',
]

const DRAWING = [
  'tikzpicture', 'scope', 'pgfonlayer', 'pgfinterruptboundingbox', 'tikzcd',
  'axis', 'semilogxaxis', 'semilogyaxis', 'loglogaxis', 'polaraxis', 'ternaryaxis',
  'smithchart', 'groupplot', 'circuitikz', 'forest', 'pspicture', 'picture',
  'feynman', 'feynmandiagram', 'dependency', 'chemfig',
]

const FLOAT = [
  'figure', 'figure*', 'table', 'table*', 'subfigure', 'subtable', 'subfloat',
  'wrapfigure', 'wraptable', 'sidewaysfigure', 'sidewaystable', 'SCfigure', 'SCtable',
  'marginfigure', 'margintable', 'algorithm', 'algorithm*', 'algorithm2e', 'listing',
  'floatrow', 'figwindow',
]

const SKIP = ['thebibliography', 'comment', 'filecontents', 'filecontents*', 'references']

const ROLES = new Map<string, EnvRole>()
for (const [names, role] of [
  [LIST, 'list'],
  [ROWS, 'rows'],
  [MATH, 'math'],
  [CODE, 'code'],
  [DRAWING, 'drawing'],
  [FLOAT, 'float'],
  [SKIP, 'skip'],
] as const) {
  for (const name of names) ROLES.set(name, role)
}

/** Definitions that name what their environment holds outright. */
const DEFINES: Array<[RegExp, EnvRole | 'list-type']> = [
  // enumitem: \newlist{steps}{enumerate}{3}
  [/\\newlist\s*\{([^}]+)\}/g, 'list'],
  [/\\lstnewenvironment\s*\{([^}]+)\}/g, 'code'],
  [/\\DefineVerbatimEnvironment\s*\{([^}]+)\}/g, 'code'],
  [/\\(?:new|renew|New|Renew|Declare)TCBListing\s*\{([^}]+)\}/g, 'code'],
  [/\\newtcblisting\s*\{([^}]+)\}/g, 'code'],
]

/** \newenvironment and its kin: the role of the first structure their opening code begins. */
const NEW_ENVIRONMENT =
  /\\(?:re)?newenvironment\*?\s*\{([^}]+)\}|\\(?:New|Renew|Provide|Declare)DocumentEnvironment\s*\{([^}]+)\}/g
/** How far into a definition its opening code is looked for. */
const DEFINITION_LOOKAHEAD = 600

let defined: { doc: string; roles: Map<string, EnvRole> } | null = null

/** The roles of the environments a document defines, read once per text. */
function definedRoles(doc: string): Map<string, EnvRole> {
  if (defined?.doc === doc) return defined.roles
  const roles = new Map<string, EnvRole>()
  const masked = maskComments(doc)
  for (const [pattern, role] of DEFINES) {
    for (const match of masked.matchAll(pattern)) roles.set(match[1].trim(), role as EnvRole)
  }
  // \newminted{python}{…} defines `pythoncode`
  for (const match of masked.matchAll(/\\newminted\s*(?:\[([^\]]+)\])?\s*\{([^}]+)\}/g)) {
    roles.set(match[1]?.trim() || `${match[2].trim()}code`, 'code')
  }
  for (const match of masked.matchAll(NEW_ENVIRONMENT)) {
    const name = (match[1] ?? match[2]).trim()
    if (roles.has(name)) continue
    const start = match.index! + match[0].length
    const body = masked.slice(start, start + DEFINITION_LOOKAHEAD)
    const inner = /\\begin\s*\{([^}]+)\}/.exec(body)
    const role = inner ? ROLES.get(inner[1].trim()) : undefined
    if (role && role !== 'prose') roles.set(name, role)
  }
  defined = { doc, roles }
  return roles
}

/** What a well-known environment holds; undefined for one a document defines or an unknown one. */
export function builtinRole(name: string): EnvRole | undefined {
  return ROLES.get(name)
}

/** What the environment `name` holds, in `doc`. */
export function envRole(name: string, doc: string): EnvRole {
  return ROLES.get(name) ?? definedRoles(doc).get(name) ?? 'prose'
}

/** The role of the innermost environment, or `skip` when any around it is skipped. */
export function roleAt(envs: string[], doc: string): EnvRole | null {
  const roles = envs.map(env => envRole(env, doc))
  if (roles.includes('skip')) return 'skip'
  return roles.length > 0 ? roles[roles.length - 1] : null
}

/** Roles whose next line goes on with the structure, whatever came before it. */
export function continuesStructure(role: EnvRole | null): boolean {
  return role !== null && role !== 'prose' && role !== 'skip'
}

/**
 * Commands that, alone on a line, end a block or start one: after them a
 * new line at column 0 begins something new, not more of the same.
 */
const STRUCTURAL = new Set([
  'begin', 'end', 'part', 'chapter', 'section', 'subsection', 'subsubsection',
  'paragraph', 'subparagraph', 'addpart', 'addchap', 'addsec', 'frametitle', 'framesubtitle',
  'label', 'caption', 'maketitle', 'tableofcontents', 'listoffigures', 'listoftables',
  'input', 'include', 'subfile', 'import', 'bibliography', 'bibliographystyle',
  'printbibliography', 'addbibresource', 'newpage', 'clearpage', 'cleardoublepage',
  'pagebreak', 'appendix', 'frontmatter', 'mainmatter', 'backmatter', 'centering',
  'vspace', 'vskip', 'hspace', 'bigskip', 'medskip', 'smallskip', 'vfill', 'hfill',
  'includegraphics', 'usepackage', 'documentclass', 'title', 'author', 'date',
  'thanks', 'and', 'keywords', 'pagestyle', 'thispagestyle', 'setcounter',
  'addtocounter', 'newcommand', 'renewcommand', 'def', 'let', 'graphicspath',
  'hline', 'midrule', 'toprule', 'bottomrule', 'item', 'footnote',
])
/** A line that is one command and its arguments, nothing else. */
const COMMAND_LINE = /^\s*\\([A-Za-z@]+)\*?\s*(?:\[[^\]]*\]\s*|\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}\s*)*$/

/**
 * Whether a line, as the line before a new one at column 0, leaves the
 * paragraph open: it holds prose (words, `\\` breaks, inline commands among
 * text) rather than being blank or a structural command on its own.
 */
export function continuesParagraph(previous: string | null): boolean {
  if (previous === null) return false
  const text = maskComments(previous)
  if (!/\S/.test(text)) return false
  const command = COMMAND_LINE.exec(text)
  // A line that is only `\textbf{…}` or `\emph{…}` is still text
  if (command) return !STRUCTURAL.has(command[1])
  return true
}

export const ALL_TABLE_ENVS = new Set([
  'table', 'table*', 'sidewaystable', 'wraptable', 'SCtable', 'margintable',
  'tabular', 'tabular*', 'tabularx', 'tabulary', 'xltabular', 'longtable', 'longtable*',
  'supertabular', 'supertabular*', 'xtabular', 'mpsupertabular', 'tabu', 'longtabu',
  'tblr', 'longtblr', 'talltblr', 'NiceTabular', 'NiceTabular*', 'NiceTabularX',
  'array', 'NiceArray', 'darray',
  'matrix', 'matrix*', 'pmatrix', 'pmatrix*', 'bmatrix', 'bmatrix*', 'Bmatrix', 'Bmatrix*',
  'vmatrix', 'vmatrix*', 'Vmatrix', 'Vmatrix*', 'smallmatrix', 'smallmatrix*',
  'psmallmatrix', 'bsmallmatrix', 'NiceMatrix', 'pNiceMatrix', 'bNiceMatrix',
  'vNiceMatrix', 'VNiceMatrix', 'BNiceMatrix',
])

export const ALL_FLOAT_ENVS = new Set([
  'figure', 'figure*', 'table', 'table*', 'subfigure', 'subtable', 'subfloat',
  'wrapfigure', 'wraptable', 'sidewaysfigure', 'sidewaystable', 'SCfigure', 'SCtable',
  'marginfigure', 'margintable', 'algorithm', 'algorithm*', 'algorithm2e', 'listing',
  'floatrow', 'figwindow',
])

export const ALL_MATH_ENVS = new Set([
  'equation', 'equation*', 'displaymath', 'displaymath*', 'math', 'math*',
  'dmath', 'dmath*', 'dseries', 'dseries*', 'subequations', 'empheq',
  'eqnarray', 'eqnarray*', 'align', 'align*', 'alignat', 'alignat*', 'flalign', 'flalign*',
  'gather', 'gather*', 'multline', 'multline*', 'split', 'split*',
  'aligned', 'aligned*', 'alignedat', 'alignedat*', 'gathered', 'gathered*',
  'multlined', 'IEEEeqnarray', 'IEEEeqnarray*', 'subeqnarray', 'subeqnarray*',
  'cases', 'cases*', 'dcases', 'dcases*', 'rcases', 'rcases*', 'drcases',
])

export const BLOCK_START_PATTERN =
  /^\s*(?:\\begin\s*\{|\\end\s*\{|\\\[|\$\$|\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph|appendix)\b|\\item\b|\\(?:centering|raggedright|raggedleft|caption|label|maketitle|tableofcontents|listoffigures|listoftables)\b|\\(?:newpage|clearpage|cleardoublepage|pagebreak|vspace|bigskip|medskip|smallskip|noindent)\b|\\(?:hline|toprule|midrule|bottomrule|cline|cmidrule)\b)/

export const MAJOR_BLOCK_PATTERN =
  /^\s*(?:\\begin\s*\{(?:table|figure|equation|align|gather|multline|lstlisting|minted|verbatim|tikzpicture)\*?\}|\\\[|\$\$|\\(?:part|chapter|section|subsection|subsubsection)\b)/
