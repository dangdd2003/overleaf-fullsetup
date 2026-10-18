// Structured defect records for a page or a whole build, built from what the
// inspector already measured: the layout of the ink, text running past the
// column, bad boxes from the log, unresolved references and the fonts. Each
// record names the page, the block ID and the source line when it can, so the
// model can go straight to the fix.
//
// The banned fixes follow PaperFit 2026, a published LaTeX layout agent: a
// quick fix that hides a symptom (shrinking a table, forcing a page break,
// squeezing spacing) is rejected in advance, because the next edit brings the
// problem back and the reader sees the squeeze. The records carry the names of
// the fixes that are banned for their category, with the reason in
// BANNED_QUICK_FIXES, so the model is told why before it reaches for one.
//
// Pure: measurements in, records out.

// The fixes an agent reaches for first, and why each is refused.
export const BANNED_QUICK_FIXES = {
  '\\resizebox':
    'shrinks a table or box to the text width, so the text becomes unreadable and any later growth overflows again',
  '\\small':
    'shrinks a whole block to hide a width problem that a reword or a line break would fix',
  '\\tiny':
    'shrinks text below the readable size to hide a width problem; no reader can use the result',
  '\\sloppy':
    'loosens word spacing across the whole document to hide one overfull line; fix that line instead',
  '\\vspace{-':
    'negative vertical space fakes a fit that overlaps the next block as soon as the content moves',
  '\\hspace{-':
    'negative horizontal space pushes ink into the margin or the next column, which is the defect itself',
  '\\enlargethispage':
    'shrinks the page bottom for one page to pull back a line; the next edit makes the page overflow',
  '\\newpage':
    'forces a break to hide an early end or a float problem, which leaves the page half empty',
  '\\clearpage':
    'flushes every pending float onto new pages to hide a placement problem, which leaves gaps',
  '[H]':
    'pins a float where it is typeset, which pushes the float to a page of its own when it does not fit',
}

// The fixes that are banned for each defect category.
export const BANNED_FIXES_BY_CATEGORY = {
  overflow: ['\\resizebox', '\\small', '\\tiny', '\\sloppy'],
  overfull_hbox: ['\\sloppy', '\\resizebox', '\\small', '\\tiny'],
  underfull: ['\\sloppy'],
  float_placement: ['[H]', '\\clearpage', '\\newpage', '\\vspace{-'],
  blank_page: ['\\newpage', '\\clearpage', '\\enlargethispage'],
  early_page_end: [
    '\\newpage',
    '\\clearpage',
    '\\enlargethispage',
    '\\vspace{-',
  ],
  widow: ['\\vspace{-', '\\enlargethispage', '\\newpage'],
  overlap: ['\\vspace{-', '\\hspace{-'],
}

export const DEFECT_CATEGORIES = [
  'overflow',
  'overfull_hbox',
  'underfull',
  'float_placement',
  'blank_page',
  'early_page_end',
  'widow',
  'unresolved_ref',
  'unresolved_cite',
  'font',
  'overlap',
]

// An overflow this far past the text block (mm) is an error, not a warning.
const OVERFLOW_ERROR_MM = 5
// An overfull box at least this wide (points) is an error.
const OVERFULL_ERROR_PT = 10

function bannedFor(category) {
  const fixes = BANNED_FIXES_BY_CATEGORY[category]
  return fixes?.length ? { bannedFixes: [...fixes] } : {}
}

// A record without the optional fields that were not known, so JSON holds
// only what was measured.
function record(category, fields) {
  const known = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined)
  )
  return { category, ...known, ...bannedFor(category) }
}

/**
 * The block of `blocks` (output form, bbox in points) that a stretch of the page
 * falls on: the one whose box overlaps it most, or null. `top` and `bottom` are
 * percentages of the page height, as the overview reports them.
 */
export function blockAtBand(blocks, { top, bottom, pageHeight }) {
  let best = null
  let bestOverlap = 0
  for (const block of blocks ?? []) {
    const blockTop = (100 * block.bbox.y) / pageHeight
    const blockBottom = (100 * (block.bbox.y + block.bbox.h)) / pageHeight
    const overlap = Math.min(bottom, blockBottom) - Math.max(top, blockTop)
    if (overlap > bestOverlap) {
      bestOverlap = overlap
      best = block
    }
  }
  return best?.id ?? null
}

/** The block that typesets `line` of `path`, from the blocks' source spans. */
export function blockAtSource(blocks, { path, line }) {
  if (!path || line == null) return null
  const found = (blocks ?? []).find(
    block =>
      block.path === path &&
      block.line != null &&
      line >= block.line &&
      line <= (block.endLine ?? block.line)
  )
  return found?.id ?? null
}

/**
 * The defect records of one page, without IDs. `layout` is what layoutFindings
 * measured, `overflow` what overflowFindings measured, `badBoxes` the bad boxes
 * that belong on the page (`{ message, path, line }`), `markers` the unresolved
 * references and citations, and `blocks` the page's labelled blocks.
 *
 * @returns {Array<object>}
 */
export function pageDefects({
  page,
  pageSize,
  layout = null,
  overflow = [],
  badBoxes = [],
  markers = { refs: 0, cites: 0 },
  blocks = [],
  near = () => null,
}) {
  const found = []
  const pageHeight = pageSize?.height ?? 842
  if (layout?.blank) {
    found.push(
      record('blank_page', {
        page,
        severity: 'error',
        evidence: 'The page has no ink: nothing typeset on it.',
      })
    )
  }
  if (layout && !layout.blank && layout.endsAt != null) {
    const where = near(layout.endsAt)
    found.push(
      record('early_page_end', {
        page,
        severity: 'warning',
        evidence: `The body ends at ${layout.endsAt}% of the page height and the rest is empty.`,
        path: where?.path,
        line: where?.line,
      })
    )
  }
  for (const gap of layout?.gaps ?? []) {
    const where = near(gap.bottom)
    found.push(
      record('float_placement', {
        page,
        severity: 'warning',
        evidence: `Empty band from ${gap.top}% to ${gap.bottom}% of the page: a float or a block may have been pushed to another page.`,
        blockId:
          blockAtBand(blocks, {
            top: gap.bottom,
            bottom: gap.bottom + 1,
            pageHeight,
          }) ?? undefined,
        path: where?.path,
        line: where?.line,
      })
    )
  }
  for (const run of overflow) {
    const where = near((run.top + run.bottom) / 2)
    const evidence =
      run.reference === 'paper'
        ? `Ink ${run.mm} mm from the ${run.side} edge of the paper, from ${run.top}% to ${run.bottom}% of the page height.`
        : `Ink ${run.mm} mm past the ${run.side} edge of the ${run.reference === 'column' ? 'column' : 'text block'}, from ${run.top}% to ${run.bottom}% of the page height.`
    found.push(
      record('overflow', {
        page,
        severity: run.mm >= OVERFLOW_ERROR_MM ? 'error' : 'warning',
        evidence,
        blockId:
          blockAtBand(blocks, {
            top: run.top,
            bottom: run.bottom,
            pageHeight,
          }) ?? undefined,
        path: where?.path,
        line: where?.line,
      })
    )
  }
  for (const box of badBoxes) {
    const tooWide = /Overfull .*?\(([\d.]+)pt too/.exec(box.message ?? '')
    const underfull = /^Underfull/.test(box.message ?? '')
    const category = underfull ? 'underfull' : 'overfull_hbox'
    const severity = underfull
      ? 'info'
      : parseFloat(tooWide?.[1] ?? '0') >= OVERFULL_ERROR_PT
        ? 'error'
        : 'warning'
    found.push(
      record(category, {
        page,
        severity,
        evidence: String(box.message ?? '').split('\n')[0],
        path: box.path ?? undefined,
        line: box.line ?? undefined,
        blockId: blockAtSource(blocks, box) ?? undefined,
      })
    )
  }
  if (markers.refs > 0) {
    found.push(
      record('unresolved_ref', {
        page,
        severity: 'error',
        evidence: `${markers.refs} reference(s) print as ?? on this page: the label is missing or the build needs another run.`,
      })
    )
  }
  if (markers.cites > 0) {
    found.push(
      record('unresolved_cite', {
        page,
        severity: 'error',
        evidence: `${markers.cites} citation(s) print as [?] on this page: the key is missing from the bibliography.`,
      })
    )
  }
  return found
}

/** Font records for a document: a font not embedded, or Type 3. No page. */
export function fontDefects(fonts) {
  const found = []
  for (const name of fonts?.notEmbedded ?? []) {
    found.push(
      record('font', {
        page: null,
        severity: 'warning',
        evidence: `Font ${name} is not embedded: another machine substitutes its own glyphs.`,
      })
    )
  }
  for (const name of fonts?.type3 ?? []) {
    found.push(
      record('font', {
        page: null,
        severity: 'warning',
        evidence: `Font ${name} is Type 3: bitmap glyphs, blurry when zoomed and rejected by many submission checkers.`,
      })
    )
  }
  return found
}

/** The records with IDs D1 upwards, in the order given. */
export function numberDefects(records) {
  return records.map((item, index) => ({ id: `D${index + 1}`, ...item }))
}
