import { expect } from 'chai'
import { scanProse } from '../../../../frontend/js/features/ai-assist/language-suggestions/prose'

const PAPER = [
  '\\documentclass{article}',
  '\\usepackage{amsmath}',
  '\\begin{document}',
  '\\section{Introduction}',
  'We study \\emph{very} large models~\\cite{smith20}, as in Fig.~\\ref{fig:a}.',
  'The loss $L = x^2$ is small % a comment',
  'and fast.',
  '',
  '\\begin{equation}',
  'E = mc^2',
  '\\end{equation}',
  'R\\&D costs 50\\% less.\\footnote{See the appendix for details.}',
  '\\end{document}',
].join('\n')

function texts(doc: string) {
  return scanProse(doc).map(p => [p.container, p.masked.text])
}

describe('language suggestions: prose scanner', function () {
  it('reads the body only, paragraph by paragraph, with the LaTeX masked', function () {
    expect(texts(PAPER)).to.deep.equal([
      ['heading', 'Introduction'],
      [
        'text',
        'We study very large models [[C1]], as in Fig. [[R1]]. The loss [[M1]] is small and fast.',
      ],
      ['text', 'R&D costs 50% less.[[X1]]'],
      ['footnote', 'See the appendix for details.'],
    ])
  })

  it('knows where every character came from', function () {
    const [, paragraph] = scanProse(PAPER)
    const { text, starts, ends, kinds, placeholders } = paragraph.masked

    const very = text.indexOf('very')
    expect(PAPER.slice(starts[very], ends[very + 3])).to.equal('very')

    expect(placeholders[0]).to.include({ kind: 'C', token: '[[C1]]', source: '\\cite{smith20}' })
    expect(PAPER.slice(placeholders[0].from, placeholders[0].to)).to.equal('\\cite{smith20}')

    const tilde = text.indexOf('Fig. ') + 4
    expect(kinds[tilde]).to.equal('hard')
    expect(PAPER.slice(starts[tilde], ends[tilde])).to.equal('~')

    const lineBreak = text.indexOf(' The loss')
    expect(kinds[lineBreak]).to.equal('break')
    expect(PAPER.slice(starts[lineBreak], ends[lineBreak])).to.equal('\n')
  })

  it('turns escaped specials into plain characters', function () {
    const paragraph = scanProse(PAPER)[2].masked
    const amp = paragraph.text.indexOf('&')
    expect(paragraph.kinds[amp]).to.equal('escaped')
    expect(PAPER.slice(paragraph.starts[amp], paragraph.ends[amp])).to.equal('\\&')
  })

  it('gives lists, the abstract and captions their own paragraphs, and skips tables and code', function () {
    const doc = [
      '\\begin{abstract}',
      'We propose a method.',
      '\\end{abstract}',
      '\\begin{itemize}',
      '  \\item First point here.',
      '  \\item[(b)] Second point here.',
      '\\end{itemize}',
      '\\begin{tabular}{ll}',
      'a & b \\\\',
      '\\end{tabular}',
      '\\begin{figure}',
      '\\centering',
      '\\includegraphics[width=\\linewidth]{plot}',
      '\\caption[Short]{Results of the \\textbf{main} run.}',
      '\\label{fig:plot}',
      '\\end{figure}',
      '\\begin{verbatim}',
      'not prose at all',
      '\\end{verbatim}',
    ].join('\n')
    expect(texts(doc)).to.deep.equal([
      ['abstract', 'We propose a method.'],
      ['item', 'First point here.'],
      ['item', 'Second point here.'],
      ['caption', 'Results of the main run.'],
    ])
  })

  it('follows TeX on comments: a comment eats its line end, a blank line still ends the paragraph', function () {
    const doc = [
      'First line of text % note',
      'continues here.',
      '% a whole comment line',
      'Still the same paragraph. % note',
      '',
      'New paragraph after a comment.',
    ].join('\n')
    expect(texts(doc)).to.deep.equal([
      ['text', 'First line of text continues here. Still the same paragraph.'],
      ['text', 'New paragraph after a comment.'],
    ])
  })

  it('keeps link text, masks code and URLs, and protects accents and dots', function () {
    const doc =
      "See \\href{https://x.org}{our site} and \\texttt{main.py} or \\url{https://y.org}; the caf\\'e is open\\ldots"
    const [paragraph] = scanProse(doc)
    expect(paragraph.masked.text).to.equal(
      'See our site and [[X1]] or [[X2]]; the café is open...'
    )
    const accent = paragraph.masked.text.indexOf('é')
    expect(paragraph.masked.kinds[accent]).to.equal('hard')
    expect(paragraph.masked.kinds.at(-1)).to.equal('hard')
  })

  it('ends a paragraph at display math', function () {
    expect(texts('Before we start.\n\\[ x = 1 \\]\nAfter that we go on.')).to.deep.equal([
      ['text', 'Before we start.'],
      ['text', 'After that we go on.'],
    ])
    expect(texts('Text before here. $$ y $$ text after here.')).to.deep.equal([
      ['text', 'Text before here.'],
      ['text', 'text after here.'],
    ])
  })

  it('reads a file with no \\begin{document} whole', function () {
    expect(texts('A chapter starts here.\n\n\\subsection{Next part}')).to.deep.equal([
      ['text', 'A chapter starts here.'],
      ['heading', 'Next part'],
    ])
  })
})
