import { expect } from 'chai'
import {
  classifySelectionInDoc,
  classifySelectionText,
} from '../../../../../frontend/js/features/ai-assist/agent/starters/classify-selection'
import { SelectionScope } from '../../../../../frontend/js/features/ai-assist/agent/starters/selection-types'

/** A small document: a preamble, then the body inside `document`. */
function documentWith(body: string, preamble = '\\documentclass{article}\n\\usepackage{amsmath}'): string {
  return [preamble, '\\begin{document}', body, '\\end{document}'].join('\n')
}

/** Classifies the one occurrence of `needle` in `doc`. */
function classifyAt(doc: string, needle: string, path = 'main.tex'): SelectionScope {
  const from = doc.indexOf(needle)
  expect(from, `"${needle}" is in the document`).to.be.at.least(0)
  expect(doc.indexOf(needle, from + 1), `"${needle}" is unique`).to.equal(-1)
  return classifySelectionInDoc(doc, from, from + needle.length, path)
}

describe('classifySelectionText', function () {
  describe('rule 1: bibliography files', function () {
    it('classifies any text in a .bib file as bibtex', function () {
      const scope = classifySelectionText('@article{key,\n  title = {Hi there}\n}', 'refs.bib')
      expect(scope.kind).to.equal('bibtex')
      expect(scope.env).to.be.null
      expect(scope.lines).to.equal(3)
    })

    it('matches the extension case-insensitively', function () {
      expect(classifySelectionText('@book{a, title = {B}}', 'Library/REFS.BIB').kind).to.equal('bibtex')
    })

    it('beats the structural rules', function () {
      expect(classifySelectionText('\\begin{tikzpicture}', 'a.bib').kind).to.equal('bibtex')
    })

    it('ignores a .bib that is not the extension', function () {
      expect(classifySelectionText('Some words here', 'notes.bib.tex').kind).to.equal('prose')
    })
  })

  describe('rule 2: TikZ and PGF', function () {
    it('takes the picture environment as the env', function () {
      const scope = classifySelectionText(
        '\\begin{tikzpicture}[scale=2]\n\\draw (0,0) -- (1,1);\n\\end{tikzpicture}',
        'main.tex'
      )
      expect(scope.kind).to.equal('tikz')
      expect(scope.env).to.equal('tikzpicture')
    })

    it('recognises a pgfplots axis', function () {
      const scope = classifySelectionText('\\begin{axis}\n\\addplot {x};\n\\end{axis}', 'main.tex')
      expect(scope.kind).to.equal('tikz')
      expect(scope.env).to.equal('axis')
    })

    it('recognises a drawing statement with no env', function () {
      const scope = classifySelectionText('\\node at (0,0) {A};', 'main.tex')
      expect(scope.kind).to.equal('tikz')
      expect(scope.env).to.be.null
    })

    it('recognises \\fill with options', function () {
      expect(classifySelectionText('\\fill[red] (0,0) circle (1);', 'main.tex').kind).to.equal('tikz')
    })

    it('beats the table rule', function () {
      const scope = classifySelectionText(
        '\\begin{tikzpicture}\n\\draw (0,0) -- (1,1);\n\\end{tikzpicture}\n\\begin{tabular}{l}\nA\n\\end{tabular}',
        'main.tex'
      )
      expect(scope.kind).to.equal('tikz')
    })
  })

  describe('rule 3: tables', function () {
    it('takes a tabular environment as the env', function () {
      const scope = classifySelectionText('\\begin{tabular}{lr}\nA & 1 \\\\\n\\end{tabular}', 'main.tex')
      expect(scope.kind).to.equal('table')
      expect(scope.env).to.equal('tabular')
    })

    it('takes the table float as a table', function () {
      const scope = classifySelectionText('\\begin{table}\n\\caption{Results}\n\\end{table}', 'main.tex')
      expect(scope.kind).to.equal('table')
      expect(scope.env).to.equal('table')
    })

    it('takes two rows of & ending in a row break as a table with no env', function () {
      const scope = classifySelectionText('a & b \\\\\nc & d \\\\', 'main.tex')
      expect(scope.kind).to.equal('table')
      expect(scope.env).to.be.null
    })

    it('does not take a single row as a table', function () {
      expect(classifySelectionText('a & b \\\\', 'main.tex').kind).to.equal('latex')
    })

    it('does not take a commented-out tabular as a table', function () {
      const scope = classifySelectionText('%\\begin{tabular}{ll}', 'main.tex')
      expect(scope.kind).to.not.equal('table')
      expect(scope.kind).to.equal('latex')
    })

    it('does not take a matrix as a table', function () {
      const scope = classifySelectionText(
        '\\begin{pmatrix}\n1 & 2 \\\\\n3 & 4 \\\\\n5 & 6\n\\end{pmatrix}',
        'main.tex'
      )
      expect(scope.kind).to.equal('math')
      expect(scope.env).to.equal('pmatrix')
    })

    it('does not take an array as a table', function () {
      const scope = classifySelectionText(
        '\\begin{array}{cc}\n1 & 2 \\\\\n3 & 4 \\\\\n\\end{array}',
        'main.tex'
      )
      expect(scope.kind).to.equal('math')
      expect(scope.env).to.equal('array')
    })

    it('does not take the rows of a multi-line align as a table', function () {
      const scope = classifySelectionText(
        '\\begin{align}\na &= b \\\\\nc &= d \\\\\n\\end{align}',
        'main.tex'
      )
      expect(scope.kind).to.equal('math')
      expect(scope.env).to.equal('align')
    })

    it('beats the figure rule', function () {
      const scope = classifySelectionText(
        '\\begin{figure}\n\\begin{tabular}{l}\nA \\\\\n\\end{tabular}\n\\end{figure}',
        'main.tex'
      )
      expect(scope.kind).to.equal('table')
      expect(scope.env).to.equal('tabular')
    })
  })

  describe('rule 4: figures', function () {
    it('takes a figure environment as the env', function () {
      const scope = classifySelectionText('\\begin{figure*}\n\\centering\n\\end{figure*}', 'main.tex')
      expect(scope.kind).to.equal('figure')
      expect(scope.env).to.equal('figure*')
    })

    it('takes an included graphic with no env', function () {
      const scope = classifySelectionText('\\includegraphics[width=3cm]{plot.pdf}', 'main.tex')
      expect(scope.kind).to.equal('figure')
      expect(scope.env).to.be.null
    })
  })

  describe('rule 5: math', function () {
    it('takes a math environment as the env', function () {
      const scope = classifySelectionText('\\begin{equation}\nE = mc^2\n\\end{equation}', 'main.tex')
      expect(scope.kind).to.equal('math')
      expect(scope.env).to.equal('equation')
      expect(scope.inline).to.be.false
    })

    it('takes text wrapped in $$ as display math with no env', function () {
      const scope = classifySelectionText('$$x^2$$', 'main.tex')
      expect(scope.kind).to.equal('math')
      expect(scope.env).to.be.null
      expect(scope.inline).to.be.false
    })

    it('takes text wrapped in \\[ \\] as display math with no env', function () {
      const scope = classifySelectionText('\\[ x \\]', 'main.tex')
      expect(scope.kind).to.equal('math')
      expect(scope.env).to.be.null
      expect(scope.inline).to.be.false
    })

    it('takes text wrapped in $ $ as inline math', function () {
      const scope = classifySelectionText('$x^2 + y$', 'main.tex')
      expect(scope.kind).to.equal('math')
      expect(scope.env).to.be.null
      expect(scope.inline).to.be.true
    })

    it('takes text wrapped in \\( \\) as inline math', function () {
      const scope = classifySelectionText('\\(a + b\\)', 'main.tex')
      expect(scope.kind).to.equal('math')
      expect(scope.inline).to.be.true
    })

    it('does not take two separate $…$ spans as one inline expression', function () {
      const scope = classifySelectionText('$a$ and $b$', 'main.tex')
      expect(scope.kind).to.equal('latex')
      expect(scope.inline).to.be.false
    })
  })

  describe('rule 6: code', function () {
    it('takes a listing environment as code', function () {
      const scope = classifySelectionText('\\begin{lstlisting}\nint x = 0;\n\\end{lstlisting}', 'main.tex')
      expect(scope.kind).to.equal('code')
      expect(scope.env).to.equal('lstlisting')
    })

    it('takes verbatim as code, even with item-looking lines', function () {
      const scope = classifySelectionText('\\begin{verbatim}\n\\item a\n\\item b\n\\end{verbatim}', 'main.tex')
      expect(scope.kind).to.equal('code')
      expect(scope.env).to.equal('verbatim')
    })
  })

  describe('rule 7: lists', function () {
    it('takes a list environment as a list', function () {
      const scope = classifySelectionText('\\begin{itemize}\n\\item One\n\\end{itemize}', 'main.tex')
      expect(scope.kind).to.equal('list')
      expect(scope.env).to.equal('itemize')
    })

    it('takes two item lines with no env as a list', function () {
      const scope = classifySelectionText('\\item One point\n\\item Two point', 'main.tex')
      expect(scope.kind).to.equal('list')
      expect(scope.env).to.be.null
    })

    it('does not take a single item line as a list', function () {
      expect(classifySelectionText('\\item Reduce latency by caching results', 'main.tex').kind).to.equal('prose')
    })
  })

  describe('rule 8: preamble', function () {
    it('takes a single package line as preamble', function () {
      expect(classifySelectionText('\\usepackage{amsmath}', 'main.tex').kind).to.equal('preamble')
    })

    it('takes three of five non-blank lines (60 %) as preamble', function () {
      const scope = classifySelectionText(
        '\\usepackage{a}\n\\usepackage{b}\n\\usepackage{c}\nWords here\nMore words',
        'main.tex'
      )
      expect(scope.kind).to.equal('preamble')
    })

    it('does not take two of five non-blank lines as preamble', function () {
      const scope = classifySelectionText(
        '\\usepackage{a}\n\\usepackage{b}\nSome plain words\nMore plain words\nAnd more here',
        'main.tex'
      )
      expect(scope.kind).to.equal('prose')
    })
  })

  describe('rule 9: headings', function () {
    it('takes a sectioning command with a title as a heading', function () {
      const scope = classifySelectionText('\\section{Results}', 'main.tex')
      expect(scope.kind).to.equal('heading')
      expect(scope.env).to.be.null
    })

    it('takes a starred, optional-title subsection as a heading', function () {
      expect(classifySelectionText('\\subsection*[Short]{Long title here}', 'main.tex').kind).to.equal('heading')
    })

    it('does not take three lines starting with sections as a heading', function () {
      expect(classifySelectionText('\\section{A}\nSome text\n\\section{B}', 'main.tex').kind).to.equal('latex')
    })
  })

  describe('rule 10: citations', function () {
    it('takes a lone cite command as a citation', function () {
      expect(classifySelectionText('\\cite{smith2020}', 'main.tex').kind).to.equal('citation')
    })

    it('takes a tilde-prefixed citep with two optional arguments as a citation', function () {
      expect(
        classifySelectionText('~\\citep[see][p.~3]{vaswani2017,devlin2019}', 'main.tex').kind
      ).to.equal('citation')
    })

    it('does not take a citation inside a sentence as a citation', function () {
      expect(classifySelectionText('Some text \\cite{x}', 'main.tex').kind).to.equal('latex')
    })
  })

  describe('rule 11: prose or LaTeX', function () {
    it('takes three or more words as prose', function () {
      expect(classifySelectionText('The quick brown fox jumps over the lazy dog.', 'main.tex').kind).to.equal('prose')
    })

    it('takes fewer than three words as LaTeX', function () {
      expect(classifySelectionText('Hello world', 'main.tex').kind).to.equal('latex')
    })

    it('strips commands and braces before counting words', function () {
      expect(classifySelectionText('\\emph{Hello} big world', 'main.tex').kind).to.equal('prose')
    })

    it('does not count words inside inline math', function () {
      expect(classifySelectionText('the value $x$ is', 'main.tex').kind).to.equal('prose')
    })

    it('takes whitespace-only text as LaTeX', function () {
      const scope = classifySelectionText('   \n  ', 'main.tex')
      expect(scope.kind).to.equal('latex')
      expect(scope.lines).to.equal(2)
    })
  })

  describe('numeric', function () {
    it('is true for prose stating three or more numbers', function () {
      const scope = classifySelectionText(
        'Revenue was 12, 15 and 19 percent in 2020, 2021 and 2022.',
        'main.tex'
      )
      expect(scope.kind).to.equal('prose')
      expect(scope.numeric).to.be.true
    })

    it('is false for prose with fewer than three numbers', function () {
      const scope = classifySelectionText('We ran 2 trials.', 'main.tex')
      expect(scope.kind).to.equal('prose')
      expect(scope.numeric).to.be.false
    })

    it('is true for a list stating three or more numbers', function () {
      const scope = classifySelectionText(
        '\\begin{itemize}\n\\item 3 apples\n\\item 4 pears\n\\item 5 kiwis\n\\end{itemize}',
        'main.tex'
      )
      expect(scope.kind).to.equal('list')
      expect(scope.numeric).to.be.true
    })

    it('is false for math, whatever it contains', function () {
      expect(classifySelectionText('$$1 + 2 + 3$$', 'main.tex').numeric).to.be.false
    })

    it('ignores numbers inside a comment', function () {
      const scope = classifySelectionText('Words here and there % 1, 2, 3', 'main.tex')
      expect(scope.kind).to.equal('prose')
      expect(scope.numeric).to.be.false
    })
  })

  describe('lines and inline', function () {
    it('counts the lines the selection spans', function () {
      expect(classifySelectionText('one\ntwo\nthree', 'main.tex').lines).to.equal(3)
      expect(classifySelectionText('single line', 'main.tex').lines).to.equal(1)
    })

    it('reports inline only for inline math', function () {
      expect(classifySelectionText('$x$', 'main.tex').inline).to.be.true
      expect(classifySelectionText('$$x$$', 'main.tex').inline).to.be.false
    })

    it('returns all six fields', function () {
      const scope = classifySelectionText('Some words here', 'main.tex')
      expect(scope).to.have.all.keys('kind', 'env', 'lines', 'numeric', 'inline', 'cues')
    })
  })
})

describe('classifySelectionInDoc', function () {
  describe('context: heading', function () {
    it('takes the title of a section as a heading', function () {
      const doc = documentWith('\\section{Introduction}\n\nSome text.')
      const scope = classifyAt(doc, 'Introduction')
      expect(scope.kind).to.equal('heading')
      expect(scope.env).to.be.null
    })

    it('takes prose inside a heading as a heading', function () {
      const doc = documentWith('\\section{Our method and results}\n\nSome text.')
      expect(classifyAt(doc, 'Our method and results').kind).to.equal('heading')
    })
  })

  describe('context: preamble', function () {
    it('takes text in a preamble command as preamble', function () {
      const doc = [
        '\\documentclass{article}',
        '\\author{Jane Doe and John Roe}',
        '\\begin{document}',
        'Body text here.',
        '\\end{document}',
      ].join('\n')
      const scope = classifyAt(doc, 'Jane Doe and John Roe')
      expect(scope.kind).to.equal('preamble')
      expect(scope.env).to.be.null
    })

    it('takes a package line as preamble', function () {
      const doc = documentWith('Body text here.')
      expect(classifyAt(doc, '\\usepackage{amsmath}').kind).to.equal('preamble')
    })
  })

  describe('context: inline math', function () {
    it('takes LaTeX inside an open $ as inline math', function () {
      const doc = documentWith('Intro.\n\nThe rate is $\\alpha + \\beta$ here.')
      const scope = classifyAt(doc, '\\alpha + \\beta')
      expect(scope.kind).to.equal('math')
      expect(scope.inline).to.be.true
      expect(scope.env).to.be.null
    })

    it('takes words after an unclosed \\( as inline math', function () {
      const doc = documentWith('Intro.\n\nWe have \\(a + b and more words here.')
      const scope = classifyAt(doc, 'a + b and more words here')
      expect(scope.kind).to.equal('math')
      expect(scope.inline).to.be.true
    })

    it('does not count an escaped \\$ as a delimiter', function () {
      const doc = documentWith('Intro.\n\nPrice is \\$5 and the total words are fine.')
      const scope = classifyAt(doc, 'the total words')
      expect(scope.kind).to.equal('prose')
      expect(scope.inline).to.be.false
    })

    it('skips $$ pairs when counting delimiters', function () {
      const doc = documentWith('Intro.\n\nDisplay $$a$$ then the important words.')
      const scope = classifyAt(doc, 'the important words')
      expect(scope.kind).to.equal('prose')
      expect(scope.inline).to.be.false
    })

    it('starts counting at the paragraph, not the document', function () {
      const doc = documentWith('Intro.\n\nCosts $5 are high.\n\nThe second paragraph has several plain words.')
      const scope = classifyAt(doc, 'several plain words')
      expect(scope.kind).to.equal('prose')
      expect(scope.inline).to.be.false
    })
  })

  describe('context: environments', function () {
    it('takes a cell of a tabular as a table', function () {
      const doc = documentWith('\\begin{tabular}{lr}\nAccuracy & 0.91 \\\\\nRecall & 0.88 \\\\\n\\end{tabular}')
      const scope = classifyAt(doc, 'Accuracy')
      expect(scope.kind).to.equal('table')
      expect(scope.env).to.equal('tabular')
      expect(scope.numeric).to.be.false
    })

    it('takes a multi-word cell of a tabular as a table', function () {
      const doc = documentWith('\\begin{tabular}{lr}\nModel accuracy & 0.91 \\\\\n\\end{tabular}')
      expect(classifyAt(doc, 'Model accuracy').kind).to.equal('table')
    })

    it('turns numbers in a table cell into a table, not a numeric prose', function () {
      const doc = documentWith(
        '\\begin{tabular}{lrrr}\nSales were 12, 15 and 19 in the first quarter & 1 & 2 & 3 \\\\\n\\end{tabular}'
      )
      const scope = classifyAt(doc, 'Sales were 12, 15 and 19 in the first quarter')
      expect(scope.kind).to.equal('table')
      expect(scope.numeric).to.be.false
    })

    it('takes a caption inside a figure as a figure', function () {
      const doc = documentWith(
        '\\begin{figure}\n\\centering\n\\includegraphics{plot.pdf}\n\\caption{Accuracy over training steps}\n\\end{figure}'
      )
      const scope = classifyAt(doc, 'Accuracy over training steps')
      expect(scope.kind).to.equal('figure')
      expect(scope.env).to.equal('figure')
    })

    it('takes words inside align as math', function () {
      const doc = documentWith('\\begin{align}\n\\text{total cost per unit} &= a + b \\\\\n\\end{align}')
      const scope = classifyAt(doc, 'total cost per unit')
      expect(scope.kind).to.equal('math')
      expect(scope.env).to.equal('align')
      expect(scope.inline).to.be.false
    })

    it('keeps the text of a list item as prose', function () {
      const doc = documentWith('\\begin{itemize}\n\\item Reduce latency by caching results\n\\end{itemize}')
      const scope = classifyAt(doc, 'Reduce latency by caching results')
      expect(scope.kind).to.equal('prose')
      expect(scope.env).to.be.null
    })

    it('takes a bare LaTeX command in a list item as a list', function () {
      const doc = documentWith('\\begin{itemize}\n\\item \\textbf{Bold}\n\\end{itemize}')
      const scope = classifyAt(doc, '\\textbf{Bold}')
      expect(scope.kind).to.equal('list')
      expect(scope.env).to.equal('itemize')
    })

    it('takes words in a listing as code', function () {
      const doc = documentWith('\\begin{lstlisting}\nfor i in range(10):\n\\end{lstlisting}')
      const scope = classifyAt(doc, 'for i in range(10):')
      expect(scope.kind).to.equal('code')
      expect(scope.env).to.equal('lstlisting')
    })

    it('takes a label inside a TikZ node as TikZ', function () {
      const doc = documentWith(
        '\\begin{tikzpicture}\n\\node at (0,0) {Start point here};\n\\end{tikzpicture}'
      )
      const scope = classifyAt(doc, 'Start point here')
      expect(scope.kind).to.equal('tikz')
      expect(scope.env).to.equal('tikzpicture')
    })

    it('takes prose in a minipage inside a figure as a figure', function () {
      const doc = documentWith(
        '\\begin{figure}\n\\begin{minipage}{0.5}\nLeft panel shows the baseline\n\\end{minipage}\n\\end{figure}'
      )
      const scope = classifyAt(doc, 'Left panel shows the baseline')
      expect(scope.kind).to.equal('figure')
      expect(scope.env).to.equal('figure')
    })

    it('takes the innermost environment when two decide the kind', function () {
      const doc = documentWith('\\begin{figure}\n\\begin{tabular}{l}\nAccuracy \\\\\n\\end{tabular}\n\\end{figure}')
      const scope = classifyAt(doc, 'Accuracy')
      expect(scope.kind).to.equal('table')
      expect(scope.env).to.equal('tabular')
    })
  })

  describe('bibliography and comments', function () {
    it('takes a .bib selection as bibtex wherever it is', function () {
      const doc = '@article{key,\n  title = {Some words here}\n}'
      const scope = classifyAt(doc, 'Some words here', 'refs.bib')
      expect(scope.kind).to.equal('bibtex')
      expect(scope.env).to.be.null
    })

    it('ignores a commented-out tabular around prose', function () {
      const doc = documentWith('% \\begin{tabular}{ll}\nSome words here')
      expect(classifyAt(doc, 'Some words here').kind).to.equal('prose')
    })

    it('takes a comment-only selection as LaTeX, not a table', function () {
      const doc = documentWith('% \\begin{tabular}{ll}\nSome words here')
      const scope = classifyAt(doc, '% \\begin{tabular}{ll}')
      expect(scope.kind).to.equal('latex')
      expect(scope.env).to.be.null
    })
  })

  describe('lines and numeric', function () {
    it('counts the lines of a multi-line prose selection', function () {
      const doc = documentWith('First line of the paragraph here.\nSecond line of the paragraph here.')
      const scope = classifyAt(doc, 'First line of the paragraph here.\nSecond line of the paragraph here.')
      expect(scope.kind).to.equal('prose')
      expect(scope.lines).to.equal(2)
    })

    it('keeps numeric on prose that stays prose', function () {
      const doc = documentWith('Revenue was 12, 15 and 19 percent in 2020, 2021 and 2022.')
      const scope = classifyAt(doc, 'Revenue was 12, 15 and 19 percent in 2020, 2021 and 2022.')
      expect(scope.kind).to.equal('prose')
      expect(scope.numeric).to.be.true
    })

    it('returns all six fields', function () {
      const doc = documentWith('\\begin{tabular}{l}\nAccuracy \\\\\n\\end{tabular}')
      expect(classifyAt(doc, 'Accuracy')).to.have.all.keys('kind', 'env', 'lines', 'numeric', 'inline', 'cues')
    })
  })

  describe('context: bare rows', function () {
    it('takes `&`/`\\\\` rows inside align as math', function () {
      const rows = 'a &= b + c \\\\\nd &= e + f \\\\'
      const doc = documentWith(`\\begin{align}\n${rows}\n\\end{align}`)
      const scope = classifyAt(doc, rows)
      expect(scope.kind).to.equal('math')
      expect(scope.env).to.equal('align')
    })

    it('keeps rows inside tabular a table and names its environment', function () {
      const rows = 'A & 1 \\\\\nB & 2 \\\\'
      const doc = documentWith(`\\begin{tabular}{lr}\n${rows}\n\\end{tabular}`)
      const scope = classifyAt(doc, rows)
      expect(scope.kind).to.equal('table')
      expect(scope.env).to.equal('tabular')
    })
  })
})

describe('selection cues', function () {
  const cuesOf = (text: string) => classifySelectionText(text, 'main.tex').cues

  describe('term', function () {
    it('marks a single word, kept as LaTeX', function () {
      const scope = classifySelectionText('entropy', 'main.tex')
      expect(scope.kind).to.equal('latex')
      expect(scope.cues).to.deep.equal(['term'])
    })

    it('marks a short noun phrase, kept as prose', function () {
      const scope = classifySelectionText('stochastic gradient descent', 'main.tex')
      expect(scope.kind).to.equal('prose')
      expect(scope.cues).to.deep.equal(['term'])
    })

    it('does not mark a sentence, a command or math', function () {
      expect(cuesOf('The model converges.')).to.not.include('term')
      expect(cuesOf('\\emph{entropy}')).to.not.include('term')
      expect(cuesOf('one two three four five')).to.not.include('term')
      expect(classifySelectionText('$x$', 'main.tex').cues).to.deep.equal([])
    })
  })

  describe('uncited_claim', function () {
    it('marks a claim of evidence with no citation', function () {
      expect(cuesOf('Previous studies have shown that attention helps translation.')).to.include('uncited_claim')
      expect(cuesOf('It is well known that deeper networks are harder to train.')).to.include('uncited_claim')
    })

    it('does not mark a claim that already cites', function () {
      expect(cuesOf('Previous studies have shown that attention helps \\cite{vaswani2017}.')).to.not.include('uncited_claim')
      expect(cuesOf('It is well known~\\citep[p.~3]{he2016} that depth hurts.')).to.not.include('uncited_claim')
    })

    it('does not mark the author\'s own results', function () {
      expect(cuesOf('Our method reaches 91 percent accuracy on the test set.')).to.not.include('uncited_claim')
    })
  })

  describe('informal', function () {
    it('marks a contraction', function () {
      expect(cuesOf("The baseline doesn't converge on this data.")).to.include('informal')
    })

    it('marks two conversational words', function () {
      expect(cuesOf('This is basically a lot faster than before.')).to.include('informal')
    })

    it('does not mark a possessive or one conversational word', function () {
      expect(cuesOf("The model's loss is really low here.")).to.not.include('informal')
    })
  })

  describe('wordy', function () {
    it('marks a very long sentence', function () {
      const sentence = Array.from({ length: 32 }, (_, i) => `word${'abcdefghijklmnopqrstuvwxyzabcdef'[i]}`).join(' ') + '.'
      expect(cuesOf(sentence)).to.include('wordy')
    })

    it('marks two filler phrases', function () {
      expect(cuesOf('In order to train it, we note the fact that data is scarce.')).to.include('wordy')
    })

    it('does not mark short plain sentences', function () {
      expect(cuesOf('We train the model. It converges fast.')).to.not.include('wordy')
    })
  })

  describe('enumeration', function () {
    it('marks two distinct ordinals', function () {
      expect(cuesOf('First, we clean the data. Second, we train the model.')).to.include('enumeration')
    })

    it('marks semicolon runs and roman markers', function () {
      expect(cuesOf('We use three sets: train; validation; and test.')).to.include('enumeration')
      expect(cuesOf('We (i) clean the data and (ii) train the model.')).to.include('enumeration')
    })

    it('does not mark one ordinal or equation numbers', function () {
      expect(cuesOf('First, we clean the data using (1) and (2).')).to.not.include('enumeration')
    })
  })

  describe('process', function () {
    it('marks three process words', function () {
      expect(cuesOf('The encoder output is then fed into the decoder.')).to.include('process')
    })

    it('marks two arrows', function () {
      expect(cuesOf('Raw text -> tokens -> embeddings are the stages here.')).to.include('process')
    })

    it('does not mark a single arrow of notation', function () {
      expect(cuesOf('Let the map $f \\colon X \\to Y$ be smooth and bounded.')).to.not.include('process')
    })
  })

  it('gives no text cues to kinds other than prose and LaTeX', function () {
    const scope = classifySelectionText('\\begin{itemize}\n\\item First, a lot\n\\item Second, basically\n\\end{itemize}', 'main.tex')
    expect(scope.kind).to.equal('list')
    expect(scope.cues).to.deep.equal([])
  })

  it('lists cues in a fixed order', function () {
    expect(cuesOf("Previous work has shown it's basically fine; first; second; then the pipeline steps.")).to.deep.equal([
      'uncited_claim',
      'informal',
      'enumeration',
      'process',
    ])
  })

  describe('section', function () {
    it('marks prose inside the abstract environment', function () {
      const doc = documentWith('\\begin{abstract}\nWe propose a new method for parsing.\n\\end{abstract}')
      expect(classifyAt(doc, 'We propose a new method for parsing.').cues).to.deep.equal(['abstract'])
    })

    it('marks prose under an Introduction heading, after its text cues', function () {
      const doc = documentWith('\\section{Introduction}\nPrior work struggles with long documents.')
      expect(classifyAt(doc, 'Prior work struggles with long documents.').cues).to.deep.equal([
        'uncited_claim',
        'introduction',
      ])
    })

    it('keeps the introduction cue in its subsections', function () {
      const doc = documentWith('\\section{Introduction}\n\\subsection{Scope}\nWe study parsing of long documents.')
      expect(classifyAt(doc, 'We study parsing of long documents.').cues).to.deep.equal(['introduction'])
    })

    it('adds no section cue elsewhere or to other kinds', function () {
      const doc = documentWith('\\section{Method}\nWe study parsing of long documents.\n\\begin{abstract}\n$$x$$\n\\end{abstract}')
      expect(classifyAt(doc, 'We study parsing of long documents.').cues).to.deep.equal([])
      expect(classifyAt(doc, '$$x$$').cues).to.deep.equal([])
    })
  })
})
