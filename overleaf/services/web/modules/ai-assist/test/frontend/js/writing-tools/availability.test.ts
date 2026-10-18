import { expect } from 'chai'
import { isWritingToolsAvailable } from '../../../../frontend/js/features/ai-assist/writing-tools/availability'

describe('isWritingToolsAvailable', function () {
  beforeEach(function () {
    window.metaAttributesCache = new Map()
  })

  afterEach(function () {
    window.metaAttributesCache = new Map()
  })

  it('is on when the instance enables AI', function () {
    window.metaAttributesCache.set('ol-aiAssistEnabled', true)

    expect(isWritingToolsAvailable()).to.equal(true)
  })

  it('is off when AI is disabled, so no editor background work starts', function () {
    // An explicit false: a <meta> tag left in the document must not turn it on
    window.metaAttributesCache.set('ol-aiAssistEnabled', false)

    expect(isWritingToolsAvailable()).to.equal(false)
  })

  it('is off when only writefull is enabled', function () {
    window.metaAttributesCache.set('ol-aiAssistEnabled', false)
    window.metaAttributesCache.set('ol-writefullEnabled', true)

    expect(isWritingToolsAvailable()).to.equal(false)
  })

  it('is off when the user has turned AI off', function () {
    window.metaAttributesCache.set('ol-aiAssistEnabled', true)
    window.metaAttributesCache.set('ol-showAiFeatures', false)

    expect(isWritingToolsAvailable()).to.equal(false)
  })
})
