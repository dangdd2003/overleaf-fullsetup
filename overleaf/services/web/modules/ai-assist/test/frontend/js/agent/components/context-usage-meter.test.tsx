import { expect } from 'chai'
import sinon from 'sinon'
import { render, screen, fireEvent } from '@testing-library/react'
import { ContextUsageMeter } from '../../../../../frontend/js/features/ai-assist/components/agent/context-usage-meter'
import type { ContextUsageSnapshot } from '../../../../../frontend/js/features/ai-assist/agent/context/context-usage-types'

function snapshot(
  overrides: Partial<ContextUsageSnapshot> = {}
): ContextUsageSnapshot {
  return {
    usedTokens: 45200,
    contextWindow: 200000,
    maxOutputTokens: 8192,
    budget: 188808,
    thresholds: {
      effective: 191808,
      autoCompactAt: 178808,
      warnAt: 171808,
      blockAt: 188808,
    },
    percentUsed: 22.6,
    percentOfBudget: 26.3,
    state: 'ok',
    exact: true,
    categories: [
      { id: 'systemPrompt', tokens: 4000, percent: 2 },
      { id: 'reserved', tokens: 20000, percent: 10 },
      { id: 'free', tokens: 176000, percent: 88 },
    ],
    deferred: [],
    empty: false,
    ...overrides,
  }
}

function arc(): SVGCircleElement {
  return document.querySelector('.ai-assist-context-meter-arc') as SVGCircleElement
}

describe('ContextUsageMeter', function () {
  it('renders nothing without a snapshot', function () {
    const { container } = render(
      <ContextUsageMeter snapshot={null} onToggle={sinon.stub()} />
    )
    expect(container.firstChild).to.equal(null)
  })

  it('is a labelled button that toggles the popover on click', function () {
    const onToggle = sinon.stub()
    render(<ContextUsageMeter snapshot={snapshot()} onToggle={onToggle} />)
    const button = screen.getByRole('button', { name: 'Context usage' })
    fireEvent.click(button)
    expect(onToggle.calledOnce).to.equal(true)
  })

  it('shows the active state while the popover is open', function () {
    render(<ContextUsageMeter snapshot={snapshot()} open onToggle={sinon.stub()} />)
    const button = screen.getByRole('button', { name: 'Context usage' })
    expect(button.getAttribute('aria-expanded')).to.equal('true')
  })

  it('shows no percentage label while the chat is well within its window', function () {
    render(<ContextUsageMeter snapshot={snapshot()} onToggle={sinon.stub()} />)
    const button = screen.getByRole('button', { name: 'Context usage' })
    expect(button.getAttribute('data-state')).to.equal('ok')
    expect(button.querySelector('.ai-assist-context-meter-label')).to.equal(null)
  })

  it('shows the percentage and the warning colour class from warn up', function () {
    render(
      <ContextUsageMeter
        snapshot={snapshot({ state: 'warn', percentUsed: 75, usedTokens: 150000 })}
        onToggle={sinon.stub()}
      />
    )
    const button = screen.getByRole('button', { name: 'Context usage' })
    expect(button.classList.contains('is-warn')).to.equal(true)
    expect(button.querySelector('.ai-assist-context-meter-label')?.textContent).to.equal('75%')
  })

  it('marks the blocked state for the danger colour', function () {
    render(
      <ContextUsageMeter
        snapshot={snapshot({ state: 'blocked', percentUsed: 99, usedTokens: 198000 })}
        onToggle={sinon.stub()}
      />
    )
    const button = screen.getByRole('button', { name: 'Context usage' })
    expect(button.classList.contains('is-blocked')).to.equal(true)
  })

  it('draws the arc in proportion to the share used', function () {
    render(<ContextUsageMeter snapshot={snapshot()} onToggle={sinon.stub()} />)
    const circumference = 2 * Math.PI * 6.5
    const dash = parseFloat(arc().style.strokeDasharray.split(' ')[0])
    expect(dash).to.be.closeTo((22.6 / 100) * circumference, 0.01)
  })

  it('keeps a visible sliver once anything is used, and none at zero', function () {
    const { unmount } = render(
      <ContextUsageMeter
        snapshot={snapshot({ percentUsed: 0.2, usedTokens: 400 })}
        onToggle={sinon.stub()}
      />
    )
    expect(parseFloat(arc().style.strokeDasharray.split(' ')[0])).to.be.at.least(0.8)
    unmount()
    render(
      <ContextUsageMeter
        snapshot={snapshot({ percentUsed: 0, usedTokens: 0 })}
        onToggle={sinon.stub()}
      />
    )
    expect(parseFloat(arc().style.strokeDasharray.split(' ')[0])).to.equal(0)
  })

  it('clamps the arc to a full ring', function () {
    render(
      <ContextUsageMeter
        snapshot={snapshot({ percentUsed: 130, state: 'blocked' })}
        onToggle={sinon.stub()}
      />
    )
    const circumference = 2 * Math.PI * 6.5
    expect(parseFloat(arc().style.strokeDasharray.split(' ')[0])).to.be.closeTo(circumference, 0.01)
  })
})
