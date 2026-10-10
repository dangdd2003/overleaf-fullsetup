import { expect } from 'chai'
import sinon from 'sinon'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  EquationCard,
  EquationCardProps,
  EquationVersion,
} from '../../../../frontend/js/features/ai-assist/components/equation/equation-card'

const WRAPPED = '\\begin{equation}\n  E = mc^2\n  \\label{eq:e}\n\\end{equation}'
const ORIGINAL = 'Energy is where m is mass.'

const VERSION: EquationVersion = {
  kind: 'equation',
  form: 'equation',
  label: 'eq:e',
  body: 'E = mc^2',
  wrapped: WRAPPED,
  withEdits: `Energy is\n${WRAPPED}\nwhere $m$ is mass.`,
  equationOnly: `Energy is\n${WRAPPED}\nwhere m is mass.`,
  editCount: 1,
  editsSkipped: false,
  packages: [],
  notes: 'Read c as the speed of light',
  warnings: [],
  raw: '',
  messages: [],
}

function props(overrides: Partial<EquationCardProps> = {}): EquationCardProps {
  return {
    title: 'mass-energy equivalence',
    imageAttached: false,
    phase: { name: 'ready' },
    versions: [VERSION],
    index: 0,
    onIndex: () => {},
    original: ORIGINAL,
    definitions: '',
    applyEdits: true,
    onApplyEdits: () => {},
    canAddPackages: false,
    addPackages: true,
    onAddPackages: () => {},
    stale: false,
    followUp: '',
    onFollowUp: () => {},
    onSendFollowUp: () => {},
    onStop: () => {},
    onRetry: () => {},
    onEditPrompt: () => {},
    onDiscard: () => {},
    onInsert: () => {},
    onConsent: () => {},
    ...overrides,
  }
}

/** The text the diff shows as the result: everything but the deletions. */
function diffResult() {
  const diff = document.querySelector('.ai-equation-diff')!
  return [...diff.childNodes]
    .filter(node => node.nodeName !== 'DEL')
    .map(node => node.textContent)
    .join('')
}

describe('equation: card', function () {
  afterEach(function () {
    cleanup()
    document.body.innerHTML = ''
  })

  it('shows the change with the edits around it, and the code', function () {
    render(<EquationCard {...props()} />)
    expect(screen.getByText('mass-energy equivalence')).to.exist
    expect(diffResult()).to.equal(VERSION.withEdits)
    expect((screen.getByLabelText('Also apply 1 small edit around it') as HTMLInputElement).checked).to.equal(true)
    expect(document.querySelector('.ai-equation-latex')!.textContent).to.include('\\label{eq:e}')
    expect(screen.getByText('Read c as the speed of light')).to.exist
  })

  it('switches to the equation alone', function () {
    const onApplyEdits = sinon.spy()
    const { rerender } = render(<EquationCard {...props({ onApplyEdits })} />)
    fireEvent.click(screen.getByLabelText('Also apply 1 small edit around it'))
    expect(onApplyEdits.calledWith(false)).to.equal(true)
    rerender(<EquationCard {...props({ applyEdits: false })} />)
    expect(diffResult()).to.equal(VERSION.equationOnly)
  })

  it('says when the edits around it were skipped', function () {
    render(<EquationCard {...props({ versions: [{ ...VERSION, editCount: 0, editsSkipped: true }] })} />)
    expect(screen.getByText('Edits around it were skipped.')).to.exist
    expect(screen.queryByLabelText(/small edit/)).to.equal(null)
  })

  it('inserts on click and on Ctrl+Enter', function () {
    const onInsert = sinon.spy()
    render(<EquationCard {...props({ onInsert })} />)
    fireEvent.click(screen.getByRole('button', { name: /^Insert/ }))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter', ctrlKey: true })
    expect(onInsert.callCount).to.equal(2)
  })

  it('refuses to insert over changed text', function () {
    render(<EquationCard {...props({ stale: true })} />)
    expect((screen.getByRole('button', { name: /^Insert/ }) as HTMLButtonElement).disabled).to.equal(true)
    expect(screen.getByText('The text changed since this was written. Retry to work on the current text.')).to.exist
  })

  it('streams, stops on Esc, and discards on Esc once done', function () {
    const onStop = sinon.spy()
    const onDiscard = sinon.spy()
    const streaming = props({
      phase: { name: 'streaming', reply: null, repairing: false },
      versions: [],
      imageAttached: true,
      onStop,
      onDiscard,
    })
    const { rerender } = render(<EquationCard {...streaming} />)
    expect(screen.getByText('Reading the image…')).to.exist
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onStop.calledOnce).to.equal(true)
    rerender(<EquationCard {...props({ onDiscard })} />)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onDiscard.calledOnce).to.equal(true)
  })

  it('explains a model that cannot read images', function () {
    render(<EquationCard {...props({ phase: { name: 'imageUnsupported' }, versions: [] })} />)
    expect(
      screen.getByText(
        "This model can't read images. Choose a vision-capable model in AI settings, or describe the equation in words."
      )
    ).to.exist
  })

  it('asks for consent before the first request', function () {
    const onConsent = sinon.spy()
    render(<EquationCard {...props({ phase: { name: 'consent' }, versions: [], onConsent })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Allow and continue' }))
    expect(onConsent.calledOnce).to.equal(true)
  })

  it('browses versions and offers the missing package', function () {
    const onIndex = sinon.spy()
    render(
      <EquationCard
        {...props({
          versions: [VERSION, { ...VERSION, packages: ['mathtools'] }],
          index: 1,
          onIndex,
          canAddPackages: true,
        })}
      />
    )
    expect(screen.getByText('2/2')).to.exist
    fireEvent.click(screen.getByRole('button', { name: 'Previous version' }))
    expect(onIndex.calledWith(0)).to.equal(true)
    expect(screen.getByText('Also add \\usepackage{mathtools} to the preamble')).to.exist
  })
})
