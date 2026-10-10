import { useEffect } from 'react'
import { highlightTree } from '@lezer/highlight'
import { LaTeXLanguage } from '@/features/source-editor/languages/latex/latex-language'
import { classHighlighter } from '@/features/source-editor/extensions/class-highlighter'
import {
  EDITOR_THEME_PALETTES,
  useEditorThemeStyles,
} from './use-editor-theme-styles'

/** Code blocks in these languages are highlighted the way the editor does it. */
const LATEX_LANGS = new Set(['latex', 'tex', 'ltx', 'sty', 'cls'])

/** Whether code in this language is highlighted like the editor's. */
export function canHighlightCode(lang: string) {
  return LATEX_LANGS.has(lang.toLowerCase())
}

/** Scope of the editor's token colours outside the editor. */
export const EDITOR_CODE_CLASS = 'ai-assist-editor-code'

/**
 * Scope of token colours for code on the AI popups, which follow Overleaf's
 * system theme rather than the editor's: the editor theme's colours when it
 * is as light or dark as the system theme, else Overleaf's own default for
 * that theme.
 */
export const SYSTEM_CODE_CLASS = 'ai-assist-system-code'

const STYLE_ELEMENT_IDS: Record<string, string> = {
  [EDITOR_CODE_CLASS]: 'ai-assist-editor-highlight',
  [SYSTEM_CODE_CLASS]: 'ai-assist-system-highlight',
}

/** Overleaf's default editor theme for each system theme. */
const SYSTEM_DEFAULT_THEMES = { light: 'textmate', dark: 'overleaf_dark' }

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

const linesCache = new Map<string, CodeSegment[][]>()

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
  const cached = linesCache.get(code)
  if (cached) return cached

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

  if (linesCache.size >= 200) linesCache.clear()
  linesCache.set(code, lines)
  return lines
}

type StyleSpec = Record<string, Record<string, string>>

function toCss(highlightStyle: StyleSpec, scope: string) {
  return Object.entries(highlightStyle)
    .map(([selector, declarations]) => {
      const scoped = selector
        .split(',')
        .map(part => `.${scope} ${part.trim()}`)
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

// The theme each scope's colours were last loaded for
const loadedThemes = new Map<string, string | null>()

async function applyTheme(editorTheme: string, scope: string) {
  if (loadedThemes.get(scope) === editorTheme) return
  loadedThemes.set(scope, editorTheme)
  try {
    const { highlightStyle } = await import(
      /* webpackChunkName: "cm6-theme" */ `@/features/source-editor/themes/cm6/${editorTheme}.json`
    )
    // A newer theme switch won the race
    if (loadedThemes.get(scope) !== editorTheme) return
    const id = STYLE_ELEMENT_IDS[scope]
    let style = document.getElementById(id)
    if (!style) {
      style = document.createElement('style')
      style.id = id
      document.head.appendChild(style)
    }
    style.textContent = toCss(highlightStyle ?? {}, scope)
  } catch {
    // Unknown theme: code keeps the surrounding text colour, unhighlighted
    if (loadedThemes.get(scope) === editorTheme) loadedThemes.set(scope, null)
  }
}

/** Keeps the page's copy of the editor theme's token colours current. */
export function useEditorHighlightStyle(editorTheme: string) {
  useEffect(() => {
    applyTheme(editorTheme || 'textmate', EDITOR_CODE_CLASS)
  }, [editorTheme])
}

/**
 * Keeps the popups' token colours ({@link SYSTEM_CODE_CLASS}) readable on the
 * system theme's surfaces.
 */
export function useSystemHighlightStyle() {
  const { editorTheme, activeOverallTheme } = useEditorThemeStyles()
  const editorDark = EDITOR_THEME_PALETTES[editorTheme]?.dark
  const editorMatches =
    editorDark !== undefined && editorDark === (activeOverallTheme === 'dark')
  const theme = editorMatches
    ? editorTheme
    : SYSTEM_DEFAULT_THEMES[activeOverallTheme]
  useEffect(() => {
    applyTheme(theme, SYSTEM_CODE_CLASS)
  }, [theme])
}
