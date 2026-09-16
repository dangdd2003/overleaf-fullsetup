import { expect } from 'chai'
import { render, screen } from '@testing-library/react'
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
    expect(container.querySelector('.diff-del')?.textContent).to.contain('\\begin{old}')
    expect(container.querySelector('.diff-ins')?.textContent).to.contain('\\begin{new}')
    expect(screen.getByText(/applied change to main\.tex/i)).to.exist
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
          { path: 'main.tex', line: 1, level: 1, title: 'Introduction', numbered: true },
          { path: 'main.tex', line: 30, level: 2, title: 'Background', numbered: true },
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
    expect(container.querySelector('.ai-assist-tool-detail-badge.rejected')).to.exist
    expect(screen.getByText(/Prefer keeping original phrasing/)).to.exist
    expect(container.querySelector('.diff-del')?.textContent).to.contain('original line')
    expect(container.querySelector('.diff-ins')?.textContent).to.contain('modified line')
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
    expect(container.querySelector('.ai-assist-tool-detail-badge.rejected')).to.exist
    expect(screen.getByText(/File already exists elsewhere/)).to.exist
  })
})
