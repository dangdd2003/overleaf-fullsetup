import { expect } from 'chai'
import sinon from 'sinon'
import { highlightInPdfTool } from '../../../../frontend/js/features/ai-assist/agent/tools/highlight-in-pdf'
import { TOOLS, toolSpecs } from '../../../../frontend/js/features/ai-assist/agent/tools/registry'

describe('highlight_in_pdf tool', function () {
  it('is read-only and does not suspend the run', function () {
    expect(highlightInPdfTool.mutates).to.equal(false)
    expect(highlightInPdfTool.suspends).to.equal(false)
  })

  it('passes its arguments to the handle and returns what it reports', async function () {
    const highlightPdf = sinon.stub().resolves({ status: 'highlighted', count: 1, pages: [2] })
    const result = await highlightInPdfTool.execute(
      { path: 'main.tex', line: 3 },
      { highlightPdf } as any
    )
    expect(highlightPdf.calledWith({ path: 'main.tex', line: 3 })).to.equal(true)
    expect(result).to.deep.equal({ status: 'highlighted', count: 1, pages: [2] })
  })

  it('reports that it is unavailable when the handle cannot highlight', async function () {
    const result = await highlightInPdfTool.execute({}, {} as any)
    expect(result).to.have.property('error')
  })

  it('is offered to the model', function () {
    expect(TOOLS).to.have.property('highlight_in_pdf')
    expect(toolSpecs().map(spec => spec.name)).to.include('highlight_in_pdf')
  })
})
