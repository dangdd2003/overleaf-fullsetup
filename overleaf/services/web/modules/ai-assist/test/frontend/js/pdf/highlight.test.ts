import { expect } from 'chai'
import fetchMock from 'fetch-mock'
import sinon from 'sinon'
import { highlightInPdf } from '../../../../frontend/js/features/ai-assist/pdf/highlight'

const box = { page: 2, h: 10, v: 20, width: 30, height: 40 }

describe('highlightInPdf', function () {
  afterEach(function () {
    fetchMock.removeRoutes().clearHistory()
  })

  function run(request: any, pageCount: number | null = 5) {
    const setHighlights = sinon.spy()
    const promise = highlightInPdf({
      request,
      projectId: 'proj1',
      rootDocPath: 'main.tex',
      context: {},
      pageCount,
      setHighlights,
    })
    return { promise, setHighlights }
  }

  it('shows the boxes it is given and reports their pages', async function () {
    const { promise, setHighlights } = run({
      boxes: [box, { ...box, page: 4 }],
    })
    expect(await promise).to.deep.equal({
      status: 'highlighted',
      count: 2,
      pages: [2, 4],
    })
    expect(setHighlights.firstCall.args[0]).to.have.length(2)
  })

  it('refuses a box on a page the document does not have', async function () {
    const { promise, setHighlights } = run({ boxes: [{ ...box, page: 9 }] })
    expect(await promise).to.deep.equal({ error: 'The PDF has 5 pages.' })
    expect(setHighlights.called).to.equal(false)
  })

  it('refuses an empty or malformed box list', async function () {
    expect(await run({ boxes: [] }).promise).to.have.property('error')
    expect(await run({ boxes: 'nope' }).promise).to.have.property('error')
  })

  it('needs either boxes or a path and a line', async function () {
    expect(await run({}).promise).to.have.property('error')
    expect(await run({ path: 'main.tex' }).promise).to.have.property('error')
    expect(await run({ path: 'main.tex', line: 0 }).promise).to.have.property('error')
  })

  it('rejects a range that ends before it starts', async function () {
    const result = await run({ path: 'main.tex', line: 9, endLine: 3 }).promise
    expect(result).to.deep.equal({ error: 'endLine must not be before line.' })
  })

  it('resolves a source line through synctex and highlights where it lands', async function () {
    fetchMock.get(new RegExp('/sync/code'), {
      pdf: [box],
    })
    const { promise, setHighlights } = run({ path: 'main.tex', line: 7 })
    expect(await promise).to.deep.equal({
      status: 'highlighted',
      count: 1,
      pages: [2],
    })
    expect(setHighlights.calledOnce).to.equal(true)
  })

  it('says so when a line is not in the build on screen', async function () {
    fetchMock.get(new RegExp('/sync/code'), { pdf: [] })
    const { promise, setHighlights } = run({ path: 'main.tex', line: 7 })
    expect(await promise).to.deep.equal({
      error: 'main.tex line 7 is not in the PDF build on screen.',
    })
    expect(setHighlights.called).to.equal(false)
  })
})
