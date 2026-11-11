import { Readable, Writable } from 'node:stream'
import { describe, it, expect, vi, afterEach } from 'vitest'
import GalleryController from '../../../app/src/controllers/GalleryController.mjs'
import BlobStore from '../../../app/src/storage/BlobStore.mjs'
import GalleryReadService from '../../../app/src/services/GalleryReadService.mjs'

const TOKEN = 'abcdefghijkl'
const SHA = 'a'.repeat(64)

function fakeResponse() {
  const headers = {}
  const res = new Writable({
    write(chunk, encoding, callback) {
      callback()
    },
  })
  Object.assign(res, {
    headersSent: false,
    setHeader: (name, value) => {
      headers[name] = value
    },
    status(code) {
      this.statusCode = code
      return this
    },
    sendStatus: vi.fn(),
    headers,
  })
  return res
}

describe('GalleryController blob streaming', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('destroys the blob stream when the client disconnects mid-transfer', async () => {
    // two chunks, then the file stays open: the transfer is still in progress
    let pushes = 0
    const stream = new Readable({
      read() {
        if (pushes++ < 2) this.push(Buffer.alloc(1024))
      },
    })
    const destroy = vi.spyOn(stream, 'destroy')
    vi.spyOn(GalleryReadService, 'getMediaItem').mockResolvedValue({
      media: { thumbSha: SHA, thumbMime: 'image/jpeg' },
    })
    vi.spyOn(BlobStore, 'exists').mockResolvedValue(true)
    vi.spyOn(BlobStore, 'getStream').mockReturnValue(stream)

    const res = fakeResponse()
    await GalleryController.serveThumbnail({ params: { token: TOKEN }, headers: {}, session: {} }, res, () => {})
    // the transfer has started, then the client goes away
    await new Promise(resolve => setImmediate(resolve))
    res.emit('close')

    expect(destroy).toHaveBeenCalled()
    expect(stream.destroyed).toBe(true)
  })

  it('answers 304 without opening the blob when the etag matches', async () => {
    vi.spyOn(GalleryReadService, 'getMediaItem').mockResolvedValue({
      media: { thumbSha: SHA, thumbMime: 'image/jpeg' },
    })
    vi.spyOn(BlobStore, 'exists').mockResolvedValue(true)
    const getStream = vi.spyOn(BlobStore, 'getStream')

    const res = fakeResponse()
    res.status = vi.fn(() => res)
    res.end = vi.fn()
    await GalleryController.serveThumbnail(
      { params: { token: TOKEN }, headers: { 'if-none-match': `"${SHA}"` }, session: {} },
      res,
      () => {}
    )

    expect(res.status).toHaveBeenCalledWith(304)
    expect(getStream).not.toHaveBeenCalled()
  })
})
