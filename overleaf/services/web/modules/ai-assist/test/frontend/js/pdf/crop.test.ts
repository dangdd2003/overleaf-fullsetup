import { expect } from 'chai'
import sinon from 'sinon'
import {
  cropCanvas,
  cropPixels,
  MAX_CROP_SIDE,
  MAX_ENCODED_CHARS,
  outputSize,
} from '../../../../frontend/js/features/ai-assist/pdf/crop'

describe('crop math', function () {
  it('maps CSS pixels to canvas pixels by the canvas-to-shown ratio', function () {
    // A 2x canvas shown at 600 CSS px wide
    const pixels = cropPixels(
      { left: 10, top: 20, right: 110, bottom: 70 },
      { width: 600, height: 800 },
      { width: 1200, height: 1600 }
    )
    expect(pixels).to.deep.equal({ x: 20, y: 40, width: 200, height: 100 })
  })

  it('keeps a crop inside the canvas and never empty', function () {
    const pixels = cropPixels(
      { left: 590, top: 790, right: 700, bottom: 900 },
      { width: 600, height: 800 },
      { width: 600, height: 800 }
    )
    expect(pixels).to.deep.equal({ x: 590, y: 790, width: 10, height: 10 })

    const empty = cropPixels(
      { left: 5, top: 5, right: 5, bottom: 5 },
      { width: 600, height: 800 },
      { width: 600, height: 800 }
    )
    expect(empty.width).to.equal(1)
    expect(empty.height).to.equal(1)
  })

  it('treats a canvas that is not shown at a size as unscaled', function () {
    const pixels = cropPixels(
      { left: 0, top: 0, right: 50, bottom: 50 },
      { width: 0, height: 0 },
      { width: 300, height: 300 }
    )
    expect(pixels).to.deep.equal({ x: 0, y: 0, width: 50, height: 50 })
  })

  it('caps the longest side of the output and keeps the aspect ratio', function () {
    expect(MAX_CROP_SIDE).to.equal(1568)
    expect(outputSize({ width: 3136, height: 800 })).to.deep.equal({
      width: 1568,
      height: 400,
    })
    expect(outputSize({ width: 800, height: 3136 })).to.deep.equal({
      width: 400,
      height: 1568,
    })
  })

  it('does not scale a crop that is already small enough', function () {
    expect(outputSize({ width: 640, height: 480 })).to.deep.equal({
      width: 640,
      height: 480,
    })
  })
})

/** A source canvas of 100x100 pixels; the crop's output canvas is stubbed. */
function sourceCanvas() {
  const canvas = document.createElement('canvas')
  canvas.width = 100
  canvas.height = 100
  return canvas
}

/** Makes the crop's output canvas hand back `context` and `toDataURL`. */
function stubOutputCanvas(
  context: unknown,
  toDataURL: (type: string) => string
) {
  const original = document.createElement.bind(document)
  sinon.stub(document, 'createElement').callsFake((tag: string, options?: any) => {
    if (tag !== 'canvas') return original(tag, options)
    const out = original('canvas')
    sinon.stub(out, 'getContext').returns(context as any)
    sinon.stub(out, 'toDataURL').callsFake(toDataURL as any)
    return out
  })
}

describe('cropCanvas', function () {
  afterEach(function () {
    sinon.restore()
  })

  it('returns null when the canvas has no pixels', function () {
    const canvas = sourceCanvas()
    canvas.width = 0
    canvas.height = 0
    expect(cropCanvas(canvas, { left: 0, top: 0, right: 10, bottom: 10 })).to.equal(null)
  })

  it('returns null when the browser cannot give a drawing context', function () {
    stubOutputCanvas(null, () => '')
    expect(
      cropCanvas(sourceCanvas(), { left: 0, top: 0, right: 10, bottom: 10 })
    ).to.equal(null)
  })

  it('returns null when the canvas cannot be exported', function () {
    stubOutputCanvas({ drawImage: sinon.spy() }, () => {
      throw new Error('tainted')
    })
    expect(
      cropCanvas(sourceCanvas(), { left: 0, top: 0, right: 10, bottom: 10 })
    ).to.equal(null)
  })

  it('encodes the crop as base64 PNG with no data: prefix', function () {
    const context = { drawImage: sinon.spy() }
    stubOutputCanvas(context, () => 'data:image/png;base64,AAAA')
    const image = cropCanvas(sourceCanvas(), { left: 0, top: 0, right: 10, bottom: 10 })
    expect(image?.mediaType).to.equal('image/png')
    expect(image?.data).to.equal('AAAA')
    expect(image?.name).to.match(
      /^Overleaf_Capture_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.png$/
    )
    // The crop rectangle is copied from the page canvas, at the output size
    expect(context.drawImage.firstCall.args.slice(1)).to.deep.equal([
      0, 0, 10, 10, 0, 0, 10, 10,
    ])
  })

  it('falls back to JPEG at quality 0.85 when the PNG is too large to send', function () {
    const big = 'A'.repeat(MAX_ENCODED_CHARS + 10)
    const toDataURL = sinon.spy((type: string, _quality?: number) =>
      type === 'image/png' ? `data:image/png;base64,${big}` : 'data:image/jpeg;base64,BBBB'
    )
    const original = document.createElement.bind(document)
    sinon.stub(document, 'createElement').callsFake((tag: string, options?: any) => {
      if (tag !== 'canvas') return original(tag, options)
      const out = original('canvas')
      sinon.stub(out, 'getContext').returns({ drawImage: sinon.spy() } as any)
      sinon.stub(out, 'toDataURL').callsFake(toDataURL as any)
      return out
    })
    const image = cropCanvas(sourceCanvas(), { left: 0, top: 0, right: 10, bottom: 10 })
    expect(image?.mediaType).to.equal('image/jpeg')
    expect(image?.data).to.equal('BBBB')
    expect(image?.name).to.match(
      /^Overleaf_Capture_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.jpg$/
    )
    expect(toDataURL.calledWith('image/jpeg', 0.85)).to.equal(true)
  })
})
