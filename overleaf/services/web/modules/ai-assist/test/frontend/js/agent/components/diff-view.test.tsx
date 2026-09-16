import { expect } from 'chai'
import { render, screen } from '@testing-library/react'
import DiffView from '../../../../../frontend/js/features/ai-assist/components/agent/diff-view'

describe('DiffView', function () {
  it('highlights only the changed span on a single-line edit', function () {
    render(
      <DiffView
        oldText="\usepackage{title asfsa sec}"
        newText="\usepackage{titlesec}"
        startLine={13}
      />
    )

    expect(screen.getByText('title asfsa sec').className).to.contain('diff-del')
    expect(screen.getByText('titlesec').className).to.contain('diff-ins')
    expect(screen.getAllByText(/13/)).to.have.length.greaterThan(0)
  })

  it('renders an unchanged line as context, not as delete plus insert', function () {
    const { container } = render(
      <DiffView
        oldText={'\\alpha\n\\beta\n\\gamma'}
        newText={'\\alpha\n\\BETA\n\\gamma'}
        startLine={5}
      />
    )

    expect(container.querySelectorAll('.diff-line-context')).to.have.length(2)
    expect(container.querySelectorAll('.diff-line-del')).to.have.length(1)
    expect(container.querySelectorAll('.diff-line-ins')).to.have.length(1)
  })

  it('folds the middle of a long hunk', function () {
    const oldText = Array.from({ length: 40 }, (_unused, i) => `old ${i}`).join('\n')
    const newText = Array.from({ length: 40 }, (_unused, i) => `new ${i}`).join('\n')

    render(<DiffView oldText={oldText} newText={newText} startLine={1} />)

    expect(screen.getByText(/more lines/)).to.exist
  })

  it('renders editor clone container with cm-editor and preview classes', function () {
    const { container } = render(
      <DiffView
        oldText="old line"
        newText="new line"
        startLine={1}
      />
    )

    const editorEl = container.querySelector('.cm-editor.cm-editor-preview')
    expect(editorEl).to.exist
    expect(editorEl?.className).to.contain('ai-suggest-code-diff')
  })

  it('calls onLineClick when a gutter line number is clicked', function () {
    let clickedLine = 0
    const { container } = render(
      <DiffView
        oldText="line 1\nline 2"
        newText="line 1\nmodified 2"
        startLine={10}
        onLineClick={line => {
          clickedLine = line
        }}
      />
    )

    const clickableGutter = container.querySelector('.diff-gutter.diff-gutter-clickable') as HTMLElement
    expect(clickableGutter).to.exist
    clickableGutter.click()
    expect(clickedLine).to.be.greaterThan(0)
  })

  it('renders new file creation with line numbers and ins markers', function () {
    const { container } = render(
      <DiffView
        oldText=""
        newText={'line one\nline two'}
        startLine={1}
      />
    )

    expect(container.querySelectorAll('.diff-line-ins')).to.have.length(2)
    expect(screen.getByText('line one')).to.exist
    expect(screen.getByText('line two')).to.exist
  })
})
