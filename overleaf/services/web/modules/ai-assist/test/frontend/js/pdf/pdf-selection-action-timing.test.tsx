import { expect } from 'chai'
import { act, render, screen, waitFor } from '@testing-library/react'
import { publishPdfViewer } from '@/features/pdf-preview/util/viewer-bridge'
import { PdfSelectionAction } from '../../../../frontend/js/features/ai-assist/pdf/pdf-selection-action'

describe('PdfSelectionAction timing', function () {
  let container: HTMLDivElement
  let originalRects: typeof window.Range.prototype.getClientRects

  beforeEach(function () {
    container = document.createElement('div')
    container.innerHTML =
      '<div class="page" data-page-number="2"><div class="textLayer"><span>the lemma holds</span></div></div>'
    document.body.append(container)
    publishPdfViewer({ wrapper: { container }, buildId: null, editorId: null } as never)
    originalRects = window.Range.prototype.getClientRects
    window.Range.prototype.getClientRects = () =>
      [{ left: 10, top: 10, right: 120, bottom: 24 }] as unknown as DOMRectList
  })

  afterEach(function () {
    window.Range.prototype.getClientRects = originalRects
    window.getSelection()?.removeAllRanges()
    publishPdfViewer(null)
    container.remove()
  })

  function selectText() {
    const span = container.querySelector('span')!
    const range = document.createRange()
    range.selectNodeContents(span)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  }

  it('shows only once the pointer is released', async function () {
    render(<PdfSelectionAction />)
    act(() => {
      document.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      selectText()
    })
    expect(screen.queryByRole('button', { name: 'Add to chat' })).to.equal(null)

    act(() => {
      document.dispatchEvent(new Event('pointerup', { bubbles: true }))
    })
    await waitFor(() => screen.getByRole('button', { name: 'Add to chat' }))
  })

  it('is placed fixed to the window, from the end of the selection', async function () {
    render(<PdfSelectionAction />)
    act(() => {
      document.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      selectText()
      document.dispatchEvent(new Event('pointerup', { bubbles: true }))
    })
    const button = await waitFor(() =>
      screen.getByRole('button', { name: 'Add to chat' })
    )
    expect(button.style.position).to.equal('fixed')
    // Below the selection, or above it when there is no room below
    expect(button.getAttribute('data-placement')).to.be.oneOf(['bottom', 'top'])
  })

  it('hides when a new selection starts', async function () {
    render(<PdfSelectionAction />)
    act(() => {
      document.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      selectText()
      document.dispatchEvent(new Event('pointerup', { bubbles: true }))
    })
    await waitFor(() => screen.getByRole('button', { name: 'Add to chat' }))

    act(() => {
      document.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    expect(screen.queryByRole('button', { name: 'Add to chat' })).to.equal(null)
  })
})
