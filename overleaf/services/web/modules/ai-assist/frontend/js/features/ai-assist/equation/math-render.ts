import { EditorState } from '@codemirror/state'
import { loadMathJax } from '@/features/mathjax/load-mathjax'
import { documentCommands } from '@/features/source-editor/languages/latex/document-commands'
import { documentEnvironments } from '@/features/source-editor/languages/latex/document-environments'
import { MathKind } from './context'
import { EquationForm } from './parse-output'

/**
 * TeX that MathJax shows for a body: `aligned`/`gathered` stand in for the
 * environments, which MathJax would otherwise number or refuse.
 */
export function previewTex(
  form: EquationForm,
  body: string,
  math?: MathKind
): { tex: string; display: boolean } {
  if (form === 'inline') return { tex: body, display: false }
  if (form === 'body') {
    if (math === 'inline') return { tex: body, display: false }
    if (math === 'align') return { tex: `\\begin{aligned}${body}\\end{aligned}`, display: true }
    return { tex: body, display: true }
  }
  const base = form.replace(/\*$/, '')
  if (base === 'align') return { tex: `\\begin{aligned}${body}\\end{aligned}`, display: true }
  if (base === 'gather' || base === 'multline') {
    return { tex: `\\begin{gathered}${body}\\end{gathered}`, display: true }
  }
  return { tex: body, display: true }
}

/** The author's own definitions in the open file, collected as upstream's math preview does. */
export function documentDefinitions(state: EditorState): string {
  let definitions = ''
  for (const environment of state.field(documentEnvironments, false)?.items ?? []) {
    if (environment.type === 'definition') definitions += `${environment.raw}\n`
  }
  for (const command of state.field(documentCommands, false)?.items ?? []) {
    if (command.type === 'definition' && command.raw) definitions += `${command.raw}\n`
  }
  return definitions
}

export type MathProblems = { errors: string[]; undefinedMacros: string[] }

function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&amp;/g, '&')
}

/** TeX errors (`merror`) and undefined macros (red `mtext`) in MathJax's MathML. */
export function mathProblemsFromMml(mml: string): MathProblems {
  const errors = [...mml.matchAll(/data-mjx-error="([^"]*)"/g)].map(match =>
    decodeEntities(match[1])
  )
  const undefinedMacros = [
    ...mml.matchAll(/<mtext\b[^>]*\bmathcolor="red"[^>]*>\s*(\\[A-Za-z@]+)\s*<\/mtext>/g),
  ].map(match => match[1])
  return { errors: [...new Set(errors)], undefinedMacros: [...new Set(undefinedMacros)] }
}

/** MathJax with the author's definitions loaded, as upstream's preview does before each render. */
async function mathJaxWith(definitions: string): Promise<any> {
  const MathJax: any = await loadMathJax()
  if (definitions) {
    try {
      await MathJax.tex2svgPromise(definitions)
    } catch {
      // a broken definition must not block the preview
    }
  }
  return MathJax
}

async function problemsWith(MathJax: any, tex: string, display: boolean): Promise<MathProblems> {
  MathJax.texReset([0])
  const mml: string = await MathJax.tex2mmlPromise(tex, { display })
  return mathProblemsFromMml(mml)
}

/** Typesets `tex` into `element`; resolves with what MathJax found wrong. */
export async function renderMath(
  element: HTMLElement,
  tex: string,
  display: boolean,
  definitions: string
): Promise<MathProblems> {
  const MathJax = await mathJaxWith(definitions)
  MathJax.texReset([0])
  const node = await MathJax.tex2svgPromise(tex, {
    ...MathJax.getMetricsFor(element, display),
    display,
  })
  element.textContent = ''
  element.append(node)
  return problemsWith(MathJax, tex, display)
}

/** The problems only, for the harness; null when MathJax cannot load. */
export async function checkMath(
  tex: string,
  display: boolean,
  definitions: string
): Promise<MathProblems | null> {
  try {
    return await problemsWith(await mathJaxWith(definitions), tex, display)
  } catch {
    return null
  }
}
