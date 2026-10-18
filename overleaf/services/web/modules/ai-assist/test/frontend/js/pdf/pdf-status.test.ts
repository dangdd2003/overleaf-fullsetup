import { expect } from 'chai'
import { withPdfStatus } from '../../../../frontend/js/features/ai-assist/agent/pdf-status'

const failed = {
  status: 'failure',
  errors: [{ message: 'Undefined control sequence', file: 'main.tex', line: 3 }],
  warnings: [],
}

describe('PDF status in compile results', function () {
  it('reports success_with_errors when errors came with a PDF', function () {
    expect(withPdfStatus(failed, true).status).to.equal('success_with_errors')
  })

  it('keeps failure when no PDF was written', function () {
    expect(withPdfStatus(failed, false).status).to.equal('failure')
  })

  it('does not invent an error status for a clean build', function () {
    const clean = { status: 'success', errors: [], warnings: [] }
    expect(withPdfStatus(clean, true).status).to.equal('success')
  })

  it('does not change the outcome it was given', function () {
    withPdfStatus(failed, true)
    expect(failed.status).to.equal('failure')
  })
})
