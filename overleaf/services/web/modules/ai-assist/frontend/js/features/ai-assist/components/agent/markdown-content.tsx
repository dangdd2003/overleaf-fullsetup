import { FC, useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { useOpenFileInEditor } from '../../hooks/use-open-file'
import {
  STREAM_FADE_MS,
  MAX_FADE_LEAD_MS,
  useStreamReveal,
} from '../../hooks/use-stream-reveal'
import {
  highlightCodeHtml,
  useEditorHighlightStyle,
  EDITOR_CODE_CLASS,
} from '../../hooks/use-editor-code-highlight'
import { useEditorThemeStyles } from '../../hooks/use-editor-theme-styles'
import {
  ensureTableSeparation,
  extractFootnotes,
  normalizeMarkdown,
} from './markdown-repair'
import {
  faviconUrl,
  hostOf,
  siteName,
  WebSource,
  WebSources,
} from '../../agent/web-sources'

export function insertSnippetIntoEditor(text: string): boolean {
  if (!text || typeof window === 'undefined') return false
  window.dispatchEvent(
    new CustomEvent('aiAssist:insertSnippet', { detail: { text } })
  )
  window.dispatchEvent(
    new CustomEvent('editor:insert-symbol', { detail: { command: text } })
  )
  return true
}

export function tableElementToLatex(tableEl: HTMLTableElement): string {
  const rows = Array.from(tableEl.querySelectorAll('tr'))
  if (rows.length === 0) return ''

  const tableData: string[][] = []
  let maxCols = 0

  for (const row of rows) {
    const cells = Array.from(row.querySelectorAll('th, td'))
    const rowData = cells.map(c => c.textContent?.trim() || '')
    if (rowData.length > maxCols) maxCols = rowData.length
    tableData.push(rowData)
  }

  if (maxCols === 0) return ''

  const colSpec = 'l'.repeat(maxCols)
  const lines: string[] = [
    '\\begin{table}[htbp]',
    '  \\centering',
    `  \\begin{tabular}{${colSpec}}`,
    '    \\toprule',
  ]

  let isFirstRow = true
  for (const row of tableData) {
    while (row.length < maxCols) row.push('')
    const escapedRow = row.map(cell => cell.replace(/([&%$#_{}])/g, '\\$1'))
    lines.push(`    ${escapedRow.join(' & ')} \\\\`)
    if (isFirstRow) {
      lines.push('    \\midrule')
      isFirstRow = false
    }
  }

  lines.push('    \\bottomrule')
  lines.push('  \\end{tabular}')
  lines.push('\\end{table}')

  return lines.join('\n')
}

const COLUMN_RESIZER =
  '<span class="ai-assist-col-resizer" aria-hidden="true"></span>'
const ROW_RESIZER =
  '<span class="ai-assist-row-resizer" aria-hidden="true"></span>'
const TABLE_RESIZER_SELECTOR = '.ai-assist-col-resizer, .ai-assist-row-resizer'
const MIN_COLUMN_WIDTH = 48

/** Pins every column at its current width so dragging one leaves the rest. */
function pinColumnWidths(table: HTMLTableElement) {
  if (table.classList.contains('is-sized')) return
  const cells = Array.from(table.rows[0]?.cells ?? [])
  const widths = cells.map(cell => cell.getBoundingClientRect().width)
  cells.forEach((cell, i) => {
    cell.style.width = `${widths[i]}px`
  })
  table.style.width = `${widths.reduce((sum, width) => sum + width, 0)}px`
  table.classList.add('is-sized')
}

/** Drags a column's right edge or a row's bottom edge. */
function startTableResize(handle: HTMLElement, down: PointerEvent) {
  const cell = handle.parentElement
  const table = cell?.closest('table')
  if (!(cell instanceof HTMLTableCellElement) || !table) return

  let resize: (delta: number) => void
  const isColumn = handle.classList.contains('ai-assist-col-resizer')
  if (isColumn) {
    pinColumnWidths(table)
    const column = table.rows[0]?.cells[cell.cellIndex]
    if (!column) return
    const startWidth = parseFloat(column.style.width)
    const otherWidths = parseFloat(table.style.width) - startWidth
    resize = delta => {
      const width = Math.max(MIN_COLUMN_WIDTH, startWidth + delta)
      column.style.width = `${width}px`
      table.style.width = `${otherWidths + width}px`
    }
  } else {
    const row = cell.parentElement as HTMLTableRowElement
    const startHeight = row.getBoundingClientRect().height
    // A row never gets shorter than its text
    resize = delta => {
      row.style.height = `${Math.max(0, startHeight + delta)}px`
    }
  }

  handle.setPointerCapture(down.pointerId)
  table.classList.add('is-resizing')
  const move = (e: PointerEvent) =>
    resize(isColumn ? e.clientX - down.clientX : e.clientY - down.clientY)
  const end = () => {
    handle.removeEventListener('pointermove', move)
    handle.removeEventListener('pointerup', end)
    handle.removeEventListener('pointercancel', end)
    table.classList.remove('is-resizing')
  }
  handle.addEventListener('pointermove', move)
  handle.addEventListener('pointerup', end)
  handle.addEventListener('pointercancel', end)
}

/** Gives the column widths, or one row's height, back to the browser. */
function resetTableSize(handle: HTMLElement) {
  const table = handle.closest('table')
  if (!table) return
  if (handle.classList.contains('ai-assist-row-resizer')) {
    handle.closest('tr')?.style.removeProperty('height')
    return
  }
  table.classList.remove('is-sized')
  table.style.removeProperty('width')
  for (const cell of Array.from(table.rows[0]?.cells ?? [])) {
    cell.style.removeProperty('width')
  }
}

export function renderFileMentionHtml(filePath: string, line?: string): string {
  const cleanPath = filePath.replace(/^\.\//, '')
  const safePath = escapeHtml(cleanPath)
  const lineAttr = line ? ` data-line="${escapeHtml(line)}"` : ''
  const lineLabel = line ? `:${escapeHtml(line)}` : ''
  const title = `Open ${safePath}${line ? ` at line ${line}` : ''}`

  return `<button type="button" class="ai-assist-file-mention ai-assist-file-link" data-path="${safePath}"${lineAttr} title="${title}" aria-label="${title}"><span class="ai-assist-file-name">${safePath}</span>${line ? `<span class="ai-assist-file-line">${lineLabel}</span>` : ''}</button>`
}

export const FILE_PATH_REGEX =
  /(?:^|(?<=[\s("`]))((?:\.\/)?[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*\.(?:tex|bib|sty|cls|bbl|bst|dtx|ins|png|jpg|jpeg|pdf|eps|svg|csv|tsv|txt|md))(?::(\d+))?(?=[.,;:!?")\s`]|$)/g

export function renderTextWithFileMentions(rawText: string): string {
  if (!rawText) return ''
  return rawText.replace(FILE_PATH_REGEX, (_match, filePath, line) => {
    return renderFileMentionHtml(filePath, line)
  })
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false

  // 1. Modern navigator.clipboard API if supported
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Fall through to clipboard event and execCommand
    }
  }

  // 2. Direct copy event listener: writes directly to OS clipboard buffer
  let copied = false
  const onCopy = (e: ClipboardEvent) => {
    e.stopImmediatePropagation()
    e.preventDefault()
    if (e.clipboardData) {
      e.clipboardData.clearData()
      e.clipboardData.setData('text/plain', text)
      copied = true
    }
  }

  try {
    document.addEventListener('copy', onCopy, { capture: true, once: true })
    const result = document.execCommand('copy')
    document.removeEventListener('copy', onCopy, { capture: true })
    if (result && copied) {
      return true
    }
  } catch {
    document.removeEventListener('copy', onCopy, { capture: true })
  }

  // 3. Fallback textarea element inside DOM
  try {
    const parent = document.body
    const textArea = document.createElement('textarea')
    textArea.value = text
    textArea.style.position = 'fixed'
    textArea.style.top = '0'
    textArea.style.left = '0'
    textArea.style.width = '1px'
    textArea.style.height = '1px'
    textArea.style.padding = '0'
    textArea.style.border = 'none'
    textArea.style.outline = 'none'
    textArea.style.background = 'transparent'
    parent.appendChild(textArea)
    textArea.focus()
    textArea.select()
    const successful = document.execCommand('copy')
    parent.removeChild(textArea)
    return successful
  } catch {
    return false
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const MATH_ENVIRONMENTS =
  '(?:equation|align|alignat|gather|multline|matrix|pmatrix|bmatrix|vmatrix|Vmatrix|cases|aligned|gathered)'
const blockEnvRegex = new RegExp(
  `^(\\\\begin\\{(${MATH_ENVIRONMENTS}\\*?)\\}[\\s\\S]+?\\\\end\\{\\2\\})`
)
const inlineEnvRegex = new RegExp(
  `^(\\\\begin\\{(${MATH_ENVIRONMENTS}\\*?)\\}[\\s\\S]+?\\\\end\\{\\2\\})`
)

// A streaming reply is re-rendered on every chunk; don't re-typeset its math
const katexCache = new Map<string, string>()
function renderKatex(text: string, displayMode: boolean): string {
  const key = `${displayMode ? 'D' : 'I'}${text}`
  let html = katexCache.get(key)
  if (html === undefined) {
    html = katex.renderToString(text, { displayMode, throwOnError: false })
    if (katexCache.size >= 500) katexCache.clear()
    katexCache.set(key, html)
  }
  return html
}

const blockMath = {
  name: 'blockMath',
  level: 'block' as const,
  start(src: string) {
    const m = src.match(/(\$\$|\\\[|\\begin\{)/)
    return m ? m.index : -1
  },
  tokenizer(src: string) {
    // 1. $$ ... $$
    let m = src.match(/^\$\$([\s\S]+?)\$\$/)
    if (m) {
      return { type: 'blockMath', raw: m[0], text: m[1].trim(), display: true }
    }
    // 2. \[ ... \]
    m = src.match(/^\\\[([\s\S]+?)\\\]/)
    if (m) {
      return { type: 'blockMath', raw: m[0], text: m[1].trim(), display: true }
    }
    // 3. \begin{env} ... \end{env}
    m = src.match(blockEnvRegex)
    if (m) {
      return { type: 'blockMath', raw: m[0], text: m[1].trim(), display: true }
    }
  },
  renderer(token: any) {
    try {
      return renderKatex(token.text, token.display)
    } catch {
      return `<div class="katex-error">${escapeHtml(token.text)}</div>`
    }
  },
}

const inlineMath = {
  name: 'inlineMath',
  level: 'inline' as const,
  start(src: string) {
    const m = src.match(/(\$\$|\$|\\\(|\\\[|\\begin\{)/)
    return m ? m.index : -1
  },
  tokenizer(src: string) {
    // 1. $$ ... $$ (display math inside paragraph)
    let m = src.match(/^\$\$([\s\S]+?)\$\$/)
    if (m) {
      return { type: 'inlineMath', raw: m[0], text: m[1].trim(), display: true }
    }
    // 2. \[ ... \]
    m = src.match(/^\\\[([\s\S]+?)\\\]/)
    if (m) {
      return { type: 'inlineMath', raw: m[0], text: m[1].trim(), display: true }
    }
    // 3. \begin{env} ... \end{env}
    m = src.match(inlineEnvRegex)
    if (m) {
      return { type: 'inlineMath', raw: m[0], text: m[1].trim(), display: true }
    }
    // 4. \( ... \)
    m = src.match(/^\\\(([\s\S]+?)\\\)/)
    if (m) {
      return {
        type: 'inlineMath',
        raw: m[0],
        text: m[1].trim(),
        display: false,
      }
    }
    // 5. $ ... $ (disallow leading/trailing whitespace, and currency numbers like $10)
    m = src.match(/^\$((?:\\\$|[^$\n])+?)\$/)
    if (m) {
      const rawInner = m[1]
      if (/^\s/.test(rawInner) || /\s$/.test(rawInner)) return
      if (/^\d+(?:\.\d+)?$/.test(rawInner.trim())) return
      return {
        type: 'inlineMath',
        raw: m[0],
        text: rawInner.trim(),
        display: false,
      }
    }
  },
  renderer(token: any) {
    try {
      return renderKatex(token.text, token.display)
    } catch {
      return `<span class="katex-error">${escapeHtml(token.text)}</span>`
    }
  },
}

const MATHML_TAGS = [
  'math',
  'semantics',
  'annotation',
  'annotation-xml',
  'mrow',
  'mo',
  'mi',
  'mn',
  'msup',
  'msub',
  'msubsup',
  'mfrac',
  'mtable',
  'mtr',
  'mtd',
  'mstyle',
  'msqrt',
  'mroot',
  'mspace',
  'mtext',
  'mpadded',
  'mphantom',
  'menclose',
  'munder',
  'mover',
  'munderover',
]

/**
 * Web citations. The model cites a source by the number the web tools gave
 * it, `[2]` or `[2][5]`. Models trained on OpenAI's browsing tool write
 * `【2†L4-L9】` instead, whatever they are told, so that spelling is read too.
 * The reply is rendered Claude.ai-style: one pill naming the site after the
 * claim, "+N" when several sources back it, and a card listing them on hover.
 */
const CITATION_UNIT = String.raw`(?:\[\d+(?:\s*,\s*\d+)*\](?![(:])|【\d+(?:†[^】\n]*)?】)`
const CITATION_RUN = new RegExp(`^${CITATION_UNIT}(?:[ \t]?${CITATION_UNIT})*`)

// Set only for the duration of one synchronous renderMarkdown call
let activeSources: WebSources | null = null
let activeBaseUrl: string | null = null

/** The nearest ancestor that clips its content, which a card must stay inside. */
function clippingAncestor(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (getComputedStyle(node).overflowY !== 'visible') return node
  }
  return null
}

function renderCitation(sources: WebSource[]): string {
  const [first] = sources
  const more =
    sources.length > 1
      ? `<span class="ai-assist-citation-more">+${sources.length - 1}</span>`
      : ''
  // Laid out like the mode menu's rows: an icon, then a title over a detail
  // line. The icon is a background image, so a site without one shows the
  // plain tile rather than a broken image.
  const rows = sources
    .map(source => {
      const icon = faviconUrl(source.url)
      return (
        `<a class="ai-assist-citation-source" href="${escapeHtml(source.url)}">` +
        `<span class="ai-assist-citation-icon" aria-hidden="true"${icon ? ` style="background-image: url('${escapeHtml(icon)}')"` : ''}></span>` +
        '<span class="ai-assist-citation-text">' +
        `<span class="ai-assist-citation-title">${escapeHtml(source.title || source.url)}</span>` +
        `<span class="ai-assist-citation-site">${escapeHtml(hostOf(source.url))}${source.published ? ` · ${escapeHtml(source.published)}` : ''}</span>` +
        '</span>' +
        '</a>'
      )
    })
    .join('')
  const header = sources.length === 1 ? 'Source' : `${sources.length} sources`
  return (
    '<span class="ai-assist-citation">' +
    `<a class="ai-assist-citation-chip" href="${escapeHtml(first.url)}">${escapeHtml(siteName(first.url))}${more}</a>` +
    '<span class="ai-assist-citation-card" role="tooltip"><span class="ai-assist-citation-card-inner">' +
    `<span class="ai-assist-citation-header">${header}</span>${rows}` +
    '</span></span>' +
    '</span>'
  )
}

const citation = {
  name: 'citation',
  level: 'inline' as const,
  start(src: string) {
    const m = src.match(/\[\d|【\d/)
    return m ? m.index : -1
  },
  tokenizer(src: string) {
    const m = src.match(CITATION_RUN)
    if (!m) return
    const numbers = [...m[0].matchAll(/\d+(?![^【]*】)|【(\d+)/g)].map(n =>
      Number(n[1] ?? n[0])
    )
    const seen = new Set<number>()
    const sources: WebSource[] = []
    for (const n of numbers) {
      const source = activeSources?.get(n)
      if (source && !seen.has(n)) {
        seen.add(n)
        sources.push(source)
      }
    }
    // A bracketed number that names no source is ordinary text, "[3]" in a
    // sentence about arrays, say. The 【†】 spelling is never ordinary text.
    if (sources.length === 0 && !m[0].includes('【')) return
    return { type: 'citation', raw: m[0], sources }
  },
  renderer(token: any) {
    return token.sources.length > 0 ? renderCitation(token.sources) : ''
  },
}

const PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'p',
    'span',
    'div',
    'strong',
    'b',
    'em',
    'i',
    'del',
    's',
    'sub',
    'sup',
    'br',
    'hr',
    'ul',
    'ol',
    'li',
    'pre',
    'code',
    'a',
    'blockquote',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
    'button',
    'svg',
    'path',
    'input',
    'kbd',
    'mark',
    'details',
    'summary',
    'ins',
    'u',
    'small',
    'abbr',
    ...MATHML_TAGS,
  ],
  ALLOWED_ATTR: [
    'href',
    'title',
    'class',
    'align',
    'type',
    'aria-label',
    'aria-hidden',
    'viewBox',
    'xmlns',
    'width',
    'height',
    'fill',
    'stroke',
    'd',
    'style',
    'checked',
    'disabled',
    'mathvariant',
    'encoding',
    'display',
    'rowspacing',
    'columnspacing',
    'columnalign',
    'data-path',
    'data-line',
    'data-code',
    'role',
    'tabindex',
    'start',
    'open',
  ],
}

// Raw HTML in a reply passes only when every tag in it is one the chat renders.
// Anything else is text the model meant literally, like `<tabular>` or `<name>`.
const RAW_HTML_TAGS = new Set(
  PURIFY_CONFIG.ALLOWED_TAGS.filter(
    tag => !['button', 'svg', 'path', 'input', ...MATHML_TAGS].includes(tag)
  )
)

// Footnotes, the way GitHub shows them: `[^id]` becomes a small number, and
// the `[^id]: note` lines are listed under the reply
let activeFootnotes: { notes: Map<string, string>; order: string[] } | null =
  null

const footnoteRef = {
  name: 'footnoteRef',
  level: 'inline' as const,
  start(src: string) {
    return src.indexOf('[^')
  },
  tokenizer(src: string) {
    const m = src.match(/^\[\^([^\]\s]+)\]/)
    const note = m && activeFootnotes?.notes.get(m[1])
    if (!m || note === undefined || !activeFootnotes) return
    const { order } = activeFootnotes
    if (!order.includes(m[1])) order.push(m[1])
    return { type: 'footnoteRef', raw: m[0], n: order.indexOf(m[1]) + 1, note }
  },
  renderer(token: any) {
    return `<sup class="ai-assist-footnote-ref" title="${escapeHtml(token.note)}">${token.n}</sup>`
  },
}

function renderFootnotes(): string {
  if (!activeFootnotes?.notes.size) return ''
  const { notes, order } = activeFootnotes
  const ids = [...order, ...[...notes.keys()].filter(id => !order.includes(id))]
  const items = ids.map(id => `<li>${marked.parseInline(notes.get(id)!)}</li>`)
  return `<ol class="ai-assist-footnotes">${items.join('')}</ol>`
}

// Titles for the tables of the reply being rendered, in document order; the
// table renderer takes the next one for each table it draws
let activeTableTitles: string[] | null = null

const TABLE_CAPTION = /^table(?:\s+\d+[a-z]?)?\s*[:.]\s*(\S.*)$/i

/** The text of inline tokens, still HTML-escaped as the lexer left it. */
function inlinePlainText(tokens: any[] = []): string {
  return tokens
    .map(token => {
      if (['citation', 'footnoteRef', 'html', 'image'].includes(token.type)) {
        return ''
      }
      if (token.type === 'br') return ' '
      if (token.tokens) return inlinePlainText(token.tokens)
      if (token.type === 'inlineMath') return escapeHtml(token.raw)
      return token.text ?? ''
    })
    .join('')
}

/** Cleaned like a chat title: one line, no "Table:" label, no end punctuation. */
function cleanTableTitle(escaped: string): string {
  const text = escaped
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
  return text
    .replace(TABLE_CAPTION, '$1')
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '')
    .replace(/[.,:;!?]+$/, '')
    .trim()
}

/** A single-line paragraph, as its inline tokens. */
function singleLine(token: any): any[] | null {
  if (token?.type !== 'paragraph' || token.text.includes('\n')) return null
  return token.tokens
}

/** A "Table: …" or "Table 2. …" caption line. */
function captionTitle(token: any): string {
  const inline = singleLine(token)
  const text = inline ? inlinePlainText(inline).trim() : ''
  return TABLE_CAPTION.test(text) ? cleanTableTitle(text) : ''
}

/** A heading, a bold line or a caption written right above a table. */
function leadInTitle(token: any): string {
  if (token?.type === 'heading') {
    return cleanTableTitle(inlinePlainText(token.tokens))
  }
  const inline = singleLine(token)?.filter(
    t => !(t.type === 'text' && /^[\s:]*$/.test(t.text))
  )
  if (inline?.length === 1 && inline[0].type === 'strong') {
    return cleanTableTitle(inlinePlainText(inline[0].tokens))
  }
  return captionTitle(token)
}

/** Index of the nearest block before or after `from`, skipping blank lines. */
function neighbourBlock(tokens: any[], from: number, step: 1 | -1): number {
  let at = from + step
  while (tokens[at]?.type === 'space') at += step
  return tokens[at] ? at : -1
}

/**
 * Titles every table from what the model wrote, the way a chat is titled from
 * its first prompt. The heading, bold line or caption right above a table
 * becomes its title and leaves the prose; failing that a caption right below
 * it; failing that its column names.
 */
function titleTables(tokens: any[], titles: string[]) {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.type === 'blockquote') titleTables(token.tokens, titles)
    if (token.type === 'list') {
      for (const item of token.items) titleTables(item.tokens, titles)
    }
    if (token.type !== 'table') continue

    const before = neighbourBlock(tokens, i, -1)
    const after = neighbourBlock(tokens, i, 1)
    let title = before >= 0 ? leadInTitle(tokens[before]) : ''
    if (title) {
      tokens.splice(before, 1)
      i--
    } else if (after >= 0 && (title = captionTitle(tokens[after]))) {
      tokens.splice(after, 1)
    } else {
      title = token.header
        .map((cell: any) => cleanTableTitle(inlinePlainText(cell.tokens)))
        .filter(Boolean)
        .join(' · ')
    }
    titles.push(title)
  }
}

// A list item with nothing in it, and a list left with no items
const EMPTY_LIST_ITEM =
  /<li>(?:\s|<p>\s*(?:<br\s*\/?>)?\s*<\/p>|<br\s*\/?>)*<\/li>\s*/gi
const EMPTY_LIST = /<(ul|ol)(?:\s[^>]*)?>\s*<\/\1>\s*/gi

marked.setOptions({
  gfm: true,
  breaks: true,
})

marked.use({
  extensions: [blockMath, inlineMath, citation, footnoteRef],
  renderer: {
    table(header: string, body: string) {
      const title = escapeHtml(activeTableTitles?.shift() ?? '')
      return `<div class="ai-assist-table-wrapper">
  <div class="ai-assist-table-header">
    <span class="ai-assist-table-label" title="${title}">${title}</span>
    <div class="ai-assist-table-actions">
      <button type="button" class="ai-assist-table-insert-btn" aria-label="Insert as LaTeX table" title="Insert as LaTeX table">
        <svg class="ai-assist-icon-insert" xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="currentColor" viewBox="0 0 256 256" aria-hidden="true"><path d="M224,128a8,8,0,0,1-8,8H136v80a8,8,0,0,1-16,0V136H40a8,8,0,0,1,0-16h80V40a8,8,0,0,1,16,0v80h80A8,8,0,0,1,224,128Z"></path></svg>
        <svg class="ai-assist-icon-check" xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="currentColor" viewBox="0 0 256 256" aria-hidden="true"><path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z"></path></svg>
        <span class="ai-assist-insert-text">Insert</span>
      </button>
    </div>
  </div>
  <div class="ai-assist-table-scroll"><table class="ai-assist-table"><thead>${header}</thead><tbody>${body}</tbody></table></div>
</div>`
    },
    // Each cell carries drag handles for its column's right edge and, in the
    // body, its row's bottom edge
    tablecell(
      content: string,
      flags: { header: boolean; align: 'center' | 'left' | 'right' | null }
    ) {
      const tag = flags.header ? 'th' : 'td'
      const align = flags.align ? ` align="${flags.align}"` : ''
      const rowHandle = flags.header ? '' : ROW_RESIZER
      return `<${tag}${align}>${content}${COLUMN_RESIZER}${rowHandle}</${tag}>\n`
    },
    code(code: string, infostring: string | undefined) {
      const lang = (infostring || '').match(/\S*/)?.[0] || ''
      const langLabel = `<span class="ai-assist-code-lang">${escapeHtml(lang || 'code')}</span>`
      const highlighted = lang ? highlightCodeHtml(code, lang) : null
      const escapedCode = highlighted !== null ? highlighted : escapeHtml(code)
      const editorCodeClass =
        highlighted !== null ? ` ${EDITOR_CODE_CLASS}` : ''

      return `<div class="ai-assist-code-block">
  <div class="ai-assist-code-header">
    ${langLabel}
    <div class="ai-assist-code-actions">
      <button type="button" class="ai-assist-code-insert-btn" aria-label="Insert at cursor" title="Insert at cursor">
        <svg class="ai-assist-icon-insert" xmlns="http://www.w3.org/2000/svg" width="13" height="13" fill="currentColor" viewBox="0 0 256 256" aria-hidden="true"><path d="M224,128a8,8,0,0,1-8,8H136v80a8,8,0,0,1-16,0V136H40a8,8,0,0,1,0-16h80V40a8,8,0,0,1,16,0v80h80A8,8,0,0,1,224,128Z"></path></svg>
        <svg class="ai-assist-icon-check" xmlns="http://www.w3.org/2000/svg" width="13" height="13" fill="currentColor" viewBox="0 0 256 256" aria-hidden="true"><path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z"></path></svg>
        <span class="ai-assist-insert-text">Insert</span>
      </button>
      <button type="button" class="ai-assist-code-copy-btn" aria-label="Copy code" title="Copy code">
        <svg class="ai-assist-icon-copy" xmlns="http://www.w3.org/2000/svg" width="13" height="13" fill="currentColor" viewBox="0 0 256 256" aria-hidden="true"><path d="M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z"></path></svg>
        <svg class="ai-assist-icon-check" xmlns="http://www.w3.org/2000/svg" width="13" height="13" fill="currentColor" viewBox="0 0 256 256" aria-hidden="true"><path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z"></path></svg>
        <span class="ai-assist-copy-text">Copy</span>
      </button>
    </div>
  </div>
  <pre class="${editorCodeClass}"><code class="${lang ? `language-${escapeHtml(lang)}` : ''}">${escapedCode}</code></pre>
</div>`
    },
    codespan(code: string) {
      const fileMatch = code.match(
        /^((?:\.\/)?[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*\.(?:tex|bib|sty|cls|bbl|bst|dtx|ins|png|jpg|jpeg|pdf|eps|svg|csv|tsv|txt|md))(?::(\d+))?$/
      )
      if (fileMatch) {
        return renderFileMentionHtml(fileMatch[1], fileMatch[2])
      }
      return `<code>${escapeHtml(code)}</code>`
    },
    text(text: string) {
      return renderTextWithFileMentions(text)
    },
    link(
      href: string | null | undefined,
      title: string | null | undefined,
      text: string
    ) {
      const cleanText = (text || '').replace(
        /<button[^>]*>([\s\S]*?)<\/button>/gi,
        '$1'
      )
      let targetHref = href || ''
      if (activeBaseUrl && targetHref) {
        try {
          const resolved = new URL(targetHref, activeBaseUrl)
          if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
            targetHref = resolved.toString()
          }
        } catch {}
      } else if (targetHref && targetHref.startsWith('//')) {
        targetHref = `https:${targetHref}`
      }
      return `<a href="${escapeHtml(targetHref)}"${title ? ` title="${escapeHtml(title)}"` : ''}>${cleanText}</a>`
    },
    // Remote images are not loaded into the chat; the image is a link to it
    image(
      href: string | null | undefined,
      title: string | null | undefined,
      text: string
    ) {
      if (!href) return text || ''
      let targetHref = href
      if (activeBaseUrl && targetHref) {
        try {
          const resolved = new URL(targetHref, activeBaseUrl)
          if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
            targetHref = resolved.toString()
          }
        } catch {}
      } else if (targetHref && targetHref.startsWith('//')) {
        targetHref = `https:${targetHref}`
      }
      return `<a href="${escapeHtml(targetHref)}"${title ? ` title="${escapeHtml(title)}"` : ''}>${text || escapeHtml(targetHref)}</a>`
    },
    html(html: string) {
      const tags = [...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)/g)]
      return tags.every(([, tag]) => RAW_HTML_TAGS.has(tag.toLowerCase()))
        ? html
        : escapeHtml(html)
    },
  },
})

export function renderMarkdown(
  content: string,
  sources?: WebSources,
  baseUrl?: string
): string {
  if (!content) {
    return ''
  }
  // A citation still streaming in shows up once it is complete
  const text = ensureTableSeparation(
    normalizeMarkdown(content.replace(/【[^】\n]*$/, ''))
  )
  const footnotes = extractFootnotes(text)

  DOMPurify.addHook('afterSanitizeAttributes', node => {
    if (node.nodeName === 'A') {
      const rawHref = node.getAttribute('href') || ''
      if (rawHref) {
        if (baseUrl) {
          try {
            const resolved = new URL(rawHref, baseUrl)
            if (
              resolved.protocol === 'http:' ||
              resolved.protocol === 'https:'
            ) {
              node.setAttribute('href', resolved.toString())
            }
          } catch {}
        } else if (rawHref.startsWith('//')) {
          node.setAttribute('href', `https:${rawHref}`)
        }
      }
      node.setAttribute('rel', 'noreferrer noopener')
      node.setAttribute('target', '_blank')
    }
  })

  activeSources = sources ?? null
  activeFootnotes = { notes: footnotes.notes, order: [] }
  activeBaseUrl = baseUrl ?? null
  try {
    let rawHtml = ''
    try {
      const tokens = marked.lexer(footnotes.text)
      const titles: string[] = []
      titleTables(tokens, titles)
      activeTableTitles = titles
      rawHtml = marked.parser(tokens) + renderFootnotes()
    } catch {
      rawHtml = escapeHtml(content)
    }
    return DOMPurify.sanitize(rawHtml, PURIFY_CONFIG)
      .replace(EMPTY_LIST_ITEM, '')
      .replace(EMPTY_LIST, '')
  } catch {
    return escapeHtml(content)
  } finally {
    activeSources = null
    activeFootnotes = null
    activeBaseUrl = null
    activeTableTitles = null
    DOMPurify.removeHook('afterSanitizeAttributes')
  }
}

type FadeChunk = { start: number; at: number }
type FadeState = { text: string; chunks: FadeChunk[] }

/** Structures that fade in as a whole when they first appear. */
const FADE_UNIT_SELECTOR =
  '.ai-assist-table-wrapper, .ai-assist-code-block, tr, li, .katex, .ai-assist-citation'
/** Structures whose text must not be split into spans. */
const ATOMIC_SELECTOR = '.katex, button, svg, .ai-assist-citation'

function fadeElement(el: Element, ageMs: number) {
  el.classList.add('ai-assist-stream-fade')
  const delayMs = Math.round(-ageMs)
  ;(el as HTMLElement).style.animationDelay = `${delayMs}ms`
}

/**
 * Fades in the text a streaming render added since the previous one. The
 * rendered text is compared with what was on screen before: everything after
 * the common prefix is a new chunk. Chunks still inside their fade window are
 * re-applied after every render with a negative animation delay, so replacing
 * the markup never restarts a fade that is already under way.
 */
function applyChunkFades(container: HTMLElement, state: FadeState) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  while (walker.nextNode()) nodes.push(walker.currentNode as Text)

  const text = nodes.map(node => node.data).join('')
  const now = performance.now()
  let kept = 0
  const max = Math.min(text.length, state.text.length)
  while (kept < max && text[kept] === state.text[kept]) kept++

  const chunks = state.chunks.filter(
    chunk =>
      chunk.start < kept && now - chunk.at < STREAM_FADE_MS + MAX_FADE_LEAD_MS
  )
  if (text.length > kept) {
    const newText = text.slice(kept)
    const tokenRegex = /\S+\s*/g
    let match: RegExpExecArray | null
    let tokenIndex = 0
    let addedAny = false
    while ((match = tokenRegex.exec(newText)) !== null) {
      const start = kept + match.index
      const stagger = Math.min(tokenIndex * 24, MAX_FADE_LEAD_MS)
      chunks.push({ start, at: now + stagger })
      tokenIndex++
      addedAny = true
    }
    if (!addedAny) {
      chunks.push({ start: kept, at: now })
    }
  }
  state.text = text
  state.chunks = chunks
  if (chunks.length === 0) return

  const chunkAt = (offset: number) => {
    for (let i = chunks.length - 1; i >= 0; i--) {
      if (offset >= chunks[i].start) return chunks[i]
    }
    return null
  }

  const unitChunks = new Map<Element, FadeChunk | null>()
  let offset = 0
  for (const node of nodes) {
    const nodeStart = offset
    offset += node.data.length

    // A structure whose first text is new fades in whole, borders included
    let covered: FadeChunk | null = null
    let el = node.parentElement
    while (el && el !== container) {
      if (el.matches(FADE_UNIT_SELECTOR)) {
        if (!unitChunks.has(el)) {
          const chunk = chunkAt(nodeStart)
          unitChunks.set(el, chunk)
          if (chunk) fadeElement(el, now - chunk.at)
        }
        covered ??= unitChunks.get(el) ?? null
      }
      el = el.parentElement
    }

    if (offset <= chunks[0].start || !node.data.trim()) continue
    if (node.parentElement?.closest(ATOMIC_SELECTOR)) continue

    // Wrap each part of the node that belongs to a chunk still fading, unless
    // an enclosing structure is already fading it
    let current: Text = node
    let currentStart = nodeStart
    for (let i = 0; i < chunks.length; i++) {
      if (covered) continue
      const start = Math.max(chunks[i].start, currentStart)
      const end = Math.min(chunks[i + 1]?.start ?? Infinity, offset)
      if (end <= start) continue
      if (start > currentStart) {
        current = current.splitText(start - currentStart)
        currentStart = start
      }
      const rest = end < offset ? current.splitText(end - currentStart) : null
      const span = document.createElement('span')
      fadeElement(span, now - chunks[i].at)
      current.parentNode!.insertBefore(span, current)
      span.appendChild(current)
      if (!rest) break
      current = rest
      currentStart = end
    }
  }
}

export const MarkdownContent: FC<{
  content: string
  onOpenFile?: (path: string, line?: number) => void
  isLive?: boolean
  /** Web pages the model may cite by number. */
  sources?: WebSources
  baseUrl?: string
}> = ({ content, onOpenFile, isLive = false, sources, baseUrl }) => {
  const defaultOpenFile = useOpenFileInEditor()
  const openFile = onOpenFile ?? defaultOpenFile
  const { editorTheme } = useEditorThemeStyles()
  useEditorHighlightStyle(editorTheme)

  const { text, animating } = useStreamReveal(content, isLive)
  const html = useMemo(
    () => renderMarkdown(text, sources, baseUrl),
    [text, sources, baseUrl]
  )

  const containerRef = useRef<HTMLDivElement>(null)
  const fadeState = useRef<FadeState | null>(
    isLive ? { text: '', chunks: [] } : null
  )

  // Runs after React swaps in the new markup and before it is painted
  useLayoutEffect(() => {
    if (!animating) {
      fadeState.current = null
      return
    }
    const container = containerRef.current
    if (!container) return
    // Resuming a finished message: what is already on screen stays put
    fadeState.current ??= {
      text: container.textContent ?? '',
      chunks: [],
    }
    applyChunkFades(container, fadeState.current)
    window.dispatchEvent(new CustomEvent('aiAssist:stickToBottom'))
  }, [html, animating])

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement

      // 1. Insert code button
      const insertBtn = target.closest<HTMLButtonElement>(
        '.ai-assist-code-insert-btn'
      )
      if (insertBtn) {
        e.preventDefault()
        e.stopPropagation()

        const block = insertBtn.closest('.ai-assist-code-block')
        const codeEl =
          block?.querySelector('pre > code') || block?.querySelector('code')
        const textToInsert = codeEl?.textContent || ''

        if (!textToInsert) return

        insertSnippetIntoEditor(textToInsert)

        if ((insertBtn as any)._insertTimeout) {
          window.clearTimeout((insertBtn as any)._insertTimeout)
        }

        insertBtn.classList.add('is-inserted')
        const label = insertBtn.querySelector('.ai-assist-insert-text')
        if (label) {
          label.textContent = 'Inserted!'
        }
        insertBtn.setAttribute('title', 'Inserted!')
        ;(insertBtn as any)._insertTimeout = window.setTimeout(() => {
          insertBtn.classList.remove('is-inserted')
          if (label) {
            label.textContent = 'Insert'
          }
          insertBtn.setAttribute('title', 'Insert at cursor')
          delete (insertBtn as any)._insertTimeout
        }, 2000)
        return
      }

      // 2. Insert table button
      const tableInsertBtn = target.closest<HTMLButtonElement>(
        '.ai-assist-table-insert-btn'
      )
      if (tableInsertBtn) {
        e.preventDefault()
        e.stopPropagation()

        const wrapper = tableInsertBtn.closest('.ai-assist-table-wrapper')
        const tableEl = wrapper?.querySelector('table')
        if (!tableEl) return

        const latex = tableElementToLatex(tableEl)
        if (!latex) return

        insertSnippetIntoEditor(latex)

        if ((tableInsertBtn as any)._insertTimeout) {
          window.clearTimeout((tableInsertBtn as any)._insertTimeout)
        }

        tableInsertBtn.classList.add('is-inserted')
        const label = tableInsertBtn.querySelector('.ai-assist-insert-text')
        if (label) {
          label.textContent = 'Inserted!'
        }
        tableInsertBtn.setAttribute('title', 'Inserted!')
        ;(tableInsertBtn as any)._insertTimeout = window.setTimeout(() => {
          tableInsertBtn.classList.remove('is-inserted')
          if (label) {
            label.textContent = 'Insert'
          }
          tableInsertBtn.setAttribute('title', 'Insert as LaTeX table')
          delete (tableInsertBtn as any)._insertTimeout
        }, 2000)
        return
      }

      // 3. Copy button
      const copyBtn = target.closest<HTMLButtonElement>(
        '.ai-assist-code-copy-btn'
      )
      if (copyBtn) {
        e.preventDefault()
        e.stopPropagation()

        const block = copyBtn.closest('.ai-assist-code-block')
        const codeEl =
          block?.querySelector('pre > code') || block?.querySelector('code')
        const textToCopy = codeEl?.textContent || ''

        if (!textToCopy) return

        copyTextToClipboard(textToCopy).then(() => {
          if ((copyBtn as any)._copyTimeout) {
            window.clearTimeout((copyBtn as any)._copyTimeout)
          }

          copyBtn.classList.add('is-copied')
          const label = copyBtn.querySelector('.ai-assist-copy-text')
          if (label) {
            label.textContent = 'Copied!'
          }
          copyBtn.setAttribute('title', 'Copied!')
          ;(copyBtn as any)._copyTimeout = window.setTimeout(() => {
            copyBtn.classList.remove('is-copied')
            if (label) {
              label.textContent = 'Copy'
            }
            copyBtn.setAttribute('title', 'Copy code')
            delete (copyBtn as any)._copyTimeout
          }, 2000)
        })
        return
      }

      // 4. File mention / link
      const fileLink = target.closest<HTMLElement>(
        '.ai-assist-file-link, .ai-assist-file-mention'
      )
      if (fileLink) {
        e.preventDefault()
        e.stopPropagation()
        const path =
          fileLink.getAttribute('data-path') ||
          fileLink.textContent?.trim() ||
          ''
        const lineStr = fileLink.getAttribute('data-line')
        const line = lineStr ? parseInt(lineStr, 10) : undefined
        if (path) {
          openFile(path, line)
        }
      }
    },
    [openFile]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter') {
        const target = e.target as HTMLElement
        const fileLink = target.closest<HTMLElement>(
          '.ai-assist-file-link, .ai-assist-file-mention'
        )
        if (fileLink) {
          e.preventDefault()
          e.stopPropagation()
          const path =
            fileLink.getAttribute('data-path') ||
            fileLink.textContent?.trim() ||
            ''
          const lineStr = fileLink.getAttribute('data-line')
          const line = lineStr ? parseInt(lineStr, 10) : undefined
          if (path) {
            openFile(path, line)
          }
        }
      }
    },
    [openFile]
  )

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const handle = (e.target as HTMLElement).closest<HTMLElement>(
        TABLE_RESIZER_SELECTOR
      )
      if (!handle || e.button !== 0) return
      e.preventDefault()
      startTableResize(handle, e.nativeEvent)
    },
    []
  )

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const handle = (e.target as HTMLElement).closest<HTMLElement>(
        TABLE_RESIZER_SELECTOR
      )
      if (handle) resetTableSize(handle)
    },
    []
  )

  // A citation card stays inside the panel: it opens leftwards when it would
  // run past the right edge, and upwards when the scrolling area it sits in
  // (the transcript, above the composer) has more room there than below
  const handleMouseOver = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const citation = (e.target as HTMLElement).closest<HTMLElement>(
      '.ai-assist-citation'
    )
    const card = citation?.querySelector<HTMLElement>(
      '.ai-assist-citation-card'
    )
    const bounds = containerRef.current?.getBoundingClientRect()
    if (!citation || !card || !bounds) return
    const chip = citation.getBoundingClientRect()
    card.classList.toggle(
      'is-flipped',
      chip.left + card.offsetWidth > bounds.right
    )
    const view = clippingAncestor(citation)?.getBoundingClientRect()
    const roomBelow = (view ? view.bottom : window.innerHeight) - chip.bottom
    const roomAbove = chip.top - (view ? view.top : 0)
    card.classList.toggle(
      'is-above',
      card.offsetHeight > roomBelow && roomAbove > roomBelow
    )
  }, [])

  if (!html) return null

  return (
    /* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions, jsx-a11y/mouse-events-have-key-events */
    <div
      ref={containerRef}
      className={
        animating ? 'ai-assist-markdown is-streaming' : 'ai-assist-markdown'
      }
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
      onMouseOver={handleMouseOver}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
