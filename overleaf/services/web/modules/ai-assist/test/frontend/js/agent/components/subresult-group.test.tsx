import { expect } from 'chai'
import sinon from 'sinon'
import { fireEvent, render, screen } from '@testing-library/react'
import {
  SubresultGroup,
  formatSubresultsSummary,
} from '../../../../../frontend/js/features/ai-assist/components/agent/subresult-group'
import { partitionBlocks } from '../../../../../frontend/js/features/ai-assist/components/agent/agent-message'

describe('partitionBlocks', function () {
  it('groups continuous thinking and tool actions together until text', function () {
    const blocks = [
      { type: 'thinking' as const, thinking: 'T1', elapsedMs: 1000 },
      {
        type: 'tool_call' as const,
        call: { id: '1', name: 'list_files', args: {} },
      },
      {
        type: 'tool_call' as const,
        call: { id: '2', name: 'read_file', args: { path: 'main.tex' } },
      },
      { type: 'text' as const, text: 'Here is the response' },
    ]

    const segments = partitionBlocks(blocks)
    expect(segments).to.have.length(2)
    expect(segments[0].type).to.equal('subresults')
    expect((segments[0] as any).items).to.have.length(3)
    expect((segments[0] as any).items[0].type).to.equal('thinking')
    expect((segments[0] as any).items[1].type).to.equal('tool_call')
    expect((segments[0] as any).items[2].type).to.equal('tool_call')
    expect(segments[1].type).to.equal('text')
  })

  it('splits into new subresults segment when tools follow text', function () {
    const blocks = [
      {
        type: 'tool_call' as const,
        call: { id: '1', name: 'list_files', args: {} },
      },
      { type: 'text' as const, text: 'Intermediate text' },
      {
        type: 'tool_call' as const,
        call: { id: '2', name: 'edit_file', args: { path: 'main.tex' } },
      },
      { type: 'text' as const, text: 'Final text' },
    ]

    const segments = partitionBlocks(blocks)
    expect(segments).to.have.length(4)
    expect(segments[0].type).to.equal('subresults')
    expect(segments[1].type).to.equal('text')
    expect(segments[2].type).to.equal('subresults')
    expect(segments[3].type).to.equal('text')
  })
})

describe('formatSubresultsSummary', function () {
  const fakeT = (_key: string, opts?: any) =>
    typeof opts === 'string' ? opts : opts?.defaultValue || _key

  it('summarizes multiple tool actions', function () {
    const items: any[] = [
      { type: 'tool_call', call: { name: 'read_file', args: { path: 'main.tex' } } },
      { type: 'tool_call', call: { name: 'list_references', args: {} } },
    ]

    const { title } = formatSubresultsSummary(items, false, fakeT)
    expect(title).to.include('Read 1 file')
    expect(title.toLowerCase()).to.include('checked references')
  })

  it('summarizes a thinking-only live group as nothing at all', function () {
    // The activity line tallies completed actions. A group that has only
    // thought so far has nothing to tally, and saying "Thinking…" here would
    // duplicate the separate status line that already reports the run is live.
    const items: any[] = [{ type: 'thinking', thinking: 'thinking' }]
    const { title } = formatSubresultsSummary(items, true, fakeT)
    expect(title).to.equal('')
  })

  it('summarizes settings tools in formatSubresultsSummary', function () {
    const items: any[] = [
      { type: 'tool_call', call: { name: 'get_project_settings', args: {} } },
      { type: 'tool_call', call: { name: 'configure_editor_settings', args: {} } },
    ]

    const { title } = formatSubresultsSummary(items, false, fakeT)
    expect(title.toLowerCase()).to.include('configured settings')
    expect(title.toLowerCase()).to.include('checked settings')
  })

  it('summarizes multiple configured settings and checked settings with counts', function () {
    const items: any[] = [
      { type: 'tool_call', call: { name: 'configure_project_settings', args: {} } },
      { type: 'tool_call', call: { name: 'configure_appearance_settings', args: {} } },
    ]

    const { title } = formatSubresultsSummary(items, false, fakeT)
    expect(title.toLowerCase()).to.include('configured settings (2)')
  })

  it('aggregates line diff stats across edit_file and create_file calls', function () {
    const items: any[] = [
      {
        type: 'tool_call',
        call: {
          name: 'edit_file',
          args: { path: 'a.tex', oldText: 'x', newText: 'x\ny' },
          result: { status: 'applied' },
        },
      },
      {
        type: 'tool_call',
        call: {
          name: 'create_file',
          args: { path: 'b.tex', content: 'p\nq' },
          result: { status: 'applied' },
        },
      },
    ]

    const { diffStats } = formatSubresultsSummary(items, false, fakeT)
    expect(diffStats).to.deep.equal({ added: 3, removed: 0 })
  })

  it('has no diff stats when no calls wrote to a file', function () {
    const items: any[] = [
      { type: 'tool_call', call: { name: 'read_file', args: { path: 'a.tex' } } },
    ]
    const { diffStats } = formatSubresultsSummary(items, false, fakeT)
    expect(diffStats).to.equal(null)
  })

  it('summarizes rejected edits as rejected rather than edited', function () {
    const items: any[] = [
      {
        type: 'tool_call',
        call: {
          name: 'edit_file',
          args: { path: 'main.tex', oldText: 'a', newText: 'b' },
          result: { status: 'rejected' },
        },
      },
    ]
    const { title, diffStats } = formatSubresultsSummary(items, false, fakeT)
    expect(title.toLowerCase()).to.include('1 edit rejected')
    expect(title.toLowerCase()).to.not.include('edited 1 file')
    expect(diffStats).to.equal(null)
  })

  it('summarizes both applied and rejected edits when present', function () {
    const items: any[] = [
      {
        type: 'tool_call',
        call: {
          name: 'edit_file',
          args: { path: 'main.tex', oldText: 'a', newText: 'b' },
          result: { status: 'applied' },
        },
      },
      {
        type: 'tool_call',
        call: {
          name: 'edit_file',
          args: { path: 'other.tex', oldText: 'c', newText: 'd' },
          result: { status: 'rejected' },
        },
      },
    ]
    const { title } = formatSubresultsSummary(items, false, fakeT)
    expect(title.toLowerCase()).to.include('edited 1 file')
    expect(title.toLowerCase()).to.include('1 edit rejected')
  })
})

describe('SubresultGroup Component', function () {
  it('renders summary header and toggles dropdown on click', function () {
    const items: any[] = [
      {
        type: 'tool_call',
        call: {
          id: 'c1',
          name: 'read_file',
          args: { path: 'main.tex' },
          result: { content: 'doc' },
        },
      },
    ]

    render(
      <SubresultGroup
        items={items}
        isLive={false}
        onDecision={sinon.stub()}
      />
    )

    const headerBtn = screen.getByRole('button')
    expect(headerBtn.textContent).to.include('Read 1 file')

    // Initially collapsed when isLive is false
    expect(screen.queryByText('main.tex')).to.equal(null)

    // Click to expand
    fireEvent.click(headerBtn)
    expect(screen.getByText('main.tex')).to.exist
  })

  it('shows the aggregated +/- diff badge in the group header', function () {
    const items: any[] = [
      {
        type: 'tool_call',
        call: {
          id: 'c1',
          name: 'edit_file',
          args: { path: 'main.tex', oldText: 'a', newText: 'a\nb\nc' },
          result: { status: 'applied' },
        },
      },
      {
        type: 'tool_call',
        call: {
          id: 'c2',
          name: 'create_file',
          args: { path: 'new.tex', content: 'x\ny' },
          result: { status: 'applied' },
        },
      },
    ]

    render(
      <SubresultGroup items={items} isLive={false} onDecision={sinon.stub()} />
    )

    const headerBtn = screen.getByRole('button')
    expect(headerBtn.textContent).to.include('+4')
  })

  it('is folded by default while generating (isLive = true)', function () {
    const items: any[] = [
      {
        type: 'tool_call',
        call: {
          id: 'c1',
          name: 'read_file',
          args: { path: 'main.tex' },
          result: { content: 'doc' },
        },
      },
      {
        type: 'thinking',
        thinking: 'Working on next step...',
      },
    ]

    render(
      <SubresultGroup items={items} isLive={true} onDecision={sinon.stub()} />
    )

    // Initially folded even though isLive is true
    expect(screen.queryByText('main.tex')).to.equal(null)
    expect(screen.queryByText('Working on next step...')).to.equal(null)
  })

  it('unfolds by default when there is a pending approval', function () {
    const items: any[] = [
      {
        type: 'tool_call',
        call: {
          id: 'c-edit',
          name: 'edit_file',
          args: { path: 'main.tex', oldText: 'a', newText: 'b' },
        },
      },
    ]

    render(
      <SubresultGroup
        items={items}
        isLive={false}
        pendingApprovalId="c-edit"
        onDecision={sinon.stub()}
      />
    )

    // Shows the approval card directly
    expect(screen.getByText('main.tex')).to.exist
    expect(screen.getByRole('button', { name: /accept/i })).to.exist
  })

  it('leaves past tool activities folded when there is a pending approval', function () {
    const items: any[] = [
      {
        type: 'tool_call',
        call: { id: 'c-read', name: 'read_file', args: { path: 'chapter1.tex' }, result: { content: 'hello' } },
      },
      {
        type: 'tool_call',
        call: { id: 'c-edit', name: 'edit_file', args: { path: 'main.tex', oldText: 'a', newText: 'b' } },
      },
    ]

    render(
      <SubresultGroup
        items={items}
        isLive={false}
        pendingApprovalId="c-edit"
        onDecision={sinon.stub()}
      />
    )

    // Header says Read 1 file and is folded (chapter1.tex not visible)
    expect(screen.getByText('Read 1 file')).to.exist
    expect(screen.queryByText('chapter1.tex')).to.equal(null)

    // But the approval card for main.tex is visible directly
    expect(screen.getByText('main.tex')).to.exist
    expect(screen.getByRole('button', { name: /accept/i })).to.exist
  })

  it('keeps activity state unfolded when new activity triggers or items change', function () {
    const initialItems: any[] = [
      {
        type: 'tool_call',
        call: {
          id: 'c1',
          name: 'read_file',
          args: { path: 'main.tex' },
          result: { content: 'doc' },
        },
      },
    ]

    const { container, rerender } = render(
      <SubresultGroup
        groupId="group-test-1"
        items={initialItems}
        isLive={true}
        onDecision={sinon.stub()}
      />
    )

    const headerBtn = screen.getByRole('button')
    expect(headerBtn.getAttribute('aria-expanded')).to.equal('false')

    // User explicitly unfolds the activity line
    fireEvent.click(headerBtn)
    expect(headerBtn.getAttribute('aria-expanded')).to.equal('true')
    expect(screen.getByText('main.tex')).to.exist

    // AI triggers a new activity (second tool call added while live)
    const updatedItems: any[] = [
      ...initialItems,
      {
        type: 'tool_call',
        call: {
          id: 'c2',
          name: 'search_project',
          args: { query: 'theorem' },
          result: { matches: [] },
        },
      },
    ]

    rerender(
      <SubresultGroup
        groupId="group-test-1"
        items={updatedItems}
        isLive={true}
        onDecision={sinon.stub()}
      />
    )

    // MUST remain unfolded — AI actions never collapse user-unfolded state
    const updatedHeader = container.querySelector('.ai-assist-subresult-group-header')
    expect(updatedHeader?.getAttribute('aria-expanded')).to.equal('true')
    expect(screen.getByText('main.tex')).to.exist
  })

  it('preserves user fold state when explicitly folded by user', function () {
    const items: any[] = [
      {
        type: 'tool_call',
        call: {
          id: 'c1',
          name: 'read_file',
          args: { path: 'main.tex' },
          result: { content: 'doc' },
        },
      },
    ]

    const { container, rerender } = render(
      <SubresultGroup
        groupId="group-test-2"
        items={items}
        isLive={true}
        onDecision={sinon.stub()}
      />
    )

    const headerBtn = container.querySelector('.ai-assist-subresult-group-header')!

    // Unfold then fold again
    fireEvent.click(headerBtn)
    expect(headerBtn.getAttribute('aria-expanded')).to.equal('true')

    fireEvent.click(headerBtn)
    expect(headerBtn.getAttribute('aria-expanded')).to.equal('false')

    // Remount / new activity arriving
    const updatedItems: any[] = [
      ...items,
      {
        type: 'tool_call',
        call: {
          id: 'c2',
          name: 'search_project',
          args: { query: 'theorem' },
          result: { matches: [] },
        },
      },
    ]

    rerender(
      <SubresultGroup
        groupId="group-test-2"
        items={updatedItems}
        isLive={true}
        onDecision={sinon.stub()}
      />
    )

    // MUST remain folded
    const updatedHeader = container.querySelector('.ai-assist-subresult-group-header')
    expect(updatedHeader?.getAttribute('aria-expanded')).to.equal('false')
  })
})
