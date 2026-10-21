import { expect } from 'chai'
import { render, screen } from '@testing-library/react'
import { ToolCallDetailView } from '../../../../../frontend/js/features/ai-assist/components/agent/tool-call-detail'

const style = {
  v: 1,
  pages: 12,
  paper: 'A4',
  class: 'article 10pt',
  area: {
    w: { v: 345.0, by: 'geometry L12', c: 'high' },
    h: { v: 500.2, c: 'low' },
    left: { v: 72.0, by: 'class default', c: 'medium' },
    right: { v: 72.0, c: 'low' },
    top: { v: 72.0, c: 'low' },
    bottom: { v: 72.0, c: 'low' },
    cols: 1,
  },
  body: {
    size: { v: 10, by: 'class default', c: 'medium' },
    font: { name: 'Latin Modern', family: 'lmodern' },
    baseline: { v: 12, c: 'low' },
  },
  parIndent: { v: 15, c: 'low' },
  headings: [
    { lvl: 1, size: 14.4, bold: true, before: 18, after: 9 },
    { lvl: 2, size: 12, bold: true, before: 12, after: 6 },
  ],
  rules: { table: { thicknessPt: 0.4, by: 'booktabs L40', c: 'high' } },
  colours: { text: [['#000000', 0.98]] },
  packages: ['amsmath', 'graphicx', 'geometry'],
}

describe('PdfStyleDetail via ToolCallDetailView', function () {
  it('renders the measured style without a comparison', function () {
    const call = {
      id: 'style-1',
      name: 'inspect_compiled_style',
      args: {},
      result: { status: 'ok', style },
    }
    const { container } = render(<ToolCallDetailView call={call} />)
    expect(container.querySelector('.ai-assist-tool-detail-pdf-style')).to
      .exist
    expect(screen.getByText('Text area')).to.exist
    expect(screen.getByText('Body text')).to.exist
    expect(screen.getByText('Headings')).to.exist
    expect(screen.getByText('Width:')).to.exist
    expect(screen.getByText(/345 pt/)).to.exist
    expect(screen.getByText(/geometry L12/)).to.exist
    expect(screen.getByText(/Latin Modern/)).to.exist
    expect(screen.getByText(/amsmath, graphicx, geometry/)).to.exist
    expect(screen.queryByText('Comparison')).to.not.exist
  })

  it('shows differing properties with the current and target values and the fix', function () {
    const call = {
      id: 'style-2',
      name: 'inspect_compiled_style',
      args: {},
      result: {
        status: 'ok',
        style,
        diff: {
          same: 10,
          diffs: [
            {
              prop: 'area.w',
              now: 345,
              template: 360,
              fix: '\\geometry{textwidth=360pt}',
            },
            {
              prop: 'body.size',
              now: 10,
              template: 11,
              fix: null,
            },
          ],
        },
      },
    }
    const { container } = render(<ToolCallDetailView call={call} />)
    expect(screen.getByText('Comparison')).to.exist
    expect(screen.getByText('2 of 12 compared properties differ.')).to.exist
    expect(screen.getByText('Text width:')).to.exist
    expect(screen.getByText(/345 pt → 360 pt/)).to.exist
    expect(screen.getByText('Body size:')).to.exist
    expect(screen.getByText(/10 pt → 11 pt/)).to.exist
    expect(container.querySelector('code')?.textContent).to.equal(
      '\\geometry{textwidth=360pt}'
    )
    expect(screen.queryByText(/All .* compared properties match/)).to.not
      .exist
  })

  it('confirms when the empty diff has nothing that differs', function () {
    const call = {
      id: 'style-3',
      name: 'inspect_compiled_style',
      args: {},
      result: {
        status: 'ok',
        style,
        diff: { same: 12, diffs: [] },
      },
    }
    const { container } = render(<ToolCallDetailView call={call} />)
    expect(screen.getByText(/All 12 compared properties match\./)).to.exist
    expect(container.querySelector('.ai-assist-pdf-warning')).to.not.exist
    expect(container.querySelector('code')).to.not.exist
  })
})
