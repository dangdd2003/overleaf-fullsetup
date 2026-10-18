import { expect } from 'chai'
import sinon from 'sinon'
import { render, screen, fireEvent } from '@testing-library/react'
import { SelectionQuickActions } from '../../../../../frontend/js/features/ai-assist/components/agent/selection-quick-actions'
import { SelectionInput } from '../../../../../frontend/js/features/ai-assist/agent/starters/selection-types'

describe('SelectionQuickActions component', function () {
  const tableSelection: SelectionInput = {
    path: 'sections/tables.tex',
    from: 10,
    to: 15,
    text: '\\begin{tabular}{ll}\nA & B \\\\\n1 & 2 \\\\\n\\end{tabular}',
    scope: {
      kind: 'table',
      env: 'tabular',
      lines: 4,
      numeric: false,
      inline: false,
    },
  }

  describe('list variant', function () {
    it('renders header with title, kind badge, and file range', function () {
      render(
        <SelectionQuickActions
          variant="list"
          selection={tableSelection}
          onPick={() => {}}
        />
      )

      expect(screen.getByText(/For your selection/i)).to.exist
      expect(screen.getByText('Table')).to.exist
      expect(screen.getByText('tables.tex:10-15')).to.exist
    })

    it('formats single-line range as file:line', function () {
      const singleLine: SelectionInput = {
        path: 'main.tex',
        from: 42,
        to: 42,
        text: 'Just one line',
        scope: {
          kind: 'prose',
          env: null,
          lines: 1,
          numeric: false,
          inline: false,
        },
      }

      render(
        <SelectionQuickActions
          variant="list"
          selection={singleLine}
          onPick={() => {}}
        />
      )

      expect(screen.getByText('main.tex:42')).to.exist
    })

    it('renders table-specific action buttons and triggers onPick with prompt', function () {
      const onPick = sinon.stub()
      render(
        <SelectionQuickActions
          variant="list"
          selection={tableSelection}
          onPick={onPick}
        />
      )

      const polishBtn = screen.getByRole('button', {
        name: /Polish this table/i,
      })
      expect(polishBtn).to.exist

      fireEvent.click(polishBtn)
      expect(onPick.calledOnce).to.be.true
      const action = onPick.firstCall.args[0]
      expect(action.id).to.equal('improve_table')
      expect(action.edits).to.be.true
      expect(action.prompt).to.include('lines 10-15 of sections/tables.tex')
    })

    it('disables buttons when disabled is true', function () {
      render(
        <SelectionQuickActions
          variant="list"
          selection={tableSelection}
          disabled={true}
          onPick={() => {}}
        />
      )

      const buttons = screen.getAllByRole('button')
      buttons.forEach(button => {
        expect(button.hasAttribute('disabled')).to.be.true
      })
    })
  })

  describe('chips variant', function () {
    it('renders at most MAX_SELECTION_CHIPS (3) in a toolbar', function () {
      render(
        <SelectionQuickActions
          variant="chips"
          selection={tableSelection}
          onPick={() => {}}
        />
      )

      const toolbar = screen.getByRole('toolbar')
      expect(toolbar).to.exist

      const chips = screen.getAllByRole('button')
      expect(chips.length).to.equal(3)
    })

    it('triggers onPick on chip click', function () {
      const onPick = sinon.stub()
      render(
        <SelectionQuickActions
          variant="chips"
          selection={tableSelection}
          onPick={onPick}
        />
      )

      const firstChip = screen.getAllByRole('button')[0]
      fireEvent.click(firstChip)
      expect(onPick.calledOnce).to.be.true
      expect(onPick.firstCall.args[0]).to.have.property('id')
      expect(onPick.firstCall.args[0]).to.have.property('prompt')
    })

    it('disables chips when disabled is true', function () {
      render(
        <SelectionQuickActions
          variant="chips"
          selection={tableSelection}
          disabled={true}
          onPick={() => {}}
        />
      )

      const chips = screen.getAllByRole('button')
      chips.forEach(chip => {
        expect(chip.hasAttribute('disabled')).to.be.true
      })
    })
  })
})
