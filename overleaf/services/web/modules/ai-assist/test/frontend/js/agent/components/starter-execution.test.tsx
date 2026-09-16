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
})
