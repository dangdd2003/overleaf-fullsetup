import { stripFences, withoutReasoning } from '../writing-tools/parse-output'

export type ParsedSentence = {
  id: string
  /** Which result: the correction, or the rewording (prompt.ts). */
  kind: 'grammar' | 'style'
  text: string
  /** What the model says it changed: its justification, not shown. */
  why?: string
}

export type ParsedReply = {
  sentences: ParsedSentence[]
  /** The model said nothing needs a change. */
  none: boolean
  /** A finished reply with no sentence, no <none/> and some text: off contract. */
  malformed: boolean
}

/** `<s id="s1" kind="grammar" why="…">`, attributes in any order; no kind is a correction. */
const SENTENCE = /<s((?:\s+[a-z]+\s*=\s*"[^"]*")+)\s*>([\s\S]*?)<\/s>/g
const ATTRIBUTE = /([a-z]+)\s*=\s*"([^"]*)"/g
const NONE = /<none\s*\/?>/

/**
 * Reads a reply, complete or still streaming. Only closed sentences count,
 * so a sentence is never shown half-written.
 */
export function parseReply(raw: string, done: boolean): ParsedReply {
  const visible = withoutReasoning(raw, done)
  if (visible === null) return { sentences: [], none: false, malformed: false }
  const text = stripFences(visible)
  const sentences: ParsedSentence[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(SENTENCE)) {
    const attributes = Object.fromEntries(
      [...match[1].matchAll(ATTRIBUTE)].map(([, name, value]) => [name, value])
    )
    const id = attributes.id?.trim()
    const kind = attributes.kind?.trim() === 'style' ? 'style' : 'grammar'
    if (!id || seen.has(`${id}\u0000${kind}`)) continue
    seen.add(`${id}\u0000${kind}`)
    sentences.push({
      id,
      kind,
      text: match[2].replace(/<\\\//g, '</').trim(),
      ...(attributes.why ? { why: attributes.why.trim() } : {}),
    })
  }
  const none = NONE.test(text)
  const malformed =
    done && sentences.length === 0 && !none && text.trim() !== ''
  return { sentences, none, malformed }
}
