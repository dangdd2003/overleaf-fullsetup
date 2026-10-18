import { describe, it, expect } from 'vitest'

const {
  BANNED_FIXES_BY_CATEGORY,
  BANNED_QUICK_FIXES,
  blockAtBand,
  blockAtSource,
  DEFECT_CATEGORIES,
  fontDefects,
  numberDefects,
  pageDefects,
} = await import('../../../../../app/src/Features/PdfInspection/PdfDefects.mjs')

const SIZE = { width: 595, height: 842 }

describe('BANNED_QUICK_FIXES', () => {
  it('gives a one-line reason for every fix a category bans', () => {
    for (const fixes of Object.values(BANNED_FIXES_BY_CATEGORY)) {
      for (const fix of fixes) {
        expect(BANNED_QUICK_FIXES[fix], fix).toMatch(/\S/)
        expect(BANNED_QUICK_FIXES[fix].includes('\n')).toBe(false)
      }
    }
  })

  it('bans the squeezes an agent reaches for first, by category', () => {
    expect(BANNED_FIXES_BY_CATEGORY.overflow).toContain('\\resizebox')
    expect(BANNED_FIXES_BY_CATEGORY.float_placement).toContain('[H]')
    expect(BANNED_FIXES_BY_CATEGORY.blank_page).toContain('\\newpage')
    expect(BANNED_FIXES_BY_CATEGORY.overfull_hbox).toContain('\\sloppy')
  })

  it('names only categories the records can have', () => {
    for (const category of Object.keys(BANNED_FIXES_BY_CATEGORY)) {
      expect(DEFECT_CATEGORIES).toContain(category)
    }
  })
})

describe('pageDefects', () => {
  it('reports a blank page as an error with its banned fixes', () => {
    const [found] = pageDefects({
      page: 4,
      pageSize: SIZE,
      layout: { blank: true, endsAt: null, gaps: [], body: null },
    })
    expect(found).toMatchObject({
      category: 'blank_page',
      page: 4,
      severity: 'error',
      bannedFixes: BANNED_FIXES_BY_CATEGORY.blank_page,
    })
  })

  it('reports an early end and a large empty band, with the line they come from', () => {
    const near = percent =>
      percent >= 50 ? { path: 'main.tex', line: 88 } : null
    const found = pageDefects({
      page: 2,
      pageSize: SIZE,
      layout: {
        blank: false,
        endsAt: 50,
        gaps: [{ top: 60, bottom: 90 }],
        body: {},
      },
      near,
    })
    expect(found.map(item => item.category)).toEqual([
      'early_page_end',
      'float_placement',
    ])
    expect(found[0]).toMatchObject({
      severity: 'warning',
      path: 'main.tex',
      line: 88,
    })
    expect(found[1].evidence).toMatch(/60% to 90%/)
  })

  it('grades an overflow by how far it reaches, and says which edge', () => {
    const found = pageDefects({
      page: 3,
      pageSize: SIZE,
      overflow: [
        { side: 'right', reference: 'textBlock', mm: 6.2, top: 40, bottom: 45 },
        {
          side: 'left',
          reference: 'column',
          column: 2,
          mm: 2,
          top: 60,
          bottom: 62,
        },
      ],
    })
    expect(found[0]).toMatchObject({ category: 'overflow', severity: 'error' })
    expect(found[0].evidence).toMatch(/past the right edge of the text block/)
    expect(found[1]).toMatchObject({ severity: 'warning' })
    expect(found[1].evidence).toMatch(/of the column/)
  })

  it('says ink near the paper edge is that far from the edge, not past anything', () => {
    const [found] = pageDefects({
      page: 1,
      pageSize: SIZE,
      overflow: [
        { side: 'right', reference: 'paper', mm: 0, top: 42, bottom: 43 },
      ],
    })
    expect(found.evidence).toMatch(/from the right edge of the paper/)
  })

  it('maps bad boxes to a category by their message and severity by width', () => {
    const found = pageDefects({
      page: 5,
      pageSize: SIZE,
      badBoxes: [
        {
          path: 'main.tex',
          line: 40,
          message:
            'Overfull \\hbox (48.2pt too wide) in paragraph at lines 40--41',
        },
        {
          path: 'main.tex',
          line: 42,
          message:
            'Overfull \\hbox (2.5pt too wide) in paragraph at lines 42--42',
        },
        {
          path: 'a.tex',
          line: 7,
          message: 'Underfull \\hbox (badness 10000) in paragraph',
        },
      ],
    })
    expect(found.map(item => [item.category, item.severity])).toEqual([
      ['overfull_hbox', 'error'],
      ['overfull_hbox', 'warning'],
      ['underfull', 'info'],
    ])
    expect(found[0]).toMatchObject({ path: 'main.tex', line: 40 })
    expect(found[0].evidence).toMatch(/^Overfull/)
  })

  it('attaches the block a bad box or an overflow falls in', () => {
    const blocks = [
      {
        id: 'B1',
        path: 'main.tex',
        line: 10,
        endLine: 14,
        bbox: { x: 72, y: 100, w: 300, h: 50 },
      },
      {
        id: 'B2',
        path: 'main.tex',
        line: 20,
        bbox: { x: 72, y: 400, w: 300, h: 50 },
      },
    ]
    const found = pageDefects({
      page: 1,
      pageSize: SIZE,
      overflow: [
        { side: 'right', reference: 'textBlock', mm: 3, top: 12, bottom: 18 },
      ],
      badBoxes: [
        {
          path: 'main.tex',
          line: 20,
          message: 'Overfull \\hbox (9pt too wide)',
        },
      ],
      blocks,
    })
    expect(found[0].blockId).toBe('B1')
    expect(found[1].blockId).toBe('B2')
  })

  it('reports unresolved references and citations once per page', () => {
    const found = pageDefects({
      page: 2,
      pageSize: SIZE,
      markers: { refs: 2, cites: 1 },
    })
    expect(found.map(item => [item.category, item.severity])).toEqual([
      ['unresolved_ref', 'error'],
      ['unresolved_cite', 'error'],
    ])
    expect(found[0]).not.toHaveProperty('bannedFixes')
  })

  it('reports nothing for a clean page', () => {
    expect(
      pageDefects({
        page: 1,
        pageSize: SIZE,
        layout: { blank: false, endsAt: null, gaps: [], body: {} },
        markers: { refs: 0, cites: 0 },
      })
    ).toEqual([])
  })
})

describe('blockAtBand and blockAtSource', () => {
  const blocks = [
    {
      id: 'B1',
      path: 'a.tex',
      line: 3,
      endLine: 8,
      bbox: { x: 0, y: 84, w: 100, h: 84 },
    },
    { id: 'B2', path: 'a.tex', line: 9, bbox: { x: 0, y: 500, w: 100, h: 84 } },
  ]

  it('picks the block whose box overlaps a band the most', () => {
    expect(blockAtBand(blocks, { top: 12, bottom: 18, pageHeight: 842 })).toBe(
      'B1'
    )
    expect(
      blockAtBand(blocks, { top: 30, bottom: 32, pageHeight: 842 })
    ).toBeNull()
  })

  it('finds the block that typesets a source line, through its end line', () => {
    expect(blockAtSource(blocks, { path: 'a.tex', line: 8 })).toBe('B1')
    expect(blockAtSource(blocks, { path: 'a.tex', line: 9 })).toBe('B2')
    expect(blockAtSource(blocks, { path: 'b.tex', line: 9 })).toBeNull()
    expect(blockAtSource(blocks, { path: null, line: 9 })).toBeNull()
  })
})

describe('fontDefects and numberDefects', () => {
  it('reports fonts that are not embedded or are Type 3, with no page', () => {
    const found = fontDefects({ notEmbedded: ['Arial'], type3: ['[none]'] })
    expect(
      found.map(item => [item.category, item.page, item.severity])
    ).toEqual([
      ['font', null, 'warning'],
      ['font', null, 'warning'],
    ])
    expect(found[0].evidence).toMatch(/Arial/)
    expect(fontDefects({ notEmbedded: [], type3: [] })).toEqual([])
  })

  it('numbers the records D1 upwards in the order given', () => {
    expect(
      numberDefects([{ category: 'blank_page' }, { category: 'font' }])
    ).toEqual([
      { id: 'D1', category: 'blank_page' },
      { id: 'D2', category: 'font' },
    ])
  })
})
