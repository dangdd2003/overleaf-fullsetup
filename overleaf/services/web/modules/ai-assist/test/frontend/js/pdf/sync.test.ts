import { expect } from 'chai'
import fetchMock from 'fetch-mock'
import {
  normalizeSynctexFile,
  pdfBoxesForSource,
  sourceAtPdfPoint,
  synctexPath,
} from '../../../../frontend/js/features/ai-assist/pdf/sync'

describe('synctex paths', function () {
  it('adds the dot synctex expects inside a subfolder root', function () {
    expect(synctexPath('chapters/intro.tex', 'chapters/main.tex')).to.equal(
      'chapters/./intro.tex'
    )
  })

  it('leaves paths alone for a root at the top level', function () {
    expect(synctexPath('intro.tex', 'main.tex')).to.equal('intro.tex')
    expect(synctexPath('intro.tex', null)).to.equal('intro.tex')
  })

  it('takes the dot back out of what synctex returns', function () {
    expect(normalizeSynctexFile('./chapters/./intro.tex')).to.equal(
      'chapters/intro.tex'
    )
    expect(normalizeSynctexFile('main.tex')).to.equal('main.tex')
  })
})

describe('synctex lookups', function () {
  afterEach(function () {
    fetchMock.removeRoutes().clearHistory()
  })

  it('resolves a PDF point to its source line, with the build it belongs to', async function () {
    fetchMock.get(new RegExp('/sync/pdf'), {
      code: [{ file: './sections/./intro.tex', line: 42, column: 7 }],
    })
    const position = await sourceAtPdfPoint(
      'proj1',
      { page: 3, h: 72, v: 410.5 },
      { clsiServerId: 'cls-1', editorId: 'ed-1', buildId: 'b9' }
    )
    expect(position).to.deep.equal({
      file: 'sections/intro.tex',
      line: 42,
      column: 7,
    })
    const url = String(fetchMock.callHistory.lastCall()!.url)
    expect(url).to.contain('/project/proj1/sync/pdf?')
    expect(url).to.contain('page=3')
    expect(url).to.contain('v=410.50')
    expect(url).to.contain('buildId=b9')
    expect(url).to.contain('editorId=ed-1')
    expect(url).to.contain('clsiserverid=cls-1')
  })

  it('returns nothing when synctex finds no source', async function () {
    fetchMock.get(new RegExp('/sync/pdf'), { code: [] })
    expect(
      await sourceAtPdfPoint('proj1', { page: 1, h: 0, v: 0 }, {})
    ).to.equal(null)
  })

  it('highlights a short range line by line and keeps only well-formed boxes', async function () {
    fetchMock.get(new RegExp('/sync/code'), {
      pdf: [{ page: 2, h: 10, v: 20, width: 100, height: 12 }, { page: 'x' }],
    })
    const boxes = await pdfBoxesForSource(
      'proj1',
      { path: 'main.tex', line: 5, endLine: 7 },
      'main.tex',
      {}
    )
    expect(fetchMock.callHistory.calls()).to.have.length(3)
    expect(boxes).to.have.length(3)
    expect(boxes[0]).to.deep.equal({ page: 2, h: 10, v: 20, width: 100, height: 12 })
  })

  it('uses only the ends of a long range', async function () {
    fetchMock.get(new RegExp('/sync/code'), { pdf: [] })
    await pdfBoxesForSource(
      'proj1',
      { path: 'main.tex', line: 1, endLine: 200 },
      null,
      {}
    )
    expect(fetchMock.callHistory.calls()).to.have.length(2)
  })
})
