import { expect } from 'chai'
import {
  documentClassOf,
  findCommandArgument,
  findEnvironmentBody,
  maskComments,
  matchingBrace,
  stripComments,
  trimRange,
} from '../../../../frontend/js/features/ai-assist/texgpt/latex-text'

describe('texgpt: latex text', function () {
  it('blanks comments without moving anything', function () {
    const text = 'a % note\n50\\% b'
    const masked = maskComments(text)
    expect(masked).to.have.length(text.length)
    expect(masked).to.equal('a' + ' '.repeat(7) + '\n50\\% b')
  })

  it('drops comments and comment-only lines', function () {
    expect(stripComments('a % x\n% whole line\nb')).to.equal('a \nb')
  })

  it('finds the matching brace, skipping escaped ones', function () {
    const text = '{a \\} {b}}c'
    expect(matchingBrace(text, 0)).to.equal(text.length - 2)
  })

  it('finds the argument of a command, after optional arguments', function () {
    const text = '\\title[Short]{A {nested} title}'
    const range = findCommandArgument(text, 'title')!
    expect(text.slice(range.from, range.to)).to.equal('A {nested} title')
  })

  it('skips commented uses, definitions and longer command names', function () {
    const text = [
      '% \\title{Commented}',
      '\\newcommand{\\keywords}[1]{\\textbf{#1}}',
      '\\maketitle \\titlepage',
      '\\keywords{real}',
    ].join('\n')
    expect(findCommandArgument(text, 'title')).to.equal(null)
    const range = findCommandArgument(text, 'keywords')!
    expect(text.slice(range.from, range.to)).to.equal('real')
  })

  it('finds an environment body outside comments', function () {
    const text = 'x\\begin{abstract}\n  Body.\n\\end{abstract}y'
    const range = findEnvironmentBody(text, 'abstract')!
    expect(text.slice(range.from, range.to)).to.equal('\n  Body.\n')
    expect(
      findEnvironmentBody('% \\begin{abstract}x\\end{abstract}', 'abstract')
    ).to.equal(null)
  })

  it('correctly matches nested environments of the same type', function () {
    const text = '\\begin{itemize}\n  \\item outer\n  \\begin{itemize}\n    \\item inner\n  \\end{itemize}\n  \\item outer again\n\\end{itemize}'
    const range = findEnvironmentBody(text, 'itemize')!
    expect(text.slice(range.from, range.to)).to.equal(
      '\n  \\item outer\n  \\begin{itemize}\n    \\item inner\n  \\end{itemize}\n  \\item outer again\n'
    )
  })

  it('trims a range to its text, flagging an empty one', function () {
    expect(trimRange('{  a b \n}', { from: 1, to: 8 })).to.deep.equal({
      from: 3,
      to: 6,
      empty: false,
    })
    expect(trimRange('{ \n }', { from: 1, to: 4 })).to.deep.equal({
      from: 1,
      to: 4,
      empty: true,
    })
  })

  it('reads the document class', function () {
    expect(
      documentClassOf('% \\documentclass{old}\n\\documentclass[11pt]{ IEEEtran }')
    ).to.equal('IEEEtran')
    expect(documentClassOf('no class')).to.equal(null)
  })
})
