import { expect } from 'chai'
import { LanguageSupport } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { LaTeXLanguage } from '@/features/source-editor/languages/latex/latex-language'
import {
  CursorWhere,
  cursorWhere,
  findPassage,
  lineIndent,
  passageMarkup,
} from '../../../../frontend/js/features/ai-assist/equation/context'
import { braceBalance } from '../../../../frontend/js/features/ai-assist/writing-tools/latex-check'

const latex = new LanguageSupport(LaTeXLanguage)
const stateOf = (doc: string) => EditorState.create({ doc, extensions: [latex] })

const prose = (doc: string): CursorWhere => ({
  kind: 'text',
  container: 'text',
  from: 0,
  to: doc.length,
})

function at(doc: string, marker: string, where: CursorWhere = prose(doc)) {
  const pos = doc.indexOf(marker)
  if (pos === -1) throw new Error(`marker not found: ${marker}`)
  return findPassage(doc, { from: pos, to: pos }, where)
}

describe('equation: context', function () {
  describe('cursorWhere', function () {
    it('reads prose as text', function () {
      const doc = 'Some text here.'
      expect(cursorWhere(stateOf(doc), 5)).to.deep.equal(prose(doc))
    })

    it('reads $…$ as inline math, with its content bounds', function () {
      const doc = 'Let $x+y$ be.'
      expect(cursorWhere(stateOf(doc), doc.indexOf('+'))).to.deep.equal({
        kind: 'math',
        math: 'inline',
        from: doc.indexOf('x'),
        to: doc.indexOf('$ be'),
      })
    })

    it('reads \\[…\\] and equation as display math', function () {
      const bracket = 'A \\[ a+b \\] B'
      expect(cursorWhere(stateOf(bracket), bracket.indexOf('+'))).to.include({
        kind: 'math',
        math: 'display',
      })
      const env = 'A\n\\begin{equation}\na+b\n\\end{equation}\nB'
      const where = cursorWhere(stateOf(env), env.indexOf('+'))
      expect(where).to.include({ kind: 'math', math: 'display' })
      if (where.kind !== 'math') throw new Error('not math')
      expect(where.from).to.be.at.most(env.indexOf('a+b'))
      expect(where.to).to.be.at.least(env.indexOf('a+b') + 3)
    })

    it('reads align and a matrix inside $…$ as aligned math', function () {
      const align = '\\begin{align}\nx &= 1\n\\end{align}'
      expect(cursorWhere(stateOf(align), align.indexOf('='))).to.include({ math: 'align' })
      const matrix = 'M = $\\begin{pmatrix} a & b \\end{pmatrix}$.'
      expect(cursorWhere(stateOf(matrix), matrix.indexOf('a &'))).to.include({ math: 'align' })
    })

    it('reads $…$ inside \\text in align as inline math', function () {
      const doc = '\\begin{align}\nx &= 1 \\text{ if $y$ holds}\n\\end{align}'
      expect(cursorWhere(stateOf(doc), doc.indexOf('y$'))).to.include({
        kind: 'math',
        math: 'inline',
      })
    })

    it('reads a caption argument, with its bounds', function () {
      const doc = '\\begin{figure}\n\\caption{The energy}\n\\end{figure}'
      expect(cursorWhere(stateOf(doc), doc.indexOf('energy'))).to.deep.equal({
        kind: 'text',
        container: 'caption',
        from: doc.indexOf('The'),
        to: doc.indexOf('}\n\\end'),
      })
    })

    it('reads a heading argument and a table cell', function () {
      const heading = '\\section{Energy terms}'
      expect(cursorWhere(stateOf(heading), heading.indexOf('terms'))).to.include({
        container: 'heading',
      })
      const table = '\\begin{tabular}{ll}\na & b \\\\\n\\end{tabular}'
      expect(cursorWhere(stateOf(table), table.indexOf('b \\'))).to.include({
        container: 'cell',
      })
    })

    it('refuses comments and verbatim', function () {
      const comment = 'Text % note here'
      expect(cursorWhere(stateOf(comment), comment.indexOf('here'))).to.deep.equal({
        kind: 'refused',
      })
      const verbatim = 'A\n\\begin{verbatim}\ncode\n\\end{verbatim}\nB'
      expect(cursorWhere(stateOf(verbatim), verbatim.indexOf('code') + 1)).to.deep.equal({
        kind: 'refused',
      })
    })
  })

  describe('findPassage', function () {
    it('takes the sentence around the cursor', function () {
      const doc =
        'First one. The energy of a moving body is given by where m is its mass. Last one.'
      const parts = at(doc, ' where')
      expect(parts.before).to.equal('The energy of a moving body is given by')
      expect(parts.after).to.equal(' where m is its mass.')
      expect(parts.selection).to.equal('')
      expect(doc.slice(parts.from, parts.to)).to.equal(parts.before + parts.after)
    })

    it('reaches back to at least 8 words', function () {
      const parts = at('Alpha beta gamma delta. It is fine.', ' fine')
      expect(parts.before).to.equal('Alpha beta gamma delta. It is')
      expect(parts.after).to.equal(' fine.')
    })

    it('keeps at most 40 words before the cursor', function () {
      const words = Array.from({ length: 50 }, (_, i) => `w${i}`).join(' ')
      const parts = at(`${words} end`, ' end')
      expect(parts.before.split(' ')).to.have.length(40)
      expect(parts.before.startsWith('w10 ')).to.equal(true)
    })

    it('does not end a sentence at e.g. or Fig.', function () {
      const doc =
        'Several methods, e.g. Newton iteration, and Fig. 3 show the error which is given by now.'
      expect(at(doc, ' now').before).to.equal(doc.slice(0, doc.indexOf(' now')))
    })

    it('stops at a blank line above', function () {
      const parts = at('Para one ends here.\n\nThe new paragraph says this.', ' this')
      expect(parts.before).to.equal('The new paragraph says')
      expect(parts.after).to.equal(' this.')
    })

    it('sees nothing on an empty line between paragraphs', function () {
      const doc = 'Para one.\n\n\n\nPara two.'
      const parts = findPassage(doc, { from: 11, to: 11 }, prose(doc))
      expect(parts).to.deep.equal({ from: 11, to: 11, before: '', selection: '', after: '' })
    })

    it('sees the lines around an empty line inside a paragraph', function () {
      const doc = 'The energy is given by\n\nwhere m is the mass.'
      const parts = findPassage(doc, { from: 23, to: 23 }, prose(doc))
      expect(parts.before).to.equal('The energy is given by\n')
      expect(parts.after).to.equal('\nwhere m is the mass.')
    })

    it('never includes a comment', function () {
      expect(at('% a note\nThe value is large.', ' large').before).to.equal('The value is')
      expect(at('The value is large % note\nmore text.', ' is').after).to.equal(' is large')
    })

    it('starts after \\item', function () {
      const parts = at('\\begin{itemize}\n\\item The value is large.\n\\end{itemize}', ' large')
      expect(parts.before).to.equal('The value is')
      expect(parts.after).to.equal(' large.')
    })

    it('ignores full stops inside braces and inline math', function () {
      const braces = 'The value is \\emph{very large. Indeed huge} today. Next.'
      expect(at(braces, ' \\emph').after).to.equal(' \\emph{very large. Indeed huge} today.')
      expect(at('Let $a. B$ be given here.', ' here').before).to.equal('Let $a. B$ be given')
    })

    it('completes a group cut by the word limit', function () {
      const footnote = `\\footnote{${Array.from({ length: 30 }, (_, i) => `f${i}`).join(' ')}}`
      const parts = at(`The value is ${footnote} end. Next.`, ' \\footnote')
      expect(parts.after.endsWith('f29}')).to.equal(true)
      expect(braceBalance(parts.after)).to.equal(0)
    })

    it('stays inside the group around the cursor', function () {
      const parts = at('We say \\textbf{the energy is large} here.', ' is large')
      expect(parts.before).to.equal('the energy')
      expect(parts.after).to.equal(' is large')
    })

    it('surrounds a selection', function () {
      const doc = 'The value is E = mc2 in units.'
      const parts = findPassage(
        doc,
        { from: doc.indexOf('E ='), to: doc.indexOf(' in') },
        prose(doc)
      )
      expect(parts).to.include({ before: 'The value is ', selection: 'E = mc2', after: ' in units.' })
    })

    it('uses a selection that crosses a blank line as the whole passage', function () {
      const doc = 'One two.\n\nThree four.'
      const anchor = { from: 4, to: doc.indexOf('four') }
      expect(findPassage(doc, anchor, prose(doc))).to.deep.equal({
        from: anchor.from,
        to: anchor.to,
        before: '',
        selection: doc.slice(anchor.from, anchor.to),
        after: '',
      })
    })

    it('keeps to the line inside math', function () {
      const doc = '\\begin{align}\nx &= 1 \\\\\ny &= 2\n\\end{align}'
      const where: CursorWhere = {
        kind: 'math',
        math: 'align',
        from: '\\begin{align}'.length,
        to: doc.indexOf('\n\\end'),
      }
      const parts = at(doc, '2', where)
      expect(parts.before).to.equal('y &= ')
      expect(parts.after).to.equal('2')
    })

    it('keeps to a caption argument', function () {
      const doc = '\\caption{The energy is given by here.}'
      const where: CursorWhere = { kind: 'text', container: 'caption', from: 9, to: doc.length - 1 }
      const parts = at(doc, ' here', where)
      expect(parts.before).to.equal('The energy is given by')
      expect(parts.after).to.equal(' here.')
    })

    it('keeps to a table cell', function () {
      const doc = 'a & b and the val & c \\\\'
      const where: CursorWhere = { kind: 'text', container: 'cell', from: 0, to: doc.length }
      const parts = at(doc, ' & c', where)
      expect(parts.before).to.equal('b and the val')
      expect(parts.after).to.equal('')
    })
  })

  it('marks the cursor or the selection in the passage', function () {
    expect(
      passageMarkup({ from: 0, to: 9, before: 'given by', selection: '', after: ' x.' })
    ).to.equal('given by<cursor/> x.')
    expect(
      passageMarkup({ from: 0, to: 9, before: 'is ', selection: 'E = mc2', after: '.' })
    ).to.equal('is <selection>E = mc2</selection>.')
  })

  it('reads the indentation of the line at a position', function () {
    expect(lineIndent('a\n    b c', 8)).to.equal('    ')
    expect(lineIndent('a\nb', 2)).to.equal('')
  })
})
