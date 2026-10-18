import { expect } from 'chai'
import sinon from 'sinon'
import { act } from 'react'
import { render, screen, fireEvent, within } from '@testing-library/react'
import {
  AgentComposer,
  AttachedSelection,
  slashQueryAt,
} from '../../../../frontend/js/features/ai-assist/components/agent/agent-composer'

const PATHS = ['main.tex', 'sections/results.tex']
const SELECTION: AttachedSelection = {
  path: 'main.tex',
  from: 10,
  to: 20,
  text: 'some passage',
}

function renderComposer(
  overrides: Partial<Parameters<typeof AgentComposer>[0]> = {}
) {
  const onSend = sinon.stub()
  const { container } = render(
    <AgentComposer
      running={false}
      paths={PATHS}
      onSend={onSend}
      onStop={() => {}}
      {...overrides}
    />
  )
  return { onSend, container }
}

function type(value: string) {
  const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
  fireEvent.change(textarea, { target: { value } })
  return textarea
}

describe('slashQueryAt', function () {
  it('returns the name while the lone first token is typed', function () {
    expect(slashQueryAt('/pro', 4)).to.equal('pro')
  })

  it('returns an empty name right after a bare slash', function () {
    expect(slashQueryAt('/', 1)).to.equal('')
  })

  it('closes once a space makes the name a command with arguments', function () {
    expect(slashQueryAt('/fix ', 5)).to.equal(null)
    expect(slashQueryAt('/fix the table', 14)).to.equal(null)
  })

  it('ignores a slash that is not at the start of the input', function () {
    expect(slashQueryAt('see /pro', 8)).to.equal(null)
  })

  it('tolerates leading whitespace, as the composer trims it on send', function () {
    expect(slashQueryAt('  /re', 5)).to.equal('re')
  })

  it('ignores a caret placed before the slash', function () {
    expect(slashQueryAt('/pro', 0)).to.equal(null)
  })
})

describe('AgentComposer slash commands', function () {

  describe('menu', function () {
    it('opens a listbox of every command when / is typed', function () {
      renderComposer()
      type('/')
      expect(screen.getByRole('listbox', { name: /commands/i })).to.exist
      expect(screen.getAllByRole('option')).to.have.length(15)
    })

    it('filters as the name is typed', function () {
      renderComposer()
      type('/pro')
      expect(screen.getByRole('option', { name: /^\/proofread/ })).to.exist
      expect(screen.queryByRole('option', { name: /^\/fix/ })).to.equal(null)
    })

    it('does not open for a / that is not at the start', function () {
      renderComposer()
      type('explain /pro')
      expect(screen.queryByRole('listbox')).to.equal(null)
    })

    it('closes when a space is typed after the name', function () {
      renderComposer()
      type('/fix ')
      expect(screen.queryByRole('listbox')).to.equal(null)
    })

    it('moves the highlight with the arrow keys and points the textarea at it', function () {
      renderComposer()
      const textarea = type('/')
      expect(textarea.getAttribute('aria-activedescendant')).to.equal(
        'ai-assist-slash-option-fix'
      )
      fireEvent.keyDown(textarea, { key: 'ArrowDown' })
      expect(textarea.getAttribute('aria-activedescendant')).to.equal(
        'ai-assist-slash-option-layout'
      )
      fireEvent.keyDown(textarea, { key: 'ArrowUp' })
      expect(textarea.getAttribute('aria-activedescendant')).to.equal(
        'ai-assist-slash-option-fix'
      )
    })

    it('moves the highlight on mouse enter and mouse move, and does not inherit mention menu styles', function () {
      renderComposer()
      const textarea = type('/')
      const menu = screen.getByRole('listbox', { name: /commands/i })
      expect(menu.classList.contains('ai-assist-slash-menu')).to.equal(true)
      expect(menu.classList.contains('ai-assist-mention-menu')).to.equal(false)

      const explainOption = screen.getByRole('option', { name: /^\/explain/ })
      fireEvent.mouseEnter(explainOption)
      expect(textarea.getAttribute('aria-activedescendant')).to.equal(
        'ai-assist-slash-option-explain'
      )
      expect(explainOption.classList.contains('is-active')).to.equal(true)
      expect(explainOption.getAttribute('aria-selected')).to.equal('true')

      const proofreadOption = screen.getByRole('option', { name: /^\/proofread/ })
      fireEvent.mouseMove(proofreadOption)
      expect(textarea.getAttribute('aria-activedescendant')).to.equal(
        'ai-assist-slash-option-proofread'
      )
      expect(proofreadOption.classList.contains('is-active')).to.equal(true)
      expect(proofreadOption.getAttribute('aria-selected')).to.equal('true')
      expect(explainOption.classList.contains('is-active')).to.equal(false)
    })

    it('closes on Escape without clearing the input', function () {
      renderComposer()
      const textarea = type('/pro')
      fireEvent.keyDown(textarea, { key: 'Escape' })
      expect(screen.queryByRole('listbox')).to.equal(null)
      expect(textarea.value).to.equal('/pro')
    })

    it('inserts the command on Enter and keeps focus, without sending', function () {
      const { onSend } = renderComposer()
      const textarea = type('/pro')
      fireEvent.keyDown(textarea, { key: 'Enter' })

      expect(textarea.value).to.equal('/proofread ')
      expect(onSend.called).to.equal(false)
      expect(screen.queryByRole('listbox')).to.equal(null)
    })

    it('sends a command typed out in full on Enter, as Claude Code does', function () {
      const { onSend } = renderComposer()
      const textarea = type('/review')
      fireEvent.keyDown(textarea, { key: 'Enter' })

      expect(onSend.calledOnce).to.equal(true)
      expect(onSend.lastCall.args[0]).to.equal('')
      expect(onSend.lastCall.args[3]).to.deep.equal({ id: 'review', args: '' })
    })

    it('sends an alias typed out in full as its command', function () {
      const { onSend } = renderComposer()
      const textarea = type('/grammar')
      fireEvent.keyDown(textarea, { key: 'Enter' })

      expect(onSend.lastCall.args[3]).to.deep.equal({ id: 'proofread', args: '' })
    })

    it('completes rather than sends a full name on Tab', function () {
      const { onSend } = renderComposer()
      const textarea = type('/review')
      fireEvent.keyDown(textarea, { key: 'Tab' })

      expect(textarea.value).to.equal('/review ')
      expect(onSend.called).to.equal(false)
    })

    it('inserts the command on Tab', function () {
      renderComposer()
      const textarea = type('/rew')
      fireEvent.keyDown(textarea, { key: 'Tab' })
      expect(textarea.value).to.equal('/rewrite ')
    })

    it('inserts the command when an option is clicked', function () {
      renderComposer()
      type('/')
      fireEvent.click(screen.getByRole('option', { name: /^\/summarize/ }))
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).to.equal(
        '/summarize '
      )
    })

    it('shows the read-only badge on read scope and the selection badge only with a selection', function () {
      renderComposer({ attachedSelection: SELECTION })
      type('/')
      const explain = screen.getByRole('option', { name: /^\/explain/ })
      expect(within(explain).getByText('read-only')).to.exist
      expect(within(explain).getByText('uses selection')).to.exist

      const fix = screen.getByRole('option', { name: /^\/fix/ })
      expect(within(fix).queryByText('read-only')).to.equal(null)
      expect(within(fix).queryByText('uses selection')).to.equal(null)
    })

    it('omits the selection badge when no selection is attached', function () {
      renderComposer()
      type('/')
      const rewrite = screen.getByRole('option', { name: /^\/rewrite/ })
      expect(within(rewrite).queryByText('uses selection')).to.equal(null)
    })
  })

  describe('hint and ghost argument hint', function () {
    it('shows the command label and argument hint once a command is recognised', function () {
      const { container } = renderComposer()
      type('/fix')
      const hint = container.querySelector('.ai-assist-slash-hint')
      expect(hint).to.exist
      expect(hint!.textContent).to.contain('Fix errors')
      expect(hint!.textContent).to.contain('[all] [file.tex:line]')
    })

    it('shows the argument hint in the input after a command with no arguments yet', function () {
      const { container } = renderComposer()
      type('/fix ')
      const ghost = container.querySelector('.ai-assist-slash-ghost-hint')
      expect(ghost).to.exist
      expect(ghost!.textContent).to.equal('[all] [file.tex:line] [notes]')
    })

    it('drops the ghost hint once arguments are typed', function () {
      const { container } = renderComposer()
      type('/fix the table')
      expect(container.querySelector('.ai-assist-slash-ghost')).to.equal(null)
    })

    it('shows no hint for an unknown command', function () {
      const { container } = renderComposer()
      type('/foo bar')
      expect(container.querySelector('.ai-assist-slash-hint')).to.equal(null)
    })
  })

  describe('sending', function () {
    it('calls onSend with the arguments and the command', function () {
      const { onSend } = renderComposer()
      const textarea = type('/fix the table')
      fireEvent.keyDown(textarea, { key: 'Enter' })

      expect(onSend.calledOnce).to.equal(true)
      expect(onSend.lastCall.args[0]).to.equal('the table')
      expect(onSend.lastCall.args[1]).to.deep.equal([])
      expect(onSend.lastCall.args[3]).to.deep.equal({
        id: 'fix',
        args: 'the table',
      })
    })

    it('sends a bare command with empty arguments', function () {
      const { onSend } = renderComposer()
      type('/review ')
      fireEvent.click(screen.getByRole('button', { name: /send/i }))

      expect(onSend.calledOnce).to.equal(true)
      expect(onSend.lastCall.args[0]).to.equal('')
      expect(onSend.lastCall.args[3]).to.deep.equal({ id: 'review', args: '' })
    })

    it('resolves an alias to its command id', function () {
      const { onSend } = renderComposer()
      const textarea = type('/improve this sentence')
      fireEvent.keyDown(textarea, { key: 'Enter' })

      expect(onSend.lastCall.args[0]).to.equal('this sentence')
      expect(onSend.lastCall.args[3]).to.deep.equal({
        id: 'rewrite',
        args: 'this sentence',
      })
    })

    it('sends an unknown /word as plain text with no command', function () {
      const { onSend } = renderComposer()
      const textarea = type('/foo bar')
      fireEvent.keyDown(textarea, { key: 'Enter' })

      expect(onSend.calledOnce).to.equal(true)
      expect(onSend.lastCall.args[0]).to.equal('/foo bar')
      expect(onSend.lastCall.args[3]).to.equal(undefined)
    })

    it('sends a command while a run is going', function () {
      const { onSend } = renderComposer({ running: true })
      const textarea = type('/explain the proof')
      fireEvent.keyDown(textarea, { key: 'Enter' })

      expect(onSend.calledOnce).to.equal(true)
      expect(onSend.lastCall.args[3]).to.deep.equal({
        id: 'explain',
        args: 'the proof',
      })
    })

    it('still attaches the selection to a command turn', function () {
      const { onSend } = renderComposer()
      act(() => {
        window.dispatchEvent(
          new CustomEvent('aiAssist:selectionChanged', { detail: SELECTION })
        )
      })
      const textarea = type('/rewrite more formally')
      fireEvent.keyDown(textarea, { key: 'Enter' })

      expect(onSend.lastCall.args[2]).to.deep.equal(SELECTION)
      expect(onSend.lastCall.args[3]).to.deep.equal({
        id: 'rewrite',
        args: 'more formally',
      })
    })
  })

})
