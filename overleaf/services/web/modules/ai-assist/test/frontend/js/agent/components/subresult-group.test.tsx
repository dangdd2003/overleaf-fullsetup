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
      {
        type: 'tool_call',
        call: { name: 'read_file', args: { path: 'main.tex' } },
      },
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
      {
        type: 'tool_call',
        call: { name: 'configure_editor_settings', args: {} },
      },
    ]

    const { title } = formatSubresultsSummary(items, false, fakeT)
    expect(title.toLowerCase()).to.include('configured settings')
    expect(title.toLowerCase()).to.include('checked settings')
  })

  it('summarizes multiple configured settings and checked settings with counts', function () {
    const items: any[] = [
      {
        type: 'tool_call',
        call: { name: 'configure_project_settings', args: {} },
      },
      {
        type: 'tool_call',
        call: { name: 'configure_appearance_settings', args: {} },
      },
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
      {
        type: 'tool_call',
        call: { name: 'read_file', args: { path: 'a.tex' } },
      },
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

  it('summarizes cancelled or unfinished edits as cancelled rather than edited', function () {
    const items: any[] = [
      {
        type: 'tool_call',
        call: {
          name: 'read_file',
          args: { path: 'main.tex' },
          result: { lines: ['a'] },
        },
      },
      {
        type: 'tool_call',
        call: {
          name: 'edit_file',
          args: { path: 'main.tex', oldText: 'a', newText: 'b' },
          result: { status: 'stopped' },
        },
      },
    ]
    const { title, diffStats } = formatSubresultsSummary(items, false, fakeT)
    expect(title.toLowerCase()).to.include('read 1 file')
    expect(title.toLowerCase()).to.include('1 edit cancelled')
    expect(title.toLowerCase()).to.not.include('edited 1 file')
    expect(diffStats).to.equal(null)
  })

  it('treats in-flight edits without a result as cancelled after run finished', function () {
    const items: any[] = [
      {
        type: 'tool_call',
        call: {
          name: 'edit_file',
          args: { path: 'main.tex', oldText: 'a', newText: 'b' },
        },
      },
    ]
    const { title, diffStats } = formatSubresultsSummary(items, false, fakeT)
    expect(title.toLowerCase()).to.include('1 edit cancelled')
    expect(title.toLowerCase()).to.not.include('edited 1 file')
    expect(diffStats).to.equal(null)
  })

  it('summarizes cancelled file creations as cancelled rather than created', function () {
    const items: any[] = [
      {
        type: 'tool_call',
        call: {
          name: 'create_file',
          args: { path: 'new.tex', content: 'abc' },
          result: { status: 'stopped' },
        },
      },
    ]
    const { title, diffStats } = formatSubresultsSummary(items, false, fakeT)
    expect(title.toLowerCase()).to.include('1 file creation cancelled')
    expect(title.toLowerCase()).to.not.include('created 1 file')
    expect(diffStats).to.equal(null)
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

    const { container } = render(
      <SubresultGroup items={items} isLive={false} onDecision={sinon.stub()} />
    )

    const headerBtn = screen.getByRole('button')
    expect(headerBtn.textContent).to.include('Read 1 file')
    const chevron = container.querySelector(
      '.ai-assist-subresult-group-chevron'
    ) as SVGElement
    expect(chevron.classList.contains('is-expanded')).to.be.false

    // Initially collapsed when isLive is false
    expect(screen.queryByText('main.tex')).to.equal(null)

    // Click to expand
    fireEvent.click(headerBtn)
    expect(screen.getByText('main.tex')).to.exist
    expect(chevron.classList.contains('is-expanded')).to.be.true
    expect(container.querySelector('.ai-assist-subresult-group-dropdown')).to
      .exist

    // Click to collapse
    fireEvent.click(headerBtn)
    expect(chevron.classList.contains('is-expanded')).to.be.false
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
        call: {
          id: 'c-read',
          name: 'read_file',
          args: { path: 'chapter1.tex' },
          result: { content: 'hello' },
        },
      },
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
    const updatedHeader = container.querySelector(
      '.ai-assist-subresult-group-header'
    )
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

    const headerBtn = container.querySelector(
      '.ai-assist-subresult-group-header'
    )!

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
    const updatedHeader = container.querySelector(
      '.ai-assist-subresult-group-header'
    )
    expect(updatedHeader?.getAttribute('aria-expanded')).to.equal('false')
  })

  it('appends 2nd activity next to 1st activity without folding activity bar or sub activity lines', function () {
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
        groupId="group-append-test"
        items={initialItems}
        isLive={true}
        onDecision={sinon.stub()}
      />
    )

    // User unfolds the activity bar with only 1 activity
    const headerBtn = container.querySelector(
      '.ai-assist-subresult-group-header'
    )!
    fireEvent.click(headerBtn)
    expect(headerBtn.getAttribute('aria-expanded')).to.equal('true')

    // Inside dropdown: 1st activity line is present and folded by default
    const subItemsBefore = container.querySelectorAll('.ai-assist-subresult-item')
    expect(subItemsBefore).to.have.length(1)
    const firstSubToggle = subItemsBefore[0].querySelector('.ai-assist-tool-call-summary')!
    expect(firstSubToggle.getAttribute('aria-expanded')).to.equal('false')

    // User unfolds the 1st sub-activity line
    fireEvent.click(firstSubToggle)
    expect(firstSubToggle.getAttribute('aria-expanded')).to.equal('true')

    // 2nd activity is added in
    const updatedItems: any[] = [
      ...initialItems,
      {
        type: 'tool_call',
        call: {
          id: 'c2',
          name: 'edit_file',
          args: { path: 'main.tex', oldText: 'a', newText: 'b' },
          result: { status: 'applied' },
        },
      },
    ]

    rerender(
      <SubresultGroup
        groupId="group-append-test"
        items={updatedItems}
        isLive={true}
        onDecision={sinon.stub()}
      />
    )

    // 1. The activity bar MUST STAY unfolded
    const updatedHeader = container.querySelector(
      '.ai-assist-subresult-group-header'
    )!
    expect(updatedHeader.getAttribute('aria-expanded')).to.equal('true')

    // 2. 2nd activity appends next to 1st activity in dropdown
    const subItemsAfter = container.querySelectorAll('.ai-assist-subresult-item')
    expect(subItemsAfter).to.have.length(2)

    // 3. 1st activity MUST NOT fold — user unfolded it, so it remains unfolded
    const firstSubToggleAfter = subItemsAfter[0].querySelector('.ai-assist-tool-call-summary')!
    expect(firstSubToggleAfter.getAttribute('aria-expanded')).to.equal('true')

    // 4. 2nd activity starts folded (static), user choice to unfold
    const secondSubToggle = subItemsAfter[1].querySelector('.ai-assist-tool-call-summary')!
    expect(secondSubToggle.getAttribute('aria-expanded')).to.equal('false')
  })

  it('keeps activity bar open when next activity is added in-flight without result', function () {
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
        groupId="group-live-append-test"
        items={initialItems}
        isLive={true}
        onDecision={sinon.stub()}
      />
    )

    // User unfolds the activity bar
    const headerBtn = container.querySelector(
      '.ai-assist-subresult-group-header'
    )!
    fireEvent.click(headerBtn)
    expect(headerBtn.getAttribute('aria-expanded')).to.equal('true')

    // Next activity starts in-flight (no result property yet)
    const inFlightItems: any[] = [
      ...initialItems,
      {
        type: 'tool_call',
        call: {
          id: 'c2',
          name: 'search_project',
          args: { query: 'theorem' },
        },
      },
    ]

    rerender(
      <SubresultGroup
        groupId="group-live-append-test"
        items={inFlightItems}
        isLive={true}
        onDecision={sinon.stub()}
      />
    )

    // Activity bar MUST REMAIN open and rendered without blinking or folding
    const updatedHeader = container.querySelector(
      '.ai-assist-subresult-group-header'
    )!
    expect(updatedHeader).to.exist
    expect(updatedHeader.getAttribute('aria-expanded')).to.equal('true')

    // In-flight call is appended as 2nd item in dropdown
    const subItems = container.querySelectorAll('.ai-assist-subresult-item')
    expect(subItems).to.have.length(2)
  })

  it('inherits entry expansion state across segmented groups so activities never fold when text intervenes', function () {
    const { container: c1 } = render(
      <SubresultGroup
        groupId="entryA-subresults-0"
        items={[
          {
            type: 'tool_call',
            call: { id: 'c1', name: 'read_file', args: {}, result: {} },
          },
        ]}
        isLive={false}
        onDecision={sinon.stub()}
      />
    )

    const btn1 = c1.querySelector('.ai-assist-subresult-group-header')!
    fireEvent.click(btn1)
    expect(btn1.getAttribute('aria-expanded')).to.equal('true')

    // A subsequent segment in the same entry (e.g. after model emitted text)
    const { container: c2 } = render(
      <SubresultGroup
        groupId="entryA-subresults-2"
        items={[
          {
            type: 'tool_call',
            call: { id: 'c2', name: 'edit_file', args: {}, result: {} },
          },
        ]}
        isLive={false}
        onDecision={sinon.stub()}
      />
    )

    const btn2 = c2.querySelector('.ai-assist-subresult-group-header')!
    // Must inherit the unfolded state from entryA
    expect(btn2.getAttribute('aria-expanded')).to.equal('true')
  })
})
