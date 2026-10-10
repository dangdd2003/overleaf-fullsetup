import { expect } from 'chai'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import {
  TableCard,
  TableCardProps,
  TableVersion,
} from '../../../../frontend/js/features/ai-assist/components/table/table-card'

const LATEX = [
  '\\begin{table}[htbp]',
  '  \\centering',
  '  \\caption{Accuracy.}',
  '  \\label{tab:acc}',
  '  \\begin{tabular}{l r}',
  '    \\toprule',
  '    A & 1 \\\\',
  '    \\bottomrule',
  '  \\end{tabular}',
  '\\end{table}',
].join('\n')

const VERSION: TableVersion = {
  kind: 'table',
  env: 'tabular',
  spec: 'l r',
  label: 'tab:acc',
  caption: 'Accuracy.',
  body: '\\toprule\nA & 1 \\\\\n\\bottomrule',
  latex: LATEX,
  text: LATEX,
  cursorOffset: LATEX.length,
  columns: 2,
  rows: 1,
  packages: [],
  notes: null,
  warnings: [],
  raw: '',
  messages: [],
}

function props(overrides: Partial<TableCardProps> = {}): TableCardProps {
  return {
    title: 'accuracy',
    imageAttached: false,
    phase: { name: 'ready' },
    versions: [VERSION],
    index: 0,
    onIndex: () => {},
    original: '',
    streamingCode: null,
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

describe('table: card', function () {
  afterEach(function () {
    cleanup()
    document.body.innerHTML = ''
  })

  it('shows the LaTeX and a summary, and no Changes at a cursor', function () {
    render(<TableCard {...props()} />)
    expect(screen.getByText('2 columns · 1 row · booktabs')).to.exist
    expect(document.querySelector('.ai-table-latex')!.textContent).to.include('\\label{tab:acc}')
    expect(screen.queryByText('Changes')).to.equal(null)
    expect(screen.getByRole('button', { name: /Regenerate/ })).to.exist
  })

  it('shows the change when it replaces a selection', function () {
    render(<TableCard {...props({ original: 'a,b\n1,2' })} />)
    expect(screen.getByText('Changes')).to.exist
    expect(document.querySelector('.ai-table-diff')).to.not.equal(null)
  })

  it('streams the rows as they come', async function () {
    render(
      <TableCard
        {...props({
          phase: { name: 'streaming', reply: null, repairing: false },
          versions: [],
          streamingCode: '\\begin{tabular}{l r}\n  A & 1 \\\\',
        })}
      />
    )
    await waitFor(() => {
      expect(document.querySelector('.ai-table-latex')!.textContent).to.include('A & 1')
    })
  })

  it('explains a model that cannot read images', function () {
    render(<TableCard {...props({ phase: { name: 'imageUnsupported' }, versions: [] })} />)
    expect(
      screen.getByText(
        "This model can't read images. Choose a vision-capable model in AI settings, or paste the cells as text."
      )
    ).to.exist
  })
})
