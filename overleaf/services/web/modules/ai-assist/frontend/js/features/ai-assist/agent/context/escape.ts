/**
 * Escapes user-controlled strings interpolated into pseudo-XML attribute
 * values (paths, the root doc). Attributes have no legitimate use for `&`,
 * `<`, `>` or `"`, so escaping them here is unambiguous and safe.
 */
export function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const ENVELOPE_CLOSING_TAGS = [
  'project-context',
  'files',
  'compile',
  'open-file',
  'selection',
  'outline',
  'attachments',
  'file',
  'compile-error',
  'compile-log-index',
  'raw',
  'prior-fix-run',
  'handoff',
  'step',
  'args',
  'result',
  'said',
  'note',
]

const CLOSING_TAG_PATTERN = new RegExp(
  `</(${ENVELOPE_CLOSING_TAGS.join('|')})>`,
  'g'
)

/**
 * Neutralises this renderer's own closing tags inside body text (selection
 * and attachment content).
 *
 * Bodies are LaTeX, where `&`, `<` and `>` are ordinary characters the model
 * needs verbatim to reason about the document, so XML-escaping them the way
 * we escape attributes would mangle the very source the model is meant to
 * read. Left completely raw, though, a selection or attachment containing
 * e.g. `</project-context>` could forge the envelope's boundary and make
 * project content address the model as if it were the harness. So only the
 * tag names this renderer itself emits are neutralised here, which keeps the
 * text readable while breaking the forgery.
 */
export function neutraliseClosingTags(value: string): string {
  return value.replace(CLOSING_TAG_PATTERN, '<\\/$1>')
}
