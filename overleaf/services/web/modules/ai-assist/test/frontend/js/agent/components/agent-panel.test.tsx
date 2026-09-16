import { expect } from 'chai'
import sinon from 'sinon'
import { fireEvent, render, screen } from '@testing-library/react'
import {
  AgentPanel,
  buildUserEntry,
} from '../../../../../frontend/js/features/ai-assist/components/agent/agent-panel'
import { AgentEmptyState } from '../../../../../frontend/js/features/ai-assist/components/agent/agent-empty-state'
import { AgentComposer } from '../../../../../frontend/js/features/ai-assist/components/agent/agent-composer'
import { createFakeHandle } from '../helpers/fake-handle'
import {
  clearConversation,
  saveConversation,
} from '../../../../../frontend/js/features/ai-assist/agent/conversation-store'
import { clearStartersCache } from '../../../../../frontend/js/features/ai-assist/agent/starters/use-project-starters'
import {
  EditorProviders,
  PROJECT_ID,
} from '../../../../../../../test/frontend/helpers/editor-providers'
import { resetMeta } from '../../../../../../../test/frontend/helpers/reset-meta'

describe('buildUserEntry', function () {
  beforeEach(function () {
    resetMeta()
  })
  it('renders and freezes the envelope onto the user entry', async function () {
    const { handle } = createFakeHandle({ docs: { 'main.tex': 'hello' } })
    const entry = await buildUserEntry({
      handle,
      transcript: [],
      text: 'please help',
    })

    expect(entry.role).to.equal('user')
    expect(entry.text).to.equal('please help')
    expect((entry as any).contextText).to.include('<project-context turn="1">')
    expect((entry as any).envelopeState).to.deep.include({ turn: 1 })
  })

  it('increments turn and delta-encodes from previous user entry', async function () {
    const { handle } = createFakeHandle({ docs: { 'main.tex': 'hello' } })
    const entry1 = await buildUserEntry({
      handle,
      transcript: [],
      text: 'first',
    })

    const entry2 = await buildUserEntry({
      handle,
      transcript: [entry1],
      text: 'second',
    })

    expect((entry2 as any).envelopeState.turn).to.equal(2)
    expect((entry2 as any).contextText).to.include('<project-context turn="2">')
    expect((entry2 as any).contextText).to.include('unchanged since turn 1')
  })

  it('falls back to no contextText if snapshot generation fails', async function () {
    const handle: any = {
      rootDocPath: () => null,
      listFiles: async () => {
        throw new Error('disk failure')
      },
      openFile: () => null,
      currentSelection: () => null,
      lastCompile: () => null,
    }

    const entry = await buildUserEntry({
      handle,
      transcript: [],
      text: 'still works',
    })

    expect(entry.role).to.equal('user')
    expect(entry.text).to.equal('still works')
    expect((entry as any).contextText).to.be.undefined
  })

  it('freezes attachments onto the user entry and includes them in contextText', async function () {
    const { handle } = createFakeHandle({ docs: { 'main.tex': 'hello' } })
    const entry = await buildUserEntry({
      handle,
      transcript: [],
      text: 'explain this',
      attachments: [{ path: 'main.tex', text: 'hello' }],
    })

    expect(entry.role).to.equal('user')
    expect((entry as any).attachments).to.deep.equal([
      { path: 'main.tex', text: 'hello' },
    ])
    expect((entry as any).contextText).to.include('<attachments>')
    expect((entry as any).contextText).to.include('hello')
  })

  it('bundles attachedSelection into attachments and selection context', async function () {
    const { handle } = createFakeHandle({ docs: { 'main.tex': 'hello world line 1\nline 2' } })
    const entry = await buildUserEntry({
      handle,
      transcript: [],
      text: 'explain selection',
      attachments: [{ path: 'refs.bib', text: '@article{test}' }],
      attachedSelection: { path: 'main.tex', from: 1, to: 2, text: 'hello world line 1\nline 2' },
    })

    expect(entry.role).to.equal('user')
    if (entry.role !== 'user') throw new Error('expected user entry')
    expect(entry.attachments).to.have.length(2)
    expect(entry.attachments![0]).to.deep.include({
      path: 'main.tex',
      from: 1,
      to: 2,
    })
    expect(entry.attachments![1]).to.deep.include({
      path: 'refs.bib',
    })
    expect((entry as any).contextText).to.include('<selection file="main.tex"')
    expect((entry as any).contextText).to.include('<file path="refs.bib">')
  })
})

describe('AgentEmptyState', function () {
  beforeEach(function () {
    clearStartersCache('default')
  })

  it('offers the advanced tool and the generic starters for a plain project', function () {
    const { handle } = createFakeHandle({ docs: { 'main.tex': 'hello' } })
    render(<AgentEmptyState onPick={sinon.stub()} handle={handle} files={[]} />)

    expect(screen.getByText(/scan for unsupported statements/i)).to.exist
    expect(screen.getByText(/what can (you help me with|the assistant do)/i)).to.exist
  })

  it('suggests fixing the compile errors the project actually has', function () {
    const { handle } = createFakeHandle({
      docs: { 'main.tex': '\\begin{document}\noops\n\\end{document}' },
      lastCompile: {
        status: 'failure',
        errors: [{ message: 'Undefined control sequence.', file: 'main.tex', line: 2 }],
        warnings: [],
        rawLog: null,
      },
    })
    render(<AgentEmptyState onPick={sinon.stub()} handle={handle} files={[]} />)

    expect(screen.getByText(/fix 1 compile error/i)).to.exist
  })

  it('passes the chosen prompt up', function () {
    const onPick = sinon.stub()
    const { handle } = createFakeHandle({ docs: { 'main.tex': 'hello' } })
    render(<AgentEmptyState onPick={onPick} handle={handle} files={[]} />)

    fireEvent.click(screen.getByText(/what can (you help me with|the assistant do)/i))
    expect(onPick).to.have.been.calledOnce
    expect(onPick.firstCall.args[0].prompt).to.be.a('string').and.not.be.empty
  })
})

describe('AgentComposer', function () {
  it('sends on Enter and clears the input', function () {
    const onSend = sinon.stub()
    render(<AgentComposer running={false} onSend={onSend} onStop={sinon.stub()} />)

    const input = screen.getByPlaceholderText(/what would you like to do/i)
    fireEvent.change(input, { target: { value: 'add a section' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onSend).to.have.been.calledWith('add a section')
    expect((input as HTMLTextAreaElement).value).to.equal('')
  })

  it('does not send on Shift+Enter', function () {
    const onSend = sinon.stub()
    render(<AgentComposer running={false} onSend={onSend} onStop={sinon.stub()} />)

    const input = screen.getByPlaceholderText(/what would you like to do/i)
    fireEvent.change(input, { target: { value: 'line one' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })

    expect(onSend).to.have.not.been.called
  })

  it('refuses to send an empty message', function () {
    const onSend = sinon.stub()
    render(<AgentComposer running={false} onSend={onSend} onStop={sinon.stub()} />)

    fireEvent.keyDown(screen.getByPlaceholderText(/what would you like to do/i), {
      key: 'Enter',
    })
    expect(onSend).to.have.not.been.called
  })

  it('shows Stop while a run is active', function () {
    const onStop = sinon.stub()
    render(<AgentComposer running onSend={sinon.stub()} onStop={onStop} />)

    fireEvent.click(screen.getByRole('button', { name: /stop/i }))
    expect(onStop).to.have.been.calledOnce
  })

  it('stops the run when Escape key is pressed in composer textarea while running', function () {
    const onStop = sinon.stub()
    render(<AgentComposer running onSend={sinon.stub()} onStop={onStop} />)

    fireEvent.keyDown(screen.getByPlaceholderText(/what would you like to do/i), {
      key: 'Escape',
    })
    expect(onStop).to.have.been.calledOnce
  })
})

describe('AgentPanel', function () {
  afterEach(function () {
    clearConversation(PROJECT_ID)
  })

  it('seeds the transcript from a previously saved conversation on mount', function () {
    saveConversation(PROJECT_ID, [
      { id: 'u0', role: 'user', text: 'what did we talk about last time?' },
    ])

    render(
      <EditorProviders>
        <AgentPanel />
      </EditorProviders>
    )

    expect(screen.getByText('what did we talk about last time?')).to.exist
  })
})
