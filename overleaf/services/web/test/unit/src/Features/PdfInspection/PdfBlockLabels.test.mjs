import { describe, it, expect } from 'vitest'

const {
  blockOf,
  groupBlocks,
  numberUnits,
  rememberBlocks,
  resolveBlock,
  unitMarks,
  unitProbes,
  unitsInSpan,
} = await import('../../../../../app/src/Features/PdfInspection/PdfBlockLabels.mjs')

const W = 595
const H = 842

/**
 * A line of `text` from x0 at baseline row `y`: words of `wordWidth` points
 * with `gap` between them, the way pdftotext lays them out.
 */
function line(text, x0, y, { gap = 3, wordWidth = 20 } = {}) {
  let x = x0
  const words = text.split(' ').map(word => {
    const box = {
      text: word,
      xMin: x,
      yMin: y,
      xMax: x + wordWidth,
      yMax: y + 10,
    }
    x += wordWidth + gap
    return box
  })
  const last = words.at(-1)
  return {
    text,
    xMin: x0,
    yMin: y,
    xMax: last.xMax,
    yMax: y + 10,
    words,
    blockEnd: false,
  }
}

/** A page whose blocks are the given arrays of lines, one block each. */
function page(blocks) {
  return {
    width: W,
    height: H,
    lines: blocks.flat(),
    blocks: blocks.map(lines => ({
      xMin: 0,
      yMin: 0,
      xMax: 0,
      yMax: 0,
      lines,
    })),
  }
}

const LEFT = 72
const RIGHT = 300

describe('groupBlocks', () => {
  it('starts a unit at each indented line, so paragraphs stay apart', () => {
    const rows = [0, 1, 2, 3].map(i =>
      line('alpha beta gamma delta', LEFT + (i === 2 ? 15 : 0), 100 + i * 12)
    )
    const units = groupBlocks(page([rows]))
    expect(units.map(unit => unit.lines.length)).toEqual([2, 2])
    expect(units[1].lines[0].yMin).toBe(124)
  })

  it('keeps a paragraph whole even when pdftotext gives each line its own block', () => {
    const rows = [0, 1, 2].map(i =>
      line('alpha beta gamma delta', LEFT, 100 + i * 12)
    )
    const units = groupBlocks(page(rows.map(row => [row])))
    expect(units).toHaveLength(1)
    expect(units[0].lines).toHaveLength(3)
  })

  it('splits two columns that pdftotext ran into one block, and reads each column top to bottom', () => {
    // Left column rows 100 to 136 and right column rows 100 to 136, one block
    const left = [0, 1, 2, 3, 4].map(i =>
      line('left column text here', LEFT, 100 + i * 12, { wordWidth: 30 })
    )
    const right = [0, 1, 2, 3, 4].map(i =>
      line('right column text here', 330, 100 + i * 12, { wordWidth: 30 })
    )
    const mixed = left.map((row, i) => {
      const words = [...row.words, ...right[i].words]
      return {
        ...row,
        words,
        text: `${row.text} ${right[i].text}`,
        xMax: right[i].xMax,
      }
    })
    const units = groupBlocks(page([mixed]))
    const columnsSeen = units.map(unit =>
      unit.bbox.x < 200 ? 'left' : 'right'
    )
    // every left column unit comes before the right column's
    expect(columnsSeen.lastIndexOf('left')).toBeLessThan(
      columnsSeen.indexOf('right')
    )
    expect(
      units.every(unit =>
        unit.lines.every(row =>
          row.words.every(word => word.xMin < 200 === unit.bbox.x < 200)
        )
      )
    ).toBe(true)
  })

  it('names a unit that starts with a caption as a caption', () => {
    const body = [0, 1].map(i =>
      line('body text of the paragraph', LEFT, 100 + i * 12)
    )
    const caption = [line('Figure 1: A grey box.', LEFT, 130)]
    const units = groupBlocks(page([body, caption]))
    expect(units.map(unit => unit.kind)).toEqual(['text', 'caption'])
  })

  it('keeps the rows of a table together as one table unit', () => {
    const rows = [0, 1, 2].map(i =>
      line('Alpha Beta Gamma', LEFT, 100 + i * 12, { gap: 14 })
    )
    const units = groupBlocks(page([rows]))
    expect(units).toHaveLength(1)
    expect(units[0].kind).toBe('table')
  })

  it('calls a short centred line display maths', () => {
    // the body runs 72 to 287, so its centre is 180
    const body = [0, 1].map(i =>
      line('body text of the paragraph', LEFT, 100 + i * 12, { wordWidth: 40 })
    )
    const equation = [line('E equals m c', 151, 140, { gap: 3, wordWidth: 12 })]
    const units = groupBlocks(page([body, equation]))
    expect(units.at(-1).kind).toBe('display')
  })

  it('gives a page with no text no units', () => {
    expect(groupBlocks({ width: W, height: H, lines: [], blocks: [] })).toEqual(
      []
    )
  })
})

describe('unit helpers', () => {
  const units = numberUnits(
    groupBlocks(
      page([
        [line('one', LEFT, 100), line('two', LEFT, 112)],
        [line('Figure 2: caption', LEFT, 400)],
        [line('three', LEFT, 700)],
      ])
    )
  )

  it('numbers units B1 upwards in reading order', () => {
    expect(units.map(unit => unit.id)).toEqual(['B1', 'B2', 'B3'])
  })

  it('probes the first and the last line of a unit, or one line once', () => {
    const [first, second] = [unitProbes(units[0]), unitProbes(units[1])]
    expect(first).toHaveLength(2)
    expect(first[0].y).toBeLessThan(first[1].y)
    expect(second).toHaveLength(1)
  })

  it('keeps the units that reach into a span of the page', () => {
    expect(
      unitsInSpan(units, H, { top: 0, bottom: 0.2 }).map(unit => unit.id)
    ).toEqual(['B1'])
    expect(
      unitsInSpan(units, H, { top: 0.4, bottom: 0.5 }).map(unit => unit.id)
    ).toEqual(['B2'])
    expect(
      unitsInSpan(units, H, { top: 0.9, bottom: 1 }).map(unit => unit.id)
    ).toEqual([])
  })

  it('places each mark in pixels of the rendered span, clipped to the image by the caller', () => {
    const marks = unitMarks([units[0]], {
      span: { top: 0, bottom: 1 },
      pageHeight: H,
      rasterHeight: 842,
    })
    expect(marks).toEqual([{ tag: 'B1', top: 100, bottom: 122 }])
    const zoomed = unitMarks([units[0]], {
      span: { top: 0.1, bottom: 0.2 },
      pageHeight: H,
      rasterHeight: 84,
    })
    // the unit starts 16pt below the top of a span 84pt high, as 84px is 84pt
    expect(zoomed[0].top).toBeCloseTo(15.76, 1)
  })

  it('writes the output form of a unit, with endLine only when it runs on', () => {
    const one = blockOf(units[0], 3, {
      path: 'main.tex',
      line: 10,
      endLine: 10,
    })
    expect(one).toMatchObject({
      id: 'B1',
      page: 3,
      path: 'main.tex',
      line: 10,
      bbox: { x: 72, y: 100 },
    })
    expect(one).not.toHaveProperty('endLine')
    const two = blockOf(units[0], 3, {
      path: 'main.tex',
      line: 10,
      endLine: 14,
    })
    expect(two.endLine).toBe(14)
    expect(blockOf(units[0], 3, null)).toMatchObject({ path: null, line: null })
  })
})

describe('resolveBlock', () => {
  it('returns the remembered source of a block of one build and page', () => {
    rememberBlocks(
      'build-rb-1',
      2,
      new Map([
        ['B1', { path: 'main.tex', line: 4, endLine: 9 }],
        ['B2', { path: 'main.tex', line: 12, endLine: 12 }],
        ['B3', null],
      ])
    )
    expect(
      resolveBlock({ buildId: 'build-rb-1', page: 2, blockId: 'B1' })
    ).toEqual({
      path: 'main.tex',
      line: 4,
      endLine: 9,
    })
    expect(
      resolveBlock({ buildId: 'build-rb-1', page: 2, blockId: 'b2' })
    ).toEqual({
      path: 'main.tex',
      line: 12,
      endLine: 12,
    })
  })

  it('is null for an unknown build, page or block, or a block with no source', () => {
    rememberBlocks(
      'build-rb-2',
      1,
      new Map([['B1', { path: 'a.tex', line: 1 }]])
    )
    expect(
      resolveBlock({ buildId: 'build-rb-2', page: 2, blockId: 'B1' })
    ).toBeNull()
    expect(
      resolveBlock({ buildId: 'build-rb-x', page: 1, blockId: 'B1' })
    ).toBeNull()
    expect(
      resolveBlock({ buildId: 'build-rb-2', page: 1, blockId: 'B9' })
    ).toBeNull()
    rememberBlocks('build-rb-3', 1, new Map([['B1', null]]))
    expect(
      resolveBlock({ buildId: 'build-rb-3', page: 1, blockId: 'B1' })
    ).toBeNull()
  })
})
