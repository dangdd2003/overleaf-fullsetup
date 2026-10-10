import { withoutPartialTag } from '../writing-tools/parse-output'

/** The body of the tag opening at `at`; while streaming, without a half-written closing tag. */
export function tagSection(
  raw: string,
  at: number,
  openLength: number,
  close: string,
  done: boolean
): { body: string; closed: boolean } {
  const rest = raw.slice(at + openLength)
  const end = rest.indexOf(close)
  if (end !== -1) return { body: rest.slice(0, end), closed: true }
  return { body: done ? rest : withoutPartialTag(rest, close), closed: false }
}

/** Package names from `<packages>a, b</packages>`. */
export function packagesIn(raw: string): string[] {
  const match = raw.match(/<packages>([\s\S]*?)<\/packages>/)
  if (!match) return []
  const names = match[1]
    .split(/[\s,]+/)
    .map(name => name.trim())
    .filter(name => /^[A-Za-z][A-Za-z0-9-]*$/.test(name))
  return [...new Set(names)]
}

/** The `<notes>` text, at most `max` characters. */
export function notesIn(raw: string, max: number): string | null {
  const match = raw.match(/<notes>([\s\S]*?)<\/notes>/)
  const text = match?.[1].trim()
  return text ? text.slice(0, max) : null
}
