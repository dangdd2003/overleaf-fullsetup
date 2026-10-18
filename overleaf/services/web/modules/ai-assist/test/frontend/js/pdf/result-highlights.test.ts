import { expect } from 'chai'
import sinon from 'sinon'
import {
  CHANGED_BY_AI_COLOR,
  dispatchPdfResultHighlights,
  parseHighlights,
  PDF_RESULT_HIGHLIGHTS_EVENT,
} from '../../../../frontend/js/features/ai-assist/pdf/result-highlights'

describe('parseHighlights', function () {
  it('keeps well-formed boxes and drops the rest', function () {
    expect(
      parseHighlights([
        { page: 1, h: 1, v: 2, width: 3, height: 4, extra: 'ignored' },
        { page: 0, h: 1, v: 2, width: 3, height: 4 },
        { page: 1, h: 'x', v: 2, width: 3, height: 4 },
        null,
      ])
    ).to.deep.equal([{ page: 1, h: 1, v: 2, width: 3, height: 4 }])
  })

  it('returns nothing for anything that is not a list', function () {
    expect(parseHighlights(undefined)).to.deep.equal([])
    expect(parseHighlights({ page: 1 })).to.deep.equal([])
  })
})

describe('dispatchPdfResultHighlights', function () {
  const box = { page: 2, h: 10, v: 20, width: 30, height: 40 }
  let listener: sinon.SinonSpy

  beforeEach(function () {
    listener = sinon.spy()
    window.addEventListener(PDF_RESULT_HIGHLIGHTS_EVENT, listener)
  })

  afterEach(function () {
    window.removeEventListener(PDF_RESULT_HIGHLIGHTS_EVENT, listener)
  })

  it('shows the boxes as changed-by-AI', function () {
    dispatchPdfResultHighlights({ highlights: [box] })
    expect(listener.calledOnce).to.equal(true)
    expect(listener.firstCall.args[0].detail.highlights).to.deep.equal([
      { ...box, color: CHANGED_BY_AI_COLOR },
    ])
  })

  it('does nothing for a result without highlights', function () {
    dispatchPdfResultHighlights({ status: 'applied' })
    dispatchPdfResultHighlights(null)
    expect(listener.called).to.equal(false)
  })
})
