import { expect } from 'chai'
import { fireEvent, render, screen } from '@testing-library/react'
import { TexGptPromptBar } from '../../../../frontend/js/features/ai-assist/components/texgpt/texgpt-prompt-bar'
import { GeneratorMenu } from '../../../../frontend/js/features/ai-assist/components/texgpt/texgpt-menu'
import { WritingToolsMenu } from '../../../../frontend/js/features/ai-assist/components/writing-tools/writing-tools-menu'

describe('texgpt: prompt bar and menus', function () {
  beforeEach(function () {
    document.body.innerHTML = ''
  })

  it('sends on Enter, keeps Shift+Enter for new lines, and stops while running', function () {
    const calls: string[] = []
    const bar = (running: boolean) => (
      <TexGptPromptBar
        value="Make a table"
        placeholder="Ask"
        running={running}
        onChange={() => {}}
        onSend={() => calls.push('send')}
        onStop={() => calls.push('stop')}
      />
    )
    const { rerender } = render(bar(false))
    const input = screen.getByPlaceholderText('Ask')
    expect(document.activeElement).to.equal(input)
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(calls).to.deep.equal([])
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(calls).to.deep.equal(['send'])
    rerender(bar(true))
    fireEvent.click(screen.getByRole('button', { name: 'Stop (Esc)' }))
    expect(calls).to.deep.equal(['send', 'stop'])
  })

  it('cannot send a blank prompt', function () {
    render(
      <TexGptPromptBar
        value="   "
        placeholder="Ask"
        running={false}
        onChange={() => {}}
        onSend={() => {}}
        onStop={() => {}}
      />
    )
    expect(
      (screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled
    ).to.equal(true)
  })

  it('lists the three generators', function () {
    const chosen: string[] = []
    render(<GeneratorMenu onChoose={id => chosen.push(id)} />)
    expect(
      screen
        .getAllByRole('menuitem')
        .map(
          item =>
            item.querySelector('.ai-texgpt-menu-item-label')?.textContent ??
            item.textContent
        )
    ).to.deep.equal([
      'Title Generator',
      'Abstract Generator',
      'Keywords Generator',
    ])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Keywords Generator' }))
    expect(chosen).to.deep.equal(['keywords'])
  })

  it('renders the writing tools list inline without taking the focus', function () {
    render(
      <>
        <input aria-label="bar" autoFocus />
        <WritingToolsMenu
          inline
          actions={['rephrase']}
          onChoose={() => {}}
          onClose={() => {}}
        />
      </>
    )
    expect(document.activeElement?.getAttribute('aria-label')).to.equal('bar')
    expect(document.querySelector('.ai-writing-tools-menu-inline')).to.not.equal(null)
  })
})
