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
})
