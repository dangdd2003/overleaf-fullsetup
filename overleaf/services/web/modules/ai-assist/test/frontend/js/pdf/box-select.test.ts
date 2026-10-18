import { expect } from 'chai'
import sinon from 'sinon'
import {
  boxBetween,
  isBigEnough,
  MIN_BOX_PX,
  pagePointToPdf,
  startBoxDrag,
} from '../../../../frontend/js/features/ai-assist/pdf/box-select'

// A page of 600x800 PDF points drawn at 1.5x, so 1 CSS px is 2/3 of a point
const viewport = {
  viewBox: [0, 0, 600, 800],
  convertToPdfPoint: (x: number, y: number) => [x * (2 / 3), 800 - y * (2 / 3)],
}

describe('box selection geometry', function () {
  it('maps a page point to PDF points measured from the top', function () {
    expect(pagePointToPdf(viewport, 0, 0)).to.deep.equal({ h: 0, v: 0 })
    expect(pagePointToPdf(viewport, 150, 300)).to.deep.equal({ h: 100, v: 200 })
  })

  it('spans two points and clamps them to the canvas', function () {
    const size = { width: 600, height: 800 }
    expect(boxBetween({ x: 200, y: 300 }, { x: 50, y: 100 }, size)).to.deep.equal({
      left: 50,
      top: 100,
      right: 200,
      bottom: 300,
    })
    expect(boxBetween({ x: -20, y: 10 }, { x: 700, y: 900 }, size)).to.deep.equal({
      left: 0,
      top: 10,
      right: 600,
      bottom: 800,
    })
  })

  it('treats a box under the minimum size as a click', function () {
    expect(isBigEnough({ left: 0, top: 0, right: MIN_BOX_PX, bottom: 40 })).to.equal(true)
    expect(isBigEnough({ left: 0, top: 0, right: MIN_BOX_PX - 1, bottom: 40 })).to.equal(false)
  })
})

describe('box drag on a PDF page', function () {
  let container: HTMLDivElement
  let page: HTMLDivElement
  let canvas: HTMLCanvasElement
  let stop: (() => void) | null

  beforeEach(function () {
    container = document.createElement('div')
    page = document.createElement('div')
    page.className = 'page'
    page.dataset.pageNumber = '2'
    canvas = document.createElement('canvas')
    page.append(canvas)
    // The page's 9px border sits outside the canvas, which starts at (10, 20)
    page.getBoundingClientRect = () =>
      ({ left: 1, top: 11, right: 619, bottom: 831, width: 618, height: 820 }) as DOMRect
    canvas.getBoundingClientRect = () =>
      ({ left: 10, top: 20, right: 610, bottom: 820, width: 600, height: 800 }) as DOMRect
    Object.defineProperty(canvas, 'clientWidth', { value: 600 })
    Object.defineProperty(canvas, 'clientHeight', { value: 800 })
    container.append(page)
    document.body.append(container)
    stop = null
  })

  afterEach(function () {
    stop?.()
    container.remove()
  })

  function pointer(
    target: EventTarget,
    type: string,
    clientX: number,
    clientY: number,
    options: { pointerId?: number; button?: number } = {}
  ) {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      button: options.button ?? 0,
    })
    Object.defineProperty(event, 'pointerId', { value: options.pointerId ?? 1 })
    target.dispatchEvent(event)
    return event
  }

  const overlayOf = () => page.querySelector('.ai-assist-pdf-area-overlay')

  it('reports the box on release, in canvas pixels, with the canvas', function () {
    const onBox = sinon.spy()
    stop = startBoxDrag({ container } as any, onBox)
    pointer(canvas, 'pointerdown', 60, 70)
    pointer(window, 'pointermove', 160, 220)
    expect(overlayOf()).to.not.equal(null)
    pointer(window, 'pointerup', 160, 220)
    expect(onBox.calledOnce).to.equal(true)
    expect(onBox.firstCall.args[0]).to.deep.equal({
      page: 2,
      left: 50,
      top: 50,
      right: 150,
      bottom: 200,
    })
    expect(onBox.firstCall.args[1]).to.equal(canvas)
    expect(overlayOf()).to.equal(null)
  })

  it('works with touch and pen pointers, not only the mouse', function () {
    const onBox = sinon.spy()
    stop = startBoxDrag({ container } as any, onBox)
    pointer(canvas, 'pointerdown', 60, 70, { pointerId: 7 })
    pointer(window, 'pointermove', 160, 220, { pointerId: 7 })
    pointer(window, 'pointerup', 160, 220, { pointerId: 7 })
    expect(onBox.calledOnce).to.equal(true)
  })

  it('ignores moves and releases from another pointer', function () {
    const onBox = sinon.spy()
    stop = startBoxDrag({ container } as any, onBox)
    pointer(canvas, 'pointerdown', 60, 70, { pointerId: 1 })
    pointer(window, 'pointerup', 160, 220, { pointerId: 2 })
    expect(onBox.called).to.equal(false)
    expect(overlayOf()).to.not.equal(null)
  })

  it('treats a click as a click, not a box, and stays in the mode', function () {
    const onBox = sinon.spy()
    const onCancel = sinon.spy()
    stop = startBoxDrag({ container } as any, onBox, onCancel)
    pointer(canvas, 'pointerdown', 60, 70)
    pointer(window, 'pointerup', 61, 71)
    expect(onBox.called).to.equal(false)
    expect(onCancel.called).to.equal(false)
    expect(overlayOf()).to.equal(null)
  })

  it('ignores drags that start outside a page, and non-primary buttons', function () {
    const onBox = sinon.spy()
    stop = startBoxDrag({ container } as any, onBox)
    pointer(container, 'pointerdown', 60, 70)
    pointer(canvas, 'pointerdown', 60, 70, { button: 2 })
    expect(overlayOf()).to.equal(null)
  })

  it('cancels on Esc mid-drag, removes the overlay, and reports nothing', function () {
    const onBox = sinon.spy()
    const onCancel = sinon.spy()
    stop = startBoxDrag({ container } as any, onBox, onCancel)
    pointer(canvas, 'pointerdown', 60, 70)
    pointer(window, 'pointermove', 160, 220)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(onCancel.calledOnce).to.equal(true)
    expect(overlayOf()).to.equal(null)
    pointer(window, 'pointerup', 160, 220)
    expect(onBox.called).to.equal(false)
  })

  it('calls onCancel on Esc even without a drag under way', function () {
    const onCancel = sinon.spy()
    stop = startBoxDrag({ container } as any, sinon.spy(), onCancel)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(onCancel.calledOnce).to.equal(true)
  })

  it('leaves the page as it was when stopped, mid-drag or not', function () {
    const onBox = sinon.spy()
    container.style.touchAction = 'pan-y'
    stop = startBoxDrag({ container } as any, onBox)
    expect(container.classList.contains('ai-assist-pdf-box-mode')).to.equal(true)
    expect(container.style.touchAction).to.equal('none')
    expect(document.getElementById('ai-assist-pdf-box-mode-style')).to.not.equal(null)
    pointer(canvas, 'pointerdown', 60, 70)
    stop()
    stop = null
    pointer(window, 'pointerup', 160, 220)
    expect(onBox.called).to.equal(false)
    expect(overlayOf()).to.equal(null)
    expect(container.classList.contains('ai-assist-pdf-box-mode')).to.equal(false)
    expect(container.style.touchAction).to.equal('pan-y')
    expect(document.getElementById('ai-assist-pdf-box-mode-style')).to.equal(null)
  })
})
