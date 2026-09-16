import { expect } from 'chai'
import sinon from 'sinon'
import { act } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import {
  AgentComposer,
  mentionQueryAt,
} from '../../../../frontend/js/features/ai-assist/components/agent/agent-composer'

const PATHS = ['main.tex', 'sections/results.tex', 'refs.bib']

function renderComposer(overrides: Partial<Parameters<typeof AgentComposer>[0]> = {}) {
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
    expect(screen.getByRole('option', { name: /sections\/results\.tex/ })).to.exist
    expect(screen.queryByRole('option', { name: /refs\.bib/ })).to.equal(null)
  })

  it('adds a chip and removes the mention text when a file is picked', function () {
    renderComposer()
    type('explain @res')
    fireEvent.click(screen.getByRole('option', { name: /sections\/results\.tex/ }))

    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).to.equal('explain ')
    expect(screen.getByText('sections/results.tex')).to.exist
  })

  it('keeps a typed line range on the chip', function () {
    renderComposer()
    type('@sections/results.tex:40-80 ')
    expect(screen.getByText('sections/results.tex:40-80')).to.exist
  })

  it('sends the attachments alongside the text', function () {
    const { onSend } = renderComposer()
    type('explain @res')
    fireEvent.click(screen.getByRole('option', { name: /sections\/results\.tex/ }))
    fireEvent.click(screen.getByRole('button', { name: /send/i }))

    expect(onSend.lastCall.args[0]).to.equal('explain')
    expect(onSend.lastCall.args[1]).to.deep.equal([{ path: 'sections/results.tex' }])
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

  it('opens the same menu from the paperclip button', function () {
    renderComposer()
    fireEvent.click(screen.getByRole('button', { name: /attach context/i }))
    expect(screen.getByRole('listbox')).to.exist
  })

  it('toggles the menu open and closed when clicking the paperclip button', function () {
    renderComposer()
    const attachBtn = screen.getByRole('button', { name: /attach context/i })

    // First click: opens menu
    fireEvent.click(attachBtn)
    expect(screen.getByRole('listbox')).to.exist

    // Second click: closes menu
    fireEvent.click(attachBtn)
    expect(screen.queryByRole('listbox')).to.equal(null)
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
})
