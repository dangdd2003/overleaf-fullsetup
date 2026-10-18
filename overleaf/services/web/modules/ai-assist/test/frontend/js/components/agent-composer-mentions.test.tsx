import { expect } from 'chai'
import sinon from 'sinon'
import { act } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import {
  AgentComposer,
  mentionQueryAt,
} from '../../../../frontend/js/features/ai-assist/components/agent/agent-composer'

const PATHS = ['main.tex', 'sections/results.tex', 'refs.bib']

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
      {...overrides}
    />
  )
  return { onSend }
}

function type(value: string) {
  const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
  fireEvent.change(textarea, { target: { value } })
  return textarea
}

describe('mentionQueryAt', function () {
  it('finds the token being typed after an @', function () {
    expect(mentionQueryAt('look at @sec', 12)).to.equal('sec')
  })

  it('returns an empty query immediately after a bare @', function () {
    expect(mentionQueryAt('look at @', 9)).to.equal('')
  })

  it('returns null when there is no @ before the caret', function () {
    expect(mentionQueryAt('look at this', 12)).to.equal(null)
  })

  it('stops at whitespace so a finished mention does not reopen the menu', function () {
    expect(mentionQueryAt('@main.tex and then', 18)).to.equal(null)
  })

  it('ignores an @ after the caret', function () {
    expect(mentionQueryAt('abc @def', 3)).to.equal(null)
  })
})

describe('AgentComposer attachments', function () {
  it('opens a file menu when the user types @', function () {
    renderComposer()
    type('@')
    expect(screen.getByRole('listbox')).to.exist
    expect(screen.getByRole('option', { name: /main\.tex/ })).to.exist
  })

  it('filters the menu as the user types', function () {
    renderComposer()
    type('@res')
    expect(screen.getByRole('option', { name: /sections\/results\.tex/ })).to
      .exist
    expect(screen.queryByRole('option', { name: /refs\.bib/ })).to.equal(null)
  })

  it('adds a chip and removes the mention text when a file is picked', function () {
    renderComposer()
    type('explain @res')
    fireEvent.click(
      screen.getByRole('option', { name: /sections\/results\.tex/ })
    )

    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).to.equal(
      'explain '
    )
    expect(screen.getByText('sections/results.tex')).to.exist
  })

  it('keeps a typed line range on the chip', function () {
    renderComposer()
    type('@sections/results.tex:40-80 ')
    expect(screen.getByText('sections/results.tex: 40-80')).to.exist
  })

  it('sends the attachments alongside the text', function () {
    const { onSend } = renderComposer()
    type('explain @res')
    fireEvent.click(
      screen.getByRole('option', { name: /sections\/results\.tex/ })
    )
    fireEvent.click(screen.getByRole('button', { name: /send/i }))

    expect(onSend.lastCall.args[0]).to.equal('explain')
    expect(onSend.lastCall.args[1]).to.deep.equal([
      { path: 'sections/results.tex' },
    ])
  })

  it('allows sending attachments when text is empty', function () {
    const { onSend } = renderComposer()
    type('@main.tex ')
    fireEvent.click(screen.getByRole('button', { name: /send/i }))

    expect(onSend.calledOnce).to.equal(true)
    expect(onSend.lastCall.args[0]).to.equal('')
    expect(onSend.lastCall.args[1]).to.deep.equal([{ path: 'main.tex' }])
  })

  it('removes a chip when its close button is clicked', function () {
    renderComposer()
    type('@main.tex ')
    fireEvent.click(screen.getByRole('button', { name: /remove attachment/i }))
    expect(screen.queryByText('main.tex')).to.equal(null)
  })

  it('clicking + does not open the workspace files menu', function () {
    renderComposer()
    const plusBtn = screen.getByRole('button', {
      name: /add files or actions/i,
    })
    fireEvent.click(plusBtn)
    expect(screen.queryByRole('listbox')).to.equal(null)
  })

  it('toggles the plus menu open and closed when clicking the + button', function () {
    renderComposer()
    const plusBtn = screen.getByRole('button', {
      name: /add files or actions/i,
    })

    // First click: opens plus menu
    fireEvent.click(plusBtn)
    expect(screen.getByRole('menu')).to.exist

    // Second click: closes plus menu
    fireEvent.click(plusBtn)
    expect(screen.queryByRole('menu')).to.equal(null)
  })

  it('closes the menu on Escape without sending', function () {
    const { onSend } = renderComposer()
    const textarea = type('@')
    fireEvent.keyDown(textarea, { key: 'Escape' })

    expect(screen.queryByRole('listbox')).to.equal(null)
    expect(onSend.called).to.equal(false)
  })

  it('does not send on Enter while the menu is open', function () {
    const { onSend } = renderComposer()
    const textarea = type('hi @')
    fireEvent.keyDown(textarea, { key: 'Enter' })

    expect(onSend.called).to.equal(false)
  })

  it('clears attachments after sending', function () {
    renderComposer()
    type('@main.tex ')
    fireEvent.click(screen.getByRole('button', { name: /send/i }))
    expect(screen.queryByText('main.tex')).to.equal(null)
  })

  it('displays selection chip on selectionChanged and removes it when selection is cleared', function () {
    renderComposer()

    act(() => {
      window.dispatchEvent(
        new CustomEvent('aiAssist:selectionChanged', {
          detail: { path: 'main.tex', from: 23, to: 31, text: 'selected text' },
        })
      )
    })
    expect(screen.getByText(/main\.tex: 23-31/)).to.exist

    // When the user unhighlights/deselects in the editor:
    act(() => {
      window.dispatchEvent(
        new CustomEvent('aiAssist:selectionChanged', {
          detail: null,
        })
      )
    })
    expect(screen.queryByText(/main\.tex: 23-31/)).to.equal(null)
  })

  it('removes selection chip when clicking close button and ignores identical selection change events', function () {
    renderComposer()

    act(() => {
      window.dispatchEvent(
        new CustomEvent('aiAssist:selectionChanged', {
          detail: { path: 'main.tex', from: 23, to: 31, text: 'selected text' },
        })
      )
    })
    expect(screen.getByText(/main\.tex: 23-31/)).to.exist

    const closeBtn = screen.getByRole('button', { name: /remove selection/i })
    fireEvent.click(closeBtn)

    expect(screen.queryByText(/main\.tex: 23-31/)).to.equal(null)

    // A selectionchange event fires from the editor with the SAME selection (still highlighted)
    act(() => {
      window.dispatchEvent(
        new CustomEvent('aiAssist:selectionChanged', {
          detail: { path: 'main.tex', from: 23, to: 31, text: 'selected text' },
        })
      )
    })

    // It should still NOT re-add the dismissed selection
    expect(screen.queryByText(/main\.tex: 23-31/)).to.equal(null)

    // But if a DIFFERENT selection arrives, it should attach
    act(() => {
      window.dispatchEvent(
        new CustomEvent('aiAssist:selectionChanged', {
          detail: { path: 'main.tex', from: 50, to: 60, text: 'different text' },
        })
      )
    })
    expect(screen.getByText(/main\.tex: 50-60/)).to.exist
  })

  it('passes attachedSelection to onSend and clears it', function () {
    const { onSend } = renderComposer()

    act(() => {
      window.dispatchEvent(
        new CustomEvent('aiAssist:selectionChanged', {
          detail: { path: 'main.tex', from: 10, to: 15, text: 'some text' },
        })
      )
    })
    expect(screen.getByText(/main\.tex: 10-15/)).to.exist

    type('explain this')
    fireEvent.click(screen.getByRole('button', { name: /send/i }))

    expect(onSend.calledOnce).to.be.true
    expect(onSend.lastCall.args[0]).to.equal('explain this')
    expect(onSend.lastCall.args[2]).to.deep.equal({
      path: 'main.tex',
      from: 10,
      to: 15,
      text: 'some text',
    })
    expect(screen.queryByText(/main\.tex: 10-15/)).to.equal(null)
  })

  it('renders selection chip at the top of the chatbox above the textarea', function () {
    renderComposer()

    act(() => {
      window.dispatchEvent(
        new CustomEvent('aiAssist:selectionChanged', {
          detail: { path: 'main.tex', from: 23, to: 31, text: 'selected text' },
        })
      )
    })

    const textarea = document.querySelector('#ai-assist-composer-textarea')
    const chipWrapper = document.querySelector(
      '.ai-assist-selection-chip-wrapper'
    )

    expect(textarea).to.exist
    expect(chipWrapper).to.exist
    expect(
      Boolean(
        textarea!.compareDocumentPosition(chipWrapper!) &
        Node.DOCUMENT_POSITION_PRECEDING
      )
    ).to.be.true
  })

  it('renders both selection and file attachment chips with consistent SVG icon elements', function () {
    renderComposer({
      attachments: [{ path: 'main.tex' }],
      attachedSelection: {
        path: 'main.tex',
        from: 52,
        to: 57,
        text: 'some code',
      },
    })

    const chips = document.querySelectorAll('.ai-assist-selection-chip')
    expect(chips.length).to.equal(2)

    // Both chips carry a 12px SVG in the same icon slot
    chips.forEach((chip) => {
      const icon = chip.querySelector('.ai-assist-selection-chip-icon svg')
      expect(icon).to.exist
      expect(icon?.getAttribute('width')).to.equal('12')
      expect(icon?.getAttribute('height')).to.equal('12')
    })
  })

  it('renders a chip for each highlighted range when multiple parts of code are selected', function () {
    renderComposer({
      attachedSelection: {
        path: 'main.tex',
        from: 10,
        to: 30,
        text: 'first block\n\nsecond block',
        ranges: [
          { from: 10, to: 12, text: 'first block' },
          { from: 25, to: 30, text: 'second block' },
        ],
      },
    })

    const chips = document.querySelectorAll('.ai-assist-selection-chip')
    expect(chips.length).to.equal(2)
    expect(screen.getByText('main.tex: 10-12')).to.exist
    expect(screen.getByText('main.tex: 25-30')).to.exist
  })

  it('removes an individual range chip when its close button is clicked', function () {
    renderComposer()

    act(() => {
      window.dispatchEvent(
        new CustomEvent('aiAssist:selectionChanged', {
          detail: {
            path: 'main.tex',
            from: 10,
            to: 30,
            text: 'first block\n\nsecond block',
            ranges: [
              { from: 10, to: 12, text: 'first block' },
              { from: 25, to: 30, text: 'second block' },
            ],
          },
        })
      )
    })

    expect(screen.getByText('main.tex: 10-12')).to.exist
    expect(screen.getByText('main.tex: 25-30')).to.exist

    const removeButtons = screen.getAllByRole('button', {
      name: /remove selection/i,
    })
    expect(removeButtons.length).to.equal(2)

    // Click close on the first range (10-12)
    fireEvent.click(removeButtons[0])

    // Second range remains as a chip
    expect(screen.queryByText('main.tex: 10-12')).to.equal(null)
    expect(screen.getByText('main.tex: 25-30')).to.exist
  })

  describe('while running', function () {
    it('shows stop button when running and content is empty', function () {
      renderComposer({ running: true })
      expect(screen.getByRole('button', { name: /stop/i })).to.exist
      expect(screen.queryByRole('button', { name: /send/i })).to.equal(null)
    })

    it('calls onStop when stop button is clicked', function () {
      const onStop = sinon.stub()
      renderComposer({ running: true, onStop })
      fireEvent.click(screen.getByRole('button', { name: /stop/i }))
      expect(onStop.calledOnce).to.be.true
    })

    it('switches to send button when user types text while running', function () {
      renderComposer({ running: true })
      type('mid-generation follow-up')
      expect(screen.queryByRole('button', { name: /stop/i })).to.equal(null)
      expect(
        screen.getByRole('button', { name: /send to the running agent/i })
      ).to.exist
    })

    it('allows sending by clicking send button while running', function () {
      const onSend = sinon.stub()
      renderComposer({ running: true, onSend })
      type('steer agent to use package hyperref')
      const sendBtn = screen.getByRole('button', {
        name: /send to the running agent/i,
      })
      fireEvent.click(sendBtn)

      expect(onSend.calledOnce).to.be.true
      expect(onSend.lastCall.args[0]).to.equal(
        'steer agent to use package hyperref'
      )
    })

    it('allows sending by pressing Enter while running', function () {
      const onSend = sinon.stub()
      renderComposer({ running: true, onSend })
      const textarea = type('append this mid-run')
      fireEvent.keyDown(textarea, { key: 'Enter' })

      expect(onSend.calledOnce).to.be.true
      expect(onSend.lastCall.args[0]).to.equal('append this mid-run')
    })
  })
})
