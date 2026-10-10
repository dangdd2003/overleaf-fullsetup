import { buildRequestMessage } from '../texgpt/prompt'
import { parseReply } from '../texgpt/parse-output'
import {
  projectClass,
  projectKeys,
  projectPackages,
  ProjectSource,
} from '../texgpt/project-text'
import { contextAround, documentHints } from '../writing-tools/prompt'
import { cursorContext, lineState } from '../inline-context/cursor-context'
import type { ShapedText } from '../inline-suggestion/engine'
import type { TexGptNotice } from '../components/texgpt/texgpt-notices'

/** The same first message the TeXGPT popup sends for a free prompt at a cursor. */
export function buildEmptyLineRequest({
  doc,
  pos,
  prompt,
  source,
}: {
  doc: string
  pos: number
  prompt: string
  source: ProjectSource
}): string {
  const hints = documentHints(doc)
  const { before, after } = contextAround(doc, pos, pos)
  return buildRequestMessage({
    docClass: projectClass(source),
    language: hints.language,
    macros: hints.macros,
    packages: [...projectPackages(source)].sort(),
    ...projectKeys(source),
    prompt,
    before,
    after,
    where: { ...cursorContext(doc, pos), line: lineState(doc, pos) },
  })
}

/** Ghost text is LaTeX only: an answer or a refusal shows nothing. */
export function shapeLatex(raw: string, done: boolean): ShapedText {
  const parsed = parseReply(raw, done, 'latex')
  return { text: parsed.kind === 'latex' ? parsed.text : '' }
}

/** What the bar says when a reply had no LaTeX to show. */
export function noticeForEmpty(raw: string): TexGptNotice {
  const parsed = parseReply(raw, true, 'latex')
  return parsed.kind === 'cannot'
    ? { name: 'cannot', reason: parsed.reason }
    : { name: 'empty' }
}
