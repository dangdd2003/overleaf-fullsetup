import { expect } from 'chai'
import { render, screen } from '@testing-library/react'
import { ToolCallDetailView } from '../../../../../frontend/js/features/ai-assist/components/agent/tool-call-detail'

describe('PdfDiffDetail', function () {
  it('renders changed pages with their regions, shifts, removed and added pages', function () {
    const call = {
      id: 'diff-1',
      name: 'diff_compiled_pdf',
      args: { before: 'previous' },
      result: {
        status: 'ok',
        changed: true,
        beforeBuildId: 'b1',
        afterBuildId: 'b2',
        dpi: 100,
        pageCount: { before: 12, after: 13 },
        pairing: 'index',
        pages: [
          {
            page: 3,
            regions: [
              { x: 0.1, y: 0.2, w: 0.5, h: 0.15, kind: 'changed' },
              { x: 0.1, y: 0.4, w: 0.5, h: 0.1, kind: 'changed' },
            ],
          },
          {
            page: 5,
            regions: [{ x: 0, y: 0.4, w: 1, h: 0.1, kind: 'moved' }],
            shiftedBelow: { y: 0.6, shiftPt: 12 },
          },
          { page: 7, status: 'added' },
          { page: null, beforePage: 4, status: 'removed' },
        ],
        unchangedPages: [1, 2, 6, 8, 9, 10, 11, 12, 13],
        highlights: [],
        summary: [
          'Page 3 changed: changed 20%-35% of page height.',
          'Page 7 is new.',
        ],
      },
    }
    render(<ToolCallDetailView call={call} />)
    expect(screen.getByText(/4 pages changed · 12 → 13 pages/)).to.exist
    expect(screen.getByText('p3')).to.exist
    expect(screen.getByText('p5')).to.exist
    expect(screen.getByText('p7')).to.exist
    expect(screen.getByText('p4')).to.exist
    expect(screen.getByText(/changed 20–50%/)).to.exist
    expect(screen.getByText(/moved 40–50%/)).to.exist
    expect(
      screen.getByText(/content below 60% shifted down 12 pt/)
    ).to.exist
    expect(screen.getByText('new page')).to.exist
    expect(screen.getByText('removed (was p4)')).to.exist
    expect(screen.getByText(/Unchanged: pages 1–2, 6, 8–13/)).to.exist
  })

  it('renders the no visible change line when nothing changed', function () {
    const call = {
      id: 'diff-2',
      name: 'diff_compiled_pdf',
      args: {},
      result: {
        status: 'ok',
        changed: false,
        pageCount: { before: 4, after: 4 },
        pages: [],
        unchangedPages: [1, 2, 3, 4],
        summary: [],
      },
    }
    const { container } = render(<ToolCallDetailView call={call} />)
    expect(screen.getByText('No visible change')).to.exist
    expect(
      container.querySelector('.ai-assist-tool-detail-success')?.textContent
    ).to.contain('No visible change from the previous build.')
    expect(screen.getByText(/Unchanged: pages 1–4/)).to.exist
  })

  it('falls back to the summary lines when the per-page detail is missing', function () {
    const call = {
      id: 'diff-3',
      name: 'diff_compiled_pdf',
      args: {},
      result: {
        status: 'ok',
        changed: true,
        summary: [
          'Page 2 changed: changed 10%-18% of page height.',
          'Page 9 is new.',
        ],
        truncated: true,
      },
    }
    const { container } = render(<ToolCallDetailView call={call} />)
    expect(screen.getByText('Changed')).to.exist
    expect(screen.getByText('Page 2 changed: changed 10%-18% of page height.'))
      .to.exist
    expect(screen.getByText('Page 9 is new.')).to.exist
    expect(
      container.querySelector('.ai-assist-pdf-page-badge')
    ).to.be.null
    expect(screen.getByText(/More pages changed/)).to.exist
  })
})
