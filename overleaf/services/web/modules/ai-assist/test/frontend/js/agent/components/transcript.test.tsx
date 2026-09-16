import { expect } from 'chai'
import sinon from 'sinon'
import { fireEvent, render, screen } from '@testing-library/react'
import {
  ToolCallCard,
  toolCallExpansionStore,
} from '../../../../../frontend/js/features/ai-assist/components/agent/tool-call-card'
import { EditApprovalCard } from '../../../../../frontend/js/features/ai-assist/components/agent/edit-approval-card'
import { AgentMessageView } from '../../../../../frontend/js/features/ai-assist/components/agent/agent-message'
import { ThinkingBlock } from '../../../../../frontend/js/features/ai-assist/components/agent/thinking-block'

describe('ToolCallCard', function () {
  beforeEach(function () {
    toolCallExpansionStore.clear()
  })
  it('summarises a read without showing the arguments until expanded', function () {
    const { container } = render(
      <ToolCallCard
        call={{
          id: 'c1',
          name: 'read_file',
          args: { path: 'chapters/intro.tex' },
          result: { content: 'intro section content' },
        }}
      />
    )

    expect(screen.getAllByText(/chapters\/intro\.tex/)).to.not.be.empty
    const body = container.querySelector('.ai-assist-tool-call-body')
    expect(body?.classList.contains('is-expanded')).to.be.false

    fireEvent.click(container.querySelector('button.ai-assist-tool-call-summary')!)
    expect(body?.classList.contains('is-expanded')).to.be.true
    expect(screen.getByText(/intro section content/)).to.exist
  })

  it('summarises a compile by its error count', function () {
    render(
      <ToolCallCard
        call={{
          id: 'c2',
          name: 'compile_project',
          args: {},
          result: { status: 'failure', errorCount: 2, warningCount: 0 },
        }}
      />
    )
    expect(screen.getByText(/2 errors/i)).to.exist
  })

  it('summarises get_compile_log with human-friendly title and error count', function () {
    render(
      <ToolCallCard
        call={{
          id: 'c-log',
          name: 'get_compile_log',
          args: {},
          result: { status: 'success', errorCount: 0, warningCount: 0 },
        }}
      />
    )
    expect(screen.getByText(/read compile log/i)).to.exist
    expect(screen.getAllByText(/0 errors/i)).to.not.be.empty
  })

  it('summarises get_outline and list_files with friendly titles', function () {
    const { rerender } = render(
      <ToolCallCard
        call={{
          id: 'c-map-outline',
          name: 'get_outline',
          args: { section: 'Intro' },
          result: { sections: [{ title: 'Intro' }] },
        }}
      />
    )
    expect(screen.getByText(/outlined project/i)).to.exist
    expect(screen.getAllByText(/section "Intro"/)).to.not.be.empty

    rerender(
      <ToolCallCard
        call={{
          id: 'c-map-files',
          name: 'list_files',
          args: { glob: '*.tex' },
          result: { files: [{ path: 'main.tex' }] },
        }}
      />
    )
    expect(screen.getByText(/listed files/i)).to.exist
    expect(screen.getAllByText(/glob \*\.tex/)).to.not.be.empty
  })

  it('marks a failed call', function () {
    render(
      <ToolCallCard
        call={{
          id: 'c3',
          name: 'read_file',
          args: { path: 'x' },
          result: { error: 'nope' },
          isError: true,
        }}
      />
    )
    expect(screen.getByText(/failed/i)).to.exist
  })

  it('shows a running call with no result yet', function () {
    render(<ToolCallCard call={{ id: 'c4', name: 'list_files', args: {} }} />)
    expect(screen.getByText(/running/i)).to.exist
  })

  it('shows a +/- line diff badge for an applied edit_file', function () {
    render(
      <ToolCallCard
        call={{
          id: 'c5',
          name: 'edit_file',
          args: { path: 'main.tex', oldText: 'a', newText: 'a\nb\nc' },
          result: { status: 'applied' },
        }}
      />
    )
    expect(screen.getByText('+2')).to.exist
  })

  it('omits the diff badge when the edit was rejected', function () {
    render(
      <ToolCallCard
        call={{
          id: 'c6',
          name: 'edit_file',
          args: { path: 'main.tex', oldText: 'a', newText: 'a\nb' },
          result: { status: 'rejected' },
        }}
      />
    )
    expect(screen.queryByText('+1')).to.equal(null)
  })

  it('shows line range in parentheses for read_file', function () {
    render(
      <ToolCallCard
        call={{
          id: 'c-read-range',
          name: 'read_file',
          args: { path: 'main.tex', from: 15, to: 30 },
          result: { from: 15, to: 30, totalLines: 100 },
        }}
      />
    )
    expect(screen.getByText('(15-30)')).to.exist
  })

  it('renders a clickable file link for file-targeting tools', function () {
    render(
      <ToolCallCard
        call={{
          id: 'c-click-file',
          name: 'read_file',
          args: { path: 'chapters/intro.tex' },
          result: {},
        }}
      />
    )
    const fileLink = screen.getByTitle(/open chapters\/intro\.tex/i)
    expect(fileLink).to.exist
  })
})

describe('EditApprovalCard', function () {
  const EDIT = { path: 'main.tex', oldText: 'alpha', newText: 'beta' }

  it('shows the path, the removed text and the added text', function () {
    render(<EditApprovalCard edit={EDIT} onDecision={sinon.stub()} />)
    expect(screen.getByText('main.tex')).to.exist
    expect(screen.getByText('alpha')).to.exist
    expect(screen.getByText('beta')).to.exist
  })

  it('reports acceptance', function () {
    const onDecision = sinon.stub()
    render(<EditApprovalCard edit={EDIT} onDecision={onDecision} />)

    fireEvent.click(screen.getByRole('button', { name: /accept/i }))
    expect(onDecision).to.have.been.calledWithMatch({ accepted: true })
  })

  it('reports rejection with the note the user typed', function () {
    const onDecision = sinon.stub()
    render(<EditApprovalCard edit={EDIT} onDecision={onDecision} />)

    fireEvent.change(screen.getByPlaceholderText(/reason/i), {
      target: { value: 'wrong section' },
    })
    fireEvent.click(screen.getByRole('button', { name: /reject/i }))

    expect(onDecision).to.have.been.calledWithMatch({
      accepted: false,
      note: 'wrong section',
    })
  })

  it('disables both buttons once a decision has been made', function () {
    render(
      <EditApprovalCard edit={EDIT} onDecision={sinon.stub()} decided="accepted" />
    )
    expect(screen.getByRole('button', { name: /accept/i })).to.have.property(
      'disabled',
      true
    )
    expect(screen.getByRole('button', { name: /reject/i })).to.have.property(
      'disabled',
      true
    )
  })

  it('shows a new file badge and all additions when oldText is empty', function () {
    const CREATION = {
      path: 'sections/new.tex',
      oldText: '',
      newText: '\\section{New}',
    }
    render(<EditApprovalCard edit={CREATION} onDecision={sinon.stub()} />)
    expect(screen.getByText('sections/new.tex')).to.exist
    expect(screen.getByText('new file')).to.exist
    expect(screen.getByText('\\section{New}')).to.exist
  })

  it('renders the approval diff with gutters and word-level highlighting', function () {
    const { container } = render(
      <EditApprovalCard
        edit={{
          path: 'main.tex',
          oldText: '\\usepackage{title asfsa sec}',
          newText: '\\usepackage{titlesec}',
        }}
        startLine={13}
        onDecision={() => {}}
      />
    )

    expect(container.querySelector('.diff-line-del')).to.exist
    expect(container.querySelector('.diff-gutter')?.textContent).to.contain('13')
  })
})

describe('AgentMessageView', function () {
  it('renders a user message', function () {
    render(
      <AgentMessageView
        entry={{ id: 'u1', role: 'user', text: 'Please fix the intro' }}
        pendingApprovalId={null}
        onDecision={sinon.stub()}
      />
    )
    expect(screen.getByText('Please fix the intro')).to.exist
  })

  it('renders an assistant message with regular tool call in subresult group', function () {
    render(
      <AgentMessageView
        entry={{
          id: 'a1',
          role: 'assistant',
          text: 'Looking at the files...',
          toolCalls: [
            {
              id: 'call-1',
              name: 'read_file',
              args: { path: 'main.tex' },
              result: { content: 'hello' },
            },
          ],
        }}
        pendingApprovalId={null}
        onDecision={sinon.stub()}
      />
    )
    expect(screen.getByText('Looking at the files...')).to.exist
    expect(screen.getByText(/read 1 file/i)).to.exist
    fireEvent.click(screen.getByText(/read 1 file/i))
    expect(screen.getAllByText(/main\.tex/)).to.not.be.empty
  })

  it('renders tool calls in chronological order with text', function () {
    const { container } = render(
      <AgentMessageView
        entry={{
          id: 'a1',
          role: 'assistant',
          text: 'Here is what I found.',
          toolCalls: [
            {
              id: 'call-1',
              name: 'search_project',
              args: { query: 'LI202121' },
              result: { hits: ['ref.bib:37'] },
            },
          ],
          blocks: [
            {
              type: 'tool_call',
              call: {
                id: 'call-1',
                name: 'search_project',
                args: { query: 'LI202121' },
                result: { hits: ['ref.bib:37'] },
              },
            },
            {
              type: 'text',
              text: 'Here is what I found.',
            },
          ],
        }}
        pendingApprovalId={null}
        onDecision={sinon.stub()}
      />
    )

    const subresultElem = container.querySelector('.ai-assist-subresult-group')
    const textElem = container.querySelector('.ai-assist-markdown')
    expect(subresultElem).to.exist
    expect(textElem).to.exist

    // subresultElem must appear before textElem in document order
    expect(
      subresultElem!.compareDocumentPosition(textElem!) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).to.be.greaterThan(0)
  })

  it('groups continuous subresults and starts a new group after text', function () {
    const { container } = render(
      <AgentMessageView
        entry={{
          id: 'a1',
          role: 'assistant',
          text: 'Text 1\nText 2',
          toolCalls: [],
          blocks: [
            { type: 'thinking', thinking: 'First thought', elapsedMs: 2000 },
            {
              type: 'tool_call',
              call: { id: 'c1', name: 'list_files', args: {}, result: [] },
            },
            {
              type: 'tool_call',
              call: {
                id: 'c2',
                name: 'read_file',
                args: { path: 'main.tex' },
                result: {},
              },
            },
            { type: 'text', text: 'Text 1' },
            { type: 'thinking', thinking: 'Second thought', elapsedMs: 3000 },
            {
              type: 'tool_call',
              call: {
                id: 'c3',
                name: 'edit_file',
                args: { path: 'main.tex' },
                result: {},
              },
            },
            { type: 'text', text: 'Text 2' },
          ],
        }}
        pendingApprovalId={null}
        onDecision={sinon.stub()}
      />
    )

    const groups = container.querySelectorAll('.ai-assist-subresult-group')
    expect(groups).to.have.length(2)

    const texts = container.querySelectorAll('.ai-assist-markdown')
    expect(texts).to.have.length(2)
  })

  it('renders pending edit_file as EditApprovalCard and passes decision', function () {
    const onDecision = sinon.stub()
    render(
      <AgentMessageView
        entry={{
          id: 'a1',
          role: 'assistant',
          text: 'I suggest this change:',
          toolCalls: [
            {
              id: 'edit-1',
              name: 'edit_file',
              args: { path: 'main.tex', oldText: 'before', newText: 'after' },
            },
          ],
        }}
        pendingApprovalId="edit-1"
        onDecision={onDecision}
      />
    )
    expect(screen.getByText('I suggest this change:')).to.exist
    expect(screen.getByText('before')).to.exist
    expect(screen.getByText('after')).to.exist

    fireEvent.click(screen.getByRole('button', { name: /accept/i }))
    expect(onDecision).to.have.been.calledWithMatch({ accepted: true })
  })

  it('renders pending create_file as EditApprovalCard with new file badge and passes decision', function () {
    const onDecision = sinon.stub()
    render(
      <AgentMessageView
        entry={{
          id: 'a2',
          role: 'assistant',
          text: 'Creating new section:',
          toolCalls: [
            {
              id: 'create-1',
              name: 'create_file',
              args: { path: 'sections/new.tex', content: '\\section{New}' },
            },
          ],
        }}
        pendingApprovalId="create-1"
        onDecision={onDecision}
      />
    )
    expect(screen.getByText('Creating new section:')).to.exist
    expect(screen.getByText('sections/new.tex')).to.exist
    expect(screen.getByText('new file')).to.exist
    expect(screen.getByText('\\section{New}')).to.exist

    fireEvent.click(screen.getByRole('button', { name: /accept/i }))
    expect(onDecision).to.have.been.calledWithMatch({ accepted: true })
  })

  it('preserves rendered subresult group stably when following chunks arrive', function () {
    const { container, rerender } = render(
      <AgentMessageView
        entry={{
          id: 'a1',
          role: 'assistant',
          text: '',
          toolCalls: [],
          blocks: [
            {
              type: 'tool_call',
              call: {
                id: 'call-cfg',
                name: 'configure_appearance_settings',
                args: { editorTheme: 'monokai' },
                result: { status: 'applied' },
              },
            },
          ],
        }}
        pendingApprovalId={null}
        onDecision={sinon.stub()}
        isRunning={true}
      />
    )

    expect(screen.getByText('Configured settings')).to.exist

    // Rerender with subsequent text streaming in
    rerender(
      <AgentMessageView
        entry={{
          id: 'a1',
          role: 'assistant',
          text: 'Theme updated.',
          toolCalls: [],
          blocks: [
            {
              type: 'tool_call',
              call: {
                id: 'call-cfg',
                name: 'configure_appearance_settings',
                args: { editorTheme: 'monokai' },
                result: { status: 'applied' },
              },
            },
            {
              type: 'text',
              text: 'Theme updated.',
            },
          ],
        }}
        pendingApprovalId={null}
        onDecision={sinon.stub()}
        isRunning={true}
      />
    )

    expect(screen.getByText('Configured settings')).to.exist
    expect(screen.getByText('Theme updated.')).to.exist
  })
})

describe('ThinkingBlock', function () {
  it('shows thinking state when live without preview text in button', function () {
    render(
      <ThinkingBlock thinking="Considering options..." isLive />
    )
    expect(screen.getByText(/thinking…/i)).to.exist
    expect(screen.getByRole('button').textContent).to.not.include('Considering options')
  })

  it('shows thought duration in seconds when finished', function () {
    render(
      <ThinkingBlock
        thinking="Considering options..."
        isLive={false}
        elapsedMs={5400}
      />
    )
    expect(screen.getByText(/thought for 5s/i)).to.exist
    expect(screen.getByRole('button').textContent).to.not.include('Considering options')
  })

  it('expands to show full thinking content when clicked', function () {
    render(
      <ThinkingBlock
        thinking="Deep reasoning line 1\nLine 2"
        isLive={false}
        elapsedMs={2000}
      />
    )
    const button = screen.getByRole('button')
    fireEvent.click(button)
    expect(screen.getByText(/deep reasoning line 1/i)).to.exist
  })
})
