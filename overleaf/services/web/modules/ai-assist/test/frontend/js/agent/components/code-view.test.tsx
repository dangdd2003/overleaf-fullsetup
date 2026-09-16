import React from 'react'
import { expect } from 'chai'
import { render, screen } from '@testing-library/react'
import CodeView from '../../../../../frontend/js/features/ai-assist/components/agent/code-view'

describe('CodeView', function () {
  it('renders numbered lines in gutter and code content', function () {
    const { container } = render(
      <CodeView
        lines={['\\documentclass{article}', '\\begin{document}']}
        startLine={10}
      />
    )

    const gutters = container.querySelectorAll('.diff-gutter')
    expect(gutters).to.have.length(2)
    expect(gutters[0].textContent).to.contain('10')
    expect(gutters[1].textContent).to.contain('11')

    expect(screen.getByText('\\documentclass{article}')).to.exist
    expect(screen.getByText('\\begin{document}')).to.exist
  })

  it('correctly parses line prefix when lines already contain line numbers', function () {
    const { container } = render(
      <CodeView
        content={'25: \\section{Introduction}\n26: This is text.'}
      />
    )

    const gutters = container.querySelectorAll('.diff-gutter')
    expect(gutters).to.have.length(2)
    expect(gutters[0].textContent).to.contain('25')
    expect(gutters[1].textContent).to.contain('26')

    expect(screen.getByText('\\section{Introduction}')).to.exist
    expect(screen.getByText('This is text.')).to.exist
  })

  it('renders editor clone container with cm-editor and preview classes', function () {
    const { container } = render(
      <CodeView content={'line 1\nline 2'} />
    )

    const editorEl = container.querySelector('.cm-editor.cm-editor-preview')
    expect(editorEl).to.exist
    expect(editorEl?.className).to.contain('ai-suggest-code-diff')
  })

  it('calls onLineClick when a line number in gutter is clicked', function () {
    let clickedLine = 0
    const { container } = render(
      <CodeView
        lines={['first line', 'second line']}
        startLine={42}
        onLineClick={line => {
          clickedLine = line
        }}
      />
    )

    const gutter = container.querySelectorAll('.diff-gutter.diff-gutter-clickable')[0] as HTMLElement
    expect(gutter).to.exist
    gutter.click()
    expect(clickedLine).to.equal(42)
  })
})
