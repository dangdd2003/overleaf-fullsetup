import { expect } from 'chai'
import {
  backgroundFor,
  base64Bytes,
  formatBytes,
  imageFileProblem,
  imageFromClipboard,
  ImageReadError,
  inkStats,
  MAX_IMAGE_FILE_BYTES,
  normalizeImage,
  targetSize,
} from '../../../../frontend/js/features/ai-assist/generator/image'

describe('equation: image', function () {
  it('accepts PNG, JPEG, WebP and GIF up to 20 MB', function () {
    expect(imageFileProblem({ type: 'image/png', size: 10 })).to.equal(null)
    expect(imageFileProblem({ type: 'image/webp', size: MAX_IMAGE_FILE_BYTES })).to.equal(null)
    expect(imageFileProblem({ type: 'image/svg+xml', size: 10 })).to.equal('type')
    expect(imageFileProblem({ type: 'application/pdf', size: 10 })).to.equal('type')
    expect(imageFileProblem({ type: 'image/jpeg', size: MAX_IMAGE_FILE_BYTES + 1 })).to.equal('size')
  })

  it('finds an image on the clipboard', function () {
    const file = new File(['x'], 'shot.png', { type: 'image/png' })
    const items = [
      { kind: 'string', type: 'text/plain', getAsFile: () => null },
      { kind: 'file', type: 'image/png', getAsFile: () => file },
    ] as unknown as DataTransferItem[]
    expect(imageFromClipboard({ items })).to.equal(file)
    expect(imageFromClipboard({ items: [], files: [file] })).to.equal(file)
    expect(imageFromClipboard({ items: [], files: [] })).to.equal(null)
    expect(imageFromClipboard(null)).to.equal(null)
  })

  it('formats sizes', function () {
    expect(formatBytes(1258291)).to.equal('1.2 MB')
    expect(formatBytes(348160)).to.equal('340 KB')
    expect(formatBytes(10)).to.equal('1 KB')
  })
})

describe('equation: image normalisation', function () {
  it('caps the long edge and scales small crops up', function () {
    expect(targetSize(3000, 1000)).to.deep.equal({ width: 1568, height: 523 })
    expect(targetSize(200, 40)).to.deep.equal({ width: 768, height: 154 })
    expect(targetSize(1000, 500)).to.deep.equal({ width: 1000, height: 500 })
  })

  it('reads transparency and how light the ink is', function () {
    const darkInkOnClear = [0, 0, 0, 255, 0, 0, 0, 0]
    const lightInkOnClear = [255, 255, 255, 255, 0, 0, 0, 0]
    expect(inkStats(darkInkOnClear)).to.deep.equal({ transparent: true, meanLuminance: 0 })
    expect(inkStats(lightInkOnClear).meanLuminance).to.be.closeTo(1, 0.001)
    expect(inkStats([10, 20, 30, 255]).transparent).to.equal(false)
  })

  it('flattens onto a background that contrasts with the ink', function () {
    expect(backgroundFor({ transparent: false, meanLuminance: 0.9 })).to.equal(null)
    expect(backgroundFor({ transparent: true, meanLuminance: 0.1 })).to.equal('#ffffff')
    expect(backgroundFor({ transparent: true, meanLuminance: 0.9 })).to.equal('#000000')
  })

  it('measures base64 data', function () {
    expect(base64Bytes('iVBORw0KGgo=')).to.equal(8)
    expect(base64Bytes('AAAA')).to.equal(3)
  })

  it('refuses a file before reading it, and reports one it cannot decode', async function () {
    const svg = new File(['<svg/>'], 'a.svg', { type: 'image/svg+xml' })
    const error = await normalizeImage(svg).catch(e => e)
    expect(error).to.be.instanceOf(ImageReadError)
    expect(error.code).to.equal('type')
    // jsdom cannot decode images: the same path as a corrupt file
    const png = new File(['not a png'], 'a.png', { type: 'image/png' })
    const unreadable = await normalizeImage(png).catch(e => e)
    expect(unreadable.code).to.equal('read')
  })
})
