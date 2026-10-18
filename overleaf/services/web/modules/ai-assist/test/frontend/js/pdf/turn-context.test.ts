import { expect } from 'chai'
import {
  addPdfArea,
  addPdfSelection,
  beginPdfArea,
  cancelPdfBoxSelect,
  finishPdfArea,
  MAX_PDF_ITEMS,
  removePdfSelection,
  getPdfTurnContext,
  resetPdfTurnContext,
  startPdfBoxSelect,
  subscribePdfTurnContext,
  takePdfTurnContext,
  updatePdfTurnContext,
} from '../../../../frontend/js/features/ai-assist/pdf/turn-context'

const selection = { page: 2, text: 'the lemma' }
const area = {
  page: 3,
  source: { path: 'a.tex', line: 4, endLine: 6 },
  rect: { x: 1, y: 2, w: 3, h: 4 },
  image: null,
}

describe('PDF turn context', function () {
  beforeEach(function () {
    resetPdfTurnContext()
  })

  it('collects selections and areas in order, and takes them all once', function () {
    addPdfSelection(selection)
    addPdfSelection({ page: 5, text: 'another' })
    addPdfArea(area)
    expect(takePdfTurnContext()).to.deep.equal({
      selections: [selection, { page: 5, text: 'another' }],
      areas: [area],
    })
    expect(takePdfTurnContext()).to.deep.equal({ selections: [], areas: [] })
  })

  it('does not add the same selection twice', function () {
    addPdfSelection(selection)
    addPdfSelection({ ...selection })
    expect(getPdfTurnContext().selections).to.have.length(1)
  })

  it('keeps the newest items when more are added than a message carries', function () {
    for (let page = 1; page <= MAX_PDF_ITEMS + 2; page++) {
      addPdfSelection({ page, text: `p${page}` })
    }
    const pages = getPdfTurnContext().selections.map(item => item.page)
    expect(pages).to.have.length(MAX_PDF_ITEMS)
    expect(pages[0]).to.equal(3)
  })

  it('removes one selection by its place', function () {
    addPdfSelection(selection)
    addPdfSelection({ page: 5, text: 'another' })
    removePdfSelection(0)
    expect(getPdfTurnContext().selections).to.deep.equal([
      { page: 5, text: 'another' },
    ])
  })

  it('counts captures and adds the area each one produces', function () {
    beginPdfArea()
    beginPdfArea()
    expect(getPdfTurnContext().pendingAreas).to.equal(2)
    finishPdfArea(area)
    finishPdfArea(null)
    expect(getPdfTurnContext()).to.deep.include({ pendingAreas: 0, areas: [area] })
  })

  it('keeps box selection and running captures when a message is sent', function () {
    addPdfSelection(selection)
    updatePdfTurnContext({ boxSelecting: true })
    beginPdfArea()
    takePdfTurnContext()
    expect(getPdfTurnContext().boxSelecting).to.equal(true)
    expect(getPdfTurnContext().pendingAreas).to.equal(1)
  })

  it('starts and cancels box selection without touching the items', function () {
    addPdfSelection(selection)
    startPdfBoxSelect()
    expect(getPdfTurnContext().boxSelecting).to.equal(true)
    cancelPdfBoxSelect()
    expect(getPdfTurnContext()).to.deep.include({
      boxSelecting: false,
      selections: [selection],
    })
  })

  it('notifies subscribers on change and stops after unsubscribing', function () {
    let calls = 0
    const unsubscribe = subscribePdfTurnContext(() => {
      calls += 1
    })
    addPdfSelection(selection)
    expect(calls).to.equal(1)
    unsubscribe()
    removePdfSelection(0)
    expect(calls).to.equal(1)
  })

  it('does not notify when there is nothing to take', function () {
    let calls = 0
    const unsubscribe = subscribePdfTurnContext(() => {
      calls += 1
    })
    takePdfTurnContext()
    expect(calls).to.equal(0)
    unsubscribe()
  })
})
