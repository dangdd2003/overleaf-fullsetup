import { expect } from 'chai'
import sinon from 'sinon'
import { render, screen } from '@testing-library/react'
import { AgentMessageView } from '../../../../../frontend/js/features/ai-assist/components/agent/agent-message'
import { TranscriptEntry } from '../../../../../frontend/js/features/ai-assist/agent/agent-messages'

const HARNESS = 'SECRET-HARNESS-INSTRUCTIONS'
const GATHERED = 'SECRET-GATHERED-PREAMBLE'

function renderUser(entry: TranscriptEntry) {
  return render(
    <AgentMessageView
      entry={entry}
      pendingApprovalId={null}
      onDecision={sinon.stub()}
    />
  )
}

describe('AgentMessageView slash command chip', function () {
  it('renders the command id as a chip before the arguments', function () {
    const { container } = renderUser({
      id: 'u1',
      role: 'user',
      text: 'the table',
      command: { id: 'fix', args: 'the table' },
      commandText: `<command name="fix">${HARNESS}${GATHERED}</command>`,
      contextText: '<project-context>CTX</project-context>',
      createdAt: Date.now(),
    } as TranscriptEntry)

    const chip = container.querySelector('.ai-assist-slash-chip')
    expect(chip).to.exist
    expect(chip!.textContent).to.equal('/fix')

    const userText = container.querySelector('.ai-assist-message-user-text')
    expect(userText!.firstElementChild).to.equal(chip)
    expect(userText!.textContent).to.equal('/fixthe table')
  })

  it('never renders the frozen command block or the context', function () {
    const { container } = renderUser({
      id: 'u2',
      role: 'user',
      text: '',
      command: { id: 'review', args: '' },
      commandText: `<command name="review">${HARNESS}${GATHERED}</command>`,
      contextText: '<project-context>CTX</project-context>',
      createdAt: Date.now(),
    } as TranscriptEntry)

    expect(container.querySelector('.ai-assist-slash-chip')!.textContent).to.equal(
      '/review'
    )
    expect(container.textContent).to.not.contain(HARNESS)
    expect(container.textContent).to.not.contain(GATHERED)
    expect(container.textContent).to.not.contain('CTX')
    expect(screen.queryByText(/command name=/)).to.equal(null)
  })

  it('renders no chip for an ordinary user message', function () {
    const { container } = renderUser({
      id: 'u3',
      role: 'user',
      text: 'just a question',
      createdAt: Date.now(),
    })

    expect(container.querySelector('.ai-assist-slash-chip')).to.equal(null)
    expect(screen.getByText('just a question')).to.exist
  })
})
