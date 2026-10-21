import { expect } from 'chai'
import { render, screen } from '@testing-library/react'
import { ToolCallDetailView } from '../../../../../frontend/js/features/ai-assist/components/agent/tool-call-detail'

describe('PDF locate details', function () {
  it('renders a resolved block with its page and source range', function () {
    const call = {
      id: 'b1',
      name: 'resolve_pdf_block',
      args: { block: 'B3', page: 4 },
      result: {
        status: 'ok',
        block: 'B3',
        page: 4,
        path: 'main.tex',
        line: 12,
        endLine: 18,
      },
    }
    const { container } = render(<ToolCallDetailView call={call} />)
    expect(container.querySelector('.ai-assist-tool-detail-pdf-block')).to.exist
    expect(screen.getByText('Block B3 · Page 4')).to.exist
    expect(screen.getByText('p4')).to.exist
    expect(screen.getByText('main.tex:12–18')).to.exist
  })

  it('renders a highlight with its pages and source', function () {
    const call = {
      id: 'h1',
      name: 'highlight_in_pdf',
      args: { path: 'sections/intro.tex', line: 5, endLine: 9 },
      result: { status: 'highlighted', count: 3, pages: [2, 3], highlights: [] },
    }
    const { container } = render(<ToolCallDetailView call={call} />)
    expect(container.querySelector('.ai-assist-tool-detail-pdf-highlight')).to
      .exist
    expect(screen.getByText('Highlighted 3 areas · pages 2–3')).to.exist
    expect(screen.getByText('Source:')).to.exist
    expect(screen.getByText('sections/intro.tex:5–9')).to.exist
    expect(
      screen.getByText('Shown in your PDF viewer; the project is unchanged.')
    ).to.exist
    expect(container.querySelector('.ai-assist-pdf-warning')).to.not.exist
  })

  it('warns when the highlighted PDF is stale', function () {
    const call = {
      id: 'h2',
      name: 'highlight_in_pdf',
      args: { path: 'main.tex', line: 3 },
      result: {
        status: 'highlighted',
        count: 1,
        pages: [1],
        highlights: [],
        stale: true,
      },
    }
    const { container } = render(<ToolCallDetailView call={call} />)
    expect(
      screen.getByText(
        'The PDF is older than your last edit, so the highlight may be off. Recompile to refresh it.'
      )
    ).to.exist
    expect(container.querySelector('.ai-assist-pdf-warning')).to.exist
  })

  it('says nothing was highlighted when the count is 0', function () {
    const call = {
      id: 'h3',
      name: 'highlight_in_pdf',
      args: { path: 'main.tex', line: 40 },
      result: { status: 'highlighted', count: 0, pages: [], highlights: [] },
    }
    render(<ToolCallDetailView call={call} />)
    expect(screen.getByText('Highlighted 0 areas')).to.exist
    expect(screen.getByText('Nothing to highlight in the current PDF.')).to
      .exist
    expect(
      screen.queryByText('Shown in your PDF viewer; the project is unchanged.')
    ).to.not.exist
  })
})
