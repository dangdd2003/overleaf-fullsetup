// The pdf.js reading of a style inspection: each sampled page's text, fills,
// strokes and colours, as PdfStyleInspector's analysis takes them. Pure given
// the pdf.js module it is passed, so the worker thread (PdfWorker.mjs) loads
// pdf.js and this file, and nothing else from the web process.

// The pages the style is read from. A long document is sampled evenly rather
// than read whole: the style is the same page to page, and every page held here
// keeps its glyphs in memory until the summary is made.
export const MAX_STYLE_PAGES = 60

/**
 * The 1-based pages read from a document of `pageCount` pages: all of them up
 * to `max`, else `max` evenly spaced ones, first and last included.
 */
export function samplePageNumbers(pageCount, max = MAX_STYLE_PAGES) {
  if (pageCount <= max) {
    return Array.from({ length: pageCount }, (_, i) => i + 1)
  }
  return Array.from(
    { length: max },
    (_, i) => 1 + Math.round((i * (pageCount - 1)) / (max - 1))
  )
}


// Paint operators pdf.js writes into a constructPath.
const PAINT_FILL = new Set(['fill', 'eoFill', 'fillStroke', 'eoFillStroke', 'closeFillStroke', 'closeEOFillStroke'])
const PAINT_STROKE = new Set(['stroke', 'closeStroke', 'fillStroke', 'eoFillStroke', 'closeFillStroke', 'closeEOFillStroke'])

function multiply(a, b) {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ]
}

function applyPoint(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

/** Colour components (0-255 when `bytes`, else 0-1) as #rrggbb. */
function hexOf(values, { unit = 255 } = {}) {
  const v = [...values].slice(0, 3).map(n => Math.max(0, Math.min(255, Math.round(Number(n) * (unit === 255 ? 1 : 255)))))
  while (v.length < 3) v.push(v[0] ?? 0)
  return `#${v.map(n => n.toString(16).padStart(2, '0')).join('')}`
}

function cmykHex([c, m, y, k]) {
  return hexOf([255 * (1 - c) * (1 - k), 255 * (1 - m) * (1 - k), 255 * (1 - y) * (1 - k)])
}

/**
 * Walks a page's operator list. The text is read here, glyph by glyph, rather
 * than from pdf.js's text items: pdf.js joins text that shares a baseline into
 * one item, so the two columns of a page come out as one line. Each glyph gets
 * its position from the text matrix, the font size and the spacing settings.
 * Colours in force when text is shown, and rules (thin filled rectangles and
 * stroked lines) with their absolute position and thickness in bp, are read
 * in the same walk.
 */
export function walkOps(ops, OPS, fontNameOf = id => id) {
  const opName = Object.fromEntries(Object.entries(OPS).map(([k, v]) => [v, k]))
  const stack = []
  const identity = [1, 0, 0, 1, 0, 0]
  let ctm = identity
  let tm = identity
  let tlm = identity
  let font = null
  let fontSize = 0
  let charSpacing = 0
  let wordSpacing = 0
  let hScale = 1
  let leading = 0
  let rise = 0
  let lineWidth = 1
  let fill = '#000000'
  let stroke = '#000000'
  const rules = []
  const textColours = {}
  const items = []

  const emit = glyph => {
    const trmOf = m => multiply([fontSize * hScale, 0, 0, fontSize, 0, rise], multiply(m, ctm))
    const start = trmOf(tm)
    const isSpace = glyph.isSpace === true || glyph.unicode === ' '
    const advance = (Number(glyph.width) / 1000) * fontSize + charSpacing + (isSpace ? wordSpacing : 0)
    tm = multiply([1, 0, 0, 1, advance * hScale, 0], tm)
    const end = trmOf(tm)
    if (Math.abs(start[1]) > 0.01 || Math.abs(start[2]) > 0.01) return
    const size = Math.abs(start[3]) || Math.hypot(start[0], start[1])
    items.push({
      s: glyph.unicode ?? '',
      font: fontNameOf(font),
      size,
      x: start[4],
      y: start[5],
      w: end[4] - start[4],
    })
    textColours[fill] = (textColours[fill] ?? 0) + 1
  }
  // A show operator's array holds glyphs and, between them, the TJ
  // adjustments that make word spaces: a number moves the pen left.
  const showArray = array => {
    for (const g of array ?? []) {
      if (typeof g === 'object') emit(g)
      else tm = multiply([1, 0, 0, 1, (-Number(g) / 1000) * fontSize * hScale, 0], tm)
    }
  }
  const moveLine = (tx, ty) => {
    tlm = multiply([1, 0, 0, 1, tx, ty], tlm)
    tm = tlm
  }

  for (let i = 0; i < ops.fnArray.length; i++) {
    const op = opName[ops.fnArray[i]]
    const args = ops.argsArray[i] ?? []
    switch (op) {
      case 'save':
        stack.push({ ctm, lineWidth, fill, stroke })
        break
      case 'restore': {
        const s = stack.pop()
        if (s) ({ ctm, lineWidth, fill, stroke } = s)
        break
      }
      case 'transform':
        ctm = multiply(Array.from(args).map(Number), ctm)
        break
      case 'setLineWidth':
        lineWidth = Number(args[0]) || 0
        break
      case 'setFillRGBColor':
        fill = hexOf(args)
        break
      case 'setStrokeRGBColor':
        stroke = hexOf(args)
        break
      case 'setFillGray':
        fill = hexOf([Number(args[0])], { unit: 1 })
        break
      case 'setStrokeGray':
        stroke = hexOf([Number(args[0])], { unit: 1 })
        break
      case 'setFillCMYKColor':
        fill = cmykHex(args)
        break
      case 'setStrokeCMYKColor':
        stroke = cmykHex(args)
        break
      case 'beginText':
        tm = identity
        tlm = identity
        break
      case 'setFont':
        font = args[0]
        fontSize = Number(args[1]) || fontSize
        break
      case 'setTextMatrix':
        tlm = Array.from(args, Number)
        tm = tlm
        break
      case 'moveText':
        moveLine(Number(args[0]), Number(args[1]))
        break
      case 'setLeadingMoveText':
        leading = -Number(args[1])
        moveLine(Number(args[0]), Number(args[1]))
        break
      case 'nextLine':
        moveLine(0, -leading)
        break
      case 'setCharSpacing':
        charSpacing = Number(args[0]) || 0
        break
      case 'setWordSpacing':
        wordSpacing = Number(args[0]) || 0
        break
      case 'setHScale':
        hScale = (Number(args[0]) || 100) / 100
        break
      case 'setLeading':
        leading = Number(args[0]) || 0
        break
      case 'setTextRise':
        rise = Number(args[0]) || 0
        break
      case 'showText':
      case 'showSpacedText':
        showArray(args[0])
        break
      case 'nextLineShowText':
        moveLine(0, -leading)
        showArray(args[0])
        break
      case 'nextLineSetSpacingShowText':
        wordSpacing = Number(args[0]) || 0
        charSpacing = Number(args[1]) || 0
        moveLine(0, -leading)
        showArray(args[2])
        break
      case 'constructPath': {
        const paint = opName[args[0]]
        const box = args[2]
        if (!box || box.length < 4 || (!PAINT_FILL.has(paint) && !PAINT_STROKE.has(paint))) break
        const [x0, y0, x1, y1] = Array.from(box, Number)
        const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => applyPoint(ctm, x, y))
        const xs = corners.map(p => p[0])
        const ys = corners.map(p => p[1])
        const w = Math.max(...xs) - Math.min(...xs)
        const h = Math.max(...ys) - Math.min(...ys)
        const scale = Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2])) || 1
        const isFill = PAINT_FILL.has(paint)
        let thick = null
        let dir = null
        if (isFill && h < 3 && w > 8) {
          thick = h
          dir = 'h'
        } else if (isFill && w < 3 && h > 8) {
          thick = w
          dir = 'v'
        } else if (PAINT_STROKE.has(paint) && h < 0.01 && w > 8) {
          thick = lineWidth * scale
          dir = 'h'
        } else if (PAINT_STROKE.has(paint) && w < 0.01 && h > 8) {
          thick = lineWidth * scale
          dir = 'v'
        }
        if (thick && thick > 0) {
          const centreX = (Math.max(...xs) + Math.min(...xs)) / 2
          const centreY = (Math.max(...ys) + Math.min(...ys)) / 2
          rules.push({
            dir,
            at: dir === 'h' ? centreY : centreX,
            from: dir === 'h' ? Math.min(...xs) : Math.min(...ys),
            to: dir === 'h' ? Math.max(...xs) : Math.max(...ys),
            thickBp: thick,
            colour: isFill ? fill : stroke,
          })
        }
        break
      }
      default:
        break
    }
  }
  return { rules, textColours, items }
}

async function readPage(pdfjs, doc, pageNumber) {
  const page = await doc.getPage(pageNumber)
  // Released on every path, including a failed operator list, so the page's
  // decoded resources do not stay in memory until the document is destroyed.
  try {
    const [x0, y0, x1, y1] = page.view
    const ops = await page.getOperatorList()
    const fontNameOf = id => {
      try {
        const font = page.commonObjs.has(id) ? page.commonObjs.get(id) : null
        return font?.name ?? String(id ?? '')
      } catch {
        return String(id ?? '')
      }
    }
    const { rules, textColours, items } = walkOps(ops, pdfjs.OPS, fontNameOf)
    return { width: x1 - x0, height: y1 - y0, items, rules, textColours }
  } finally {
    page.cleanup()
  }
}


/**
 * The sampled pages of a PDF and its page count. `pdfjs` is the legacy build,
 * passed in so the caller decides where it is loaded. Throws with code
 * 'not_a_pdf' when pdf.js cannot open the bytes.
 */
export async function readPdfPages(pdfjs, data) {
  let doc
  try {
    doc = await pdfjs.getDocument({
      data,
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      verbosity: 0,
    }).promise
  } catch {
    throw Object.assign(new Error('The file is not a readable PDF.'), {
      code: 'not_a_pdf',
    })
  }
  try {
    const pages = []
    for (const n of samplePageNumbers(doc.numPages)) {
      pages.push(await readPage(pdfjs, doc, n))
    }
    return { pages, pageCount: doc.numPages }
  } finally {
    await doc.destroy().catch(() => {})
  }
}
