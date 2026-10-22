import { expect } from 'chai'
import sinon from 'sinon'
import React, { createRef } from 'react'
import { render, fireEvent, act } from '@testing-library/react'
import {
  ImageLightbox,
  calculatePanBounds,
} from '../../../../../frontend/js/features/ai-assist/components/agent/image-lightbox'

describe('ImageLightbox Component', function () {
  let clock: sinon.SinonFakeTimers

  beforeEach(function () {
    clock = sinon.useFakeTimers()
  })

  afterEach(function () {
    clock.restore()
    // Clean up any left over body overflow
    document.body.style.overflow = ''
  })

  it('does not render when isOpen is false', function () {
    const onClose = sinon.stub()
    render(
      <ImageLightbox
        src="data:image/png;base64,abc123"
        isOpen={false}
        onClose={onClose}
      />
    )

    expect(document.querySelector('.ai-assist-lightbox-overlay')).to.not.exist
  })

  it('renders into portal when isOpen is true with the image src and alt', function () {
    const onClose = sinon.stub()
    render(
      <ImageLightbox
        src="data:image/png;base64,testImage"
        alt="Custom Alt Text"
        isOpen={true}
        onClose={onClose}
      />
    )

    const overlay = document.querySelector('.ai-assist-lightbox-overlay')
    expect(overlay).to.exist
    expect(overlay?.classList.contains('is-entering')).to.be.true

    const img = overlay?.querySelector('img.ai-assist-lightbox-image') as HTMLImageElement
    expect(img).to.exist
    expect(img.src).to.equal('data:image/png;base64,testImage')
    expect(img.alt).to.equal('Custom Alt Text')
  })

  it('locks body scroll while open and restores it when closed', function () {
    document.body.style.overflow = 'auto'
    const onClose = sinon.stub()
    const { unmount } = render(
      <ImageLightbox
        src="data:image/png;base64,test"
        isOpen={true}
        onClose={onClose}
      />
    )

    expect(document.body.style.overflow).to.equal('hidden')

    unmount()
    expect(document.body.style.overflow).to.equal('auto')
  })

  it('calls onClose when close button is clicked', function () {
    const onClose = sinon.stub()
    render(
      <ImageLightbox
        src="data:image/png;base64,test"
        isOpen={true}
        onClose={onClose}
      />
    )

    const closeBtn = document.querySelector('.ai-assist-lightbox-close-btn') as HTMLButtonElement
    expect(closeBtn).to.exist

    fireEvent.click(closeBtn)
    expect(onClose.calledOnce).to.be.true
  })

  it('calls onClose when clicking the backdrop overlay', function () {
    const onClose = sinon.stub()
    render(
      <ImageLightbox
        src="data:image/png;base64,test"
        isOpen={true}
        onClose={onClose}
      />
    )

    const overlay = document.querySelector('.ai-assist-lightbox-overlay') as HTMLElement
    fireEvent.click(overlay)

    expect(onClose.calledOnce).to.be.true
  })

  it('does NOT call onClose when clicking the image inside container', function () {
    const onClose = sinon.stub()
    render(
      <ImageLightbox
        src="data:image/png;base64,test"
        isOpen={true}
        onClose={onClose}
      />
    )

    const img = document.querySelector('.ai-assist-lightbox-image') as HTMLImageElement
    fireEvent.click(img)

    expect(onClose.called).to.be.false
  })

  it('calls onClose when Escape key is pressed', function () {
    const onClose = sinon.stub()
    render(
      <ImageLightbox
        src="data:image/png;base64,test"
        isOpen={true}
        onClose={onClose}
      />
    )

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose.calledOnce).to.be.true
  })

  it('plays leave animation before unrendering when isOpen becomes false', function () {
    const onClose = sinon.stub()
    const { rerender } = render(
      <ImageLightbox
        src="data:image/png;base64,test"
        isOpen={true}
        onClose={onClose}
      />
    )

    const overlay = document.querySelector('.ai-assist-lightbox-overlay')
    expect(overlay).to.exist

    // Change isOpen to false
    rerender(
      <ImageLightbox
        src="data:image/png;base64,test"
        isOpen={false}
        onClose={onClose}
      />
    )

    // Should have is-leaving class during transition
    const overlayLeaving = document.querySelector('.ai-assist-lightbox-overlay')
    expect(overlayLeaving?.classList.contains('is-leaving')).to.be.true

    // Advance timer past exit animation (180ms)
    act(() => {
      clock.tick(200)
    })

    // Now unrendered
    expect(document.querySelector('.ai-assist-lightbox-overlay')).to.not.exist
  })

  it('renders download button and image with suggested filename for Save image as', function () {
    const onClose = sinon.stub()
    render(
      <ImageLightbox
        src="data:image/png;base64,test"
        title="Custom_Title_2026-10-17_15-00-00.png"
        downloadName="Custom_Title_2026-10-17_15-00-00.png"
        isOpen={true}
        onClose={onClose}
      />
    )

    const downloadBtn = document.querySelector('.ai-assist-lightbox-download-btn') as HTMLElement
    expect(downloadBtn).to.exist

    const img = document.querySelector('.ai-assist-lightbox-image') as HTMLImageElement
    expect(img).to.exist
    expect(img.title).to.equal('Custom_Title_2026-10-17_15-00-00.png')
    expect(img.alt).to.equal('Custom_Title_2026-10-17_15-00-00.png')
  })

  it('zooms in and out across full viewport with mouse wheel scrolling and clamps between 0.2x and 5x', function () {
    const onClose = sinon.stub()
    render(
      <ImageLightbox
        src="data:image/png;base64,test"
        isOpen={true}
        onClose={onClose}
      />
    )

    const container = document.querySelector('.ai-assist-lightbox-container') as HTMLDivElement
    const img = document.querySelector('.ai-assist-lightbox-image') as HTMLImageElement
    expect(img.style.transform).to.include('scale(1)')

    // Scroll up to zoom in
    fireEvent.wheel(container, { deltaY: -100 })

    expect(img.style.transform).to.include('scale(1.25)')
    expect(document.querySelector('.ai-assist-lightbox-zoom-level')?.textContent).to.equal('125%')

    // Scroll down to zoom out back to 1x
    fireEvent.wheel(container, { deltaY: 100 })

    expect(img.style.transform).to.include('scale(1)')
    expect(document.querySelector('.ai-assist-lightbox-zoom-level')?.textContent).to.equal('100%')

    // Scroll down further to zoom out below 1x using full viewport
    fireEvent.wheel(container, { deltaY: 100 })
    expect(img.style.transform).to.include('scale(0.75)')
    expect(document.querySelector('.ai-assist-lightbox-zoom-level')?.textContent).to.equal('75%')
  })

  it('toggles zoom between 1x and 2x on double click', function () {
    const onClose = sinon.stub()
    render(
      <ImageLightbox
        src="data:image/png;base64,test"
        isOpen={true}
        onClose={onClose}
      />
    )

    const img = document.querySelector('.ai-assist-lightbox-image') as HTMLImageElement
    expect(img.style.transform).to.include('scale(1)')

    fireEvent.doubleClick(img)
    expect(img.style.transform).to.include('scale(2)')
    expect(document.querySelector('.ai-assist-lightbox-zoom-level')?.textContent).to.equal('200%')

    fireEvent.doubleClick(img)
    expect(img.style.transform).to.include('scale(1)')
    expect(document.querySelector('.ai-assist-lightbox-zoom-level')?.textContent).to.equal('100%')
  })

  it('resets zoom when clicking the return/reset button', function () {
    const onClose = sinon.stub()
    render(
      <ImageLightbox
        src="data:image/png;base64,test"
        isOpen={true}
        onClose={onClose}
      />
    )

    const container = document.querySelector('.ai-assist-lightbox-container') as HTMLDivElement
    const img = document.querySelector('.ai-assist-lightbox-image') as HTMLImageElement

    // Zoom in twice
    fireEvent.wheel(container, { deltaY: -100 })
    fireEvent.wheel(container, { deltaY: -100 })
    expect(img.style.transform).to.include('scale(1.5)')

    const resetBtn = document.querySelector('.ai-assist-lightbox-zoom-reset') as HTMLButtonElement
    expect(resetBtn).to.exist
    fireEvent.click(resetBtn)

    expect(img.style.transform).to.include('scale(1)')
    expect(document.querySelector('.ai-assist-lightbox-zoom-level')?.textContent).to.equal('100%')
  })

  it('opens manual size popover on clicking the zoom percentage badge without auto-reverting', function () {
    const onClose = sinon.stub()
    render(
      <ImageLightbox
        src="data:image/png;base64,test"
        isOpen={true}
        onClose={onClose}
      />
    )

    const container = document.querySelector('.ai-assist-lightbox-container') as HTMLDivElement
    const img = document.querySelector('.ai-assist-lightbox-image') as HTMLImageElement

    // Zoom in to 150%
    fireEvent.wheel(container, { deltaY: -100 })
    fireEvent.wheel(container, { deltaY: -100 })
    expect(img.style.transform).to.include('scale(1.5)')

    // Click the percentage badge button
    const badge = document.querySelector('.ai-assist-lightbox-zoom-badge') as HTMLButtonElement
    expect(badge).to.exist
    fireEvent.click(badge)

    // MUST NOT auto-revert to 100%!
    expect(img.style.transform).to.include('scale(1.5)')

    // Popover menu must appear
    const popover = document.querySelector('.ai-assist-lightbox-zoom-popover')
    expect(popover).to.exist

    const input = document.querySelector('.ai-assist-lightbox-zoom-input') as HTMLInputElement
    expect(input).to.exist
    expect(input.value).to.equal('150%')
  })

  it('manually sets zoom size via custom percentage input', function () {
    const onClose = sinon.stub()
    render(
      <ImageLightbox
        src="data:image/png;base64,test"
        isOpen={true}
        onClose={onClose}
      />
    )

    const img = document.querySelector('.ai-assist-lightbox-image') as HTMLImageElement
    const badge = document.querySelector('.ai-assist-lightbox-zoom-badge') as HTMLButtonElement
    fireEvent.click(badge)

    const input = document.querySelector('.ai-assist-lightbox-zoom-input') as HTMLInputElement
    expect(input).to.exist

    // Type 220% and submit form
    fireEvent.change(input, { target: { value: '220%' } })
    const form = document.querySelector('.ai-assist-lightbox-zoom-input-form') as HTMLFormElement
    fireEvent.submit(form)

    // Zoom level must update to 220% (scale 2.2)
    expect(img.style.transform).to.include('scale(2.2)')
    expect(document.querySelector('.ai-assist-lightbox-zoom-level')?.textContent).to.equal('220%')

    // Popover menu closes
    expect(document.querySelector('.ai-assist-lightbox-zoom-popover')).to.not.exist
  })

  it('manually sets zoom size via preset button in the popover', function () {
    const onClose = sinon.stub()
    render(
      <ImageLightbox
        src="data:image/png;base64,test"
        isOpen={true}
        onClose={onClose}
      />
    )

    const img = document.querySelector('.ai-assist-lightbox-image') as HTMLImageElement
    const badge = document.querySelector('.ai-assist-lightbox-zoom-badge') as HTMLButtonElement
    fireEvent.click(badge)

    const presetButtons = document.querySelectorAll('.ai-assist-lightbox-zoom-preset-btn')
    expect(presetButtons.length).to.be.above(0)

    // Find and click the 300% preset button
    const preset300 = Array.from(presetButtons).find(btn => btn.textContent === '300%') as HTMLButtonElement
    expect(preset300).to.exist
    fireEvent.click(preset300)

    // Zoom level must update to 300% (scale 3)
    expect(img.style.transform).to.include('scale(3)')
    expect(document.querySelector('.ai-assist-lightbox-zoom-level')?.textContent).to.equal('300%')

    // Popover closes
    expect(document.querySelector('.ai-assist-lightbox-zoom-popover')).to.not.exist
  })

  it('closes manual zoom popover on Escape without closing the lightbox', function () {
    const onClose = sinon.stub()
    render(
      <ImageLightbox
        src="data:image/png;base64,test"
        isOpen={true}
        onClose={onClose}
      />
    )

    const badge = document.querySelector('.ai-assist-lightbox-zoom-badge') as HTMLButtonElement
    fireEvent.click(badge)
    expect(document.querySelector('.ai-assist-lightbox-zoom-popover')).to.exist

    fireEvent.keyDown(document, { key: 'Escape' })

    // Popover closed
    expect(document.querySelector('.ai-assist-lightbox-zoom-popover')).to.not.exist
    // Lightbox itself should NOT be closed
    expect(onClose.called).to.be.false
  })

  it('calculates correct edge limits for dragging via calculatePanBounds', function () {
    // When scaled image is larger than viewport:
    // e.g. Image 800x600 scaled 3x = 2400x1800, Viewport 1920x1080
    // diffX = (2400 - 1920) / 2 = 240; diffY = (1800 - 1080) / 2 = 360
    const boundsZoomed = calculatePanBounds(800, 600, 3, 1920, 1080)
    expect(boundsZoomed.minX).to.equal(-240)
    expect(boundsZoomed.maxX).to.equal(240)
    expect(boundsZoomed.minY).to.equal(-360)
    expect(boundsZoomed.maxY).to.equal(360)

    // When scaled image is smaller than viewport:
    // e.g. Image 400x300 scaled 1x = 400x300, Viewport 1000x800
    // diffX = (1000 - 400) / 2 = 300; diffY = (800 - 300) / 2 = 250
    const boundsSmall = calculatePanBounds(400, 300, 1, 1000, 800)
    expect(boundsSmall.minX).to.equal(-300)
    expect(boundsSmall.maxX).to.equal(300)
    expect(boundsSmall.minY).to.equal(-250)
    expect(boundsSmall.maxY).to.equal(250)
  })

  it('restricts pan coordinates within edge limits when dragging with pointer', function () {
    const onClose = sinon.stub()
    render(
      <ImageLightbox
        src="data:image/png;base64,test"
        isOpen={true}
        onClose={onClose}
      />
    )

    const img = document.querySelector('.ai-assist-lightbox-image') as HTMLImageElement
    expect(img).to.exist

    // Start dragging at x=100, y=100
    fireEvent.pointerDown(img, { button: 0, clientX: 100, clientY: 100, pointerId: 1 })

    // Drag to excessive coordinates (e.g. clientX = 50000, clientY = 50000)
    fireEvent.pointerMove(img, { clientX: 50000, clientY: 50000, pointerId: 1 })

    // Pan transform should be bounded, not 50000px!
    const transform = img.style.transform
    expect(transform).to.include('translate(')
    const match = transform.match(/translate\(([^,]+)px,\s*([^)]+)px\)/)
    expect(match).to.exist
    const x = parseFloat(match![1])
    const y = parseFloat(match![2])

    // Must be strictly clamped within reasonable screen bounds (e.g. <= 2000px)
    expect(Math.abs(x)).to.be.below(2000)
    expect(Math.abs(y)).to.be.below(2000)

    fireEvent.pointerUp(img, { pointerId: 1 })
  })
})
