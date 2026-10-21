import { expect } from 'chai'
import sinon from 'sinon'
import { useRef } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { ContextUsagePopover } from '../../../../../frontend/js/features/ai-assist/components/agent/context-usage-popover'
import type {
  ContextBreakdown,
  ContextUsageSnapshot,
} from '../../../../../frontend/js/features/ai-assist/agent/context/context-usage-types'

function snapshot(
  overrides: Partial<ContextUsageSnapshot> = {}
): ContextUsageSnapshot {
  return {
    usedTokens: 261000,
    contextWindow: 1000000,
    maxOutputTokens: 8192,
    budget: 988808,
    thresholds: {
      effective: 991808,
      autoCompactAt: 978808,
      warnAt: 971808,
      blockAt: 988808,
    },
    percentUsed: 26.1,
    percentOfBudget: 29,
    state: 'ok',
    exact: true,
    categories: [
      { id: 'messages', tokens: 90000, percent: 9 },
      { id: 'systemTools', tokens: 20000, percent: 2 },
      { id: 'mcpTools', tokens: 1200, percent: 0.12 },
      { id: 'skills', tokens: 3000, percent: 0.3 },
      { id: 'systemPrompt', tokens: 4000, percent: 0.4 },
      { id: 'memoryFiles', tokens: 0, percent: 0 },
      { id: 'mcpInstructions', tokens: 0, percent: 0 },
      { id: 'sinceLastUpdate', tokens: 1000, percent: 0.1 },
      { id: 'reserved', tokens: 20000, percent: 2 },
      { id: 'free', tokens: 739000, percent: 73.9 },
    ],
    deferred: [],
    empty: false,
    ...overrides,
  }
}

const BREAKDOWN: ContextBreakdown = {
  systemPrompt: 4000,
  projectInstructions: 0,
  connectorInstructions: 0,
  builtinTools: 0,
  webTools: 0,
  connectorTools: 1200,
  connectorToolDetails: [
    { name: 'search_docs', server: 'docs', tokens: 700 },
    { name: 'list_items', server: 'tracker', tokens: 500 },
  ],
  userMessages: 3000,
  projectContext: 0,
  assistantMessages: 20000,
  toolResults: 90000,
  images: 0,
  elidedMessages: 0,
  droppedMessages: 0,
  contextWindow: 1000000,
  maxOutputTokens: 8192,
  budget: 900000,
}

function Harness({
  show = true,
  onHide = sinon.stub(),
  value,
}: {
  show?: boolean
  onHide?: () => void
  value: ContextUsageSnapshot
}) {
  const ref = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button ref={ref} type="button" className="meter-anchor">
        meter
      </button>
      <ContextUsagePopover
        show={show}
        onHide={onHide}
        targetRef={ref}
        snapshot={value}
      />
    </>
  )
}

function rowNames(): string[] {
  return Array.from(
    document.querySelectorAll('.ai-assist-context-popover-rows:not(.is-deferred) .ai-assist-context-popover-name')
  ).map(el => el.textContent ?? '')
}

describe('ContextUsagePopover', function () {
  beforeEach(function () {
    window.localStorage.removeItem('ai-assist:context-panel-open')
  })

  it('renders nothing while hidden', function () {
    render(<Harness show={false} value={snapshot()} />)
    expect(screen.queryByRole('dialog')).to.equal(null)
  })

  it('is a labelled dialog titled Context with the used share and tokens', function () {
    render(<Harness value={snapshot()} />)
    expect(screen.getByRole('dialog', { name: 'Context usage' })).to.exist
    expect(screen.getByText('Context')).to.exist
    expect(screen.getByText('26% used')).to.exist
    expect(screen.getByText('261k / 1M')).to.exist
  })

  it('lists the rows largest first with Claude Code labels, hiding zero rows but the buffer and free space', function () {
    render(<Harness value={snapshot()} />)
    expect(rowNames()).to.deep.equal([
      'Messages',
      'System tools',
      'System prompt',
      'Skills',
      'MCP tools',
      'Since last update',
      'Autocompact buffer',
      'Free space',
    ])
  })

  it('shows the zero reserve and free rows even when they are empty', function () {
    render(
      <Harness
        value={snapshot({
          categories: snapshot().categories.map(c =>
            c.id === 'reserved' || c.id === 'free' ? { ...c, tokens: 0 } : c
          ),
        })}
      />
    )
    expect(rowNames()).to.include('Autocompact buffer')
    expect(rowNames()).to.include('Free space')
  })

  it('orders content rows by size and keeps the buffer and free space last', function () {
    render(
      <Harness
        value={snapshot({
          categories: snapshot().categories.map(c =>
            c.id === 'messages' ? { ...c, tokens: 1 } : c
          ),
        })}
      />
    )
    const names = rowNames()
    expect(names[0]).to.equal('System tools')
    expect(names.slice(-3)).to.deep.equal([
      'Messages',
      'Autocompact buffer',
      'Free space',
    ])
  })

  it('colours the four largest rows by rank and greys the rest', function () {
    render(<Harness value={snapshot()} />)
    const swatch = (name: string) =>
      (screen.getByText(name).closest('li') as HTMLElement).querySelector(
        '.ai-assist-context-popover-swatch'
      ) as HTMLElement
    expect(swatch('Messages').classList.contains('ai-assist-context-cat-rank-1')).to.equal(true)
    expect(swatch('Skills').classList.contains('ai-assist-context-cat-rank-4')).to.equal(true)
    expect(swatch('MCP tools').classList.contains('ai-assist-context-cat-other')).to.equal(true)
    expect(swatch('Since last update').classList.contains('ai-assist-context-cat-other')).to.equal(true)
    expect(swatch('Autocompact buffer').classList.contains('ai-assist-context-cat-reserved')).to.equal(true)
  })

  it('renders name, tokens and percent as separate column elements in each row', function () {
    render(<Harness value={snapshot()} />)
    const row = screen.getByText('Messages').closest('li') as HTMLElement
    expect(row.querySelector('.ai-assist-context-popover-name')?.textContent).to.equal('Messages')
    expect(row.querySelector('.ai-assist-context-popover-tokens')?.textContent).to.equal('90k')
    expect(row.querySelector('.ai-assist-context-popover-percent')?.textContent).to.equal('9.0%')
    expect(row.querySelector('.ai-assist-context-popover-swatch')).to.exist
  })

  it('draws one bar segment per non-free row with tokens, none for free space', function () {
    render(<Harness value={snapshot()} />)
    const segments = document.querySelectorAll('.ai-assist-context-popover-bar > span')
    // messages, system tools, mcp tools, skills, system prompt, since last update, buffer
    expect(segments.length).to.equal(7)
    expect((segments[0] as HTMLElement).style.width).to.equal('9%')
  })

  it('shows deferred MCP tools muted with their tokens and a dash for the share', function () {
    render(
      <Harness
        value={snapshot({
          deferred: [{ id: 'deferredConnectorTools', tokens: 5000, count: 12 }],
        })}
      />
    )
    const deferred = document.querySelector('.ai-assist-context-popover-rows.is-deferred') as HTMLElement
    expect(deferred).to.exist
    expect(deferred.textContent).to.contain('MCP tools (deferred)')
    expect(deferred.querySelector('.ai-assist-context-popover-tokens')?.textContent).to.equal('5k')
    expect(deferred.querySelector('.ai-assist-context-popover-percent')?.textContent).to.equal('—')
  })

  it('omits the deferred row when there is none', function () {
    render(<Harness value={snapshot()} />)
    expect(document.querySelector('.is-deferred')).to.equal(null)
  })

  it('puts a dotted tooltip on Skills and Memory files only', function () {
    render(
      <Harness
        value={snapshot({
          categories: snapshot().categories.map(c =>
            c.id === 'memoryFiles' ? { ...c, tokens: 500, percent: 0.05 } : c
          ),
        })}
      />
    )
    const hints = Array.from(document.querySelectorAll('.ai-assist-context-popover-name.is-hint'))
    expect(hints.map(el => el.textContent)).to.deep.equal(['Skills', 'Memory files'])
  })

  it('folds everything under the header, leaving the percent and a mini bar', function () {
    render(<Harness value={snapshot({ breakdown: BREAKDOWN })} />)
    const header = screen.getByRole('button', { name: /^Context/ })
    expect(header.getAttribute('aria-expanded')).to.equal('true')
    expect(document.querySelector('.ai-assist-context-popover-folded')).to.equal(null)
    fireEvent.click(header)
    expect(header.getAttribute('aria-expanded')).to.equal('false')
    expect(rowNames()).to.deep.equal([])
    expect(screen.queryByText(/used$/)).to.equal(null)
    expect(screen.queryByRole('button', { name: /MCP tools/ })).to.equal(null)
    expect(
      document.querySelector('.ai-assist-context-popover-folded-percent')
        ?.textContent
    ).to.equal('26%')
    expect(document.querySelector('.ai-assist-context-popover-mini-bar')).to.exist
    fireEvent.click(header)
    expect(rowNames()).to.not.deep.equal([])
  })

  it('remembers the fold for the next time it opens', function () {
    const { unmount } = render(<Harness value={snapshot()} />)
    fireEvent.click(screen.getByRole('button', { name: /^Context/ }))
    unmount()
    render(<Harness value={snapshot()} />)
    expect(
      screen.getByRole('button', { name: /^Context/ }).getAttribute('aria-expanded')
    ).to.equal('false')
  })

  it('keeps the MCP tools list collapsed until its header is opened', function () {
    render(<Harness value={snapshot({ breakdown: BREAKDOWN })} />)
    expect(screen.queryByText('docs · search_docs')).to.equal(null)
    const toggle = screen.getByRole('button', { name: /MCP tools/ })
    expect(toggle.getAttribute('aria-expanded')).to.equal('false')
    fireEvent.click(toggle)
    expect(screen.getByText('docs · search_docs')).to.exist
    fireEvent.click(toggle)
    expect(screen.queryByText('docs · search_docs')).to.equal(null)
  })

  it('aligns the MCP title with the row names and its count with the token column', function () {
    render(<Harness value={snapshot({ breakdown: BREAKDOWN })} />)
    const toggle = screen.getByRole('button', { name: /MCP tools/ })
    expect(toggle.querySelector('.ai-assist-context-popover-section-title')?.textContent).to.equal('MCP tools')
    expect(toggle.querySelector('.ai-assist-context-popover-section-count')?.textContent).to.equal('2')
    fireEvent.click(toggle)
    const detail = screen.getByText('docs · search_docs').closest('li') as HTMLElement
    expect(detail.querySelector('.ai-assist-context-popover-detail-name')).to.exist
    expect(detail.querySelector('.ai-assist-context-popover-tokens')?.textContent).to.equal('700')
  })

  it('puts the auto-compact threshold and the count basis in the summary tooltip', function () {
    const summary = () =>
      document.querySelector('.ai-assist-context-popover-summary') as HTMLElement
    const { unmount } = render(<Harness value={snapshot()} />)
    expect(summary().title).to.contain('Auto-compacts at 978.8k (97.9%)')
    expect(summary().title).to.contain("provider's reported usage")
    expect(screen.queryByText(/^Auto-compacts at/)).to.equal(null)
    unmount()
    render(<Harness value={snapshot({ exact: false })} />)
    expect(summary().title).to.contain('Estimated from the text')
  })

  it('notes trimming only when messages were elided or dropped', function () {
    const { unmount } = render(<Harness value={snapshot({ breakdown: BREAKDOWN })} />)
    expect(document.querySelector('.ai-assist-context-popover-footer')).to.equal(null)
    unmount()
    render(
      <Harness
        value={snapshot({
          breakdown: { ...BREAKDOWN, elidedMessages: 3, droppedMessages: 1 },
        })}
      />
    )
    expect(screen.getByText(/3 older messages were shortened and 1 dropped/)).to.exist
  })

  it('closes on Escape and returns focus to the meter', function () {
    const onHide = sinon.stub()
    render(<Harness onHide={onHide} value={snapshot()} />)
    const dialog = screen.getByRole('dialog')
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onHide.called).to.equal(true)
    expect(document.activeElement).to.equal(screen.getByRole('button', { name: 'meter' }))
  })

  it('draws no divider lines anywhere in the panel', function () {
    render(
      <Harness
        value={snapshot({
          breakdown: BREAKDOWN,
          exact: false,
          deferred: [{ id: 'deferredConnectorTools', tokens: 5000, count: 12 }],
        })}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /MCP tools/ }))
    const dialog = screen.getByRole('dialog')
    expect(dialog.querySelectorAll('hr').length).to.equal(0)
    expect(dialog.querySelectorAll('[class*="divider"], [class*="separator"]').length).to.equal(0)
    expect(dialog.querySelectorAll('[style*="border"]').length).to.equal(0)
  })

  it('lists sent MCP tools before deferred ones, the deferred muted and truncated with a title', function () {
    render(
      <Harness
        value={snapshot({
          breakdown: {
            ...BREAKDOWN,
            connectorToolDetails: [
              { name: 'list_items', server: 'tracker', tokens: 500, deferred: true },
              { name: 'search_docs', server: 'docs', tokens: 700 },
            ],
          },
        })}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /MCP tools/ }))
    const rows = Array.from(
      document.querySelectorAll('.ai-assist-context-popover-list > li')
    ) as HTMLElement[]
    expect(rows.map(row => row.textContent)).to.deep.equal([
      'docs · search_docs700',
      'tracker · list_items500',
    ])
    expect(rows[0].classList.contains('is-deferred')).to.equal(false)
    expect(rows[1].classList.contains('is-deferred')).to.equal(true)
    const name = rows[1].querySelector('.ai-assist-context-popover-detail-name') as HTMLElement
    expect(name.getAttribute('title')).to.equal('tracker · list_items')
  })

  it('hides the MCP section when the newest breakdown lists no tools', function () {
    render(
      <Harness
        value={snapshot({
          breakdown: { ...BREAKDOWN, connectorToolDetails: [] },
        })}
      />
    )
    expect(screen.queryByRole('button', { name: /MCP tools/ })).to.equal(null)
  })

  it('fills the folded mini bar to the share used, never thinner than 2px', function () {
    window.localStorage.setItem('ai-assist:context-panel-open', 'false')
    render(<Harness value={snapshot()} />)
    const fill = document.querySelector('.ai-assist-context-popover-mini-bar > span') as HTMLElement
    expect(fill.style.getPropertyValue('--ai-ctx-fill')).to.equal('26.1%')
  })

  it('floats with the panel-tracking engine, like the other popovers in the composer', function () {
    render(<Harness value={snapshot()} />)
    const dialog = screen.getByRole('dialog') as HTMLElement
    // floating-ui with autoUpdate: fixed positioning, repositioned by the
    // engine as the anchor (and the panel around it) resizes
    expect(dialog.style.position).to.equal('fixed')
    expect(dialog.style.transform).to.not.equal('')
  })

  it('stays open on a mousedown that starts on the meter itself', function () {
    // the meter's own click toggles the panel, so root-close must not eat it
    render(<Harness value={snapshot()} />)
    const meter = document.querySelector('.meter-anchor') as HTMLElement
    fireEvent.mouseDown(meter)
    expect(screen.getByRole('dialog')).to.exist
  })

  it('closes on a mousedown outside the box and the meter', function () {
    const onHide = sinon.stub()
    render(<Harness onHide={onHide} value={snapshot()} />)
    fireEvent.mouseDown(document.body)
    expect(onHide.called).to.equal(true)
  })
})
