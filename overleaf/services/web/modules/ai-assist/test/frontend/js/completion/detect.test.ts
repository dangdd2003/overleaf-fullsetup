import { expect } from 'chai'
import fetchMock from 'fetch-mock'
import { LanguageSupport } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import customLocalStorage from '@/infrastructure/local-storage'
import { LaTeXLanguage } from '@/features/source-editor/languages/latex/latex-language'
import {
  autoSkipReason,
  completionKind,
  inComment,
  trailingFits,
} from '../../../../frontend/js/features/ai-assist/completion/detect'
import {
  forgetInlineSuggestionsPreferences,
  updateInlineSuggestionsPreferences,
} from '../../../../frontend/js/features/ai-assist/inline-suggestion/preferences'

const latex = new LanguageSupport(LaTeXLanguage)
const BODY = 'Our method improves accuracy on every benchmark we tried'

/** The state of `doc` without its `|`, and the position the `|` marked. */
function at(doc: string) {
  const pos = doc.indexOf('|')
  if (pos === -1) throw new Error('no | in doc')
  return { state: EditorState.create({ doc: doc.replace('|', ''), extensions: [latex] }), pos }
}

const kindAt = (doc: string) => {
  const { state, pos } = at(doc)
  return completionKind(state, pos)
}

/** The reason at the `|`, or null where Automatic may ask. */
const reasonAt = (doc: string) => {
  const { state, pos } = at(doc)
  return autoSkipReason(state, pos)
}

describe('completion: detection', function () {
  beforeEach(function () {
    customLocalStorage.clear()
    forgetInlineSuggestionsPreferences()
    fetchMock.removeRoutes().clearHistory()
    fetchMock.put('/ai-assist/preferences', { preferences: null })
  })

  afterEach(function () {
    fetchMock.removeRoutes().clearHistory()
    customLocalStorage.clear()
    forgetInlineSuggestionsPreferences()
  })

  describe('what may follow the cursor on its line', function () {
    it('nothing, closers, the punctuation that ends a clause, a row end or a comment', function () {
      for (const rest of ['', '   ', '}', '} $', ')]', '\\)', '\\]', '} % note', '% note', '.', '$.', '}.', ' \\\\', '} \\\\[2pt]']) {
        expect(trailingFits(rest), JSON.stringify(rest)).to.equal(true)
      }
    })

    it('never words: a chat model cannot fill a gap in the middle of the text', function () {
      for (const rest of ['word', ' and more', '\\% of it', '}{x}', ' & b \\\\', '. Next sentence']) {
        expect(trailingFits(rest), JSON.stringify(rest)).to.equal(false)
      }
      expect(kindAt('Our |method works')).to.equal(null)
      expect(reasonAt(`${BODY} and | results`)).to.equal('text after the cursor')
      expect(reasonAt(`${BODY} re|sults`)).to.equal('text after the cursor')
    })
  })

  it('inComment: after an unescaped %', function () {
    let { state, pos } = at('Text % note|')
    expect(inComment(state, pos)).to.equal(true)
    ;({ state, pos } = at('Cost 5\\% of|'))
    expect(inComment(state, pos)).to.equal(false)
    expect(kindAt('Text % note|')).to.equal(null)
  })

  describe('the kind', function () {
    it('prose at the end of a sentence line, before closers or a final full stop', function () {
      expect(kindAt('Our method|')).to.equal('prose')
      expect(kindAt('See \\textbf{our method|}')).to.equal('prose')
      expect(kindAt('We trained it on|.')).to.equal('prose')
      expect(kindAt('\\begin{itemize}\n\\item First point|\n\\end{itemize}')).to.equal('prose')
    })

    it('block on a blank line, after a finished row, after a structural line', function () {
      expect(kindAt('First paragraph.\n\n|')).to.equal('block')
      expect(kindAt('\\begin{itemize}\n\\item One.\n|\n\\end{itemize}')).to.equal('block')
      expect(kindAt('\\begin{tabular}{ll}\na & b \\\\|\n\\end{tabular}')).to.equal('block')
      expect(kindAt('\\begin{align}\na &= b \\\\|\n\\end{align}')).to.equal('block')
      expect(kindAt('\\section{Method}|')).to.equal('block')
      expect(kindAt('\\begin{itemize}|\n\\end{itemize}')).to.equal('block')
    })

    it('block after a sentence that announces a table, figure, formula, list or code', function () {
      const doc = '\\begin{document}\nYou can use \\texttt{\\textbackslash hline} to insert rules. This is the example tables: |\n\n\\end{document}'
      expect(kindAt(doc)).to.equal('block')
      expect(reasonAt(doc)).to.equal(null)
      expect(kindAt('The loss is given by|')).to.equal('block')
      expect(kindAt('Note:|')).to.equal('prose')
      expect(kindAt('We have $x: |$')).to.equal('math')
    })

    it('math inside math, code inside a listing or a drawing', function () {
      expect(kindAt('We have $a + b = |  $')).to.equal('math')
      expect(kindAt('\\begin{equation}\nE = mc^2|\n\\end{equation}')).to.equal('math')
      expect(kindAt('\\begin{lstlisting}\nx = 1|\n\\end{lstlisting}')).to.equal('code')
      expect(kindAt('\\begin{tikzpicture}\n\\draw (0,0) -- (1,1);|\n\\end{tikzpicture}')).to.equal('code')
    })

    it('a cell of a table: the rest of the row, before the \\\\ already there', function () {
      expect(kindAt('\\begin{tabular}{ll}\na & b \\\\\nc & |\\\\\n\\end{tabular}')).to.equal('prose')
    })

    it('block lines in the preamble, on Shift+Space only', function () {
      const doc = `\\documentclass{article}\n\\usepackage{amsmath}\n|\n\\begin{document}\n${BODY}\n\\end{document}`
      expect(kindAt(doc)).to.equal('block')
      expect(reasonAt(doc)).to.equal('preamble')
    })
  })

  describe('where neither Shift+Space nor Automatic runs', function () {
    it('command names, keys, paths and options are LaTeX autocomplete’s', function () {
      expect(reasonAt(`${BODY} \\|`)).to.equal('command name')
      expect(reasonAt(`${BODY} \\textb|`)).to.equal('command name')
      expect(kindAt(`${BODY} \\textb|`)).to.equal(null)
      // Complete as they are: text or a row follows
      expect(reasonAt(`${BODY}\n\\item|`)).to.equal(null)
      expect(reasonAt(`${BODY} \\\\ \\hline|`)).to.equal(null)
      // `\\` ends a row or a line; it is not a command being typed
      expect(reasonAt(`${BODY} \\\\|`)).to.equal(null)
      expect(reasonAt(`${BODY} \\\\\\|`)).to.equal('command name')
      expect(reasonAt(`${BODY} \\cite{smith2020,|`)).to.equal('key or path argument')
      expect(reasonAt(`${BODY} \\citep[p.~3]{|`)).to.equal('key or path argument')
      expect(reasonAt(`${BODY} \\ref{fig:|`)).to.equal('key or path argument')
      expect(reasonAt(`${BODY} \\begin{|`)).to.equal('key or path argument')
      expect(reasonAt(`${BODY} \\includegraphics[width=0.5\\linewidth]{figs/|`)).to.equal('key or path argument')
      expect(reasonAt(`${BODY} \\includegraphics[width=|`)).to.equal('command options')
      expect(reasonAt(`${BODY} \\textcolor{|`)).to.equal('key or path argument')
      expect(kindAt(`${BODY} \\cite{|}`)).to.equal(null)
      // A closed key argument is behind the cursor: back to writing
      expect(reasonAt(`${BODY} \\cite{smith2020} |`)).to.equal(null)
      expect(reasonAt(`${BODY} \\href{https://x.org}{|`)).to.equal(null)
    })

    it('a bibliography or a comment block', function () {
      const SKIP = 'bibliography, comment or file contents'
      expect(reasonAt(`${BODY}\n\\begin{thebibliography}{9}\n\\bibitem{a} A. Author, Title, 2020.\n  |\n\\end{thebibliography}`)).to.equal(SKIP)
      expect(reasonAt(`${BODY}\n\\begin{comment}\nold text here \n|`)).to.equal(SKIP)
      expect(kindAt(`${BODY}\n\\begin{comment}\nold text here |`)).to.equal(null)
    })
  })

  describe('where Automatic asks', function () {
    it('at a break in the writing', function () {
      for (const end of [' ', '.', ', ', ';', ':', '!', '?', ')', '}', '$', '. ']) {
        expect(reasonAt(`${BODY}${end}|`), JSON.stringify(end)).to.equal(null)
      }
      expect(reasonAt(`${BODY} \\section{|`)).to.equal(null)
      expect(reasonAt(`${BODY} $x = |`)).to.equal(null)
      expect(reasonAt(`${BODY} \\item |`)).to.equal(null)
      expect(reasonAt(`${BODY} a & |`)).to.equal(null)
    })

    it('after a word, which the model may finish', function () {
      expect(reasonAt(`${BODY} resu|`)).to.equal(null)
      expect(reasonAt(`${BODY} 20|`)).to.equal(null)
    })

    it('not in the preamble or an almost empty document', function () {
      expect(
        reasonAt(`\\documentclass{article}\n\\usepackage{amsmath} |\n\\begin{document}\n${BODY}\n\\end{document}`)
      ).to.equal('preamble')
      expect(reasonAt(`\\documentclass{article}\n\\begin{document}\n${BODY} |\n\\end{document}`)).to.equal(null)
      expect(reasonAt('Intro |')).to.equal('too little text')
      // Shift+Space still asks there
      expect(kindAt('Intro |')).to.equal('prose')
    })
  })

  describe('a new, blank line', function () {
    const LIST = '\\begin{itemize}\n  \\item We train the model on three datasets\n'

    beforeEach(function () {
      updateInlineSuggestionsPreferences({ emptyLineShortcut: false })
    })

    it('asks on an indented line: it continues a block', function () {
      expect(reasonAt(`${LIST}  |\n\\end{itemize}`)).to.equal(null)
      expect(reasonAt(`${BODY}\n\\begin{figure}\n  |\n\\end{figure}`)).to.equal(null)
    })

    it('asks at column 0 inside any structure: list, table, math rows, formula, code, drawing, float', function () {
      expect(reasonAt(`${LIST}|\n\\end{itemize}`)).to.equal(null)
      expect(reasonAt(`${BODY}\n\\begin{tabular}{ll}\na & b \\\\\n|\n\\end{tabular}`)).to.equal(null)
      expect(reasonAt(`${BODY}\n\\begin{align}\nx &= 1 \\\\\n|\n\\end{align}`)).to.equal(null)
      expect(reasonAt(`${BODY}\n\\begin{equation}\nx = 1\n|\n\\end{equation}`)).to.equal(null)
      expect(reasonAt(`${BODY}\n\\begin{algorithmic}\n\\State x\n|\n\\end{algorithmic}`)).to.equal(null)
      expect(reasonAt(`${BODY}\n\\begin{tikzpicture}\n\\draw (0,0) -- (1,1);\n|\n\\end{tikzpicture}`)).to.equal(null)
      expect(reasonAt(`${BODY}\n\\begin{figure}\n\\centering\n|\n\\end{figure}`)).to.equal(null)
      // An environment the document defines as a list
      expect(reasonAt(`\\newlist{steps}{enumerate}{1}\n${BODY}\n\\begin{steps}\n\\item One step\n|\n\\end{steps}`)).to.equal(null)
    })

    it('asks at column 0 right after a line of the paragraph', function () {
      expect(reasonAt(`${BODY}\n|`)).to.equal(null)
      expect(reasonAt(`${BODY}\n% a note\n|`)).to.equal(null)
      expect(reasonAt(`${BODY}\n\\begin{theorem}\nEvery bounded sequence has a limit point.\n|\n\\end{theorem}`)).to.equal(null)
    })

    it('stays quiet at column 0 where a new block starts', function () {
      const NEW_BLOCK = 'new block: nothing to continue'
      expect(reasonAt(`${BODY}\n\n|`)).to.equal(NEW_BLOCK)
      expect(reasonAt(`${BODY}\n\\section{Method}\n|`)).to.equal(NEW_BLOCK)
      expect(reasonAt(`${LIST}\\end{itemize}\n|`)).to.equal(NEW_BLOCK)
      expect(reasonAt(`${BODY}\n\\begin{theorem}\n|\n\\end{theorem}`)).to.equal(NEW_BLOCK)
      expect(reasonAt(`${BODY}\n\\label{sec:x}\n|`)).to.equal(NEW_BLOCK)
      // Shift+Space writes the next block there
      expect(kindAt(`${BODY}\n\n|`)).to.equal('block')
    })

    it('leaves a truly empty line to the Space prompt while that is on', function () {
      updateInlineSuggestionsPreferences({ emptyLineShortcut: true })
      expect(reasonAt(`${LIST}|\n\\end{itemize}`)).to.equal('empty line: Space opens the writing prompt')
      // Indented: not empty, and asks
      expect(reasonAt(`${LIST}  |\n\\end{itemize}`)).to.equal(null)
    })
  })
})
