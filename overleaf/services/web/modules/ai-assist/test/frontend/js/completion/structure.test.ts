import { expect } from 'chai'
import {
  continuesParagraph,
  envRole,
  roleAt,
} from '../../../../frontend/js/features/ai-assist/completion/structure'

describe('completion: LaTeX structure', function () {
  it('knows what the common environments hold', function () {
    const roles = (names: string[]) => names.map(name => envRole(name, ''))
    expect(roles(['itemize', 'enumerate*', 'compactitem', 'tasks', 'questions', 'choices'])).to.deep.equal(
      Array(6).fill('list')
    )
    expect(roles(['tabular', 'tblr', 'longtable', 'align*', 'aligned', 'pmatrix', 'dcases', 'IEEEeqnarray'])).to.deep.equal(
      Array(8).fill('rows')
    )
    expect(roles(['equation', 'equation*', 'dmath', 'subequations'])).to.deep.equal(Array(4).fill('math'))
    expect(roles(['verbatim', 'lstlisting', 'minted', 'algorithmic', 'pycode'])).to.deep.equal(Array(5).fill('code'))
    expect(roles(['tikzpicture', 'axis', 'scope', 'circuitikz', 'forest'])).to.deep.equal(Array(5).fill('drawing'))
    expect(roles(['figure', 'table*', 'subfigure', 'wrapfigure', 'algorithm'])).to.deep.equal(Array(5).fill('float'))
    expect(roles(['thebibliography', 'comment', 'filecontents*'])).to.deep.equal(Array(3).fill('skip'))
    // Theorems, quotes, frames, anything unknown: paragraphs
    expect(roles(['abstract', 'theorem', 'proof', 'quote', 'frame', 'mycustomthing'])).to.deep.equal(Array(6).fill('prose'))
  })

  it('recognises environments the document defines', function () {
    const doc = [
      '\\newlist{steps}{enumerate}{3}',
      '\\lstnewenvironment{pythonlisting}{\\lstset{language=Python}}{}',
      '\\DefineVerbatimEnvironment{console}{Verbatim}{}',
      '\\newminted{python}{linenos}',
      '\\newenvironment{mylist}{\\begin{itemize}\\setlength{\\itemsep}{0pt}}{\\end{itemize}}',
      '\\NewDocumentEnvironment{plot}{}{\\begin{tikzpicture}}{\\end{tikzpicture}}',
      '\\newenvironment{note}{\\begin{quote}\\small}{\\end{quote}}',
      '% \\newlist{ignored}{itemize}{1}',
    ].join('\n')
    expect(
      ['steps', 'pythonlisting', 'console', 'pythoncode', 'mylist', 'plot', 'note', 'ignored'].map(name =>
        envRole(name, doc)
      )
    ).to.deep.equal(['list', 'code', 'code', 'code', 'list', 'drawing', 'prose', 'prose'])
  })

  it('takes the innermost environment, but anything inside a bibliography is skipped', function () {
    expect(roleAt(['figure', 'tikzpicture'], '')).to.equal('drawing')
    expect(roleAt(['itemize', 'theorem'], '')).to.equal('prose')
    expect(roleAt(['thebibliography', 'itemize'], '')).to.equal('skip')
    expect(roleAt([], '')).to.equal(null)
  })

  it('tells a line of the paragraph from a structural line or a blank one', function () {
    expect(continuesParagraph('We trained the model on three datasets.')).to.equal(true)
    expect(continuesParagraph('the results, as \\cite{x} shows, hold \\\\')).to.equal(true)
    expect(continuesParagraph('\\textbf{Note:} this holds.')).to.equal(true)
    expect(continuesParagraph('\\emph{Results}')).to.equal(true)
    for (const line of [
      '',
      '   ',
      '% only a comment',
      '\\section{Method}',
      '\\subsection*{Data}',
      '\\end{itemize}',
      '\\begin{abstract}',
      '\\label{sec:method}',
      '\\maketitle',
      '\\includegraphics[width=\\linewidth]{fig.pdf}',
      '\\caption{A caption with {nested} braces}',
    ]) {
      expect(continuesParagraph(line), line).to.equal(false)
    }
    expect(continuesParagraph(null)).to.equal(false)
  })
})
