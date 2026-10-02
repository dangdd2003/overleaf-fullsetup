import { collapse, webError } from '../util.mjs'

/** PDFs are parsed in full without page limit. */
/** PDF pages read: past this the text would pass MAX_DOCUMENT_CHARS anyway */
export const MAX_PDF_PAGES = 10_000
/** Less text than this in the whole file means it has no text layer. */
const MIN_PDF_TEXT = 100
/** A line this much taller than body text is a ## heading; the second, a ### heading. */
const H2_RATIO = 1.3
const H3_RATIO = 1.15
const MAX_HEADING_CHARS = 120
/** A vertical gap this many times the usual line gap starts a paragraph. */
const PARAGRAPH_GAP = 1.6
const LIST_MARKER = /^(?:[•\-–*]\s|\d{1,3}[.)]\s|\([a-z0-9]{1,3}\)\s)/i
const PAGE_NUMBER =
  /^(?:page\s+)?[-–]?\s*\d{1,4}\s*[-–]?(?:\s*(?:of|\/)\s*\d{1,4})?$/i

let pdfjsPromise = null

function loadPdfjs() {
  // The legacy build runs in Node without a worker or a DOM
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs')
  return pdfjsPromise
}

/** One page's text items grouped into lines, each with its baseline and height. */
export function layoutLines(items) {
  const lines = []
  let line = null
  let lastY = null
  const flush = () => {
    if (line && line.text.trim()) {
      lines.push({ ...line, text: line.text.replace(/\s+$/, '') })
    }
    line = null
  }
  for (const item of items ?? []) {
    // marked-content items carry no text
    if (typeof item?.str !== 'string') continue
    const y = Array.isArray(item.transform)
      ? Math.round(item.transform[5])
      : lastY
    if (lastY !== null && y !== lastY) flush()
    if (!line) line = { text: '', y: y ?? 0, height: 0 }
    line.text += item.str
    line.height = Math.max(line.height, Math.abs(Number(item.height) || 0))
    if (item.hasEOL) flush()
    lastY = y
  }
  flush()
  return lines
}

/** The lower middle value of the positive numbers, or 0. */
function median(values) {
  const sorted = values
    .filter(value => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b)
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0
}

function lineKey(text) {
  return collapse(text).toLowerCase().replace(/\d+/g, '#')
}

/** Lines repeated at the top or bottom of most pages: running headers and footers. */
function runningLines(pages) {
  const eligible = pages.filter(lines => lines.length >= 3)
  const counts = new Map()
  for (const lines of eligible) {
    const keys = new Set(
      [...lines.slice(0, 2), ...lines.slice(-2)].map(line => lineKey(line.text))
    )
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const needed = Math.max(3, Math.ceil(eligible.length / 2))
  return new Set(
    [...counts]
      .filter(([key, count]) => key && count >= needed)
      .map(([key]) => key)
  )
}

/** A page's lines without running headers, footers and bare page numbers. */
function bodyLines(lines, running) {
  return lines.filter((line, index) => {
    const edge = index < 2 || index >= lines.length - 2
    if (!edge) return true
    if (lines.length >= 3 && running.has(lineKey(line.text))) return false
    const outermost = index === 0 || index === lines.length - 1
    if (outermost && PAGE_NUMBER.test(collapse(line.text))) return false
    return true
  })
}

function headingLevel(line, bodyHeight) {
  if (
    !bodyHeight ||
    line.text.length > MAX_HEADING_CHARS ||
    !/\p{L}/u.test(line.text)
  ) {
    return 0
  }
  const ratio = line.height / bodyHeight
  if (ratio >= H2_RATIO) return 2
  if (ratio >= H3_RATIO) return 3
  return 0
}

/** One page as Markdown: headings and reflowed paragraphs. */
function pageMarkdown(lines, { bodyHeight, lineGap }) {
  const blocks = []
  let paragraph = ''
  let previous = null
  let afterHeading = false
  const flush = () => {
    if (paragraph) blocks.push(paragraph)
    paragraph = ''
  }
  for (const line of lines) {
    const text = collapse(line.text)
    const level = headingLevel(line, bodyHeight)
    if (level) {
      flush()
      blocks.push(`${'#'.repeat(level)} ${text}`)
      previous = line
      afterHeading = true
      continue
    }
    const gap = previous ? previous.y - line.y : 0
    const newParagraph =
      !paragraph ||
      afterHeading ||
      gap < 0 ||
      (lineGap > 0 && gap > PARAGRAPH_GAP * lineGap) ||
      LIST_MARKER.test(text)
    if (newParagraph) {
      flush()
      paragraph = text
    } else if (/\p{Ll}-$/u.test(paragraph) && /^\p{Ll}/u.test(text)) {
      paragraph = `${paragraph.slice(0, -1)}${text}`
    } else {
      paragraph = `${paragraph} ${text}`
    }
    previous = line
    afterHeading = false
  }
  flush()
  return blocks.join('\n\n')
}

/**
 * Markdown for each page of a PDF from its pdf.js text items: lines reflowed
 * into paragraphs, clearly larger lines as headings, running headers,
 * footers and page numbers removed.
 */
export function layoutText(pageItems) {
  const pages = pageItems.map(items => layoutLines(items))
  const all = pages.flat()
  const bodyHeight =
    median(
      all.filter(line => line.text.length >= 20).map(line => line.height)
    ) || median(all.map(line => line.height))
  const gaps = []
  for (const lines of pages) {
    for (let i = 1; i < lines.length; i++) {
      const gap = lines[i - 1].y - lines[i].y
      if (gap > 0 && (!bodyHeight || gap <= 3 * bodyHeight)) gaps.push(gap)
    }
  }
  const lineGap = median(gaps)
  const running = runningLines(pages)
  return pages.map(lines =>
    pageMarkdown(bodyLines(lines, running), { bodyHeight, lineGap })
  )
}

/**
 * The text of a PDF, each page under a `--- PDF page N ---` marker so a
 * passage found later can be traced to its page. A file that is not a
 * readable PDF throws a 'content' webError: no other route would do better.
 */
export async function pdfToText(
  body,
  { url = 'The file', maxPages = MAX_PDF_PAGES } = {}
) {
  const pdfjs = await loadPdfjs()
  let doc
  try {
    doc = await pdfjs.getDocument({
      // a copy: pdf.js takes ownership of the bytes it is given
      data: new Uint8Array(body),
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      verbosity: 0,
    }).promise
  } catch (err) {
    throw webError(
      err?.name === 'PasswordException'
        ? `${url} is a password-protected PDF.`
        : `${url} could not be read as a PDF.`
    )
  }
  try {
    const info = (await doc.getMetadata().catch(() => null))?.info
    const title = collapse(info?.Title ?? '')
    const count = Number.isFinite(maxPages)
      ? Math.min(doc.numPages, maxPages)
      : doc.numPages
    const pageItems = []
    for (let n = 1; n <= count; n++) {
      const page = await doc.getPage(n)
      const content = await page.getTextContent()
      pageItems.push(content.items)
      page.cleanup()
    }
    const text = layoutText(pageItems)
      .map((page, index) => `--- PDF page ${index + 1} ---\n${page}`)
      .join('\n\n')
    if (
      collapse(text.replace(/--- PDF page \d+ ---/g, '')).length < MIN_PDF_TEXT
    ) {
      throw webError(
        `${url} is a PDF with no text layer (most likely a scan), which web_fetch cannot read.`
      )
    }
    return { title, text, truncated: doc.numPages > count }
  } finally {
    await doc.destroy().catch(() => {})
  }
}
