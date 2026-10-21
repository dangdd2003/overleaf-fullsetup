import { expect } from 'chai'
import {
  horizontalShift,
  verticalRoom,
  verticalShift,
} from '../../../../frontend/js/features/ai-assist/floating/editor-card'

describe('floating card: horizontal placement', function () {
  const bounds = { left: 0, right: 1000 }

  it('leaves a card that fits where it is', function () {
    expect(horizontalShift(100, 200, bounds)).to.equal(0)
  })

  it('moves a card that runs past the right edge back inside the margin', function () {
    // 900 + 200 is past 1000 - 16, so the right edge lands on 984
    expect(horizontalShift(900, 200, bounds)).to.equal(-116)
  })

  it('moves a card that runs past the left edge in to the margin', function () {
    expect(horizontalShift(-50, 100, bounds)).to.equal(66)
  })

  it('keeps the left edge in view when the card is wider than the pane', function () {
    expect(horizontalShift(100, 1200, bounds)).to.equal(-84)
  })

  it('respects a custom margin', function () {
    expect(horizontalShift(900, 200, bounds, 0)).to.equal(-100)
  })
})

describe('floating card: vertical room', function () {
  const space = { left: 0, right: 1000, top: 0, bottom: 500 }
  const anchor = (top: number, bottom: number) => ({
    left: 0,
    right: 0,
    top,
    bottom,
  })

  it('measures the room below the anchor, less the gap and margin', function () {
    // 500 - 120 = 380, less the 6px gap and 8px margin
    expect(verticalRoom(anchor(100, 120), space, 'bottom')).to.equal(366)
  })

  it('measures the room above the anchor, less the gap and margin', function () {
    // 100 - 0 = 100, less the 6px gap and 8px margin
    expect(verticalRoom(anchor(100, 120), space, 'top')).to.equal(86)
  })

  it('is never negative', function () {
    expect(verticalRoom(anchor(480, 495), space, 'bottom')).to.equal(0)
    expect(verticalRoom(anchor(4, 20), space, 'top')).to.equal(0)
  })

  it('uses the given gap', function () {
    expect(verticalRoom(anchor(100, 120), space, 'bottom', 0, 0)).to.equal(380)
  })
})

describe('floating card: laid over the text', function () {
  const bounds = { top: 0, bottom: 600 }

  it('lifts a card running past the bottom back into view', function () {
    expect(verticalShift(500, 300, bounds)).to.equal(-208)
  })

  it('keeps the top in view when the card is taller than the editor', function () {
    expect(verticalShift(50, 900, bounds)).to.equal(-42)
  })

  it('leaves a card that fits where it is', function () {
    expect(verticalShift(100, 300, bounds)).to.equal(0)
  })
})
