import { expect } from 'chai'
import {
  parseCitations,
  parseCustomCommands,
  parseEnvironments,
  parseIncludes,
  parseLabelsAndRefs,
  parseSections,
  parseTodoNotes,
  stripComments,
} from '../../../../src/parsers/latexSectionParser.js'

const DOC = [
  '\\documentclass{article}',
  '\\newcommand{\\vect}[1]{\\mathbf{#1}}',
  '\\begin{document}',
  '\\section{Introduction}',
  '\\label{sec:intro}',
  'We build on \\cite{knuth1984,lamport1994}. % TODO: cite more',
  '\\input{chapters/method}',
  '\\subsection{Setup}',
  'See \\ref{sec:intro} and \\eqref{eq:main}.',
  '\\begin{equation}',
  '  E = mc^2',
  '  \\label{eq:main}',
  '\\end{equation}',
  '\\section*{Acknowledgements}',
  '\\begin{figure}',
  '  \\caption{A plot}',
  '  \\label{fig:plot}',
  '\\end{figure}',
  '\\end{document}',
].join('\n')

describe('latexSectionParser', function () {
  describe('stripComments', function () {
    it('removes a trailing comment but keeps the line', function () {
      expect(stripComments('text % note')).to.equal('text ')
    })

    it('keeps an escaped percent sign', function () {
      expect(stripComments('50\\% done % note')).to.equal('50\\% done ')
    })

    it('preserves the line count', function () {
      expect(stripComments('a % x\nb\nc % y').split('\n')).to.have.length(3)
    })
  })

  describe('parseSections', function () {
    it('finds every sectioning command with its level and line', function () {
      const sections = parseSections(DOC)
      expect(sections.map(s => s.title)).to.deep.equal([
        'Introduction',
        'Setup',
        'Acknowledgements',
      ])
      expect(sections[0].level).to.equal(2)
      expect(sections[1].level).to.equal(3)
      expect(sections[0].startLine).to.equal(4)
    })

    it('marks starred sections', function () {
      expect(parseSections(DOC)[2].starred).to.be.true
    })

    it('handles an optional short title', function () {
      const sections = parseSections('\\section[Short]{The Long Title}')
      expect(sections[0].title).to.equal('The Long Title')
    })

    it('handles nested braces in a title', function () {
      const sections = parseSections('\\section{A \\textbf{bold} title}')
      expect(sections[0].title).to.equal('A \\textbf{bold} title')
    })

    it('ignores a sectioning command inside a comment', function () {
      expect(parseSections('% \\section{Ignored}')).to.have.length(0)
    })
  })

  describe('parseSections line ranges', function () {
    it('ends a section at the line before the next same-or-higher-level one', function () {
      const [intro, setup] = parseSections(DOC)
      // \subsection{Setup} nests inside Introduction, so it must not end it;
      // \section*{Acknowledgements} at line 14 does.
      expect(intro.endLine).to.equal(13)
      expect(setup.startLine).to.equal(8)
      expect(setup.endLine).to.equal(13)
    })

    it('runs the last section to the end of the document', function () {
      const sections = parseSections(DOC)
      expect(sections.at(-1).endLine).to.equal(DOC.split('\n').length)
    })

    it('gives a lone section the whole document', function () {
      const [only] = parseSections('\\section{Solo}\nbody\nmore')
      expect(only.startLine).to.equal(1)
      expect(only.endLine).to.equal(3)
    })
  })

  describe('parseIncludes', function () {
    it('finds input and include commands', function () {
      const includes = parseIncludes(DOC)
      expect(includes).to.deep.include({
        command: 'input',
        path: 'chapters/method',
        line: 7,
      })
    })
  })

  describe('parseCitations', function () {
    it('splits a multi-key citation', function () {
      const keys = parseCitations(DOC).map(c => c.key)
      expect(keys).to.deep.equal(['knuth1984', 'lamport1994'])
    })

    it('recognises biblatex commands', function () {
      expect(parseCitations('\\textcite{a} \\parencite{b}').map(c => c.key)).to.deep.equal([
        'a',
        'b',
      ])
    })
  })

  describe('parseLabelsAndRefs', function () {
    it('collects labels and references separately', function () {
      const { labels, refs } = parseLabelsAndRefs(DOC)
      expect(labels.map(l => l.name)).to.have.members(['sec:intro', 'eq:main', 'fig:plot'])
      expect(refs.map(r => r.name)).to.have.members(['sec:intro', 'eq:main'])
    })
  })

  describe('parseEnvironments', function () {
    it('captures an environment body with its label and caption', function () {
      const [figure] = parseEnvironments(DOC, ['figure'])
      expect(figure.caption).to.equal('A plot')
      expect(figure.label).to.equal('fig:plot')
      expect(figure.line).to.equal(15)
      expect(figure.endLine).to.equal(18)
    })

    it('captures caption correctly when optional argument contains braces', () => {
      const doc = `\\begin{figure}
\\caption[Short title with \\ref{fig1}]{Detailed Full Caption}
\\label{fig:main}
\\end{figure}`
      const envs = parseEnvironments(doc, ['figure'])
      expect(envs).to.have.length(1)
      expect(envs[0].caption).to.equal('Detailed Full Caption')
      expect(envs[0].label).to.equal('fig:main')
    })

    it('matches nested environments of the same name', function () {
      const text = '\\begin{a}\n\\begin{a}\ninner\n\\end{a}\nouter\n\\end{a}'
      const found = parseEnvironments(text, ['a'])
      expect(found).to.have.length(2)
      expect(found[0].endLine).to.equal(6)
    })

    it('returns nothing for an unterminated environment', function () {
      expect(parseEnvironments('\\begin{equation}\nx', ['equation'])).to.have.length(0)
    })
  })

  describe('parseCustomCommands', function () {
    it('reads the name, arity and definition', function () {
      const [command] = parseCustomCommands(DOC)
      expect(command.name).to.equal('\\vect')
      expect(command.arity).to.equal(1)
      expect(command.definition).to.equal('\\mathbf{#1}')
    })

    it('handles the brace-less form and zero arity', function () {
      const [command] = parseCustomCommands('\\newcommand\\R{\\mathbb{R}}')
      expect(command.name).to.equal('\\R')
      expect(command.arity).to.equal(0)
    })

    it('recognises DeclareMathOperator', function () {
      const [command] = parseCustomCommands('\\DeclareMathOperator{\\argmin}{arg\\,min}')
      expect(command.name).to.equal('\\argmin')
    })
  })

  describe('parseTodoNotes', function () {
    it('finds a TODO in a comment', function () {
      const notes = parseTodoNotes(DOC)
      expect(notes[0].kind).to.equal('TODO')
      expect(notes[0].text).to.equal('cite more')
      expect(notes[0].line).to.equal(6)
    })

    it('finds a todo macro', function () {
      const [note] = parseTodoNotes('\\todo{rewrite this}')
      expect(note.kind).to.equal('todo')
      expect(note.text).to.equal('rewrite this')
    })

    it('finds FIXME and XXX', function () {
      expect(parseTodoNotes('% FIXME broken\n% XXX hack').map(n => n.kind)).to.deep.equal([
        'FIXME',
        'XXX',
      ])
    })

    it('finds a TODO in a comment following an escaped percent sign', function () {
      const notes = parseTodoNotes('50\\% completed % TODO: finish')
      expect(notes).to.have.length(1)
      expect(notes[0].kind).to.equal('TODO')
      expect(notes[0].text).to.equal('finish')
    })
  })
})
