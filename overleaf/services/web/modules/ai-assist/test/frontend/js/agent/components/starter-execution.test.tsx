import { expect } from 'chai'
import sinon from 'sinon'
import { render, screen, fireEvent } from '@testing-library/react'
import { AgentEmptyState } from '../../../../../frontend/js/features/ai-assist/components/agent/agent-empty-state'
import { createFakeHandle } from '../helpers/fake-handle'

describe('AgentEmptyState starter clicks', function () {
  it('hands the starter object to onPick so the caller can apply the task harness', function () {
    const onPick = sinon.stub()
    const { handle } = createFakeHandle()

    render(
      <AgentEmptyState
        onPick={onPick}
        handle={handle}
        files={[{ path: 'main.tex', type: 'doc', size: 100 }]}
      />
    )

    const buttons = screen.getAllByRole('button')
    fireEvent.click(buttons[buttons.length - 1])

    expect(onPick.calledOnce).to.equal(true)
    const arg = onPick.firstCall.args[0]
    expect(arg).to.be.an('object')
    expect(arg).to.have.property('prompt')
    expect(arg).to.have.property('oneShot')
  })

  it('renders both advanced tools: unsupported statements and reference integrity audit', function () {
    const { handle } = createFakeHandle()
    render(
      <AgentEmptyState
        onPick={() => {}}
        handle={handle}
        files={[{ path: 'main.tex', type: 'doc', size: 100 }]}
      />
    )

    expect(screen.getByText(/Scan for unsupported statements/i)).to.exist
    expect(screen.getByText(/Audit cross-references and citations/i)).to.exist
  })

  it('renders "For your selection" quick actions instead of "Start a chat" when selection is present', function () {
    const onPick = sinon.stub()
    const { handle } = createFakeHandle()

    render(
      <AgentEmptyState
        onPick={onPick}
        handle={handle}
        files={[{ path: 'main.tex', type: 'doc', size: 100 }]}
        selection={{
          path: 'main.tex',
          from: 10,
          to: 20,
          text: 'Some paragraph text here with enough words to be prose.',
          scope: {
            kind: 'prose',
            env: null,
            lines: 11,
            numeric: false,
            inline: false,
          },
        }}
      />
    )

    expect(screen.getByText(/For your selection/i)).to.exist
    expect(screen.queryByText(/Start a chat/i)).to.be.null

    const refineBtn = screen.getByRole('button', {
      name: /Refine my writing/i,
    })
    expect(refineBtn).to.exist

    fireEvent.click(refineBtn)
    expect(onPick.calledOnce).to.be.true
    expect(onPick.firstCall.args[0].prompt).to.include('lines 10-20 of main.tex')
  })
})
