import { expect } from 'chai'
import {
  MAX_PDF_SELECTION_CHARS,
  pdfPageOf,
  readPdfSelection,
} from '../../../../frontend/js/features/ai-assist/pdf/selection'

function buildViewer() {
  const root = document.createElement('div')
  root.innerHTML = `
    <div class="pdfViewer">
      <div class="page" data-page-number="3">
        <div class="textLayer"><span id="inside">Hello world</span></div>
      </div>
      <div class="page" data-page-number="4">
        <canvas id="canvas"></canvas>
      </div>
    </div>
    <div id="editor"><span id="code">code</span></div>`
  document.body.append(root)
  return root
}

function fakeSelection(
  anchorNode: Node | null,
  text: string,
  collapsed = false
): Selection {
  return {
    anchorNode,
    isCollapsed: collapsed,
    toString: () => text,
  } as unknown as Selection
}

describe('PDF text selection', function () {
  let root: HTMLElement

  beforeEach(function () {
    root = buildViewer() as HTMLElement
  })

  afterEach(function () {
    root.remove()
  })

  it('finds the page of a node in the text layer', function () {
    const span = document.getElementById('inside')!
    expect(pdfPageOf(span.firstChild, root)).to.equal(3)
  })

  it('ignores nodes on a page without a text layer, and nodes outside the viewer', function () {
    expect(pdfPageOf(document.getElementById('canvas'), root)).to.equal(null)
    expect(pdfPageOf(document.getElementById('code'), root)).to.equal(null)
  })

  it('reads the selected text with its page', function () {
    const span = document.getElementById('inside')!
    expect(
      readPdfSelection(root, fakeSelection(span.firstChild, '  Hello world \n'))
    ).to.deep.equal({ page: 3, text: 'Hello world' })
  })

  it('returns nothing for a collapsed or empty selection', function () {
    const span = document.getElementById('inside')!
    expect(readPdfSelection(root, fakeSelection(span.firstChild, '', true))).to.equal(null)
    expect(readPdfSelection(root, fakeSelection(span.firstChild, '   '))).to.equal(null)
  })

  it('returns nothing for a selection made in the editor', function () {
    const code = document.getElementById('code')!
    expect(readPdfSelection(root, fakeSelection(code.firstChild, 'code'))).to.equal(null)
  })

  it('caps very long selections', function () {
    const span = document.getElementById('inside')!
    const long = 'x'.repeat(MAX_PDF_SELECTION_CHARS + 50)
    const result = readPdfSelection(root, fakeSelection(span.firstChild, long))
    expect(result!.text).to.have.length(MAX_PDF_SELECTION_CHARS)
  })
})
