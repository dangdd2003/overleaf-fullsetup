import { FC, useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { useOpenFileInEditor } from '../../hooks/use-open-file'
import {
  STREAM_FADE_MS,
  useStreamReveal,
} from '../../hooks/use-stream-reveal'

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
      return { type: 'inlineMath', raw: m[0], text: m[1].trim(), display: false }
    }
    // 5. $ ... $ (disallow leading/trailing whitespace, and currency numbers like $10)
    m = src.match(/^\$((?:\\\$|[^$\n])+?)\$/)
    if (m) {
      const rawInner = m[1]
      if (/^\s/.test(rawInner) || /\s$/.test(rawInner)) return
      if (/^\d+(?:\.\d+)?$/.test(rawInner.trim())) return
      return { type: 'inlineMath', raw: m[0], text: rawInner.trim(), display: false }
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
  ],
}

marked.setOptions({
  gfm: true,
  breaks: true,
})

marked.use({
  extensions: [blockMath, inlineMath],
  renderer: {
    table(header: string, body: string) {
      return `<div class="ai-assist-table-wrapper">
  <div class="ai-assist-table-header">
    <span class="ai-assist-table-label">Table</span>
    <div class="ai-assist-table-actions">
      <button type="button" class="ai-assist-table-insert-btn" aria-label="Insert as LaTeX table" title="Insert as LaTeX table">
        <svg class="ai-assist-icon-insert" xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="currentColor" viewBox="0 0 256 256" aria-hidden="true"><path d="M224,128a8,8,0,0,1-8,8H136v80a8,8,0,0,1-16,0V136H40a8,8,0,0,1,0-16h80V40a8,8,0,0,1,16,0v80h80A8,8,0,0,1,224,128Z"></path></svg>
        <svg class="ai-assist-icon-check" xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="currentColor" viewBox="0 0 256 256" aria-hidden="true"><path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z"></path></svg>
        <span class="ai-assist-insert-text">Insert</span>
      </button>
    </div>
  </div>
  <table class="ai-assist-table"><thead>${header}</thead><tbody>${body}</tbody></table>
</div>`
    },
    code(code: string, infostring: string | undefined) {
      const lang = (infostring || '').match(/\S*/)?.[0] || ''
      const langLabel = `<span class="ai-assist-code-lang">${escapeHtml(lang || 'code')}</span>`
      const escapedCode = escapeHtml(code)

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
  <pre><code class="${lang ? `language-${escapeHtml(lang)}` : ''}">${escapedCode}</code></pre>
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
    link(href: string, title: string | null | undefined, text: string) {
      const cleanText = text.replace(/<button[^>]*>([\s\S]*?)<\/button>/gi, '$1')
      return `<a href="${href}"${title ? ` title="${escapeHtml(title)}"` : ''}>${cleanText}</a>`
    },
  },
})

export function renderMarkdown(content: string): string {
  if (!content) {
    return ''
  }

  DOMPurify.addHook('afterSanitizeAttributes', node => {
    if (node.nodeName === 'A') {
      node.setAttribute('rel', 'noreferrer noopener')
      node.setAttribute('target', '_blank')
    }
  })

  try {
    const rawHtml = marked.parse(content) as string
    return DOMPurify.sanitize(rawHtml, PURIFY_CONFIG)
  } finally {
    DOMPurify.removeHook('afterSanitizeAttributes')
  }
}

type FadeChunk = { start: number; at: number }
type FadeState = { text: string; chunks: FadeChunk[] }

/** Structures that fade in as a whole when they first appear. */
const FADE_UNIT_SELECTOR =
  '.ai-assist-table-wrapper, .ai-assist-code-block, tr, li, .katex'
/** Structures whose text must not be split into spans. */
const ATOMIC_SELECTOR = '.katex, button, svg'

function fadeElement(el: Element, ageMs: number) {
  el.classList.add('ai-assist-stream-fade')
  ;(el as HTMLElement).style.animationDelay = `-${Math.round(ageMs)}ms`
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
    chunk => chunk.start < kept && now - chunk.at < STREAM_FADE_MS
  )
  if (text.length > kept) chunks.push({ start: kept, at: now })
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
      if (covered && chunks[i].start <= covered.start) continue
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
}> = ({ content, onOpenFile, isLive = false }) => {
  const defaultOpenFile = useOpenFileInEditor()
  const openFile = onOpenFile ?? defaultOpenFile

  const { text, animating } = useStreamReveal(content, isLive)
  const html = useMemo(() => renderMarkdown(text), [text])

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
      const insertBtn = target.closest<HTMLButtonElement>('.ai-assist-code-insert-btn')
      if (insertBtn) {
        e.preventDefault()
        e.stopPropagation()

        const block = insertBtn.closest('.ai-assist-code-block')
        const codeEl = block?.querySelector('pre > code') || block?.querySelector('code')
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
      const tableInsertBtn = target.closest<HTMLButtonElement>('.ai-assist-table-insert-btn')
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
      const copyBtn = target.closest<HTMLButtonElement>('.ai-assist-code-copy-btn')
      if (copyBtn) {
        e.preventDefault()
        e.stopPropagation()

        const block = copyBtn.closest('.ai-assist-code-block')
        const codeEl = block?.querySelector('pre > code') || block?.querySelector('code')
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
      const fileLink = target.closest<HTMLElement>('.ai-assist-file-link, .ai-assist-file-mention')
      if (fileLink) {
        e.preventDefault()
        e.stopPropagation()
        const path = fileLink.getAttribute('data-path') || fileLink.textContent?.trim() || ''
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
        const fileLink = target.closest<HTMLElement>('.ai-assist-file-link, .ai-assist-file-mention')
        if (fileLink) {
          e.preventDefault()
          e.stopPropagation()
          const path = fileLink.getAttribute('data-path') || fileLink.textContent?.trim() || ''
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

  if (!html) return null

  return (
    /* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */
    <div
      ref={containerRef}
      className={animating ? 'ai-assist-markdown is-streaming' : 'ai-assist-markdown'}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
