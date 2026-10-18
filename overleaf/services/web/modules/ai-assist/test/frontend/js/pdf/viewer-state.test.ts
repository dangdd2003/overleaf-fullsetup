import { expect } from 'chai'
import {
  formatPageRanges,
} from '../../../../frontend/js/features/ai-assist/agent/context/project-context'
import {
  readPdfViewerSnapshot,
  visiblePageNumbers,
  zoomLabel,
} from '../../../../frontend/js/features/ai-assist/pdf/viewer-state'

type Rect = { top: number; bottom: number }

/**
 * A stand-in for the pdf.js wrapper: pages stacked 100px apart in a container
 * showing 0 to 250px of them.
 */
function fakeWrapper({
  pages = 6,
  currentPageNumber = 1,
  currentScaleValue = 'page-width',
  currentScale = 1.25,
}: {
  pages?: number
  currentPageNumber?: number
  currentScaleValue?: string
  currentScale?: number
} = {}) {
  const pageViews = Array.from({ length: pages }, (_, index) => {
    const rect: Rect = { top: index * 100 - 0, bottom: index * 100 + 90 }
    return {
      div: {
        getBoundingClientRect: () => ({ top: rect.top, bottom: rect.bottom }),
      },
    }
  })
  return {
    container: {
      getBoundingClientRect: () => ({ top: 0, bottom: 250 }),
    },
    viewer: {
      pagesCount: pages,
      currentPageNumber,
      currentScaleValue,
      currentScale,
      getPageView: (index: number) => pageViews[index],
    },
  } as any
}

describe('PDF viewer snapshot', function () {
  it('lists the pages that overlap the visible part of the viewer', function () {
    // Page 1 spans 0-90, page 2 100-190, page 3 200-290; the view ends at 250
    expect(visiblePageNumbers(fakeWrapper())).to.deep.equal([1, 2, 3])
  })

  it('falls back to the current page when no page is measurable', function () {
    const wrapper = fakeWrapper({ pages: 0, currentPageNumber: 4 })
    expect(visiblePageNumbers(wrapper)).to.deep.equal([4])
  })

  it('names a fit, or gives the scale as a percentage', function () {
    expect(zoomLabel(fakeWrapper({ currentScaleValue: 'page-width' }))).to.equal(
      'page-width'
    )
    expect(
      zoomLabel(fakeWrapper({ currentScaleValue: '1.25', currentScale: 1.25 }))
    ).to.equal('125%')
  })

  it('carries the build, pages, zoom and dark mode together', function () {
    expect(readPdfViewerSnapshot(fakeWrapper(), 'b42', true)).to.deep.equal({
      buildId: 'b42',
      pages: [1, 2, 3],
      zoom: 'page-width',
      darkMode: true,
    })
  })

  it('reports nothing when no PDF is on screen', function () {
    expect(readPdfViewerSnapshot(null, 'b42', false)).to.equal(null)
  })

  it('reports nothing rather than throwing when the viewer is half torn down', function () {
    const broken = { container: null, viewer: null } as any
    expect(readPdfViewerSnapshot(broken, null, false)).to.equal(null)
  })
})

describe('formatPageRanges', function () {
  it('joins consecutive pages into ranges', function () {
    expect(formatPageRanges([3, 4, 5, 9])).to.equal('3-5,9')
    expect(formatPageRanges([7])).to.equal('7')
    expect(formatPageRanges([])).to.equal('')
  })
})
