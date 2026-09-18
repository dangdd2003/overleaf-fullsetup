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
import customLocalStorage from '@/infrastructure/local-storage'

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

  it('does not send on Enter while running', function () {
    const onSend = sinon.stub()
    render(<AgentComposer running onSend={onSend} onStop={sinon.stub()} />)

    const input = screen.getByPlaceholderText(/what would you like to do/i)
    fireEvent.change(input, { target: { value: 'add a section' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onSend).to.have.not.been.called
  })

  it('navigates history prompts with ArrowUp and ArrowDown', function () {
    render(
      <AgentComposer
        running={false}
        onSend={sinon.stub()}
        onStop={sinon.stub()}
        history={['first prompt', 'second prompt']}
      />
    )

    const input = screen.getByPlaceholderText(/what would you like to do/i) as HTMLTextAreaElement
    expect(input.value).to.equal('')

    // Up arrow to latest history prompt
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input.value).to.equal('second prompt')

    // Up arrow to older history prompt
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input.value).to.equal('first prompt')

    // Up arrow at oldest prompt stays there
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input.value).to.equal('first prompt')

    // Down arrow forward to newer prompt
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input.value).to.equal('second prompt')

    // Down arrow back to original empty draft
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input.value).to.equal('')
  })

  it('preserves draft input when navigating history and returning with ArrowDown', function () {
    render(
      <AgentComposer
        running={false}
        onSend={sinon.stub()}
        onStop={sinon.stub()}
        history={['existing prompt']}
      />
    )

    const input = screen.getByPlaceholderText(/what would you like to do/i) as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'my unfinished draft' } })

    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input.value).to.equal('existing prompt')

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input.value).to.equal('my unfinished draft')
  })

  it('does not navigate history if history is empty', function () {
    render(
      <AgentComposer
        running={false}
        onSend={sinon.stub()}
        onStop={sinon.stub()}
        history={[]}
      />
    )

    const input = screen.getByPlaceholderText(/what would you like to do/i) as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'current text' } })

    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input.value).to.equal('current text')
  })

  it('cycles mode with Shift+Tab in composer textarea', function () {
    const onModeChange = sinon.stub()
    render(
      <AgentComposer
        running={false}
        mode="manual"
        onModeChange={onModeChange}
        onSend={sinon.stub()}
        onStop={sinon.stub()}
      />
    )

    const input = screen.getByPlaceholderText(/what would you like to do/i) as HTMLTextAreaElement
    fireEvent.keyDown(input, { key: 'Tab', shiftKey: true })
    expect(onModeChange.calledWith('acceptEdits')).to.be.true
  })

  it('opens mode menu and selects a mode', function () {
    const onModeChange = sinon.stub()
    render(
      <AgentComposer
        running={false}
        mode="manual"
        onModeChange={onModeChange}
        onSend={sinon.stub()}
        onStop={sinon.stub()}
      />
    )

    const modeBtn = screen.getByLabelText(/select mode/i)
    fireEvent.click(modeBtn)

    const planOption = screen.getByText(/^plan$/i)
    fireEvent.click(planOption)

    expect(onModeChange.calledWith('plan')).to.be.true
  })

  it('selects a mode by typing its number while the menu is open', function () {
    const onModeChange = sinon.stub()
    render(
      <AgentComposer
        running={false}
        mode="manual"
        onModeChange={onModeChange}
        onSend={sinon.stub()}
        onStop={sinon.stub()}
      />
    )

    const modeBtn = screen.getByLabelText(/select mode/i)
    fireEvent.click(modeBtn)
    fireEvent.keyDown(modeBtn, { key: '2' })

    expect(onModeChange.calledWith('acceptEdits')).to.be.true
  })

  it('leaves digits as text in the textarea when the mode menu is closed', function () {
    const onModeChange = sinon.stub()
    render(
      <AgentComposer
        running={false}
        mode="manual"
        onModeChange={onModeChange}
        onSend={sinon.stub()}
        onStop={sinon.stub()}
      />
    )

    const input = screen.getByPlaceholderText(
      /what would you like to do/i
    ) as HTMLTextAreaElement
    fireEvent.keyDown(input, { key: '2' })
    fireEvent.change(input, { target: { value: '2' } })

    expect(onModeChange.called).to.be.false
    expect(input.value).to.equal('2')
  })
})

describe('AgentPanel', function () {
  let origEventSource: any
  let fakeFetch: sinon.SinonStub | null = null

  beforeEach(function () {
    origEventSource = globalThis.EventSource
  })

  afterEach(function () {
    clearConversation(PROJECT_ID)
    customLocalStorage.clear()
    fakeFetch?.restore()
    fakeFetch = null
    globalThis.EventSource = origEventSource
  })

  it('seeds the transcript from a previously saved conversation on mount', function () {
    saveConversation(PROJECT_ID, [
      { id: 'u0', role: 'user', text: 'what did we talk about last time?' },
    ])

    render(
      <EditorProviders mockCompileOnLoad>
        <AgentPanel />
      </EditorProviders>
    )

    expect(screen.getByText('what did we talk about last time?')).to.exist
  })

  it('stops active background run when New chat is clicked', async function () {
    customLocalStorage.setItem('ai-assist:active-run:' + PROJECT_ID, 'run-123')
    customLocalStorage.setItem('ai-assist:active-run-start:' + PROJECT_ID, String(Date.now()))

    fakeFetch = sinon.stub(globalThis, 'fetch' as any).resolves({
      ok: true,
      json: async () => ({ ok: true }),
    })

    const closeStub = sinon.stub()
    function FakeEventSource(this: any) {
      this.close = closeStub
      Object.defineProperty(this, 'onmessage', {
        set(_fn) {},
      })
    }
    globalThis.EventSource = FakeEventSource as any

    render(
      <EditorProviders mockCompileOnLoad>
        <AgentPanel />
      </EditorProviders>
    )

    fireEvent.click(screen.getByLabelText('New chat'))

    const stopCall = fakeFetch.getCalls().find(c =>
      String(c.args[0]).includes('/runs/run-123/stop')
    )
    expect(stopCall, 'New chat must POST stop for the active run').to.exist
  })

  it('does not repopulate transcript with stream events arriving after New chat', async function () {
    customLocalStorage.setItem('ai-assist:active-run:' + PROJECT_ID, 'run-123')
    customLocalStorage.setItem('ai-assist:active-run-start:' + PROJECT_ID, String(Date.now()))

    fakeFetch = sinon.stub(globalThis, 'fetch' as any).resolves({
      ok: true,
      json: async () => ({ ok: true }),
    })

    let messageHandler: ((msg: any) => void) | null = null
    const closeStub = sinon.stub()
    function FakeEventSource(this: any) {
      this.close = closeStub
      Object.defineProperty(this, 'onmessage', {
        set(fn) {
          messageHandler = fn
        },
      })
    }
    globalThis.EventSource = FakeEventSource as any

    render(
      <EditorProviders mockCompileOnLoad>
        <AgentPanel />
      </EditorProviders>
    )

    fireEvent.click(screen.getByLabelText('New chat'))

    // An event arriving from the old run after clicking New chat
    const handler = messageHandler as ((msg: any) => void) | null
    if (handler) {
      handler({
        data: JSON.stringify({
          seq: 1,
          event: { type: 'text', text: 'resurrected zombie text' },
        }),
      })
    }

    expect(screen.queryByText(/resurrected zombie text/)).to.equal(null)
  })

  it('shows jump to latest button when scrolled up and clicking it scrolls to bottom', function () {
    saveConversation(PROJECT_ID, [
      { id: 'u1', role: 'user', text: 'turn 1' },
      { id: 'a1', role: 'assistant', text: 'turn 1 reply', toolCalls: [] },
      { id: 'u2', role: 'user', text: 'turn 2' },
      { id: 'a2', role: 'assistant', text: 'turn 2 reply', toolCalls: [] },
    ])

    const { container } = render(
      <EditorProviders mockCompileOnLoad>
        <AgentPanel />
      </EditorProviders>
    )

    const transcript = container.querySelector('.ai-assist-transcript') as HTMLElement
    expect(transcript).to.exist

    let scrollTop = 0
    Object.defineProperty(transcript, 'scrollHeight', { get: () => 1000 })
    Object.defineProperty(transcript, 'clientHeight', { get: () => 200 })
    Object.defineProperty(transcript, 'scrollTop', {
      get: () => scrollTop,
      set: v => {
        scrollTop = v
      },
    })

    // Initially at bottom, button not rendered
    expect(screen.queryByLabelText(/jump to latest/i)).to.equal(null)

    // Scroll up
    scrollTop = 100
    fireEvent.scroll(transcript)

    // Button should now be rendered
    const jumpBtn = screen.getByLabelText(/jump to latest/i)
    expect(jumpBtn).to.exist

    // Click jump button
    fireEvent.click(jumpBtn)
    expect(transcript.scrollTop).to.equal(1000)
    expect(screen.queryByLabelText(/jump to latest/i)).to.equal(null)
  })
})
