import { expect } from 'chai'
import fetchMock from 'fetch-mock'
import { areaFromBox } from '../../../../frontend/js/features/ai-assist/pdf/use-pdf-context'

const viewport = {
  viewBox: [0, 0, 600, 800],
  convertToPdfPoint: (x: number, y: number) => [x, 800 - y],
}

const wrapper = {
  viewer: { getPageView: () => ({ viewport }) },
} as any

const image = { mediaType: 'image/png' as const, data: 'AAAA' }

describe('areaFromBox', function () {
  afterEach(function () {
    fetchMock.removeRoutes().clearHistory()
  })

  it('turns a drawn box into the source lines its top and bottom reach', async function () {
    fetchMock.get(new RegExp('/sync/pdf'), request => {
      // The top edge (v=100) lands on line 40, the bottom (v=300) on line 52
      const url = String((request as { url?: string }).url ?? request)
      return url.includes('v=100.00')
        ? { code: [{ file: './sec/./a.tex', line: 40 }] }
        : { code: [{ file: './sec/./a.tex', line: 52 }] }
    })
    const area = await areaFromBox(
      wrapper,
      { page: 3, left: 100, top: 100, right: 300, bottom: 300 },
      'proj1',
      { buildId: 'b1' },
      { image }
    )
    expect(area).to.deep.equal({
      page: 3,
      source: { path: 'sec/a.tex', line: 40, endLine: 52 },
      rect: { x: 100, y: 100, w: 200, h: 200 },
      image,
    })
  })

  it('keeps the area with no source when synctex finds nothing', async function () {
    fetchMock.get(new RegExp('/sync/pdf'), { code: [] })
    const area = await areaFromBox(
      wrapper,
      { page: 1, left: 0, top: 0, right: 50, bottom: 50 },
      'proj1',
      {},
      { image }
    )
    expect(area).to.deep.equal({
      page: 1,
      source: null,
      rect: { x: 0, y: 0, w: 50, h: 50 },
      image,
    })
  })

  it('keeps the area with no source when the synctex request fails', async function () {
    fetchMock.get(new RegExp('/sync/pdf'), 500)
    const area = await areaFromBox(
      wrapper,
      { page: 1, left: 0, top: 0, right: 50, bottom: 50 },
      'proj1',
      {},
      { image }
    )
    expect(area?.source).to.equal(null)
    expect(area?.image).to.deep.equal(image)
  })

  it('keeps the area without a crop when the source is known', async function () {
    fetchMock.get(new RegExp('/sync/pdf'), { code: [{ file: 'a.tex', line: 7 }] })
    const area = await areaFromBox(
      wrapper,
      { page: 1, left: 0, top: 0, right: 50, bottom: 50 },
      'proj1',
      {}
    )
    expect(area?.image).to.equal(null)
    expect(area?.source).to.deep.equal({ path: 'a.tex', line: 7, endLine: 7 })
  })

  it('returns nothing when there is neither a crop nor a source', async function () {
    fetchMock.get(new RegExp('/sync/pdf'), { code: [] })
    expect(
      await areaFromBox(
        wrapper,
        { page: 1, left: 0, top: 0, right: 50, bottom: 50 },
        'proj1',
        {}
      )
    ).to.equal(null)
  })

  it('returns nothing for a page the viewer does not have', async function () {
    const empty = { viewer: { getPageView: () => undefined } } as any
    expect(
      await areaFromBox(
        empty,
        { page: 9, left: 0, top: 0, right: 5, bottom: 5 },
        'p',
        {},
        { image }
      )
    ).to.equal(null)
  })
})
