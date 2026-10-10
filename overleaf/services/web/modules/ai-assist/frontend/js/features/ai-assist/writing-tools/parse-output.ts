export type ParsedRewrite =
  | { kind: 'rewrite'; text: string; complete: boolean }
  | { kind: 'cannot'; reason: string; complete: boolean }

export type ParsedSynonyms =
  | { kind: 'synonyms'; options: string[]; complete: boolean }
  | { kind: 'cannot'; reason: string; complete: boolean }

const OPEN = '<rewrite>'
const CLOSE = '</rewrite>'
const CANNOT_OPEN = '<cannot>'
const CANNOT_CLOSE = '</cannot>'
const MAX_SYNONYMS = 8

/** Drops a trailing fragment that could still grow into `tag` ("</rew"). */
export function withoutPartialTag(text: string, tag: string): string {
  for (let n = Math.min(tag.length - 1, text.length); n > 0; n--) {
    if (text.endsWith(tag.slice(0, n))) return text.slice(0, -n)
  }
  return text
}

export function stripFences(text: string): string {
  return text
    .replace(/^\s*```[a-zA-Z]*[ \t]*\n?/, '')
    .replace(/\n?```\s*$/, '')
}

/** Echoed input tags have no place in a result. */
function stripEchoedTags(text: string): string {
  return text.replace(/<\/?(?:selection|rewrite)>/g, '')
}

function finish(text: string, complete: boolean): string {
  const clean = stripEchoedTags(stripFences(text))
  return complete ? clean.trim() : clean.trimStart()
}

const REASONING = /^\s*<(think|thinking|reasoning)>[\s\S]*?<\/\1>/
const OPEN_REASONING = /^\s*<(think|thinking|reasoning)>/

/**
 * Some models (DeepSeek, Qwen, gateways that flatten reasoning) put their
 * reasoning in the reply text. It is never part of the answer; while it is
 * still open there is nothing to show yet.
 */
export function withoutReasoning(raw: string, done: boolean): string | null {
  let text = raw
  while (REASONING.test(text)) text = text.replace(REASONING, '')
  const open = text.match(OPEN_REASONING)
  if (open) return done ? text.slice(open[0].length) : null
  return text
}

/** "Sure, here is the revised text:" and the like, which a model may put first. */
const PREFACE =
  /^\s*(?:(?:sure|certainly|of course)[,.!]?\s*)?(?:here(?:'s| is| are)|below is)\s+(?:the|your|a|an)\b[^\n]*?\b(?:text|version|rewrite|translation|paragraph|sentence|passage|selection)\b[^\n]*:[ \t]*\n+/i

function parseCannot(raw: string, done: boolean, at: number) {
  const rest = raw.slice(at + CANNOT_OPEN.length)
  const end = rest.indexOf(CANNOT_CLOSE)
  const reason =
    end === -1 ? withoutPartialTag(rest, CANNOT_CLOSE) : rest.slice(0, end)
  return {
    kind: 'cannot' as const,
    reason: reason.trim(),
    complete: done || end !== -1,
  }
}

/**
 * Reads a rewrite reply, complete or still streaming. The contract is one
 * <rewrite> block or one <cannot> block; a model that ignores it has its whole
 * reply (minus code fences) taken as the rewrite.
 */
export function parseRewrite(reply: string, done: boolean): ParsedRewrite {
  const raw = withoutReasoning(reply, done)
  if (raw === null) return { kind: 'rewrite', text: '', complete: false }
  const cannotAt = raw.indexOf(CANNOT_OPEN)
  const openAt = raw.indexOf(OPEN)
  if (cannotAt !== -1 && (openAt === -1 || cannotAt < openAt)) {
    return parseCannot(raw, done, cannotAt)
  }
  if (openAt !== -1) {
    const rest = raw.slice(openAt + OPEN.length)
    const end = rest.indexOf(CLOSE)
    const complete = done || end !== -1
    const body =
      end !== -1
        ? rest.slice(0, end)
        : done
          ? rest
          : withoutPartialTag(rest, CLOSE)
    return { kind: 'rewrite', text: finish(body, complete), complete }
  }
  // Nothing to show while the reply could still be opening a tag
  const head = raw.trimStart()
  if (!done && (OPEN.startsWith(head) || CANNOT_OPEN.startsWith(head))) {
    return { kind: 'rewrite', text: '', complete: false }
  }
  if (!done && PREFACE.test(`${head}\n`) && !head.includes('\n')) {
    return { kind: 'rewrite', text: '', complete: false }
  }
  return {
    kind: 'rewrite',
    text: finish(raw.replace(PREFACE, ''), done),
    complete: done,
  }
}

/** Drops wrapping quotes and a closing full stop a list item may carry. */
export function cleanOption(option: string): string {
  return option
    .trim()
    .replace(/^(?:"(.+)"|“(.+)”|‘(.+)’)$/, '$1$2$3')
    .replace(/^([^.]*)\.$/, '$1')
    .trim()
}

/** Reads a <synonyms><s>…</s></synonyms> reply, deduplicated, best first. */
export function parseSynonyms(reply: string, done: boolean): ParsedSynonyms {
  const raw = withoutReasoning(reply, done)
  if (raw === null) return { kind: 'synonyms', options: [], complete: false }
  const cannotAt = raw.indexOf(CANNOT_OPEN)
  if (cannotAt !== -1) return parseCannot(raw, done, cannotAt)

  let options = [...raw.matchAll(/<s>([\s\S]*?)<\/s>/g)].map(m => m[1])
  if (options.length === 0 && done && !raw.includes('<s>')) {
    // A model that ignored the format: one alternative per line or comma
    options = raw
      .replace(/<\/?synonyms>/g, '')
      .split(/\n|,/)
      .map(s => s.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, ''))
  }
  options = options.map(cleanOption)

  const seen = new Set<string>()
  const unique = options.filter(option => {
    const key = option.toLowerCase()
    if (!option || seen.has(key)) return false
    seen.add(key)
    return true
  })
  return {
    kind: 'synonyms',
    options: unique.slice(0, MAX_SYNONYMS),
    complete: done || raw.includes('</synonyms>'),
  }
}
