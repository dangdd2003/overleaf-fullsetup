import { stripFences, withoutReasoning } from '../writing-tools/parse-output'
import { notesIn, packagesIn, tagSection } from '../generator/reply'

export const EQUATION_FORMS = [
  'body',
  'inline',
  'display',
  'equation',
  'equation*',
  'align',
  'align*',
  'gather',
  'gather*',
  'multline',
  'multline*',
] as const

export type EquationForm = (typeof EQUATION_FORMS)[number]

export type ParsedEquation =
  | {
      kind: 'equation'
      /** Null when missing or not one of `EQUATION_FORMS`. */
      form: EquationForm | null
      label: string | null
      /** The body so far. */
      body: string
      bodyComplete: boolean
      /** Exactly as sent; null until `</passage>` (or the end of the reply). */
      passage: string | null
      packages: string[]
      notes: string | null
      complete: boolean
    }
  | { kind: 'cannot'; reason: string; complete: boolean }

const MAX_NOTES = 300
/** The opening tag, never the `<equation/>` slot. */
const EQUATION_OPEN = /<equation\b([^>/]*)>/
const FORM_ATTRIBUTE = /\bform\s*=\s*"([^"]*)"/
const LABEL_ATTRIBUTE = /\blabel\s*=\s*"([^"]*)"/

/** Whether the reply has an `<equation …>` block (the slot does not count). */
export function hasEquationBlock(raw: string): boolean {
  return EQUATION_OPEN.test(raw)
}

const FENCE = /```[a-zA-Z]*[ \t]*\n([\s\S]*?)\n?```/
const PREFACE_LINE = /^[^\n]*:[ \t]*\n/
const OUR_TAGS = /<\/?(?:equation|passage|packages|notes|latex|cannot)\b[^>]*>/g

/**
 * A model that ignored the format: the fenced block, or the reply without a
 * "Here is…:" line, taken as the math. `normalizeBody` removes delimiters.
 */
function fallbackOf(raw: string): { body: string; form: EquationForm | null } | null {
  const fenced = FENCE.exec(raw)
  const text = (fenced ? fenced[1] : raw.replace(PREFACE_LINE, ''))
    .replace(OUR_TAGS, '')
    .trim()
  if (!text) return null
  const environment = /^\\begin\s*\{([a-zA-Z]+\*?)\}/.exec(text)?.[1] ?? ''
  const form = (EQUATION_FORMS as readonly string[]).includes(environment)
    ? (environment as EquationForm)
    : null
  return { body: text, form }
}

/**
 * Reads an equation reply, complete or still streaming. The contract is
 * `<equation form label>body</equation>`, `<passage>` with an `<equation/>`
 * slot, optional `<packages>` and `<notes>`; or `<cannot>`.
 */
export function parseEquationReply(reply: string, done: boolean): ParsedEquation {
  const empty: ParsedEquation = {
    kind: 'equation',
    form: null,
    label: null,
    body: '',
    bodyComplete: false,
    passage: null,
    packages: [],
    notes: null,
    complete: done,
  }
  const raw = withoutReasoning(reply, done)
  if (raw === null) return { ...empty, complete: false }

  const open = EQUATION_OPEN.exec(raw)
  const cannotAt = raw.indexOf('<cannot>')
  if (cannotAt !== -1 && (!open || cannotAt < open.index)) {
    const { body, closed } = tagSection(raw, cannotAt, '<cannot>'.length, '</cannot>', done)
    return { kind: 'cannot', reason: body.trim(), complete: done || closed }
  }
  if (!open) {
    const fallback = done ? fallbackOf(raw) : null
    return fallback
      ? { ...empty, body: fallback.body, form: fallback.form, bodyComplete: true }
      : empty
  }

  const formValue = FORM_ATTRIBUTE.exec(open[1])?.[1].trim() ?? ''
  const form = (EQUATION_FORMS as readonly string[]).includes(formValue)
    ? (formValue as EquationForm)
    : null
  const label = (LABEL_ATTRIBUTE.exec(open[1])?.[1] ?? '').replace(/[^A-Za-z0-9:_.\-]/g, '')

  const found = tagSection(raw, open.index, open[0].length, '</equation>', done)
  const bodyComplete = done || found.closed
  const body = stripFences(found.body).replace(/^\s*\n/, '')

  let passage: string | null = null
  const passageAt = raw.indexOf('<passage>')
  if (passageAt !== -1) {
    const text = tagSection(raw, passageAt, '<passage>'.length, '</passage>', done)
    if (text.closed || done) passage = text.body
  }

  return {
    kind: 'equation',
    form,
    label: label || null,
    body: bodyComplete ? body.trim() : body,
    bodyComplete,
    passage,
    packages: packagesIn(raw),
    notes: notesIn(raw, MAX_NOTES),
    complete: done,
  }
}
