import { expect } from 'chai'
import { pdfSelectionTarget } from '../../../../frontend/js/features/ai-assist/pdf/pdf-selection-action'

function buildRoot() {
  const root = document.createElement('div')
  root.innerHTML = `
    <div class="pdfViewer">
      <div class="page" data-page-number="3">
        <div class="textLayer"><span>the lemma</span></div>
      </div>
    </div>
    <div class="editor"><p>outside the PDF</p></div>
  `
  document.body.append(root)
  return root
}

/** A Selection with the given anchor, text and line boxes, as a browser gives. */
function selectionOf(
  anchorNode: Node | null,
  options: { text?: string; collapsed?: boolean; rects?: DOMRect[] } = {}
): Selection {
  const rects = options.rects ?? [rect(10, 20, 200, 36)]
  return {
    anchorNode,
    isCollapsed: options.collapsed ?? false,
    rangeCount: 1,
    toString: () => options.text ?? 'the lemma',
    getRangeAt: () => ({ getClientRects: () => rects }),
  } as unknown as Selection
}

function rect(left: number, top: number, right: number, bottom: number): DOMRect {
  return { left, top, right, bottom, width: right - left, height: bottom - top } as DOMRect
}

describe('PDF selection action', function () {
  let root: HTMLElement

  beforeEach(function () {
    root = buildRoot() as HTMLElement
  })

  afterEach(function () {
    root.remove()
  })

  describe('which selection it offers', function () {
    it('offers a non-empty selection inside the PDF text layer, at its last line', function () {
      const span = root.querySelector('.textLayer span')!.firstChild
      const rects = [rect(10, 20, 200, 36), rect(10, 40, 90, 56)]
      const target = pdfSelectionTarget(root, selectionOf(span, { rects }))
      expect(target?.context).to.deep.equal({ page: 3, text: 'the lemma' })
      expect(target?.end).to.deep.equal({ left: 10, top: 40, right: 90, bottom: 56 })
    })

    it('hides for a collapsed selection', function () {
      const span = root.querySelector('.textLayer span')!.firstChild
      expect(pdfSelectionTarget(root, selectionOf(span, { collapsed: true }))).to.equal(null)
    })

    it('hides for a selection made outside the PDF', function () {
      const outside = root.querySelector('.editor p')!.firstChild
      expect(pdfSelectionTarget(root, selectionOf(outside))).to.equal(null)
    })

    it('hides when there is no viewer', function () {
      const span = root.querySelector('.textLayer span')!.firstChild
      expect(pdfSelectionTarget(null, selectionOf(span))).to.equal(null)
      expect(pdfSelectionTarget(root, null)).to.equal(null)
    })

    it('hides for a selection with only whitespace', function () {
      const span = root.querySelector('.textLayer span')!.firstChild
      expect(
        pdfSelectionTarget(root, selectionOf(span, { text: '   ' }))
      ).to.equal(null)
    })

    it('hides when the selection has no line boxes to place it by', function () {
      const span = root.querySelector('.textLayer span')!.firstChild
      expect(pdfSelectionTarget(root, selectionOf(span, { rects: [] }))).to.equal(null)
    })
  })
})
