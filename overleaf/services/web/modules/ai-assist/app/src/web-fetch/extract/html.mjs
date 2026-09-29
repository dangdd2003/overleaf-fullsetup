import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import sanitizeHtml from 'sanitize-html'
import { collapse, isoDay } from '../util.mjs'

/** Pages larger than this are not given to Readability: parsing them costs too much. */
const READABILITY_MAX_HTML = 3 * 1024 * 1024
/** Readability's result is used only when it keeps at least this much text. */
const READABLE_MIN_CHARS = 300
/** Below this much Markdown, the page's embedded data is tried as well. */
const EMBEDDED_MIN_CHARS = 400

/** Page chrome: removed with everything inside it. */
const DROPPED_ELEMENTS = new Set([
  'nav',
  'footer',
  'aside',
  'form',
  'button',
  'select',
  'dialog',
  'menu',
])

const MARKDOWN_TAGS = [
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'div',
  'section',
  'article',
  'main',
  'header',
  'blockquote',
  'figure',
  'figcaption',
  'details',
  'summary',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'pre',
  'code',
  'kbd',
  'samp',
  'tt',
  'a',
  'br',
  'hr',
  'math',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'caption',
  'strong',
  'b',
  'em',
  'i',
  'del',
  's',
  'sup',
  'sub',
  'img',
  ...DROPPED_ELEMENTS,
]

const BLOCK_TAGS = new Set([
  'p',
  'div',
  'section',
  'article',
  'main',
  'header',
  'figure',
  'figcaption',
  'details',
  'summary',
  'dl',
  'thead',
  'tbody',
  'tfoot',
])

const INLINE_CODE_TAGS = new Set(['code', 'kbd', 'samp', 'tt'])
const EMPHASIS = { strong: '**', b: '**', em: '*', i: '*', del: '~~', s: '~~' }
/** Tags whose Markdown depends on their whole content, rendered on close. */
const WRAPPED_TAGS = new Set([
  ...Object.keys(EMPHASIS),
  'sup',
  'sub',
  'blockquote',
  'dt',
  'dd',
  ...INLINE_CODE_TAGS,
])
const IMAGE_FILE = /\.(?:png|jpe?g|gif|svg|webp|avif|bmp|ico)$/i
const GENERIC_ALT = /^(?:image|img|logo|icon|photo|picture|figure)\s*\d*$/i
const HIDDEN_STYLE =
  /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important\s*)?(?=;|$)/i

function unescapeHtml(text) {
  return text.replace(
    /&(lt|gt|quot|#39|amp);/g,
    (_match, entity) =>
      ({ lt: '<', gt: '>', quot: '"', '#39': "'", amp: '&' })[entity]
  )
}

const JSON_LD =
  /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
const APP_DATA =
  /<script\b[^>]*id\s*=\s*["'](?:__NEXT_DATA__|__NUXT_DATA__)["'][^>]*>([\s\S]*?)<\/script>/gi
const DESCRIPTION =
  /<meta\b[^>]*(?:name|property)\s*=\s*["'](?:og:description|description)["'][^>]*content\s*=\s*["']([^"']*)["']/i

function parseJson(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** Plain text of an HTML string, entities decoded. */
export function htmlText(html) {
  return collapse(
    unescapeHtml(
      sanitizeHtml(String(html ?? ''), {
        allowedTags: [],
        allowedAttributes: {},
      })
    )
  )
}

/** articleBody or text of every JSON-LD node, walking @graph and arrays. */
function jsonLdBodies(node, out, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return
  if (Array.isArray(node)) {
    for (const item of node) jsonLdBodies(item, out, depth + 1)
    return
  }
  for (const key of ['articleBody', 'text']) {
    if (typeof node[key] === 'string' && node[key].trim()) {
      out.push(htmlText(node[key]))
    }
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') jsonLdBodies(value, out, depth + 1)
  }
}

/** Long prose strings in a framework's page data, in document order. */
function longStrings(node, out, seen, depth = 0) {
  if (out.length >= 50 || depth > 12 || node === null || node === undefined) {
    return
  }
  if (typeof node === 'string') {
    if (node.length < 200 || /^https?:\/\//.test(node)) return
    // base64 blobs and hashes are long but not prose
    if (/^[A-Za-z0-9+/=_-]{200,}$/.test(node)) return
    const text = htmlText(node)
    if (text.length >= 200 && !seen.has(text)) {
      seen.add(text)
      out.push(text)
    }
    return
  }
  if (typeof node !== 'object') return
  for (const value of Array.isArray(node) ? node : Object.values(node)) {
    longStrings(value, out, seen, depth + 1)
  }
}

/**
 * Text a JavaScript-rendered page ships inside its HTML for the browser to
 * render: JSON-LD structured data, Next.js or Nuxt page data, or failing
 * those its description. '' when there is none.
 */
export function embeddedText(html) {
  const candidates = []
  for (const [, raw] of html.matchAll(JSON_LD)) {
    const bodies = []
    jsonLdBodies(parseJson(raw), bodies)
    candidates.push(bodies.join('\n\n'))
  }
  for (const [, raw] of html.matchAll(APP_DATA)) {
    const strings = []
    longStrings(parseJson(raw), strings, new Set())
    candidates.push(strings.join('\n\n'))
  }
  const description = DESCRIPTION.exec(html)?.[1]
  if (description) candidates.push(htmlText(description))
  return candidates.reduce(
    (best, text) => (text.length > best.length ? text : best),
    ''
  )
}

function attribute(attrs, name) {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs || '')
  return match ? unescapeHtml(match[1]) : undefined
}

/** The page's own <main>, or its only <article>, when it marks one. */
function semanticMainHtml(html) {
  const main = /<main\b[^>]*>([\s\S]*)<\/main>/i.exec(html)
  if (main && main[1].length > 500) return main[1]
  if ((html.match(/<article\b/gi) || []).length === 1) {
    const article = /<article\b[^>]*>([\s\S]*)<\/article>/i.exec(html)
    if (article && article[1].length > 500) return article[1]
  }
  return null
}

/** The article as Firefox's reader view would show it, or null. */
function readableHtml(html) {
  if (html.length > READABILITY_MAX_HTML) return null
  try {
    const { document } = parseHTML(html)
    const article = new Readability(document, {
      charThreshold: READABLE_MIN_CHARS,
    }).parse()
    return article?.content &&
      collapse(article.textContent ?? '').length >= READABLE_MIN_CHARS
      ? article.content
      : null
  } catch {
    return null
  }
}

function bodyHtml(html) {
  const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)
  return body ? body[1] : html
}

/**
 * The HTML without elements a reader never sees: a `hidden` attribute,
 * `aria-hidden="true"`, or an inline `display:none` / `visibility:hidden`.
 * Text a page hides is also where it hides instructions aimed at an AI reader.
 */
export function withoutHiddenElements(html) {
  const source = String(html ?? '')
  if (!/\b(?:hidden|aria-hidden|style)\b/i.test(source)) return source
  try {
    const { document } = parseHTML(
      `<!doctype html><html><head></head><body>${source}</body></html>`
    )
    for (const element of [
      ...document.querySelectorAll('[hidden],[aria-hidden],[style]'),
    ]) {
      const hidden =
        element.hasAttribute('hidden') ||
        String(element.getAttribute('aria-hidden') ?? '')
          .trim()
          .toLowerCase() === 'true' ||
        HIDDEN_STYLE.test(
          String(element.getAttribute('style') ?? '').replace(/\s+/g, ' ')
        )
      if (hidden) element.remove()
    }
    return document.body.innerHTML
  } catch {
    return source
  }
}

function sanitizeForMarkdown(html) {
  return sanitizeHtml(html, {
    allowedTags: MARKDOWN_TAGS,
    allowedAttributes: {
      a: ['href'],
      math: ['alttext', 'display'],
      img: ['alt'],
      pre: ['class'],
      code: ['class'],
      td: ['colspan'],
      th: ['colspan'],
    },
    allowedSchemes: ['http', 'https'],
    nonTextTags: [
      'script',
      'style',
      'textarea',
      'option',
      'noscript',
      'svg',
      'template',
      'iframe',
      'head',
      'title',
      'canvas',
      'object',
    ],
    exclusiveFilter: frame => DROPPED_ELEMENTS.has(frame.tag),
    disallowedTagsMode: 'discard',
  })
}

function formatLink(inner, href, baseUrl) {
  const text = collapse(inner)
  if (!text) return ''
  if (!href) return inner
  let target
  try {
    target = new URL(href, baseUrl)
  } catch {
    return inner
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return inner
  // An anchor on the same page tells the reader nothing the text does not.
  if (target.hash) {
    const page = new URL(target)
    page.hash = ''
    const base = baseUrl ? new URL(baseUrl) : null
    if (base) base.hash = ''
    if (base && page.toString() === base.toString()) return inner
  }
  return `[${text}](${target.toString()})`
}

/** Emphasis markers around the text, with surrounding spaces kept outside. */
function wrapInline(inner, marker) {
  const lead = /^\s*/.exec(inner)[0]
  const trail = /\s*$/.exec(inner.slice(lead.length))[0]
  const core = inner.slice(lead.length, inner.length - trail.length)
  if (!core || core.includes('\n')) return inner
  return `${lead}${marker}${core}${marker}${trail}`
}

/** Inline code, with a longer delimiter when the code contains a backtick. */
function inlineCode(inner) {
  const code = inner.replace(/\s+/g, ' ')
  if (!code.trim()) return inner
  const longest = Math.max(
    0,
    ...(code.match(/`+/g) ?? []).map(run => run.length)
  )
  const fence = '`'.repeat(longest + 1)
  return longest ? `${fence} ${code} ${fence}` : `${fence}${code}${fence}`
}

function quoted(inner) {
  const body = tidyMarkdown(inner)
  if (!body) return ''
  const lines = body.split('\n').map(line => (line ? `> ${line}` : '>'))
  return `\n\n${lines.join('\n')}\n\n`
}

/** The language a code block names in its class ("language-latex"), or ''. */
function languageOf(attrs) {
  const classes = attribute(attrs, 'class') ?? ''
  const match = /(?:^|\s)(?:language|lang|highlight-source)-([\w+#.-]+)/i.exec(
    classes
  )
  return match ? match[1].toLowerCase() : ''
}

function usefulAlt(alt) {
  return alt.length >= 3 && !IMAGE_FILE.test(alt) && !GENERIC_ALT.test(alt)
}

/** A collected table as Markdown, or as paragraphs when it only lays out a page. */
function tableMarkdown(table) {
  const rows = table.rows.filter(row => row.some(cell => cell !== ''))
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0)
  if (rows.length === 0) return table.caption ? `\n\n${table.caption}\n\n` : ''
  if (table.layout || width < 2) {
    const paragraphs = [table.caption, ...rows.flat()].filter(Boolean)
    return `\n\n${paragraphs.join('\n\n')}\n\n`
  }
  const line = row =>
    `| ${[...row, ...Array(width - row.length).fill('')].join(' | ')} |`
  const caption = table.caption ? `Table: ${table.caption}\n` : ''
  const lines = [
    line(rows[0]),
    `|${' --- |'.repeat(width)}`,
    ...rows.slice(1).map(line),
  ]
  return `\n\n${caption}${lines.join('\n')}\n\n`
}

function tidyMarkdown(text) {
  const result = []
  let fence = 0
  for (const raw of text.split('\n')) {
    const marker = /^\s*(`{3,})(.*)$/.exec(raw)
    if (
      marker &&
      (!fence || (marker[1].length >= fence && !marker[2].trim()))
    ) {
      fence = fence ? 0 : marker[1].length
      result.push(raw.trim())
      continue
    }
    if (fence) {
      result.push(raw.replace(/\s+$/, ''))
      continue
    }
    let line = raw.replace(/\s+$/, '')
    const listItem = /^(\s*)(- |\d+\. )\s*(.*)$/.exec(line)
    if (listItem) {
      if (!listItem[3]) continue
      line = `${listItem[1]}${listItem[2]}${listItem[3].replace(/ {2,}/g, ' ')}`
    } else {
      line = line.replace(/(\S) {2,}/g, '$1 ')
      line = line.trimStart().replace(/^(#{1,6} )\s+/, '$1')
      if (/^#{1,6}$/.test(line)) continue
    }
    result.push(line)
  }
  return result
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Converts HTML already narrowed by `sanitizeForMarkdown` to Markdown. */
function sanitizedHtmlToMarkdown(html, baseUrl) {
  const out = []
  const lists = []
  const links = []
  const wraps = []
  let pre = null
  let skippingMath = false
  let table = null
  let lastDefinition = ''

  const inCell = () => table !== null && table.cellAt !== null
  const inInlineCode = () => wraps.some(wrap => INLINE_CODE_TAGS.has(wrap.name))
  const blockBreak = () => out.push(inCell() ? ' ' : '\n\n')

  for (const match of html.matchAll(
    /<(\/?)([a-z][a-z0-9]*)([^>]*)>|([^<]+)/gi
  )) {
    const [, closing, rawName, attrs, text] = match

    if (text !== undefined) {
      if (skippingMath) continue
      const decoded = unescapeHtml(text)
      out.push(pre ? decoded.replace(/ /g, ' ') : decoded.replace(/\s+/g, ' '))
      continue
    }

    const name = rawName.toLowerCase()

    // MathML carries the TeX source in alttext (Wikipedia, arXiv HTML), which
    // is exactly what a LaTeX assistant wants rather than the rendered glyphs.
    if (name === 'math') {
      if (closing) {
        skippingMath = false
        continue
      }
      const tex = attribute(attrs, 'alttext')
      if (tex && tex.trim()) {
        skippingMath = true
        out.push(
          attribute(attrs, 'display') === 'block'
            ? `\n\n$$${tex.trim()}$$\n\n`
            : ` $${tex.trim()}$ `
        )
      }
      continue
    }
    if (skippingMath) continue

    if (name === 'pre') {
      if (!closing) {
        if (pre) pre.depth++
        else pre = { at: out.length, depth: 1, language: languageOf(attrs) }
      } else if (pre) {
        pre.depth--
        if (pre.depth === 0) {
          const code = out
            .splice(pre.at)
            .join('')
            .replace(/^\n/, '')
            .replace(/\s+$/, '')
          const language = pre.language
          pre = null
          if (!code.trim()) continue
          const longest = Math.max(
            0,
            ...(code.match(/`+/g) ?? []).map(run => run.length)
          )
          const fence = '`'.repeat(Math.max(3, longest + 1))
          out.push(
            inCell()
              ? ` ${collapse(code)} `
              : `\n\n${fence}${language}\n${code}\n${fence}\n\n`
          )
        }
      }
      continue
    }
    if (pre) {
      if (name === 'br') out.push('\n')
      else if (name === 'code' && !closing && !pre.language) {
        pre.language = languageOf(attrs)
      }
      continue
    }

    const heading = /^h([1-6])$/.exec(name)
    if (heading) {
      if (inCell()) {
        table.layout = true
        out.push(' ')
      } else {
        out.push(closing ? '\n\n' : `\n\n${'#'.repeat(Number(heading[1]))} `)
      }
      continue
    }

    if (WRAPPED_TAGS.has(name)) {
      if (!closing) {
        // Markup inside inline code is part of the code
        if (!inInlineCode()) wraps.push({ name, at: out.length })
        continue
      }
      const index = wraps.findLastIndex(wrap => wrap.name === name)
      if (index === -1) continue
      const [wrap] = wraps.splice(index)
      const inner = out.splice(wrap.at).join('')
      let rendered
      if (EMPHASIS[name]) {
        rendered = wrapInline(inner, EMPHASIS[name])
      } else if (name === 'sup' || name === 'sub') {
        const core = collapse(inner)
        rendered = core ? `${name === 'sup' ? '^' : '_'}{${core}}` : ''
      } else if (INLINE_CODE_TAGS.has(name)) {
        rendered = inlineCode(inner)
      } else if (name === 'blockquote') {
        rendered = inCell() ? ` ${collapse(inner)} ` : quoted(inner)
      } else if (name === 'dt') {
        const term = collapse(inner)
        rendered = !term ? '' : inCell() ? ` ${term} ` : `\n- **${term}**`
        lastDefinition = 'dt'
      } else {
        const definition = collapse(inner)
        rendered = !definition
          ? ''
          : inCell()
            ? ` ${definition} `
            : lastDefinition === 'dt'
              ? `: ${definition}`
              : `\n  - ${definition}`
        if (definition) lastDefinition = 'dd'
      }
      out.push(rendered)
      continue
    }

    switch (name) {
      case 'br':
        out.push(inCell() ? ' ' : '\n')
        break
      case 'hr':
        out.push(inCell() ? ' ' : '\n\n---\n\n')
        break
      case 'ul':
      case 'ol':
        if (!closing) {
          // A nested list starts on its first item's own line, not a blank one.
          if (lists.length === 0) out.push(inCell() ? ' ' : '\n')
          lists.push({ ordered: name === 'ol', count: 0 })
        } else {
          lists.pop()
          out.push(inCell() ? ' ' : lists.length ? '\n' : '\n\n')
        }
        break
      case 'li':
        if (!closing) {
          const list = lists.at(-1)
          const marker = list?.ordered ? `${++list.count}. ` : '- '
          out.push(
            inCell()
              ? ' '
              : `\n${'  '.repeat(Math.max(0, lists.length - 1))}${marker}`
          )
        }
        break
      case 'a':
        if (!closing) {
          links.push({ href: attribute(attrs, 'href'), at: out.length })
        } else {
          const link = links.pop()
          if (link)
            out.push(
              formatLink(out.splice(link.at).join(''), link.href, baseUrl)
            )
        }
        break
      case 'img': {
        // An image inside a link is a logo or a badge
        if (closing || links.length > 0) break
        const alt = collapse(attribute(attrs, 'alt') ?? '').replace(
          /[[\]]/g,
          ''
        )
        if (usefulAlt(alt)) out.push(`[Image: ${alt}]`)
        break
      }
      case 'table':
        if (!closing) {
          if (table) {
            // A table inside a table lays out the page
            table.nested++
            table.layout = true
          } else {
            table = {
              start: out.length,
              rows: [],
              row: null,
              cellAt: null,
              span: 1,
              captionAt: null,
              caption: '',
              layout: false,
              nested: 0,
            }
          }
        } else if (table) {
          if (table.nested > 0) {
            table.nested--
          } else {
            if (table.row) table.rows.push(table.row)
            // Whatever was written between the cells is layout whitespace
            out.splice(table.start)
            const markdown = tableMarkdown(table)
            table = null
            out.push(markdown)
          }
        }
        break
      case 'caption':
        if (!table || table.nested > 0) break
        if (!closing) {
          table.captionAt = out.length
        } else if (table.captionAt !== null) {
          table.caption = collapse(out.splice(table.captionAt).join(''))
          table.captionAt = null
        }
        break
      case 'tr':
        if (!table) break
        if (table.nested > 0) {
          if (closing) out.push(' ')
          break
        }
        if (!closing) {
          table.row = []
        } else if (table.row) {
          table.rows.push(table.row)
          table.row = null
        }
        break
      case 'th':
      case 'td':
        if (!table) break
        if (table.nested > 0) {
          out.push(' ')
          break
        }
        if (!closing) {
          if (!table.row) table.row = []
          table.cellAt = out.length
          table.span = Math.min(
            20,
            Math.max(1, parseInt(attribute(attrs, 'colspan') ?? '1', 10) || 1)
          )
        } else if (table.cellAt !== null) {
          const cell = collapse(out.splice(table.cellAt).join('')).replace(
            /\|/g,
            '\\|'
          )
          table.row.push(cell, ...Array(table.span - 1).fill(''))
          table.cellAt = null
        }
        break
      default:
        if (BLOCK_TAGS.has(name)) blockBreak()
    }
  }

  return tidyMarkdown(out.join(''))
}

const PUBLISHED_META = [
  'article:published_time',
  'og:published_time',
  'datepublished',
  'publish-date',
  'publishdate',
  'pubdate',
  'date',
  'dc.date.issued',
  'dc.date',
  'citation_publication_date',
  'citation_date',
]
const MODIFIED_META = [
  'article:modified_time',
  'og:updated_time',
  'datemodified',
  'last-modified',
]

function metaContent(html, names) {
  const found = new Map()
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const name = /\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i
      .exec(tag)?.[1]
      ?.toLowerCase()
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]
    if (name && content && !found.has(name)) found.set(name, content)
  }
  for (const name of names) {
    const day = isoDay(found.get(name))
    if (day) return day
  }
  return ''
}

/**
 * When a page says it was published and last changed. How current a source
 * is decides whether it answers a question about the present, so the model
 * is told whenever the page says.
 */
export function extractPageDates(html) {
  const head = html.slice(0, 200_000)
  const jsonLd = key =>
    isoDay(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`).exec(head)?.[1])
  const published =
    metaContent(head, PUBLISHED_META) ||
    jsonLd('datePublished') ||
    isoDay(/<time\b[^>]*\bdatetime\s*=\s*["']([^"']+)["']/i.exec(head)?.[1])
  const modified = metaContent(head, MODIFIED_META) || jsonLd('dateModified')
  return {
    ...(published ? { published } : {}),
    ...(modified && modified !== published ? { modified } : {}),
  }
}

/** Title and Markdown body of an HTML page, and its dates when it has them. */
export function htmlToMarkdown(html, baseUrl) {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const title = titleMatch
    ? collapse(
        unescapeHtml(
          sanitizeHtml(titleMatch[1], {
            allowedTags: [],
            allowedAttributes: {},
          })
        )
      )
    : ''
  const chosen = withoutHiddenElements(
    semanticMainHtml(html) ?? readableHtml(html) ?? bodyHtml(html)
  )
  let markdown = sanitizedHtmlToMarkdown(sanitizeForMarkdown(chosen), baseUrl)
  if (collapse(markdown).length < EMBEDDED_MIN_CHARS) {
    const embedded = embeddedText(html)
    if (embedded.length > collapse(markdown).length) markdown = embedded
  }
  return { title, markdown, ...extractPageDates(html) }
}

/** An HTML fragment (an answer body, a package description) as Markdown. */
export function fragmentToMarkdown(html, baseUrl) {
  return sanitizedHtmlToMarkdown(
    sanitizeForMarkdown(withoutHiddenElements(String(html ?? ''))),
    baseUrl
  )
}
