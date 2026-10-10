import {
  cleanOption,
  stripFences,
  withoutPartialTag,
  withoutReasoning,
} from '../writing-tools/parse-output'

/** What a request asks for: code, or a list of titles or keywords. */
export type Expect = 'latex' | 'titles' | 'keywords'

export type ParsedReply =
  | { kind: 'latex'; text: string; packages: string[]; complete: boolean }
  | { kind: 'answer'; text: string; complete: boolean }
  | { kind: 'cannot'; reason: string; complete: boolean }
  | { kind: 'options'; options: string[]; complete: boolean }

const MAX_OPTIONS = 8
const OPEN_TAGS = ['<latex>', '<answer>', '<cannot>', '<titles>', '<keywords>']

/** "Sure, here is the LaTeX code:" and the like, which a model may put first. */
const PREFACE =
  /^\s*(?:(?:sure|certainly|of course)[,.!]?\s*)?(?:here(?:'s| is| are)|below is)\b[^\n]*?\b(?:code|latex|snippet|table|figure|equation|text|version|abstract|titles?|keywords?)\b[^\n]*:[ \t]*\n+/i

/** The body of `<tag>…</tag>` opening at `at`; while streaming, without a half-written closing tag. */
function section(raw: string, tag: string, at: number, done: boolean) {
  const close = `</${tag}>`
  const rest = raw.slice(at + tag.length + 2)
  const end = rest.indexOf(close)
  if (end !== -1) return { body: rest.slice(0, end), closed: true }
  return { body: done ? rest : withoutPartialTag(rest, close), closed: false }
}

function packagesIn(raw: string): string[] {
  const match = raw.match(/<packages>([\s\S]*?)<\/packages>/)
  if (!match) return []
  const names = match[1]
    .split(/[\s,]+/)
    .map(name => name.trim())
    .filter(name => /^[A-Za-z][A-Za-z0-9-]*$/.test(name))
  return [...new Set(names)]
}

/** Fences and echoed tags removed; leading blank lines dropped, indentation kept. */
function cleanLatex(text: string, complete: boolean): string {
  const clean = stripFences(text)
    .replace(/<\/?(?:latex|selection|request|packages)>/g, '')
    .replace(/^\s*\n/, '')
  return complete ? clean.replace(/\s+$/, '') : clean
}

function optionsIn(raw: string, item: 't' | 'k', done: boolean): string[] {
  let found = [
    ...raw.matchAll(new RegExp(`<${item}>([\\s\\S]*?)</${item}>`, 'g')),
  ].map(match => match[1])
  if (found.length === 0 && done && !raw.includes(`<${item}>`)) {
    // A model that ignored the format: one option per line (keywords: or per comma)
    found = raw
      .replace(PREFACE, '')
      .replace(/<\/?(?:titles|keywords)>/g, '')
      .split(item === 'k' ? /\n|,|;/ : /\n/)
      .map(line => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, ''))
      .filter(line => !/:\s*$/.test(line))
  }
  const seen = new Set<string>()
  return found
    .map(cleanOption)
    .filter(option => {
      const key = option.toLowerCase()
      if (!option || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, MAX_OPTIONS)
}

/**
 * Reads a TeXGPT reply, complete or still streaming. The contract is one
 * <latex> block (with an optional <packages> list), an <answer>, a <cannot>,
 * or for generators <titles>/<keywords>. A model that ignores it has its
 * reply taken as LaTeX — only the fenced block when it wrapped the code in
 * prose — or, for generators, one option per line.
 */
export function parseReply(
  reply: string,
  done: boolean,
  expect: Expect = 'latex'
): ParsedReply {
  const empty: ParsedReply =
    expect === 'latex'
      ? { kind: 'latex', text: '', packages: [], complete: false }
      : { kind: 'options', options: [], complete: false }
  const raw = withoutReasoning(reply, done)
  if (raw === null) return empty

  const first = OPEN_TAGS.map(tag => ({ tag, at: raw.indexOf(tag) }))
    .filter(found => found.at !== -1)
    .sort((a, b) => a.at - b.at)[0]
  if (first) {
    const name = first.tag.slice(1, -1)
    const { body, closed } = section(raw, name, first.at, done)
    const complete = done || closed
    switch (name) {
      case 'cannot':
        return { kind: 'cannot', reason: body.trim(), complete }
      case 'answer':
        return {
          kind: 'answer',
          text: complete ? body.trim() : body.trimStart(),
          complete,
        }
      case 'titles':
        return { kind: 'options', options: optionsIn(raw, 't', done), complete }
      case 'keywords':
        return { kind: 'options', options: optionsIn(raw, 'k', done), complete }
      default:
        return {
          kind: 'latex',
          text: cleanLatex(body, complete),
          packages: packagesIn(raw),
          complete,
        }
    }
  }

  // Nothing to show while the reply could still be opening a tag or a preface
  const head = raw.trimStart()
  if (!done && OPEN_TAGS.some(tag => tag.startsWith(head))) return empty
  if (!done && !head.includes('\n') && PREFACE.test(`${head}\n`)) return empty

  if (expect !== 'latex') {
    return {
      kind: 'options',
      options: done ? optionsIn(raw, expect === 'titles' ? 't' : 'k', true) : [],
      complete: done,
    }
  }

  const body = raw.replace(PREFACE, '')
  const fence = /```[a-zA-Z]*[ \t]*\n([\s\S]*?)(\n```|$)/.exec(body)
  if (
    fence &&
    (body.slice(0, fence.index).trim() ||
      body.slice(fence.index + fence[0].length).trim())
  ) {
    return {
      kind: 'latex',
      text: cleanLatex(fence[1], done),
      packages: [],
      complete: done,
    }
  }
  return {
    kind: 'latex',
    text: cleanLatex(body, done),
    packages: packagesIn(raw),
    complete: done,
  }
}
