import { expect } from 'chai'
import {
  applyEdits,
  findExact,
  findLoose,
  lineLookup,
  nearestWindow,
  numberLines,
} from '../../../../src/parsers/textEdit.js'

const PATH = '/main.tex'

describe('textEdit', function () {
  describe('findExact and findLoose', function () {
    it('finds non-overlapping exact occurrences', function () {
      expect(findExact('aaaa', 'aa')).to.deep.equal([
        { index: 0, length: 2 },
        { index: 2, length: 2 },
      ])
    })

    it('finds a match across differing whitespace', function () {
      expect(findLoose('x  =\t1', 'x = 1')).to.deep.equal([{ index: 0, length: 6 }])
    })
  })

  describe('applyEdits', function () {
    it('applies one unique edit and reports its line', function () {
      const result = applyEdits('alpha beta gamma', [
        { oldString: 'beta', newString: 'delta' },
      ], { path: PATH })
      expect(result.text).to.equal('alpha delta gamma')
      expect(result.replacements).to.equal(1)
      expect(result.changes).to.deep.equal([
        { editIndex: 0, startLine: 1, endLine: 1, diff: '- beta\n+ delta' },
      ])
    })

    it('applies edits in order and tracks each change to its final line', function () {
      const result = applyEdits(
        'line one\nline two\nline three\nline four',
        [
          { oldString: 'line four', newString: 'line four\nline five' },
          { oldString: 'line one', newString: 'intro\nlead' },
        ],
        { path: PATH }
      )
      expect(result.text).to.equal(
        'intro\nlead\nline two\nline three\nline four\nline five'
      )
      expect(result.changes.map(c => [c.editIndex, c.startLine])).to.deep.equal([
        [1, 1],
        [0, 5],
      ])
    })

    it('replaces every occurrence with replaceAll', function () {
      const result = applyEdits('a\nx\nb\nx', [
        { oldString: 'x', newString: 'yy', replaceAll: true },
      ], { path: PATH })
      expect(result.text).to.equal('a\nyy\nb\nyy')
      expect(result.changes.map(c => c.startLine)).to.deep.equal([2, 4])
    })

    it('deletes text when newString is empty', function () {
      const result = applyEdits('keep\ndrop me\nkeep2', [
        { oldString: 'drop me\n', newString: '' },
      ], { path: PATH })
      expect(result.text).to.equal('keep\nkeep2')
      expect(result.changes[0].diff).to.equal('- drop me')
      expect(result.changes[0].startLine).to.equal(2)
      expect(result.changes[0].endLine).to.equal(2)
    })

    it('reports every change and every diff line, with no cap', function () {
      const lines = Array.from({ length: 30 }, (_, i) => `L${i}:`)
      const text = lines.join('\n')
      const edits = lines.map(line => ({ oldString: line, newString: `${line}!` }))
      const result = applyEdits(text, edits, { path: PATH })
      expect(result.changes).to.have.lengthOf(30)
      expect(result).to.not.have.property('changesOmitted')

      const longEdit = applyEdits(text, [
        { oldString: text, newString: 'replaced' },
      ], { path: PATH })
      expect(longEdit.changes[0].diff.split('\n')).to.have.lengthOf(31)
      expect(longEdit.changes[0].diff).to.not.include('more')
    })

    it('numbers each change after earlier edits have moved the text', function () {
      const result = applyEdits('a\nb\nc\nd', [
        { oldString: 'b', newString: 'B\nB2' },
        { oldString: 'd', newString: 'D' },
      ], { path: PATH })
      expect(result.text).to.equal('a\nB\nB2\nc\nD')
      expect(result.changes.map(c => [c.editIndex, c.startLine, c.endLine])).to.deep.equal([
        [0, 2, 3],
        [1, 5, 5],
      ])
    })

    it('numbers every occurrence of a replaceAll that adds lines', function () {
      const result = applyEdits('a x\nb x\nc x\nd x', [
        { oldString: 'x', newString: 'y\nq', replaceAll: true },
      ], { path: PATH })
      expect(result.replacements).to.equal(4)
      expect(result.changes.map(c => [c.startLine, c.endLine])).to.deep.equal([
        [1, 2],
        [3, 4],
        [5, 6],
        [7, 8],
      ])
    })

    it('leaves the document unchanged and throws when a later edit fails', function () {
      const original = 'alpha\nbeta'
      expect(() =>
        applyEdits(original, [
          { oldString: 'alpha', newString: 'A' },
          { oldString: 'gamma', newString: 'G' },
        ], { path: PATH })
      ).to.throw(/edit 2 of 2/)
    })

    it('names every match line when the text is ambiguous', function () {
      try {
        applyEdits('x x\nx', [{ oldString: 'x', newString: 'y' }], { path: PATH })
        expect.fail('expected an error')
      } catch (err) {
        expect(err.code).to.equal('validation_error')
        expect(err.details.count).to.equal(3)
        expect(err.details.matches.map(m => m.line)).to.deep.equal([1, 1, 2])
      }
    })

    it('returns the nearest window with its numbered lines when nothing matches', function () {
      try {
        applyEdits('\\section{Intro}\nSome text here about cats.\n\\section{End}', [
          { oldString: 'Some text about dogs.', newString: 'x' },
        ], { path: PATH })
        expect.fail('expected an error')
      } catch (err) {
        expect(err.details.nearest.startLine).to.equal(2)
        expect(err.details.nearest.text).to.equal('2\tSome text here about cats.')
        expect(err.hint).to.include('lines 2-2')
      }
    })

    it('warns when a whitespace-insensitive match was used', function () {
      const result = applyEdits('x  =  1', [
        { oldString: 'x = 1', newString: 'x = 2' },
      ], { path: PATH })
      expect(result.text).to.equal('x = 2')
      expect(result.warnings[0]).to.include('ignoring whitespace')
    })

    it('warns when the edits change nothing', function () {
      const result = applyEdits('same', [{ oldString: 'same', newString: 'same' }], { path: PATH })
      expect(result.warnings).to.include('the edits left the document unchanged')
    })
  })

  describe('nearestWindow', function () {
    it('gives no hint once the document is too large to score cheaply', function () {
      const text = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n')
      const needle = Array.from({ length: 10 }, (_, i) => `missing ${i}`).join('\n')
      expect(nearestWindow(text, needle)).to.be.null
    })

    it('scores the closest window highest', function () {
      const window = nearestWindow('one\ntwo\nthree\nfour', 'three')
      expect(window.startLine).to.equal(3)
      expect(window.similarity).to.equal(1)
    })

    it('returns null for an empty needle', function () {
      expect(nearestWindow('abc', '   ')).to.be.null
    })
  })

  describe('line helpers', function () {
    it('lineLookup is 1-based', function () {
      expect(lineLookup('a\nb\nc')(0)).to.equal(1)
      expect(lineLookup('a\nb\nc')(4)).to.equal(3)
    })

    it('numberLines prefixes each line with its number', function () {
      expect(numberLines(['x', 'y'], 7)).to.equal('7\tx\n8\ty')
    })
  })
})
