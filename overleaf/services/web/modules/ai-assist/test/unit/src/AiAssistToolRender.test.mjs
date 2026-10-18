import { describe, it } from 'vitest'
import { expect } from 'chai'
import {
  connectorOutcome,
  renderToolResult,
  withNotice,
} from '../../../app/src/AiAssistToolRender.mjs'

describe('renderToolResult', function () {
  it('renders read_file as a fenced block with a header and continuation hint', function () {
    const text = renderToolResult('read_file', {
      path: 'main.tex',
      from: 1,
      to: 2,
      totalLines: 5,
      content: '1: a\n2: b',
      truncated: true,
      nextRange: { from: 3, to: 5 },
    })
    expect(text).to.equal(
      'main.tex lines 1-2 of 5\n```\n1: a\n2: b\n```\n(truncated - call read_file with from=3, to=5 for the rest)'
    )
  })

  it('renders list_files rows and marks binaries', function () {
    const text = renderToolResult('list_files', {
      files: [
        { path: 'main.tex', type: 'doc', lines: 12 },
        { path: 'fig.png', type: 'binary' },
      ],
      total: 3,
      truncated: true,
    })
    expect(text).to.equal('main.tex  doc  12\nfig.png  binary\n(1 more; narrow with glob=)')
  })

  it('renders get_outline as an indented tree', function () {
    const text = renderToolResult('get_outline', {
      documentClass: 'article',
      sections: [
        { path: 'main.tex', line: 4, level: 1, title: 'Intro' },
        { path: 'main.tex', line: 6, level: 2, title: 'Background' },
      ],
      includes: [{ from: 'main.tex', to: 'b.tex', line: 9, resolved: false }],
      notes: [],
    })
    expect(text).to.equal(
      'documentclass: article\n    main.tex:4 Intro\n      main.tex:6 Background\n\\input main.tex:9 -> b.tex (UNRESOLVED)'
    )
  })

  it('renders get_packages and get_references', function () {
    expect(renderToolResult('get_packages', {
      documentClass: 'article',
      packages: [{ name: 'geometry', path: 'main.tex', line: 2 }],
    })).to.equal('documentclass: article\ngeometry  (main.tex:2)')

    expect(renderToolResult('get_references', {
      refs: [{ command: 'ref', key: 'sec:x', path: 'main.tex', line: 5, resolved: false }],
    })).to.equal('ref sec:x  main.tex:5  UNRESOLVED')

    expect(renderToolResult('get_references', {})).to.equal(
      '(no labels, references, or citations found in project)'
    )
  })

  it('keeps errors and unknown tools as JSON', function () {
    expect(renderToolResult('read_file', { error: 'File not found: x' })).to.equal('{"error":"File not found: x"}')
    expect(renderToolResult('compile_project', { status: 'success' })).to.equal('{"status":"success"}')
    expect(renderToolResult('no_such_tool', { a: 1 })).to.equal('{"a":1}')
    expect(renderToolResult('read_file', null)).to.equal('null')
  })

  it('renders compile_project as compact text without repeating the primary error', function () {
    const error = { file: 'main.tex', line: 3, message: 'Undefined control sequence.', excerpt: 'l.3 \\foo' }
    const text = renderToolResult('compile_project', {
      status: 'failure',
      errorCount: 2,
      warningCount: 1,
      message: 'The project compiled with 2 error(s) and 1 warning(s).',
      primaryError: error,
      errors: [error, { file: null, line: null, message: 'Emergency stop.' }],
      warnings: [{ file: 'main.tex', line: null, message: 'Label(s) may have changed.' }],
    })
    expect(text).to.equal([
      'The project compiled with 2 error(s) and 1 warning(s).',
      'Errors after the first often cascade from it.',
      'error main.tex:3: Undefined control sequence.',
      '    l.3 \\foo',
      'error unknown location: Emergency stop.',
      'warning main.tex: Label(s) may have changed.',
    ].join('\n'))
  })

  it('says how many diagnostics compile_project left out', function () {
    const text = renderToolResult('compile_project', {
      status: 'failure',
      errorCount: 25,
      warningCount: 0,
      message: 'm',
      errors: [{ file: 'a.tex', line: 1, message: 'x' }],
      warnings: [],
    })
    expect(text).to.include('(24 more error(s) and 0 more warning(s) not shown; call get_compile_result with a higher limit)')
  })

  it('renders get_compile_result, including the nothing-compiled case', function () {
    expect(renderToolResult('get_compile_result', { status: 'none', message: 'No compile yet.' })).to.equal('No compile yet.')
    expect(renderToolResult('get_compile_result', {
      status: 'success',
      errorCount: 0,
      warningCount: 1,
      errors: [],
      warnings: [{ file: 'main.tex', line: 7, message: 'Overfull \\hbox' }],
      truncated: false,
    })).to.equal('Last compile: success - 0 error(s), 1 warning(s)\nwarning main.tex:7: Overfull \\hbox')
  })

  it('renders an applied edit with its new line numbers and the shift below it', function () {
    expect(renderToolResult('edit_file', {
      status: 'applied',
      path: 'main.tex',
      startLine: 2,
      endLine: 3,
      lineDelta: 1,
      excerpt: '1: line 1\n2: a\n3: b\n4: line 3',
    })).to.equal(
      'Applied to main.tex, now lines 2-3. Later lines moved by +1; use these line numbers, not ones read before this edit.\n```\n1: line 1\n2: a\n3: b\n4: line 3\n```'
    )

    expect(renderToolResult('edit_file', {
      status: 'applied',
      path: 'main.tex',
      startLine: 2,
      endLine: null,
      lineDelta: -2,
      excerpt: '1: line 1',
    })).to.equal(
      'Applied to main.tex, removed text at line 2. Later lines moved by -2; use these line numbers, not ones read before this edit.\n```\n1: line 1\n```'
    )

    expect(renderToolResult('edit_file', { status: 'noMatch', error: 'x' })).to.equal('{"status":"noMatch","error":"x"}')
  })

  it('renders search context lines in file order', function () {
    expect(renderToolResult('search_text', {
      hits: [{ path: 'main.tex', line: 5, text: 'hit', before: ['b1', 'b2'], after: ['a1'] }],
      total: 1,
      truncated: false,
    })).to.equal('Found 1 hit(s):\n  3: b1\n  4: b2\nmain.tex:5: hit\n  6: a1')
  })

  it('renders a notice after the result, not inside it', function () {
    const text = renderToolResult('get_packages', {
      error: 'x',
      notice: 'The user switched to Plan mode.',
    })
    expect(text).to.equal(
      `${JSON.stringify({ error: 'x' })}\n\nThe user switched to Plan mode.`
    )
  })

  it('joins notices', function () {
    expect(withNotice({ a: 1, notice: 'One.' }, 'Two.')).to.deep.equal({
      a: 1,
      notice: 'One. Two.',
    })
    expect(withNotice('text', 'Two.')).to.equal('text')
  })

  it('renders list_available_settings and get_project_settings as human-readable text', function () {
    const availableText = renderToolResult('list_available_settings', {
      options: {
        compilers: ['pdflatex', 'xelatex'],
        editorThemes: ['cobalt', 'textmate'],
        imageNames: [{ imageName: 'texlive-2024.1' }],
        editorModes: ['none', 'vim'],
        overallThemes: ['system', 'light', 'dark'],
      },
    })
    expect(availableText).to.include('Available Settings & Options:')
    expect(availableText).to.include('Compilers: pdflatex, xelatex')
    expect(availableText).to.include('Editor Themes: cobalt, textmate')

    const settingsText = renderToolResult('get_project_settings', {
      settings: {
        name: 'Test Paper',
        compiler: { compiler: 'pdflatex', imageName: 'texlive-2024.1' },
        appearance: { editorTheme: 'cobalt', fontSize: 14 },
      },
    })
    expect(settingsText).to.include('Current Project Settings:')
    expect(settingsText).to.include('Project: Test Paper')
    expect(settingsText).to.include('Theme=cobalt')
  })

  it('renders configure settings tools as clean summary text', function () {
    const text = renderToolResult('configure_appearance_settings', {
      status: 'applied',
      updatedSettings: { editorTheme: 'cobalt', editorDarkTheme: 'cobalt' },
      message: 'Appearance settings updated successfully.',
    })
    expect(text).to.include(
      'Updated appearance settings (editorTheme, editorDarkTheme): Appearance settings updated successfully.'
    )
  })

  it('renders present_plan with its message or falls back to JSON', function () {
    expect(renderToolResult('present_plan', {
      status: 'approved',
      mode: 'manual',
      message: 'The user approved the plan.',
    })).to.equal('The user approved the plan.')

    expect(renderToolResult('present_plan', {
      status: 'unknown',
    })).to.equal('{"status":"unknown"}')
  })

  it('clamps get_outline MAX_SAFE_INTEGER range.to to "end"', function () {
    const text = renderToolResult('get_outline', {
      sections: [{ path: 'main.tex', line: 12, level: 1, title: 'Discussion' }],
      range: { from: 12, to: Number.MAX_SAFE_INTEGER },
      hint: 'read_file with path=main.tex from=12 to=end for the body',
    })
    expect(text).to.equal(
      'section lines 12-end\n    main.tex:12 Discussion\nread_file with path=main.tex from=12 to=end for the body'
    )
  })

  it('renders read_file on empty files gracefully', function () {
    const text = renderToolResult('read_file', {
      path: 'empty.tex',
      from: 1,
      to: 0,
      totalLines: 0,
      content: '',
      truncated: false,
    })
    expect(text).to.equal('empty.tex is empty (0 lines)\n```\n```')
  })

  it('renders tool aliases matching their canonical renderers', function () {
    expect(renderToolResult('search_project', {
      hits: [{ path: 'a.tex', line: 1, text: 'hi' }],
      total: 1,
    })).to.include('Found 1 hit(s):')

    expect(renderToolResult('project_map', {
      files: [{ path: 'main.tex', type: 'doc', lines: 10 }],
      total: 1,
    })).to.include('main.tex  doc  10')

    expect(renderToolResult('get_compile_log', {
      status: 'success',
      errorCount: 0,
      warningCount: 0,
      errors: [],
      warnings: [],
    })).to.equal('Last compile: success - 0 error(s), 0 warning(s)')
  })

  it('ends a clean compile with the visual check', function () {
    const text = renderToolResult('compile_project', {
      status: 'success',
      errorCount: 0,
      warningCount: 0,
      errors: [],
      warnings: [],
      message: 'The project compiled without errors.',
      visualCheck: 'A PDF was built ... call view_compiled_pdf_page',
    })
    expect(text.split('\n')).to.deep.equal([
      'The project compiled without errors.',
      'A PDF was built ... call view_compiled_pdf_page',
    ])
  })

  describe('view_compiled_pdf_page', function () {
    const PAGE = {
      status: 'ok',
      chosenBy: 'lastEdit',
      page: 3,
      pageCount: 12,
      pageSize: { width: 595, height: 842 },
      region: 'full',
      span: { top: 0, bottom: 100 },
      located: { path: 'tables/results.tex', line: 14, y: 37 },
      sourceMap: [
        { y: 5, path: 'main.tex', line: 88 },
        { y: 35, path: 'tables/results.tex', line: 12 },
      ],
      sourceRanges: [],
      badBoxes: [
        {
          path: 'tables/results.tex',
          line: 12,
          message: 'Overfull \\hbox (48.2pt too wide) in alignment at lines 12--20',
        },
      ],
      image: { mediaType: 'image/png', dpi: 150, width: 1240, height: 1754 },
    }

    it('says where the page is, which source is at which height, and what to check', function () {
      const text = renderToolResult('view_compiled_pdf_page', PAGE)
      expect(text).to.include(
        'PDF page 3 of 12, 595x842pt: the page of your last edit.'
      )
      expect(text).to.include(
        'tables/results.tex line 14 is typeset about 37% down the page.'
      )
      expect(text).to.include('    5%  main.tex:88\n   35%  tables/results.tex:12')
      expect(text).to.include(
        '  tables/results.tex:12  Overfull \\hbox (48.2pt too wide) in alignment at lines 12--20'
      )
      expect(text).to.include('compile_project, then view the page again')
      expect(text).to.include('Only the newest page images stay')
    })

    it('reads the same with or without the image bytes', function () {
      const withBytes = { ...PAGE, image: { ...PAGE.image, data: 'iVBORw0KGgo=' } }
      expect(renderToolResult('view_compiled_pdf_page', withBytes)).to.equal(
        renderToolResult('view_compiled_pdf_page', PAGE)
      )
    })

    it('names a zoomed region, a stale build and a model without images', function () {
      const text = renderToolResult('view_compiled_pdf_page', {
        ...PAGE,
        chosenBy: 'page',
        region: 'bottom',
        span: { top: 60, bottom: 100 },
        stale: true,
        imageOmitted: true,
        image: null,
      })
      expect(text).to.include('bottom third zoomed in (60%-100% of the page height).')
      expect(text).to.include('You edited the project after this build')
      expect(text).to.include('This model cannot take images')
      expect(text).to.not.include('Only the newest page images stay')
    })

    it('falls back to JSON for an error', function () {
      expect(
        renderToolResult('view_compiled_pdf_page', { error: 'No compile' })
      ).to.equal('{"error":"No compile"}')
    })

    it('says what a zoom on source covers, and where the block goes on', function () {
      const text = renderToolResult('view_compiled_pdf_page', {
        ...PAGE,
        chosenBy: 'line',
        region: 'focus',
        span: { top: 31, bottom: 48 },
        focus: {
          path: 'main.tex',
          line: 40,
          endLine: 52,
          top: 31,
          bottom: 48,
          continuesOn: [4],
        },
        image: null,
        imageOmitted: true,
      })
      expect(text.split('\n')[0]).to.equal(
        'PDF page 3 of 12, 595x842pt, zoomed on main.tex lines 40-52 (31%-48% of the page height).'
      )
      expect(text).to.include('The block continues on page 4.')
      expect(text).to.not.include('the page where the requested line')
    })

    it('names one line and several continuation pages', function () {
      const focus = {
        path: 'main.tex',
        line: 40,
        endLine: 40,
        top: 31,
        bottom: 48,
        continuesOn: [4, 5, 6],
      }
      const text = renderToolResult('view_compiled_pdf_page', {
        ...PAGE,
        region: 'focus',
        span: { top: 31, bottom: 48 },
        focus,
      })
      expect(text.split('\n')[0]).to.include(
        'zoomed on main.tex line 40 (31%-48% of the page height).'
      )
      expect(text).to.include('The block continues on pages 4–6.')
    })

    it('leaves the continuation line out when the block fits on one page', function () {
      const text = renderToolResult('view_compiled_pdf_page', {
        ...PAGE,
        region: 'focus',
        span: { top: 31, bottom: 48 },
        focus: {
          path: 'main.tex',
          line: 40,
          endLine: 52,
          top: 31,
          bottom: 48,
          continuesOn: [],
        },
      })
      expect(text).to.not.include('continues')
    })

    it('suggests endLine only for a page the model can see and has not zoomed', function () {
      const plain = renderToolResult('view_compiled_pdf_page', PAGE)
      expect(plain).to.include(
        'To check one element closely, pass path, line and endLine.'
      )
      const zoomed = renderToolResult('view_compiled_pdf_page', {
        ...PAGE,
        region: 'focus',
        span: { top: 31, bottom: 48 },
        focus: {
          path: 'main.tex',
          line: 40,
          endLine: 52,
          top: 31,
          bottom: 48,
          continuesOn: [],
        },
      })
      expect(zoomed).to.not.include('To check one element closely')
      const textOnly = renderToolResult('view_compiled_pdf_page', {
        ...PAGE,
        image: null,
        imageOmitted: true,
      })
      expect(textOnly).to.not.include('To check one element closely')
    })

    it('gives a text-only model the page text, with each line at its height', function () {
      const text = renderToolResult('view_compiled_pdf_page', {
        ...PAGE,
        image: null,
        imageOmitted: true,
        text: {
          lines: [
            { y: 8, text: 'Table 2: Results' },
            { y: 35, text: 'as shown in Figure ??' },
          ],
          truncated: true,
        },
      })
      expect(text).to.include(
        'described only by the page text, the SyncTeX map and bad boxes below.'
      )
      expect(text).to.include(
        'Page text (height % from the top):\n    8%  Table 2: Results\n   35%  as shown in Figure ??'
      )
      expect(text).to.include('(more text on this page is not shown)')
      expect(text).to.not.include('Only the newest page images stay')
    })

    it('says so when the page has no text layer', function () {
      const text = renderToolResult('view_compiled_pdf_page', {
        ...PAGE,
        image: null,
        imageOmitted: true,
        text: { lines: [], truncated: false },
      })
      expect(text).to.include(
        '(no text on this page; it may be only images)'
      )
    })
  })

  describe('view_compiled_pdf_overview', function () {
    const EMPTY_PAGE = {
      source: [],
      blank: false,
      endsAt: null,
      gaps: [],
      overflow: [],
      badBoxes: 0,
      worstBadBox: null,
      unresolved: { refs: 0, cites: 0 },
    }

    const OVERVIEW = {
      status: 'ok',
      fromPage: 1,
      toPage: 6,
      pageCount: 34,
      paper: {
        width: 612,
        height: 792,
        name: 'Letter',
        orientation: 'portrait',
      },
      mixedSizes: false,
      fonts: {
        total: 9,
        notEmbedded: ['Arial', 'Symbol'],
        type3: ['T1-cmr10'],
      },
      columns: 4,
      pages: [
        {
          ...EMPTY_PAGE,
          page: 1,
          source: [{ path: 'main.tex', startLine: 1, endLine: 35 }],
        },
        {
          ...EMPTY_PAGE,
          page: 2,
          source: [{ path: 'main.tex', startLine: 36, endLine: 80 }],
          badBoxes: 2,
          worstBadBox: {
            path: 'main.tex',
            line: 40,
            message: 'Overfull \\hbox (48.2pt too wide) in alignment at lines 40--52',
          },
        },
        {
          ...EMPTY_PAGE,
          page: 3,
          source: [{ path: 'chapters/intro.tex', startLine: 1, endLine: 40 }],
          endsAt: 55,
        },
        {
          ...EMPTY_PAGE,
          page: 4,
          source: [{ path: 'chapters/intro.tex', startLine: 41, endLine: 90 }],
          overflow: [{ side: 'right', mm: 12, top: 40, bottom: 52 }],
        },
        { ...EMPTY_PAGE, page: 5, blank: true },
        {
          ...EMPTY_PAGE,
          page: 6,
          source: [
            { path: 'chapters/methods.tex', startLine: 1, endLine: 30 },
            { path: 'tables/t1.tex', startLine: 1, endLine: 20 },
          ],
          gaps: [{ top: 30, bottom: 58 }],
          unresolved: { refs: 2, cites: 0 },
        },
      ],
      image: { mediaType: 'image/png', width: 1200, height: 900, bytes: 1 },
    }

    it('lists each page with its source and what was found on it', function () {
      expect(
        renderToolResult('view_compiled_pdf_overview', OVERVIEW).split('\n')
      ).to.deep.equal([
        'PDF overview: pages 1-6 of 34, Letter portrait (612x792pt). The image shows them 4 per row, each labelled with its page number.',
        'Fonts: not embedded: Arial, Symbol. Bitmap Type 3 (blurry text; usually fixed with \\usepackage[T1]{fontenc} and lmodern or cm-super): T1-cmr10.',
        '  p1   main.tex:1-35',
        '  p2   main.tex:36-80 | 2 bad boxes, worst main.tex:40 Overfull \\hbox (48.2pt too wide) in alignment at lines 40--52',
        '  p3   chapters/intro.tex:1-40 | content ends 55% down',
        '  p4   chapters/intro.tex:41-90 | ink 12mm past the right edge of the text block at 40%-52% down',
        '  p5   blank',
        '  p6   chapters/methods.tex:1-30, tables/t1.tex:1-20 | empty band 30%-58% | 2x ?? (undefined \\ref)',
        'Thumbnails cannot show small details: open a page with view_compiled_pdf_page to check it. Pages 7-34: call again with fromPage 7.',
      ])
    })

    it('says a single page and a last page without a next range', function () {
      const text = renderToolResult('view_compiled_pdf_overview', {
        ...OVERVIEW,
        fromPage: 34,
        toPage: 34,
        pages: [{ ...EMPTY_PAGE, page: 34, source: [] }],
        fonts: { notEmbedded: [], type3: [] },
      })
      expect(text.split('\n')).to.deep.equal([
        'PDF overview: page 34 of 34, Letter portrait (612x792pt). The image shows them 4 per row, each labelled with its page number.',
        '  p34  no source found',
        'Thumbnails cannot show small details: open a page with view_compiled_pdf_page to check it.',
      ])
    })

    it('names the next single page when one is left', function () {
      const text = renderToolResult('view_compiled_pdf_overview', {
        ...OVERVIEW,
        fromPage: 1,
        toPage: 33,
        pageCount: 34,
        pages: [],
      })
      expect(text).to.include('Page 34: call again with fromPage 34.')
    })

    it('leaves out the fonts line when every font is embedded and vector', function () {
      const text = renderToolResult('view_compiled_pdf_overview', {
        ...OVERVIEW,
        fonts: { total: 9, notEmbedded: [], type3: [] },
      })
      expect(text).to.not.include('Fonts:')
    })

    it('says the thumbnails predate later edits, and that pages differ in size', function () {
      const text = renderToolResult('view_compiled_pdf_overview', {
        ...OVERVIEW,
        stale: true,
        mixedSizes: true,
      })
      const lines = text.split('\n')
      expect(lines[1]).to.equal(
        'You edited the project after this build, so the thumbnails do not show those edits yet. Call compile_project, then view again.'
      )
      expect(text).to.include('The pages in this range have different sizes.')
    })

    it('says the image was left out for a model that cannot take images', function () {
      const text = renderToolResult('view_compiled_pdf_overview', {
        ...OVERVIEW,
        image: null,
        imageOmitted: true,
      })
      expect(text.split('\n')[0]).to.equal(
        'PDF overview: pages 1-6 of 34, Letter portrait (612x792pt). This model cannot take images, so only the measured facts are listed.'
      )
    })

    it('reads the same with or without the image bytes', function () {
      const withBytes = {
        ...OVERVIEW,
        image: { ...OVERVIEW.image, data: 'iVBORw0KGgo=' },
      }
      expect(renderToolResult('view_compiled_pdf_overview', withBytes)).to.equal(
        renderToolResult('view_compiled_pdf_overview', OVERVIEW)
      )
    })

    it('falls back to JSON for an error or an unexpected shape', function () {
      expect(
        renderToolResult('view_compiled_pdf_overview', { error: 'No compile' })
      ).to.equal('{"error":"No compile"}')
      expect(
        renderToolResult('view_compiled_pdf_overview', { unexpected: 1 })
      ).to.equal('{"unexpected":1}')
    })
  })

  describe('search_compiled_pdf', function () {
    const SEARCH = {
      status: 'ok',
      query: 'Figure ??',
      fromPage: 1,
      toPage: 12,
      pageCount: 12,
      matchCount: 14,
      pages: [3, 5, 6, 7, 12],
      matches: [
        {
          page: 3,
          y: 41,
          text: 'Figure ??',
          context: 'as shown in Figure ?? the model',
          path: 'main.tex',
          line: 120,
        },
        {
          page: 5,
          y: 12,
          text: 'Figure ??',
          context: 'see Figure ??',
          path: null,
          line: null,
        },
      ],
      truncated: true,
    }

    it('lists the matches with their pages, height and source', function () {
      expect(
        renderToolResult('search_compiled_pdf', SEARCH).split('\n')
      ).to.deep.equal([
        '14 matches for "Figure ??" on pages 3, 5–7, 12 (first 2 shown):',
        '  p3   41%  main.tex:120  …as shown in Figure ?? the model…',
        '  p5   12%  (no source found)  …see Figure ??…',
        'Open a page with view_compiled_pdf_page (page, or path and line) to see a match in place.',
      ])
    })

    it('does not say first N shown when every match came back', function () {
      const text = renderToolResult('search_compiled_pdf', {
        ...SEARCH,
        matchCount: 2,
        pages: [3, 5],
        truncated: false,
      })
      expect(text.split('\n')[0]).to.equal(
        '2 matches for "Figure ??" on pages 3, 5:'
      )
    })

    it('says a single match in the singular', function () {
      const text = renderToolResult('search_compiled_pdf', {
        ...SEARCH,
        matchCount: 1,
        pages: [3],
        matches: [SEARCH.matches[0]],
        truncated: false,
      })
      expect(text.split('\n')[0]).to.equal(
        '1 match for "Figure ??" on page 3:'
      )
    })

    it('says when nothing matched, and where it looked', function () {
      const text = renderToolResult('search_compiled_pdf', {
        status: 'ok',
        query: 'Nope',
        fromPage: 1,
        toPage: 12,
        pageCount: 12,
        matchCount: 0,
        pages: [],
        matches: [],
        truncated: false,
      })
      expect(text).to.equal(
        'No match for "Nope" in pages 1-12 of the PDF. The text may be typeset differently (try fewer words), be inside an image, or not be in this build.'
      )
    })

    it('names the one page it searched when that is all there was', function () {
      const text = renderToolResult('search_compiled_pdf', {
        status: 'ok',
        query: 'Nope',
        fromPage: 4,
        toPage: 4,
        pageCount: 12,
        matchCount: 0,
        pages: [],
        matches: [],
        truncated: false,
      })
      expect(text).to.include('No match for "Nope" in page 4 of the PDF.')
    })

    it('says the PDF predates later edits, before the matches', function () {
      const text = renderToolResult('search_compiled_pdf', {
        ...SEARCH,
        stale: true,
      })
      expect(text.split('\n')[0]).to.equal(
        'You edited the project after this build, so the PDF does not show those edits yet. Call compile_project, then search again.'
      )
    })

    it('falls back to JSON for an error or an unexpected shape', function () {
      expect(
        renderToolResult('search_compiled_pdf', { error: 'The query is empty.' })
      ).to.equal('{"error":"The query is empty."}')
      expect(renderToolResult('search_compiled_pdf', { hits: [] })).to.equal(
        '{"hits":[]}'
      )
    })
  })
})

describe('renderToolResult for highlight_in_pdf', function () {
  it('says what was highlighted without sending the boxes to the model', function () {
    const text = renderToolResult('highlight_in_pdf', {
      status: 'highlighted',
      count: 2,
      pages: [2, 3],
      highlights: [{ page: 2, h: 72.5, v: 300.25, width: 200, height: 12 }],
    })
    expect(text).to.include('Highlighted 2 area(s) on pages 2–3')
    expect(text).to.include('The project is unchanged.')
    expect(text).not.to.include('72.5')
    expect(text).not.to.include('highlights')
  })

  it('warns when the PDF predates the last edit', function () {
    const text = renderToolResult('highlight_in_pdf', {
      status: 'highlighted',
      count: 1,
      pages: [1],
      highlights: [],
      stale: true,
    })
    expect(text).to.include('on page 1')
    expect(text).to.include('may be off')
  })
})

describe('connector results in the transcript', function () {
  it('renders an MCP error as an Error line, so a provider without is_error still sees it failed', function () {
    const text = renderToolResult('mcp__docs__search', {
      error: 'Docs returned 500',
      mcpError: true,
    })
    expect(text).to.equal('Error: Docs returned 500')
  })

  it('renders the text of a successful connector result as it is', function () {
    expect(renderToolResult('mcp__docs__get', { result: 'Page body' })).to.equal('Page body')
  })

  it('renders search_connector_tools and read_connector_result as text, not as JSON', function () {
    expect(
      renderToolResult('search_connector_tools', { result: 'Loaded: mcp__docs__get' })
    ).to.equal('Loaded: mcp__docs__get')
    expect(
      renderToolResult('read_connector_result', { result: 'line one\nline two' })
    ).to.equal('line one\nline two')
    expect(
      renderToolResult('read_connector_result', { error: 'No connector result r9' })
    ).to.equal('Error: No connector result r9')
  })

  it('turns a server-flagged isError result into a failed result with its text as the error', function () {
    expect(connectorOutcome({ result: 'Not found', isError: true })).to.deep.equal({
      error: 'Not found',
      mcpError: true,
    })
  })

  it('leaves successful, already-failed and non-object results alone', function () {
    const ok = { result: 'fine' }
    expect(connectorOutcome(ok)).to.equal(ok)
    const failed = { error: 'boom' }
    expect(connectorOutcome(failed)).to.equal(failed)
    expect(connectorOutcome('plain')).to.equal('plain')
    expect(connectorOutcome(null)).to.equal(null)
  })

  it('describes an isError result with no text, rather than an empty error', function () {
    expect(connectorOutcome({ isError: true })).to.deep.equal({
      error: 'The tool reported an error.',
      mcpError: true,
    })
  })
})

