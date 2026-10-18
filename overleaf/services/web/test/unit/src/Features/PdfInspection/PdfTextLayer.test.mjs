import { describe, it, expect } from 'vitest'

const {
  compileQuery,
  pageColumns,
  pageLines,
  parseBboxLayout,
  searchPage,
  splitByColumns,
  unresolvedMarkers,
} = await import('../../../../../app/src/Features/PdfInspection/PdfTextLayer.mjs')

/**
 * One line of pdftotext output: words set on baseline `y` from x 72, 5pt per
 * character with 5pt between words. Word text is XML, so pass '&amp;' for '&'.
 */
function words(y, ...texts) {
  let x = 72
  return texts.map(text => {
    const word = [text, x, y]
    x += 5 * text.length + 5
    return word
  })
}

function boxAttrs([x0, y0, x1, y1]) {
  return `xMin="${x0.toFixed(6)}" yMin="${y0.toFixed(6)}" xMax="${x1.toFixed(6)}" yMax="${y1.toFixed(6)}"`
}

function lineXml(list) {
  const boxes = list.map(([text, x, y]) => [x, y, x + 5 * text.length, y + 10])
  const line = [
    Math.min(...boxes.map(box => box[0])),
    Math.min(...boxes.map(box => box[1])),
    Math.max(...boxes.map(box => box[2])),
    Math.max(...boxes.map(box => box[3])),
  ]
  const wordXml = list
    .map(([text], i) => `<word ${boxAttrs(boxes[i])}>${text}</word>`)
    .join('')
  return `<line ${boxAttrs(line)}>${wordXml}</line>`
}

function blockXml(lines) {
  const body = lines.map(lineXml).join('\n')
  return `<block xMin="0.000000" yMin="0.000000" xMax="612.000000" yMax="792.000000">\n${body}\n</block>`
}

function pageXml(blocks) {
  const body = blocks.map(blockXml).join('\n')
  return `<page width="612.000000" height="792.000000">\n<flow>\n${body}\n</flow>\n</page>`
}

function xhtml(pages) {
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd"><html xmlns="http://www.w3.org/1999/xhtml">
<head>
<title></title>
<meta name="Producer" content="xdvipdfmx (20260317)"/>
</head>
<body>
<doc>
${pages}
</doc>
</body>
</html>
`
}

/**
 * pdftotext output for `pages`: a page is an array of blocks, a block an array
 * of lines, a line the words() of it. So one page of one block of one line is
 * layout([[[words(90, 'Hello')]]]).
 */
function layout(pages) {
  return xhtml(pages.map(pageXml).join('\n'))
}

describe('parseBboxLayout', () => {
  it('reads every page in order, including a page with no text', () => {
    const pages = parseBboxLayout(
      layout([
        [[words(90, 'Chapter', 'One')]],
        [],
        [[words(90, 'Page', 'three')]],
      ])
    )
    expect(pages).toHaveLength(3)
    expect(pages.map(page => page.lines.map(line => line.text))).toEqual([
      ['Chapter One'],
      [],
      ['Page three'],
    ])
    expect(pages[1]).toEqual({ width: 612, height: 792, lines: [], blocks: [] })
  })

  it('returns no pages for an empty document', () => {
    expect(parseBboxLayout('')).toEqual([])
  })

  it('gives the page size and the box of each line and word', () => {
    const [page] = parseBboxLayout(layout([[[words(90, 'Figure', '2:')]]]))
    expect(page.blocks).toEqual([
      { xMin: 0, yMin: 0, xMax: 612, yMax: 792, lines: page.lines },
    ])
    const { blocks, ...rest } = page
    expect(rest).toEqual({
      width: 612,
      height: 792,
      lines: [
        {
          text: 'Figure 2:',
          xMin: 72,
          yMin: 90,
          xMax: 117,
          yMax: 100,
          words: [
            { text: 'Figure', xMin: 72, yMin: 90, xMax: 102, yMax: 100 },
            { text: '2:', xMin: 107, yMin: 90, xMax: 117, yMax: 100 },
          ],
          blockEnd: true,
        },
      ],
    })
  })

  it('decodes XML entities, numeric references included', () => {
    const [page] = parseBboxLayout(
      layout([
        [
          [
            words(
              90,
              'R&amp;D',
              '&#8217;s',
              '&#x2014;',
              '&lt;b&gt;',
              '&quot;q&quot;',
              '&apos;x&apos;'
            ),
          ],
        ],
      ])
    )
    expect(page.lines[0].text).toBe('R&D ’s — <b> "q" \'x\'')
  })

  it('folds ligatures to plain letters with NFKC', () => {
    const [page] = parseBboxLayout(
      layout([[[words(90, 'ﬁnal', 'ﬂow', 'o&#xFB03;ce', '&#xFB01;rst')]]])
    )
    expect(page.lines[0].words.map(word => word.text)).toEqual([
      'final',
      'flow',
      'office',
      'first',
    ])
  })

  it('marks only the last line of each block', () => {
    const [page] = parseBboxLayout(
      layout([
        [[words(90, 'Alpha'), words(106, 'beta')], [words(200, 'Gamma')]],
      ])
    )
    expect(page.lines.map(line => [line.text, line.blockEnd])).toEqual([
      ['Alpha', false],
      ['beta', true],
      ['Gamma', true],
    ])
  })
})

describe('compileQuery', () => {
  it('is null for a blank query', () => {
    expect(compileQuery('')).toBeNull()
    expect(compileQuery('  \t ')).toBeNull()
    expect(compileQuery(undefined)).toBeNull()
    expect(compileQuery('­')).toBeNull()
  })

  it('folds the query with NFKC, so a ligature in it matches the page', () => {
    const [page] = parseBboxLayout(
      layout([[[words(90, 'the', 'final', 'run')]]])
    )
    const matches = searchPage(page, compileQuery('ﬁnal'))
    expect(matches.map(match => match.text)).toEqual(['final'])
  })

  it('lets a hyphen in the query match a line-end hyphenation', () => {
    const [page] = parseBboxLayout(
      layout([[[words(90, 'state-of-'), words(106, 'the-art', 'models')]]])
    )
    const matches = searchPage(page, compileQuery('state-of-the-art'))
    // The line-end hyphen is read as TeX's, so the matched text drops it.
    expect(matches.map(match => match.text)).toEqual(['state-ofthe-art'])
  })
})

describe('searchPage', () => {
  it('finds a word hyphenated at a line end, without the hyphen', () => {
    const [page] = parseBboxLayout(
      layout([
        [[words(90, 'Our', 'experi-'), words(106, 'ment', 'was', 'long')]],
      ])
    )
    const matches = searchPage(page, compileQuery('experiment'))
    expect(matches).toHaveLength(1)
    // 'experi-' sits after 'Our' on the first line; 'ment' starts the second
    expect(matches[0]).toMatchObject({
      text: 'experiment',
      context: 'Our experiment was long',
      xMin: 72,
      yMin: 90,
      xMax: 127,
      yMax: 116,
      anchor: { x: 109.5, y: 95 },
    })
  })

  it('keeps a real hyphen at a line end that is followed by a digit', () => {
    const [page] = parseBboxLayout(
      layout([
        [[words(90, 'Caused', 'by', 'COVID-'), words(106, '19', 'cases')]],
      ])
    )
    const matches = searchPage(page, compileQuery('COVID-19'))
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({
      text: 'COVID-19',
      context: 'Caused by COVID-19 cases',
    })
  })

  it('matches a multi-word query across a line break', () => {
    const [page] = parseBboxLayout(
      layout([
        [
          [
            words(90, 'Recent', 'artificial'),
            words(106, 'intelligence', 'work'),
          ],
        ],
      ])
    )
    const matches = searchPage(page, compileQuery('artificial   intelligence'))
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({
      text: 'artificial intelligence',
      context: 'Recent artificial intelligence work',
    })
  })

  it('ignores case unless asked not to', () => {
    const [page] = parseBboxLayout(
      layout([
        [[words(90, 'Table', '1', 'shows', 'TABLE', '2', 'and', 'table', '3')]],
      ])
    )
    expect(searchPage(page, compileQuery('table'))).toHaveLength(3)
    const exact = searchPage(
      page,
      compileQuery('Table', { caseSensitive: true })
    )
    expect(exact.map(match => match.text)).toEqual(['Table'])
  })

  it('treats the query as plain text, not as a pattern', () => {
    const [page] = parseBboxLayout(
      layout([
        [
          [
            words(
              90,
              'Values',
              '??',
              'and',
              '[?]',
              'a+b',
              '(c)',
              'aab',
              'what?'
            ),
          ],
        ],
      ])
    )
    expect(searchPage(page, compileQuery('??')).map(m => m.text)).toEqual([
      '??',
    ])
    expect(searchPage(page, compileQuery('[?]')).map(m => m.text)).toEqual([
      '[?]',
    ])
    expect(searchPage(page, compileQuery('a+b (c)')).map(m => m.text)).toEqual([
      'a+b (c)',
    ])
    expect(searchPage(page, compileQuery('.*'))).toEqual([])
  })

  it('unions the boxes of the words a match touches and anchors on the first', () => {
    const [page] = parseBboxLayout(
      layout([[[words(90, 'Figure', '2:', 'Results')]]])
    )
    const [match] = searchPage(page, compileQuery('Figure 2'))
    expect(match).toMatchObject({
      text: 'Figure 2',
      xMin: 72,
      yMin: 90,
      xMax: 117,
      yMax: 100,
      anchor: { x: 87, y: 95 },
    })
  })

  it('cuts the context to 60 characters a side, marked with an ellipsis', () => {
    const before = Array(30).fill('lorem')
    const after = Array(30).fill('ipsum')
    const [page] = parseBboxLayout(
      layout([[[words(90, ...before, 'target', ...after)]]])
    )
    const [match] = searchPage(page, compileQuery('target'))
    const near = Array(10).fill('lorem').join(' ')
    const far = Array(10).fill('ipsum').join(' ')
    expect(match.context).toBe(`…${near} target ${far}…`)
  })

  it('finds nothing for a null regex and leaves lastIndex at zero', () => {
    const [page] = parseBboxLayout(layout([[[words(90, 'Table', '1')]]]))
    expect(searchPage(page, null)).toEqual([])
    const regex = compileQuery('table')
    expect(searchPage(page, regex)).toHaveLength(1)
    expect(regex.lastIndex).toBe(0)
  })

  it('steps over zero-length matches rather than looping on them', () => {
    const [page] = parseBboxLayout(layout([[[words(90, 'Table', '1')]]]))
    expect(searchPage(page, /x*/g)).toEqual([])
    expect(searchPage(page, /table/i)).toHaveLength(1)
  })
})

describe('pageLines', () => {
  it('gives each line top to bottom with its height as a percentage of the page', () => {
    const [page] = parseBboxLayout(
      layout([[[words(90, 'Title')], [words(200, 'Body', 'text')]]])
    )
    expect(pageLines(page)).toEqual({
      lines: [
        { y: 12, text: 'Title' },
        { y: 26, text: 'Body text' },
      ],
    })
  })

  it('keeps every line of a long page', () => {
    const [page] = parseBboxLayout(
      layout([[[words(90, 'aaaa'), words(106, 'bbbbb'), words(122, 'cccccc')]]])
    )
    expect(pageLines(page).lines.map(line => line.text)).toEqual([
      'aaaa',
      'bbbbb',
      'cccccc',
    ])
  })
})

describe('unresolvedMarkers', () => {
  it('counts a run of question marks once as a reference', () => {
    const [page] = parseBboxLayout(
      layout([
        [
          [
            words(
              90,
              'See',
              'Section',
              '??',
              'and',
              'Table',
              '???,',
              'what?',
              'Fine',
              '[?]??'
            ),
          ],
        ],
      ])
    )
    expect(unresolvedMarkers(page)).toEqual({ refs: 3, cites: 1 })
  })

  it('counts [?] as a citation and not as a reference', () => {
    const [page] = parseBboxLayout(
      layout([[[words(90, 'as', 'shown', '[?],', '[?]', 'and', '[?]')]]])
    )
    expect(unresolvedMarkers(page)).toEqual({ refs: 0, cites: 3 })
  })

  it('counts a citation of several undefined keys once', () => {
    const [page] = parseBboxLayout(
      layout([[[words(90, 'see', '[?,', '?]', 'and', '[?,?,?]')]]])
    )
    expect(unresolvedMarkers(page)).toEqual({ refs: 0, cites: 2 })
  })

  it('counts nothing on a page with no text', () => {
    const [page] = parseBboxLayout(layout([[]]))
    expect(unresolvedMarkers(page)).toEqual({ refs: 0, cites: 0 })
  })
})

/** A page object as parseBboxLayout gives it: one line of words per row. */
function rowOf(text, x0, x1, y) {
  const parts = text.split(' ')
  const step = (x1 - x0) / parts.length
  const words = parts.map((word, i) => ({
    text: word,
    xMin: x0 + i * step,
    yMin: y,
    xMax: x0 + (i + 1) * step - 2,
    yMax: y + 10,
  }))
  return {
    text,
    xMin: x0,
    yMin: y,
    xMax: x1 - 2,
    yMax: y + 10,
    words,
    blockEnd: false,
  }
}

// pdftotext gives the two columns of a row one line, the words of both in it
function twoColumnPage(rows = 6) {
  const lines = []
  for (let i = 0; i < rows; i++) {
    const left = rowOf(
      'left column text of the body here',
      72,
      290,
      100 + i * 12
    )
    const right = rowOf(
      'right column text of the body here',
      310,
      530,
      100 + i * 12
    )
    lines.push({
      text: `${left.text} ${right.text}`,
      xMin: 72,
      yMin: left.yMin,
      xMax: right.xMax,
      yMax: left.yMax,
      words: [...left.words, ...right.words],
      blockEnd: false,
    })
  }
  return { width: 595, height: 842, lines, blocks: [{ lines }] }
}

describe('pageColumns', () => {
  it('finds two columns from the words, where a gutter no row crosses separates them', () => {
    const columns = pageColumns(twoColumnPage())
    expect(columns).toHaveLength(2)
    // the edges are the words' edges, to the point
    expect(Math.abs(columns[0].left - 72)).toBeLessThanOrEqual(1)
    expect(Math.abs(columns[0].right - 288)).toBeLessThanOrEqual(2)
    expect(Math.abs(columns[1].left - 310)).toBeLessThanOrEqual(1)
    expect(Math.abs(columns[1].right - 528)).toBeLessThanOrEqual(2)
  })

  it('is one column for a page of one column of text', () => {
    const lines = Array.from({ length: 8 }, (_, i) =>
      rowOf('one column of body text here', 72, 500, 100 + i * 12)
    )
    const columns = pageColumns({ width: 595, height: 842, lines, blocks: [] })
    expect(columns).toHaveLength(1)
    expect(columns[0].left).toBeCloseTo(72, 0)
  })

  it('is not split by a heading across the gutter, which one row alone crosses', () => {
    const page = twoColumnPage()
    page.lines.unshift(rowOf('Two Columns', 250, 350, 80))
    expect(pageColumns(page)).toHaveLength(2)
  })

  it('needs a few rows in each column before it calls them columns', () => {
    expect(pageColumns(twoColumnPage(1))).toHaveLength(1)
  })

  it('gives no columns for a page with no text', () => {
    expect(
      pageColumns({ width: 595, height: 842, lines: [], blocks: [] })
    ).toEqual([])
  })

  it('keeps the columns of a page with more rows than a 16-bit count holds', () => {
    const lines = []
    for (let i = 0; i < 70000; i++) {
      lines.push({
        text: 'a b',
        xMin: 72,
        yMin: i,
        xMax: 528,
        yMax: i + 10,
        words: [
          { text: 'a', xMin: 72, yMin: i, xMax: 288, yMax: i + 10 },
          { text: 'b', xMin: 310, yMin: i, xMax: 528, yMax: i + 10 },
        ],
        blockEnd: false,
      })
    }
    expect(pageColumns({ width: 595, height: 842, lines, blocks: [] })).toHaveLength(2)
  })

  it('reads a line of very many words without spreading them into arguments', () => {
    const words = Array.from({ length: 200_000 }, (_, i) => ({
      text: 'w',
      xMin: 72 + i * 0.002,
      yMin: 100,
      xMax: 72 + i * 0.002 + 0.001,
      yMax: 110,
    }))
    const page = {
      width: 595,
      height: 842,
      lines: [
        {
          text: 'w',
          xMin: 72,
          yMin: 100,
          xMax: 472,
          yMax: 110,
          words,
          blockEnd: false,
        },
      ],
      blocks: [],
    }
    expect(() => pageColumns(page)).not.toThrow()
    expect(() => splitByColumns(page)).not.toThrow()
  })
})

describe('splitByColumns', () => {
  it('cuts a line that runs across the gutter into one piece per column', () => {
    const page = twoColumnPage()
    const { columns, page: laid } = splitByColumns(page)
    expect(columns).toHaveLength(2)
    expect(laid.lines).toHaveLength(page.lines.length * 2)
    const first = laid.lines[0]
    expect(first.text).toBe('left column text of the body here')
    expect(first.xMax).toBeLessThan(300)
    expect(laid.lines[1].text).toBe('right column text of the body here')
    expect(laid.lines[1].xMin).toBeGreaterThan(300)
    // the blocks hold the pieces too, so grouping sees the columns
    expect(laid.blocks[0].lines).toHaveLength(page.lines.length * 2)
  })

  it('leaves a single-column page as it is', () => {
    const lines = [rowOf('one column', 72, 300, 100)]
    const page = { width: 595, height: 842, lines, blocks: [{ lines }] }
    expect(splitByColumns(page).page).toBe(page)
  })
})

describe('line boxes without their own extent', () => {
  it('takes the extent of its words, as a line with an empty box does not say where it is', () => {
    const [page] = parseBboxLayout(
      '<html><body><doc><page width="612" height="792"><flow><block>' +
        '<line xMin="0.000000" yMin="0.000000" xMax="0.000000" yMax="0.000000">' +
        '<word xMin="72.000000" yMin="90.000000" xMax="102.000000" yMax="100.000000">Figure</word>' +
        '<word xMin="107.000000" yMin="90.000000" xMax="117.000000" yMax="100.000000">2:</word>' +
        '</line></block></flow></page></doc></body></html>'
    )
    expect(page.lines[0]).toMatchObject({
      xMin: 72,
      xMax: 117,
      yMin: 90,
      yMax: 100,
    })
  })
})
