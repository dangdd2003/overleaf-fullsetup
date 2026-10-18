import { expect } from 'chai'
import { fireEvent, render, screen } from '@testing-library/react'
import { ToolCallDetailView } from '../../../../../frontend/js/features/ai-assist/components/agent/tool-call-detail'

describe('ToolCallDetailView', function () {
  it('renders read_file content with line numbers', function () {
    const call = {
      id: '1',
      name: 'read_file',
      args: { path: 'main.tex' },
      result: {
        content: '14: \\begin{document}\n15: \\begin{abstract}',
      },
    }
    render(<ToolCallDetailView call={call} />)
    expect(screen.getByText(/14: \\begin{document}/)).to.exist
    expect(screen.getByText(/15: \\begin{abstract}/)).to.exist
  })

  it('renders edit_file diff lines with additions and deletions', function () {
    const call = {
      id: '2',
      name: 'edit_file',
      args: {
        path: 'main.tex',
        oldText: '\\begin{old}',
        newText: '\\begin{new}',
      },
      result: { status: 'applied', message: 'Applied change to main.tex.' },
    }
    const { container } = render(<ToolCallDetailView call={call} />)
    expect(container.querySelector('.diff-del')?.textContent).to.contain(
      '\\begin{old}'
    )
    expect(container.querySelector('.diff-ins')?.textContent).to.contain(
      '\\begin{new}'
    )
    expect(screen.getByText(/applied change to main\.tex/i)).to.exist
  })

  it('renders cancelled badge when edit_file was stopped', function () {
    const call = {
      id: '2b',
      name: 'edit_file',
      args: {
        path: 'main.tex',
        oldText: '\\begin{old}',
        newText: '\\begin{new}',
      },
      result: { status: 'stopped' },
    }
    const { container } = render(<ToolCallDetailView call={call} />)
    expect(screen.getByText('Cancelled')).to.exist
    expect(container.querySelector('.ai-assist-tool-detail-diff.is-cancelled'))
      .to.exist
  })

  it('renders error messages when tool failed', function () {
    const call = {
      id: '3',
      name: 'edit_file',
      args: { path: 'main.tex' },
      result: { error: 'Text not found in main.tex' },
      isError: true,
    }
    render(<ToolCallDetailView call={call} />)
    expect(screen.getByText('Error')).to.exist
    expect(screen.getByText('Text not found in main.tex')).to.exist
  })

  it('renders compile log errors with file and line', function () {
    const call = {
      id: '4',
      name: 'get_compile_log',
      args: {},
      result: {
        status: 'failure',
        errors: [
          {
            file: 'main.tex',
            line: 15,
            message: 'Environment undefined',
            excerpt: '\\begin{undefined_env}',
          },
        ],
      },
    }
    render(<ToolCallDetailView call={call} />)
    expect(screen.getByText('main.tex:15')).to.exist
    expect(screen.getByText('Environment undefined')).to.exist

    // Only the title shows until the entry is clicked open.
    expect(screen.queryByText('\\begin{undefined_env}')).to.equal(null)
    const toggle = screen.getByRole('button', { expanded: false })
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).to.equal('true')
    expect(screen.getByText('\\begin{undefined_env}')).to.exist
  })

  it('unwraps legacy truncated preview strings to display read_file content', function () {
    const call = {
      id: '5',
      name: 'read_file',
      args: { path: 'main.tex' },
      result: {
        truncated: true,
        preview: JSON.stringify({
          truncated: true,
          preview: JSON.stringify({
            path: 'main.tex',
            from: 14,
            to: 18,
            content: '14: \\begin{document}\n15: \\begin{abstract}',
          }),
        }),
      },
    }
    render(<ToolCallDetailView call={call} />)
    expect(screen.getByText(/14: \\begin{document}/)).to.exist
    expect(screen.getByText(/15: \\begin{abstract}/)).to.exist
  })

  it('renders list_files with files array object without raw JSON dump', function () {
    const call = {
      id: '6',
      name: 'list_files',
      args: {},
      result: {
        files: [
          { path: 'main.tex', type: 'doc', size: 30094, lines: 323 },
          { path: 'ref.bib', type: 'doc', size: 1024, lines: 45 },
        ],
      },
    }
    const { container } = render(<ToolCallDetailView call={call} />)
    expect(screen.getByText('main.tex')).to.exist
    expect(screen.getByText(/323 lines/)).to.exist
    expect(screen.getByText('ref.bib')).to.exist
    expect(screen.getByText(/45 lines/)).to.exist
    // Must NOT contain raw JSON syntax
    expect(container.textContent).to.not.include('"files":')
  })

  it('renders outline_project sections with line numbers', function () {
    const call = {
      id: '7',
      name: 'outline_project',
      args: {},
      result: {
        documentClass: 'article',
        packages: ['amsmath', 'graphicx'],
        sections: [
          {
            path: 'main.tex',
            line: 1,
            level: 1,
            title: 'Introduction',
            numbered: true,
          },
          {
            path: 'main.tex',
            line: 30,
            level: 2,
            title: 'Background',
            numbered: true,
          },
        ],
      },
    }
    render(<ToolCallDetailView call={call} />)
    expect(screen.getByText('Introduction')).to.exist
    expect(screen.getByText('Background')).to.exist
    expect(screen.getByText('Line 1:')).to.exist
    expect(screen.getByText('Line 30:')).to.exist
  })

  it('renders rejection badge and user note for rejected edit_file', function () {
    const call = {
      id: '8',
      name: 'edit_file',
      args: {
        path: 'sections/discussion.tex',
        oldText: 'original line',
        newText: 'modified line',
      },
      result: {
        status: 'rejected',
        note: 'Prefer keeping original phrasing',
        message: 'The user rejected this change.',
      },
    }
    const { container } = render(<ToolCallDetailView call={call} />)
    expect(screen.getByText('Rejected')).to.exist
    expect(container.querySelector('.ai-assist-tool-detail-badge.rejected')).to
      .exist
    expect(screen.getByText(/Prefer keeping original phrasing/)).to.exist
    expect(container.querySelector('.diff-del')?.textContent).to.contain(
      'original line'
    )
    expect(container.querySelector('.diff-ins')?.textContent).to.contain(
      'modified line'
    )
  })

  it('renders rejection badge and note for rejected create_file', function () {
    const call = {
      id: '9',
      name: 'create_file',
      args: {
        path: 'new_section.tex',
        content: '\\section{New Section}\nContent here',
      },
      result: {
        status: 'rejected',
        note: 'File already exists elsewhere',
        message: 'The user rejected creating new_section.tex.',
      },
    }
    const { container } = render(<ToolCallDetailView call={call} />)
    expect(screen.getByText('Rejected')).to.exist
    expect(container.querySelector('.ai-assist-tool-detail-badge.rejected')).to
      .exist
    expect(screen.getByText(/File already exists elsewhere/)).to.exist
  })

  it('renders web_fetch content as rich markdown when page text is returned', function () {
    const call = {
      id: '10',
      name: 'web_fetch',
      args: { url: 'https://en.wikipedia.org/wiki/Latex' },
      result: {
        url: 'https://en.wikipedia.org/wiki/Latex',
        title: 'LaTeX - Wikipedia',
        content:
          '# LaTeX\nLaTeX is a software system for document preparation.',
        totalPages: 1,
        page: 1,
      },
    }
    const { container } = render(<ToolCallDetailView call={call} />)
    expect(
      screen.getByText(/LaTeX is a software system for document preparation/)
    ).to.exist
    // Renders the fetched URL like Claude.ai
    expect(
      container.querySelector('.ai-assist-web-fetch-url')?.getAttribute('href')
    ).to.equal('https://en.wikipedia.org/wiki/Latex')
    // Renders the box containing the result like other tools
    expect(container.querySelector('.ai-assist-web-fetch-box')).to.exist
    // Renders as formatted markdown (heading, paragraph) rather than raw code pre
    expect(container.querySelector('h1')?.textContent).to.equal('LaTeX')
    // Does NOT duplicate the website row inside the detail
    expect(container.querySelector('.ai-assist-web-row')).to.be.null
  })

  it('renders web_fetch passages as rich markdown when matches are returned for find', function () {
    const call = {
      id: '11',
      name: 'web_fetch',
      args: { url: 'https://en.wikipedia.org/wiki/Test', find: 'Born' },
      result: {
        url: 'https://en.wikipedia.org/wiki/Test',
        title: 'Test Person',
        find: 'Born',
        totalMatches: 2,
        totalPages: 1,
        matches: [
          { heading: '## Early life', text: 'Born in Hanoi in **1980**.' },
          { heading: '## Career', text: 'Born to lead projects.' },
        ],
      },
    }
    const { container } = render(<ToolCallDetailView call={call} />)
    // Renders the fetched URL like Claude.ai
    expect(
      container.querySelector('.ai-assist-web-fetch-url')?.getAttribute('href')
    ).to.equal('https://en.wikipedia.org/wiki/Test')
    // Renders the box containing the result like other tools
    expect(container.querySelector('.ai-assist-web-fetch-box')).to.exist
    expect(screen.getByText('## Early life')).to.exist
    expect(screen.getByText(/Born in Hanoi in/)).to.exist
    expect(container.querySelector('strong')?.textContent).to.equal('1980')
    expect(screen.getByText('## Career')).to.exist
    expect(screen.getByText(/Born to lead projects\./)).to.exist
    // Does NOT duplicate the website row inside the detail
    expect(container.querySelector('.ai-assist-web-row')).to.be.null
  })

  it('renders list_available_settings with structured categories rather than empty json', function () {
    const call = {
      id: '12',
      name: 'list_available_settings',
      args: {},
      result: {
        status: 'ok',
        options: {
          compilers: ['pdflatex', 'xelatex', 'lualatex'],
          editorThemes: ['cobalt', 'dracula', 'textmate'],
          overallThemes: ['system', 'light', 'dark'],
          fontFamilies: [{ name: 'monaco', label: 'Monaco' }],
          editorModes: ['none', 'vim', 'emacs'],
          lineHeights: ['compact', 'normal', 'spacious'],
        },
      },
    }
    const { container } = render(<ToolCallDetailView call={call} />)
    expect(screen.getByText('LaTeX Compilers')).to.exist
    expect(screen.getByText('pdflatex')).to.exist
    expect(screen.getByText('xelatex')).to.exist
    expect(screen.getByText('Editor Syntax Themes')).to.exist
    expect(screen.getByText('cobalt')).to.exist
    expect(screen.getByText('dracula')).to.exist
    expect(screen.getByText('Keybinding Modes')).to.exist
    expect(screen.getByText('vim')).to.exist
    expect(container.querySelector('.ai-assist-settings-detail')).to.exist
    expect(container.textContent).not.to.equal('{}')
  })

  it('renders get_project_settings with structured sections and rows', function () {
    const call = {
      id: '13',
      name: 'get_project_settings',
      args: {},
      result: {
        status: 'ok',
        settings: {
          name: 'My Paper',
          compiler: {
            compiler: 'xelatex',
            imageName: 'texlive-2024.1',
            rootDocPath: 'main.tex',
            draft: false,
          },
          appearance: {
            overallTheme: 'system',
            editorTheme: 'cobalt',
            fontSize: 14,
          },
          editor: {
            mode: 'vim',
            autoComplete: true,
          },
        },
      },
    }
    const { container } = render(<ToolCallDetailView call={call} />)
    expect(screen.getByText(/My Paper/)).to.exist
    expect(screen.getByText('xelatex')).to.exist
    expect(screen.getByText('main.tex')).to.exist
    expect(screen.getByText('cobalt')).to.exist
    expect(screen.getByText('14px')).to.exist
    expect(screen.getByText('vim')).to.exist
    expect(container.querySelector('.ai-assist-settings-detail')).to.exist
  })

  it('renders configure_appearance_settings with human-readable keys and values', function () {
    const call = {
      id: '14',
      name: 'configure_appearance_settings',
      args: { editorTheme: 'cobalt', fontSize: 14 },
      result: {
        status: 'applied',
        updatedSettings: { editorTheme: 'cobalt', fontSize: 14 },
        message: 'Appearance settings updated successfully.',
      },
    }
    const { container } = render(<ToolCallDetailView call={call} />)
    expect(screen.getByText(/Appearance settings updated successfully/)).to.exist
    expect(screen.getByText('Editor Theme:')).to.exist
    expect(screen.getByText('cobalt')).to.exist
    expect(screen.getByText('Font Size:')).to.exist
    expect(screen.getByText('14px')).to.exist
    expect(container.textContent).not.to.include('{"editorTheme"')
  })

  it('renders get_references with structured labels, refs, citations and bibKeys', function () {
    const call = {
      id: '15',
      name: 'get_references',
      args: {},
      result: {
        labels: [{ key: 'sec:intro', path: 'main.tex', line: 10 }],
        refs: [
          { command: 'ref', key: 'sec:intro', path: 'main.tex', line: 25, resolved: true },
          { command: 'ref', key: 'sec:missing', path: 'main.tex', line: 40, resolved: false },
        ],
        citations: [
          { command: 'cite', key: 'einstein1905', path: 'main.tex', line: 50, resolved: true },
        ],
        bibKeys: [{ key: 'einstein1905', path: 'refs.bib', line: 1 }],
      },
    }
    const { container } = render(<ToolCallDetailView call={call} />)
    expect(screen.getByText('Cross-References (2)')).to.exist
    expect(screen.getByText('\\ref{sec:intro}')).to.exist
    expect(screen.getByText('\\ref{sec:missing}')).to.exist
    expect(screen.getByText('Citations (1)')).to.exist
    expect(screen.getByText('\\cite{einstein1905}')).to.exist
    expect(screen.getByText('Labels (1)')).to.exist
    expect(screen.getByText('\\label{sec:intro}')).to.exist
    expect(screen.getByText('Bibliography Entries (1)')).to.exist
    expect(screen.getByText('@einstein1905')).to.exist
    expect(container.querySelector('.ai-assist-tool-detail-refs')).to.exist
  })

  it('renders view_compiled_pdf_page with zoom info, SyncTeX rows, bad boxes, and text lines', function () {
    const call = {
      id: '16',
      name: 'view_compiled_pdf_page',
      args: { page: 3 },
      result: {
        page: 3,
        pageCount: 12,
        focus: {
          path: 'main.tex',
          line: 40,
          endLine: 52,
          continuesOn: [4],
        },
        sourceMap: [
          { y: 5, path: 'main.tex', line: 88 },
          { y: 35, path: 'tables/results.tex', line: 12 },
        ],
        badBoxes: [
          {
            path: 'tables/results.tex',
            line: 12,
            message: 'Overfull \\hbox (48.2pt too wide)',
          },
        ],
        text: {
          lines: [
            { y: 8, text: 'Table 2: Results' },
            { y: 35, text: 'Sample text' },
          ],
          truncated: true,
        },
      },
    }
    const { container } = render(<ToolCallDetailView call={call} />)
    expect(screen.getByText(/Zoomed on/)).to.exist
    expect(screen.getByText('main.tex:40–52')).to.exist
    expect(screen.getByText(/continues on page 4/)).to.exist
    expect(screen.getByText('5% down:')).to.exist
    expect(screen.getByText('main.tex:88')).to.exist
    expect(screen.getAllByText('tables/results.tex:12')).to.have.length(2)
    expect(screen.getByText(/Overfull \\hbox/)).to.exist
    expect(screen.getByText('Text on the page')).to.exist
    expect(screen.getByText('Table 2: Results')).to.exist
    expect(screen.getByText('Sample text')).to.exist
    expect(screen.getByText('Only part of the text is shown')).to.exist
    expect(container.querySelector('.ai-assist-tool-detail-outline')).to.exist
  })

  it('renders clean view_compiled_pdf_page with page header, clean layout status, and image preview (not empty)', function () {
    const call = {
      id: '16b',
      name: 'view_compiled_pdf_page',
      args: { page: 5 },
      result: {
        page: 5,
        pageCount: 6,
        pageSize: { width: 612, height: 792 },
        region: 'full',
        badBoxes: [],
        sourceRanges: [{ path: 'main.tex', startLine: 1, endLine: 45 }],
        image: {
          mediaType: 'image/png',
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        },
      },
    }
    const { container } = render(<ToolCallDetailView call={call} />)
    expect(screen.getByText(/Page 5 of 6/)).to.exist
    expect(screen.getByText(/Page 5 rendered cleanly with no layout issues/)).to.exist
    expect(screen.getByText(/main.tex:1–45/)).to.exist
    const img = container.querySelector('.ai-assist-pdf-image-thumb img')
    expect(img).to.exist
    expect(img?.getAttribute('src')).to.include('data:image/png;base64,')
  })

  it('renders view_compiled_pdf_overview with header, font warnings, page labels, source links, and findings', function () {
    const call = {
      id: '17',
      name: 'view_compiled_pdf_overview',
      args: { fromPage: 1, toPage: 6 },
      result: {
        fromPage: 1,
        toPage: 6,
        pageCount: 34,
        paper: {
          width: 612,
          height: 792,
          name: 'Letter',
          orientation: 'portrait',
        },
        fonts: {
          notEmbedded: ['Arial'],
          type3: ['T1-cmr10'],
        },
        pages: [
          {
            page: 1,
            source: [{ path: 'main.tex', startLine: 1, endLine: 35 }],
            blank: false,
          },
          {
            page: 2,
            source: [{ path: 'main.tex', startLine: 36, endLine: 80 }],
            badBoxes: 2,
            worstBadBox: {
              path: 'main.tex',
              line: 40,
              message: 'Overfull \\hbox on page 2',
            },
          },
          {
            page: 3,
            source: [{ path: 'chapters/intro.tex', startLine: 1, endLine: 40 }],
            endsAt: 55,
          },
          {
            page: 4,
            source: [{ path: 'chapters/intro.tex', startLine: 41, endLine: 90 }],
            overflow: [{ side: 'right', mm: 12 }],
          },
          {
            page: 5,
            source: [],
            blank: true,
          },
          {
            page: 6,
            source: [{ path: 'chapters/methods.tex', startLine: 1, endLine: 30 }],
            gaps: [{ top: 30, bottom: 58 }],
            unresolved: { refs: 2, cites: 1 },
          },
        ],
      },
    }
    const { container } = render(<ToolCallDetailView call={call} />)
    expect(screen.getByText(/Letter · portrait · 612 × 792 mm · 34 pages/)).to.exist
    expect(screen.getByText(/Fonts not embedded: Arial/)).to.exist
    expect(screen.getByText(/Type 3 fonts: T1-cmr10/)).to.exist
    expect(screen.getByText('p1')).to.exist
    expect(screen.getByText('main.tex:1–35')).to.exist
    expect(screen.getByText('p2')).to.exist
    expect(screen.getByText('main.tex:36–80')).to.exist
    expect(screen.getByText('2 bad boxes')).to.exist
    expect(screen.getByText(/Overfull \\hbox on page 2/)).to.exist
    expect(screen.getByText('p3')).to.exist
    expect(screen.getByText('ends 55% down')).to.exist
    expect(screen.getByText('p4')).to.exist
    expect(screen.getByText('12mm past right margin')).to.exist
    expect(screen.getByText('p5')).to.exist
    expect(screen.getByText('blank')).to.exist
    expect(screen.getByText('p6')).to.exist
    expect(screen.getByText('empty 30–58% · 2× ?? · 1× [?]')).to.exist
    expect(screen.getByText('No layout issues')).to.exist
    expect(container.querySelectorAll('.ai-assist-pdf-page').length).to.equal(6)
  })

  it('renders clean PDF overview with page badges and clean layout status for all clean pages', function () {
    const call = {
      id: '17b',
      name: 'view_compiled_pdf_overview',
      args: { fromPage: 1, toPage: 6 },
      result: {
        fromPage: 1,
        toPage: 6,
        pageCount: 6,
        paper: {
          width: 612,
          height: 792,
          name: 'Letter',
          orientation: 'portrait',
        },
        pages: [
          { page: 1 },
          { page: 2 },
          { page: 3 },
          { page: 4 },
          { page: 5 },
          { page: 6 },
        ],
      },
    }
    const { container } = render(<ToolCallDetailView call={call} />)
    expect(screen.getByText(/Letter · portrait · 612 × 792 mm · 6 pages/)).to.exist
    for (let p = 1; p <= 6; p++) {
      expect(screen.getByText(`p${p}`)).to.exist
    }
    expect(screen.getAllByText('No layout issues')).to.have.length(6)
    expect(container.querySelectorAll('.ai-assist-pdf-page.is-clean')).to.have.length(6)
    expect(container.querySelectorAll('.ai-assist-pdf-page-badge')).to.have.length(6)
  })

  it('renders search_compiled_pdf with matches, locations, source links, highlighted text, and truncation note', function () {
    const call = {
      id: '18',
      name: 'search_compiled_pdf',
      args: { query: 'Figure 3' },
      result: {
        query: 'Figure 3',
        matchCount: 10,
        matches: [
          {
            page: 1,
            y: 41,
            context: 'see Figure 3 below',
            path: 'main.tex',
            line: 42,
          },
          {
            page: 2,
            y: 15,
            context: 'as in Figure 3',
            path: 'figs.tex',
            line: null,
          },
        ],
        truncated: true,
      },
    }
    const { container } = render(<ToolCallDetailView call={call} />)
    expect(screen.getByText('p1 · 41%')).to.exist
    expect(screen.getByText('main.tex:42')).to.exist
    expect(screen.getByText('p2 · 15%')).to.exist
    expect(screen.getByText('figs.tex')).to.exist
    expect(container.querySelector('mark')?.textContent).to.equal('Figure 3')
    expect(screen.getByText('showing 2 of 10')).to.exist
  })

  it('renders search_compiled_pdf note when no matches found', function () {
    const call = {
      id: '19',
      name: 'search_compiled_pdf',
      args: { query: 'nonexistent' },
      result: {
        query: 'nonexistent',
        matchCount: 0,
        matches: [],
      },
    }
    render(<ToolCallDetailView call={call} />)
    expect(screen.getByText('No matches found for "nonexistent".')).to.exist
  })
})

describe('tool output links and images', function () {
  it('shows a web_fetch address that is not http(s) as text, not as a link', function () {
    const url = 'javascript:alert(document.cookie)'
    const call = {
      id: '30',
      name: 'web_fetch',
      args: { url },
      result: { url, title: 'Page', content: '# Hi', totalPages: 1, page: 1 },
    }
    const { container } = render(<ToolCallDetailView call={call} />)

    expect(container.querySelector('a[href^="javascript"]')).to.equal(null)
    expect(container.textContent).to.include('javascript:alert(document.cookie)')
  })

  it('does not load a remote image named by tool output', function () {
    const call = {
      id: '31',
      name: 'view_compiled_pdf_page',
      args: { page: 2 },
      result: {
        page: 2,
        pageCount: 3,
        pageSize: { width: 612, height: 792 },
        region: 'full',
        badBoxes: [],
        sourceRanges: [],
        image: { url: 'https://tracker.example/pixel.png' },
      },
    }
    const { container } = render(<ToolCallDetailView call={call} />)

    expect(container.querySelector('img[src^="https"]')).to.equal(null)
    expect(container.querySelector('.ai-assist-pdf-image-thumb img')).to.equal(null)
  })
})
