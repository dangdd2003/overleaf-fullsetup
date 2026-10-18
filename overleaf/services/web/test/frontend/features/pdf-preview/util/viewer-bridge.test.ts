import { expect } from 'chai'
import sinon from 'sinon'
import {
  getPdfViewer,
  publishPdfViewer,
  subscribePdfViewer,
} from '@/features/pdf-preview/util/viewer-bridge'

describe('viewer-bridge', function () {
  // The bridge is module state, so each test leaves it empty.
  afterEach(function () {
    publishPdfViewer(null)
  })

  it('has no viewer until one is published', function () {
    expect(getPdfViewer()).to.be.null
  })

  it('returns the published viewer, and nothing once it is cleared', function () {
    const bridge = { wrapper: {}, buildId: 'b-1', editorId: 'e-1' } as never
    publishPdfViewer(bridge)
    expect(getPdfViewer()).to.equal(bridge)
    publishPdfViewer(null)
    expect(getPdfViewer()).to.be.null
  })

  it('tells subscribers when the viewer changes', function () {
    const listener = sinon.spy()
    const unsubscribe = subscribePdfViewer(listener)
    publishPdfViewer({ wrapper: {}, buildId: null, editorId: null } as never)
    publishPdfViewer(null)
    expect(listener.callCount).to.equal(2)
    unsubscribe()
  })

  it('stops telling a subscriber once it has unsubscribed', function () {
    const listener = sinon.spy()
    const unsubscribe = subscribePdfViewer(listener)
    unsubscribe()
    publishPdfViewer({ wrapper: {}, buildId: null, editorId: null } as never)
    expect(listener.callCount).to.equal(0)
  })
})
