import { expect } from 'chai'
import {
  fitPaper,
  flattenDocument,
  MAX_KEYS_LISTED,
  paperDigest,
  PAPER_BUDGET,
  PAPER_HEAD,
  PAPER_TAIL,
  projectClass,
  projectKeys,
  projectPackages,
  ProjectSource,
} from '../../../../frontend/js/features/ai-assist/texgpt/project-text'

function source(
  docs: Record<string, string>,
  rootPath: string | null = 'main.tex',
  openPath = 'main.tex'
): ProjectSource {
  return { docs, rootPath, openPath, complete: true }
}

describe('texgpt: project text', function () {
  it('inlines \\input, \\include and \\subfile files in reading order', function () {
    const text = flattenDocument(
      source({
        'main.tex': 'A\n\\input{sections/intro}\n\\include{sections/end.tex}\nZ',
        'sections/intro.tex': 'Intro % note\n\\subfile{sections/detail}',
        'sections/detail.tex': 'Detail',
        'sections/end.tex': 'End',
      })
    )
    expect(text).to.equal('A\nIntro \nDetail\nEnd\nZ')
  })

  it('resolves inputs relative to the including file and stops on cycles', function () {
    const text = flattenDocument(
      source({
        'main.tex': '\\input{chapters/one}',
        'chapters/one.tex': 'One \\input{two} \\input{main}',
        'chapters/two.tex': 'Two',
      })
    )
    expect(text).to.equal('One Two \\input{main}')
  })

  it('starts from the open file when the root is unknown', function () {
    expect(
      flattenDocument(source({ 'ch.tex': 'Chapter' }, null, 'ch.tex'))
    ).to.equal('Chapter')
  })

  it('keeps the start, the end and the headings of a long paper', function () {
    const filler = (n: number) => 'x'.repeat(n)
    const text = `${filler(PAPER_HEAD)}\n\\section{Middle}\n${filler(20000)}\n${filler(PAPER_TAIL)}`
    const fitted = fitPaper(text)
    expect(fitted.cut).to.equal(true)
    expect(fitted.text).to.include('\\section{Middle}')
    expect(fitted.text.startsWith(filler(100))).to.equal(true)
    expect(fitted.text.length).to.be.below(PAPER_BUDGET)
    expect(fitPaper('short')).to.deep.equal({ text: 'short', cut: false })
  })

  it('collects the packages and the class', function () {
    const s = source({
      'main.tex':
        '\\documentclass{IEEEtran}\n\\usepackage{amsmath,graphicx}\n% \\usepackage{old}',
      'sec.tex': '\\usepackage[table]{xcolor}',
      'refs.bib': '\\usepackage{nope}',
    })
    expect([...projectPackages(s)].sort()).to.deep.equal([
      'amsmath',
      'graphicx',
      'xcolor',
    ])
    expect(projectClass(s)).to.equal('IEEEtran')
  })

  it('lists the bibliography keys, cited ones first, and the labels, the open file first', function () {
    const keys = projectKeys(
      source(
        {
          'main.tex': '\\label{sec:intro} \\cite{b2}\n% \\bibitem{gone}',
          'ch.tex':
            '\\label{fig:a}\n\\begin{thebibliography}{9}\n\\bibitem{c3} C.\n\\end{thebibliography}',
          'refs.bib': '@article{a1,\n  title={A}}\n@book{b2,\n  title={B}}',
        },
        'main.tex',
        'ch.tex'
      )
    )
    expect(keys.citeKeys).to.deep.equal(['b2', 'a1', 'c3'])
    expect(keys.labels).to.deep.equal(['fig:a', 'sec:intro'])
  })

  it('caps both lists', function () {
    const count = MAX_KEYS_LISTED + 20
    const bib = Array.from({ length: count }, (_, i) => `@misc{k${i},}`).join('\n')
    const labels = Array.from({ length: count }, (_, i) => `\\label{l${i}}`).join('\n')
    const keys = projectKeys(source({ 'main.tex': labels, 'refs.bib': bib }))
    expect(keys.citeKeys).to.have.length(MAX_KEYS_LISTED)
    expect(keys.labels).to.have.length(MAX_KEYS_LISTED)
  })

  it('keeps the title and the body, without bibliography or appendices', function () {
    const text = [
      '\\documentclass{article}',
      '\\usepackage{amsmath}',
      '\\newcommand{\\R}{\\mathbb{R}}',
      '\\title{Fast \\emph{Sorting}}',
      '\\begin{document}',
      '\\maketitle',
      'Body text.',
      '\\begin{thebibliography}{9}',
      '\\bibitem{a} A.',
      '\\end{thebibliography}',
      '\\appendix',
      '\\section{Proofs}',
      'Long proof.',
      '\\end{document}',
    ].join('\n')
    expect(paperDigest(text)).to.equal(
      '\\title{Fast \\emph{Sorting}}\n\n\\maketitle\nBody text.'
    )
  })

  it('drops appendices written as an environment', function () {
    expect(paperDigest('Intro.\n\\begin{appendices}\nA.\n\\end{appendices}')).to.equal(
      'Intro.'
    )
  })

  it('keeps the conclusion and the captions of a long paper', function () {
    const filler = (n: number) => 'x'.repeat(n)
    const text = [
      filler(PAPER_HEAD),
      '\\section{Results}',
      filler(20000),
      '\\begin{figure}\\caption{Accuracy per model.}\\end{figure}',
      filler(5000),
      '\\section{Conclusion}',
      'We conclude.',
      filler(10000),
    ].join('\n')
    const fitted = fitPaper(text)
    expect(fitted.cut).to.equal(true)
    expect(fitted.text).to.include('\\section{Results}')
    expect(fitted.text).to.include('\\caption{Accuracy per model.}')
    expect(fitted.text).to.include('\\section{Conclusion}\nWe conclude.')
    expect(fitted.text.length).to.be.below(PAPER_BUDGET)
  })
})
