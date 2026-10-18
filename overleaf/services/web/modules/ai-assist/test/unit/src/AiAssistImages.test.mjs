import { describe, it } from 'vitest'
import { expect } from 'chai'
import {
  detachToolImages,
  hasImages,
  imageProblem,
  imageStats,
  isImageRejection,
  limitContextImages,
  limitUserImages,
  MAX_IMAGE_BYTES,
  MAX_MESSAGE_IMAGES,
  messageImagesProblem,
  stripToolImages,
  suggestCaptureTitle,
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

  it('suggests a capture title with date and time following best practice', function () {
    const fixedTime = new Date('2026-10-17T14:35:20Z').getTime()
    const title = suggestCaptureTitle({
      page: 2,
      timestamp: fixedTime,
      mediaType: 'image/png',
    })
    expect(title).to.match(/^Overleaf_Capture_p2_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.png$/)

    const jpegTitle = suggestCaptureTitle({
      timestamp: fixedTime,
      mediaType: 'image/jpeg',
    })
    expect(jpegTitle).to.match(/^Overleaf_Capture_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.jpg$/)
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

  describe('tool images', function () {
    const toolMessage = (id, withImage = true) => ({
      role: 'tool',
      toolCallId: id,
      name: 'view_compiled_pdf_page',
      content: `page ${id}`,
      ...(withImage ? { images: [image] } : {}),
    })

    it('splits the bytes off a result, keeping what the image is', function () {
      const result = { page: 2, image: { ...image, dpi: 150, width: 1240 } }
      expect(detachToolImages(result)).to.deep.equal({
        result: { page: 2, image: { mediaType: 'image/png', dpi: 150, width: 1240 } },
        images: [image],
      })
    })

    it('leaves a result without a usable image alone', function () {
      for (const result of [
        { page: 2 },
        { page: 2, image: null },
        { page: 2, image: { mediaType: 'image/svg+xml', data: 'PHN2Zz4=' } },
        { error: 'nope' },
        null,
      ]) {
        const detached = detachToolImages(result)
        expect(detached.result).to.equal(result)
        expect(detached.images).to.deep.equal([])
      }
    })

    it('keeps the images of only the newest tool messages', function () {
      const messages = [
        { role: 'user', content: 'u' },
        toolMessage('a'),
        toolMessage('b', false),
        toolMessage('c'),
        toolMessage('d'),
      ]
      const limited = limitContextImages(messages, 2, 0)
      expect(limited.map(message => Boolean(message.images))).to.deep.equal([
        false,
        false,
        false,
        true,
        true,
      ])
      expect(limited[1].content).to.equal('page a')
      // unchanged when within the limit, so nothing is rebuilt needlessly
      expect(limitContextImages(messages, 3, 0)).to.equal(messages)
      expect(messages[1].images).to.deep.equal([image])
    })

    it('waits for the slack before dropping, then drops back to the limit in one go', function () {
      const pages = n =>
        [{ role: 'user', content: 'u' }, ...Array.from({ length: n }, (_, i) => toolMessage(`p${i}`))]
      // Within max + slack nothing is dropped, so the prefix the cache holds
      // stays the same from one page view to the next
      const eight = pages(8)
      expect(limitContextImages(eight, 4, 4)).to.equal(eight)
      const nine = limitContextImages(pages(9), 4, 4)
      // Nine pictures: the five oldest go, the newest four stay
      expect(nine.filter(m => m.images).map(m => m.toolCallId)).to.deep.equal([
        'p5',
        'p6',
        'p7',
        'p8',
      ])
      expect(nine[1].content).to.equal('page p0')
    })

    it('strips every tool image for a model that refused them', function () {
      const messages = [
        { role: 'user', content: 'u', images: [image] },
        toolMessage('a'),
      ]
      const stripped = stripToolImages(messages)
      expect(stripped[1]).to.deep.equal(toolMessage('a', false))
      // a user's own attachment is not the tool's to drop
      expect(stripped[0]).to.equal(messages[0])
    })
  })

  describe('limitUserImages', function () {
    const user = (content, count) => ({
      role: 'user',
      content,
      images: Array.from({ length: count }, () => image),
    })

    it('returns the messages unchanged when within the limit', function () {
      const messages = [user('a', 2), { role: 'assistant', content: 'b' }, user('c', 1)]
      expect(limitUserImages(messages, 3)).to.equal(messages)
    })

    it('keeps the newest images and notes the dropped ones', function () {
      const messages = [user('old', 2), { role: 'assistant', content: 'b' }, user('new', 2)]
      const out = limitUserImages(messages, 3)
      expect(out[2]).to.equal(messages[2])
      expect(out[0].images).to.have.length(1)
      expect(out[0].content).to.match(/^old\n\n\[1 image attached .* was dropped/)
      expect(messages[0].images).to.have.length(2)
    })

    it('removes every image from turns past the limit', function () {
      const out = limitUserImages([user('old', 2), user('new', 1)], 1)
      expect(out[0]).not.to.have.property('images')
      expect(out[0].content).to.include('2 images attached to this message were dropped')
      expect(out[1].images).to.have.length(1)
    })

    it('leaves tool images to limitContextImages', function () {
      const tool = { role: 'tool', content: 'page', images: [image] }
      const messages = [tool, user('new', 1)]
      expect(limitUserImages(messages, 0)[0]).to.equal(tool)
    })
  })

  describe('messageImagesProblem', function () {
    it('accepts no images and valid ones', function () {
      expect(messageImagesProblem(undefined)).to.equal(null)
      expect(messageImagesProblem([image, image, image])).to.equal(null)
    })

    it('refuses more than one message may attach', function () {
      const many = Array.from({ length: MAX_MESSAGE_IMAGES + 1 }, () => image)
      expect(messageImagesProblem(many)).to.match(/At most/)
    })

    it('refuses an invalid image', function () {
      expect(messageImagesProblem([{ mediaType: 'image/bmp', data: 'AAAA' }])).to.equal(
        'Unsupported image type.'
      )
      expect(messageImagesProblem('x')).to.equal('Images must be a list.')
    })
  })
})
