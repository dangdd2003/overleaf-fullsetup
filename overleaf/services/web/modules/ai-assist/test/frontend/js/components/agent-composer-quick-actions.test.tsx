import { expect } from 'chai'
import sinon from 'sinon'
import { act } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import {
  AgentComposer,
  AttachedSelection,
} from '../../../../frontend/js/features/ai-assist/components/agent/agent-composer'

const PATHS = ['main.tex', 'sections/results.tex']

describe('AgentComposer quick action chips', function () {
  const selection: AttachedSelection = {
    path: 'main.tex',
    from: 5,
    to: 8,
    text: '\\begin{tabular}{ll}\nA & B \\\\\n\\end{tabular}',
    scope: {
      kind: 'table',
      env: 'tabular',
      lines: 3,
      numeric: false,
      inline: false,
    },
  }

  function renderComposer(
    overrides: Partial<Parameters<typeof AgentComposer>[0]> = {}
  ) {
    const onSend = sinon.stub()
    render(
      <AgentComposer
        running={false}
        paths={PATHS}
        onSend={onSend}
        onStop={() => {}}
        showSelectionActions={true}
        attachedSelection={selection}
        {...overrides}
      />
    )
    return { onSend }
  }

  it('renders quick action chips toolbar when showSelectionActions is true and input is empty', function () {
    renderComposer()

    const toolbar = screen.getByRole('toolbar')
    expect(toolbar).to.exist
    expect(screen.getByRole('button', { name: /Polish this table/i })).to.exist
  })

  it('does not render chips when showSelectionActions is false', function () {
    renderComposer({ showSelectionActions: false })

    expect(screen.queryByRole('toolbar')).to.be.null
  })

  it('does not render chips when running is true', function () {
    renderComposer({ running: true })

    expect(screen.queryByRole('toolbar')).to.be.null
  })

  it('hides chips when user types into the textarea', function () {
    renderComposer()

    expect(screen.getByRole('toolbar')).to.exist

    const textarea = screen.getByRole('textbox')
    act(() => {
      fireEvent.change(textarea, { target: { value: 'Draft something' } })
    })

    expect(screen.queryByRole('toolbar')).to.be.null
  })

  it('calls onSend with action prompt and selection on chip click', function () {
    const { onSend } = renderComposer()

    const chip = screen.getByRole('button', { name: /Polish this table/i })
    fireEvent.click(chip)

    expect(onSend.calledOnce).to.be.true
    const [sentPrompt, sentAttachments, sentSelection] = onSend.firstCall.args
    expect(sentPrompt).to.include('lines 5-8 of main.tex')
    expect(sentPrompt).to.include('booktabs')
    expect(sentSelection).to.deep.equal(selection)
  })
})
