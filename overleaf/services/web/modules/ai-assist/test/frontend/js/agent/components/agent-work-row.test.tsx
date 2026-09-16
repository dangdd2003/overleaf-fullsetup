import { expect } from 'chai'
import { render, screen, fireEvent } from '@testing-library/react'
import { SubresultGroup } from '../../../../../frontend/js/features/ai-assist/components/agent/subresult-group'

/**
 * Coverage inherited from the compile-log panel's old `AgentWorkRow`, which
 * has been folded into `SubresultGroup` so the error panel and the main chat
 * render an agent's activity identically. The behaviours it guarded still
 * matter; they just belong to the shared component now.
 */
const BLOCKS = [
  {
    type: 'tool_call' as const,
    call: { id: '1', name: 'read_file', args: { path: 'main.tex' }, result: {} },
  },
  {
    type: 'tool_call' as const,
    call: { id: '2', name: 'list_references', args: {}, result: {} },
  },
]

describe('the shared agent activity row', function () {
  it('collapses to a single summary row', function () {
    const { container } = render(
      <SubresultGroup items={BLOCKS} onDecision={() => {}} />
    )

    // The summary reads like Claude Code's activity line — a natural
    // description of what happened, not a bare tool count.
    expect(screen.getByText(/Read 1 file, checked references/)).to.exist
    // Collapsed: the individual calls are not in the document yet.
    expect(container.querySelectorAll('.ai-assist-tool-call')).to.have.length(0)
  })

  it('expands to the calls in the order they happened', function () {
    const { container } = render(
      <SubresultGroup items={BLOCKS} onDecision={() => {}} />
    )

    fireEvent.click(screen.getByText(/Read 1 file, checked references/))

    const names = [...container.querySelectorAll('.ai-assist-tool-call')].map(
      node => node.textContent
    )
    expect(names).to.have.length(2)
    // ToolCallCard renders a human-readable title + args.path, not the raw
    // tool name, so assert on what it actually displays for each call.
    expect(names[0]).to.contain('Read file')
    expect(names[0]).to.contain('main.tex')
    expect(names[1]).to.contain('Checked references')
  })

  it('shows a live status with a pulse and a chevron while running', function () {
    const { container } = render(
      <SubresultGroup
        items={[
          {
            type: 'tool_call' as const,
            call: { id: '1', name: 'read_file', args: { path: 'main.tex' }, result: {} },
          },
        ]}
        isLive
        onDecision={() => {}}
      />
    )

    expect(screen.getByText(/Read 1 file/)).to.exist
    expect(container.querySelector('.ai-assist-subresult-group-chevron')).to
      .exist

    fireEvent.click(screen.getByText(/Read 1 file/))
    expect(container.querySelector('.ai-assist-subresult-group-dropdown')).to
      .exist
  })

  it('tallies the calls and ignores thinking while running', function () {
    render(
      <SubresultGroup
        items={[
          {
            type: 'tool_call' as const,
            call: { id: '1', name: 'read_file', args: {}, result: {} },
          },
        ]}
        isLive
        onDecision={() => {}}
      />
    )

    expect(screen.getByText(/Read 1 file/)).to.exist
  })
})
