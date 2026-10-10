import { stripFences } from '../writing-tools/parse-output'
import { CursorWhere } from './context'
import { EquationForm } from './parse-output'

const ENVIRONMENT_FORMS = new Set([
  'equation',
  'equation*',
  'align',
  'align*',
  'gather',
  'gather*',
  'multline',
  'multline*',
])

/**
 * The math only: the delimiters, form environment and `\label` the model was
 * told not to write are taken off (its label is kept as a fallback), blank
 * lines dropped, a trailing `\\` removed.
 */
export function normalizeBody(body: string): { body: string; label: string | null } {
  let text = stripFences(body).trim()
  text = text
    .replace(/^\$\$([^$]*)\$\$$/, '$1')
    .replace(/^\$([^$]*)\$$/, '$1')
    .replace(/^\\\[([\s\S]*)\\\]$/, '$1')
    .replace(/^\\\(([\s\S]*)\\\)$/, '$1')
    .trim()
  const environment = /^\\begin\s*\{([a-zA-Z]+\*?)\}([\s\S]*)\\end\s*\{\1\}$/.exec(text)
  if (environment && ENVIRONMENT_FORMS.has(environment[1])) text = environment[2]
  const label = /\\label\s*\{([^}]*)\}/.exec(text)?.[1].trim() || null
  text = text.replace(/\\label\s*\{[^}]*\}/g, '')
  text = text
    .split('\n')
    .map(line => line.replace(/\s+$/, ''))
    .filter(line => line.trim() !== '')
    .join('\n')
    .trim()
    .replace(/\\\\\s*$/, '')
    .trim()
  return { body: text, label }
}

/** Whether `token` appears outside every nested `\begin…\end` (a `cases` or `pmatrix`). */
export function hasTopLevel(body: string, token: '\\\\' | '&'): boolean {
  let text = body
  let previous: string
  do {
    previous = text
    text = text.replace(
      /\\begin\s*\{([^}]*)\}(?:(?!\\begin\s*\{)[\s\S])*?\\end\s*\{\1\}/g,
      ''
    )
  } while (text !== previous)
  return token === '&' ? /(?<!\\)&/.test(text) : /\\\\/.test(text)
}

const ALIGNED: Record<string, EquationForm> = {
  inline: 'align*',
  display: 'align*',
  equation: 'align',
  'equation*': 'align*',
  gather: 'align',
  'gather*': 'align*',
  multline: 'align',
  'multline*': 'align*',
}

const GATHERED: Record<string, EquationForm> = {
  inline: 'gather*',
  display: 'gather*',
  equation: 'gather',
  'equation*': 'gather*',
}

/**
 * The form to write. Inside math only the body fits; captions, headings and
 * cells take inline math (`coerced` when the model chose otherwise). In
 * prose, `&` needs an align form and a top-level `\\` a multi-line one.
 */
export function resolveForm(
  form: EquationForm | null,
  body: string,
  where: CursorWhere
): { form: EquationForm; coerced: boolean } {
  if (where.kind === 'math') return { form: 'body', coerced: form !== null && form !== 'body' }
  if (where.kind === 'text' && where.container !== 'text') {
    return { form: 'inline', coerced: form !== null && form !== 'inline' }
  }
  const breaks = hasTopLevel(body, '\\\\')
  const amps = hasTopLevel(body, '&')
  let chosen: EquationForm = form ?? (amps ? 'align' : breaks ? 'gather' : 'display')
  if (chosen === 'body') chosen = amps ? 'align*' : breaks ? 'gather*' : 'display'
  if (amps && !chosen.startsWith('align')) chosen = ALIGNED[chosen] ?? chosen
  else if (breaks && GATHERED[chosen]) chosen = GATHERED[chosen]
  return { form: chosen, coerced: false }
}

export function isBlockForm(form: EquationForm): boolean {
  return form !== 'inline' && form !== 'body'
}

export function isNumbered(form: EquationForm): boolean {
  return form === 'equation' || form === 'align' || form === 'gather' || form === 'multline'
}

/** The equation as it goes in the document. */
export function wrapEquation({
  form,
  body,
  label,
  indent,
  parenInline,
}: {
  form: EquationForm
  body: string
  label: string | null
  indent: string
  parenInline: boolean
}): string {
  if (form === 'body') return body
  if (form === 'inline') return parenInline ? `\\(${body}\\)` : `$${body}$`
  const lines = body.split('\n').map(line => `${indent}  ${line}`)
  if (form === 'display') return [`${indent}\\[`, ...lines, `${indent}\\]`].join('\n')
  if (label && isNumbered(form)) {
    if (form === 'align' || form === 'gather') {
      // the first line's number: before its \\
      const first = lines[0]
      const breakAt = /\s*\\\\\s*$/.exec(first)
      lines[0] = breakAt
        ? `${first.slice(0, breakAt.index)} \\label{${label}}${first.slice(breakAt.index)}`
        : `${first} \\label{${label}}`
    } else {
      lines.push(`${indent}  \\label{${label}}`)
    }
  }
  return [`${indent}\\begin{${form}}`, ...lines, `${indent}\\end{${form}}`].join('\n')
}

export { uniqueLabel } from '../generator/labels'

/**
 * `left + wrapped + right`. A block gets its own lines: a line break is
 * added only where text shares its line, so no blank line is ever added.
 */
export function joinAround(left: string, wrapped: string, right: string, block: boolean): string {
  if (!block) return left + wrapped + right
  const lastLine = left.slice(left.lastIndexOf('\n') + 1)
  const head = lastLine.trim()
    ? `${left.replace(/[ \t]+$/, '')}\n`
    : left.slice(0, left.length - lastLine.length)
  const lineEnd = right.indexOf('\n')
  const firstLine = lineEnd === -1 ? right : right.slice(0, lineEnd)
  const tail = firstLine.trim()
    ? `\n${right.replace(/^[ \t]+/, '')}`
    : right.slice(firstLine.length)
  return head + wrapped + tail
}
