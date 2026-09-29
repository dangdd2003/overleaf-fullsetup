import { useEffect } from 'react'
import { highlightTree } from '@lezer/highlight'
import { LaTeXLanguage } from '@/features/source-editor/languages/latex/latex-language'
import { classHighlighter } from '@/features/source-editor/extensions/class-highlighter'

/** Code blocks in these languages are highlighted the way the editor does it. */
const LATEX_LANGS = new Set(['latex', 'tex', 'ltx', 'sty', 'cls'])

/** Whether code in this language is highlighted like the editor's. */
export function canHighlightCode(lang: string) {
  return LATEX_LANGS.has(lang.toLowerCase())
}

/** Scope of the editor's token colours outside the editor. */
export const EDITOR_CODE_CLASS = 'ai-assist-editor-code'

const STYLE_ELEMENT_ID = 'ai-assist-editor-highlight'

function escapeHtml(str: string) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// A streaming reply re-renders its code on every frame
const highlightCache = new Map<string, string>()

/**
 * Highlights LaTeX with the editor's own parser and `tok-*` classes, so the
 * editor theme's token colours apply to it. Returns null for other languages.
 */
export function highlightCodeHtml(code: string, lang: string): string | null {
  if (!LATEX_LANGS.has(lang.toLowerCase())) return null

  let html = highlightCache.get(code)
  if (html !== undefined) return html

  const tree = LaTeXLanguage.parser.parse(code)
  let out = ''
  let pos = 0
  highlightTree(tree, classHighlighter, (from, to, classes) => {
    if (from > pos) out += escapeHtml(code.slice(pos, from))
    out += `<span class="${classes}">${escapeHtml(code.slice(from, to))}</span>`
    pos = to
  })
  out += escapeHtml(code.slice(pos))
  html = out

  if (highlightCache.size >= 200) highlightCache.clear()
  highlightCache.set(code, html)
  return html
}

export type CodeSegment = { text: string; className?: string }

/**
 * The same highlighting split into lines of segments, for views that lay code
 * out line by line. The whole text is parsed at once so a construct spanning
 * lines keeps its colours. Returns null for other languages.
 */
export function highlightCodeLines(
  code: string,
  lang: string
): CodeSegment[][] | null {
  if (!LATEX_LANGS.has(lang.toLowerCase())) return null

  const lines: CodeSegment[][] = [[]]
  const push = (text: string, className?: string) => {
    text.split('\n').forEach((part, index) => {
      if (index > 0) lines.push([])
      if (part) lines[lines.length - 1].push({ text: part, className })
    })
  }

  const tree = LaTeXLanguage.parser.parse(code)
  let pos = 0
  highlightTree(tree, classHighlighter, (from, to, classes) => {
    if (from > pos) push(code.slice(pos, from))
    push(code.slice(from, to), classes)
    pos = to
  })
  push(code.slice(pos))
  return lines
}

type StyleSpec = Record<string, Record<string, string>>

function toCss(highlightStyle: StyleSpec) {
  return Object.entries(highlightStyle)
    .map(([selector, declarations]) => {
      const scoped = selector
        .split(',')
        .map(part => `.${EDITOR_CODE_CLASS} ${part.trim()}`)
        .join(', ')
      const body = Object.entries(declarations)
        .map(
          ([prop, value]) =>
            `${prop.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}: ${value};`
        )
        .join(' ')
      return `${scoped} { ${body} }`
    })
    .join('\n')
}

let loadedTheme: string | null = null

async function applyEditorTheme(editorTheme: string) {
  if (loadedTheme === editorTheme) return
  loadedTheme = editorTheme
  try {
    const { highlightStyle } = await import(
      /* webpackChunkName: "cm6-theme" */ `@/features/source-editor/themes/cm6/${editorTheme}.json`
    )
    // A newer theme switch won the race
    if (loadedTheme !== editorTheme) return
    let style = document.getElementById(STYLE_ELEMENT_ID)
    if (!style) {
      style = document.createElement('style')
      style.id = STYLE_ELEMENT_ID
      document.head.appendChild(style)
    }
    style.textContent = toCss(highlightStyle ?? {})
  } catch {
    // Unknown theme: code keeps the editor's font and colours, unhighlighted
    if (loadedTheme === editorTheme) loadedTheme = null
  }
}

/** Keeps the page's copy of the editor theme's token colours current. */
export function useEditorHighlightStyle(editorTheme: string) {
  useEffect(() => {
    applyEditorTheme(editorTheme || 'textmate')
  }, [editorTheme])
}
