import { describe, it } from 'vitest'
import { expect } from 'chai'
import {
  hasImages,
  imageProblem,
  imageStats,
  isImageRejection,
  MAX_IMAGE_BYTES,
} from '../../../app/src/AiAssistImages.mjs'

const image = { mediaType: 'image/png', data: 'iVBORw0KGgo=' }

describe('AiAssistImages', function () {
  it('finds images on messages', function () {
    expect(hasImages([{ role: 'user', content: 'x', images: [image] }])).to.equal(true)
    expect(hasImages([{ role: 'user', content: 'x', images: [] }])).to.equal(false)
    expect(hasImages([{ role: 'user', content: 'x' }])).to.equal(false)
    expect(hasImages(undefined)).to.equal(false)
  })

  it('accepts up to two valid images on user messages', function () {
    expect(imageProblem([{ role: 'user', content: 'x', images: [image, image] }])).to.equal(null)
    expect(imageProblem([{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }])).to.equal(null)
    expect(imageProblem(undefined)).to.equal(null)
  })

  it('refuses images it cannot accept', function () {
    const big = 'A'.repeat(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4)
    for (const messages of [
      [{ role: 'assistant', content: 'x', images: [image] }],
      [{ role: 'user', content: 'x', images: [image, image, image] }],
      [{ role: 'user', content: 'x', images: [{ mediaType: 'image/svg+xml', data: 'PHN2Zz4=' }] }],
      [{ role: 'user', content: 'x', images: [{ mediaType: 'image/png', data: 'abc' }] }],
      [{ role: 'user', content: 'x', images: [{ mediaType: 'image/png', data: 'ab!=' }] }],
      [{ role: 'user', content: 'x', images: [{ mediaType: 'image/png', data: big }] }],
      [{ role: 'user', content: 'x', images: 'not a list' }],
    ]) {
      expect(imageProblem(messages), JSON.stringify(messages).slice(0, 80)).to.be.a('string')
    }
  })

  it('recognises a provider refusing images', function () {
    expect(isImageRejection({ status: 400, message: 'image_url is only supported by certain models' })).to.equal(true)
    expect(isImageRejection({ status: 400, message: 'This model does not support vision' })).to.equal(true)
    expect(isImageRejection({ status: 400, message: 'max_tokens is too large' })).to.equal(false)
    expect(isImageRejection({ status: 401, message: 'image' })).to.equal(false)
    expect(isImageRejection({ status: 429, message: 'image' })).to.equal(false)
    expect(isImageRejection({ status: 500, message: 'image' })).to.equal(false)
  })

  it('measures images for the logs, never their data', function () {
    expect(imageStats([{ role: 'user', content: 'x', images: [image] }])).to.deep.equal([
      { mediaType: 'image/png', bytes: 8 },
    ])
  })
})
