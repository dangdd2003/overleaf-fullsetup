import { expect } from 'chai'
import { parseBibtex, searchBibtex } from '../../../../src/parsers/bibtexParser.js'

const BIB = [
  '% a comment',
  '@article{knuth1984,',
  '  author  = {Donald E. Knuth},',
  '  title   = {Literate Programming},',
  '  journal = {The Computer Journal},',
  '  year    = 1984,',
  '}',
  '',
  '@book{lamport1994,',
  '  author = "Leslie Lamport",',
  '  title  = {LaTeX: A Document Preparation System},',
  '  year   = {1994}',
  '}',
].join('\n')

describe('bibtexParser', function () {
  describe('parseBibtex', function () {
    it('parses every entry with its type, key and line', function () {
      const entries = parseBibtex(BIB)
      expect(entries).to.have.length(2)
      expect(entries[0].type).to.equal('article')
      expect(entries[0].key).to.equal('knuth1984')
      expect(entries[0].line).to.equal(2)
      expect(entries[1].type).to.equal('book')
    })

    it('reads brace-delimited, quote-delimited and bare field values', function () {
      const [knuth, lamport] = parseBibtex(BIB)
      expect(knuth.fields.author).to.equal('Donald E. Knuth')
      expect(knuth.fields.year).to.equal('1984')
      expect(lamport.fields.author).to.equal('Leslie Lamport')
    })

    it('keeps nested braces inside a value', function () {
      const [entry] = parseBibtex('@article{k, title = {A {Nested} Title}}')
      expect(entry.fields.title).to.equal('A {Nested} Title')
    })

    it('handles escaped braces without disrupting depth counting', function () {
      const [entry] = parseBibtex('@article{k, title = {The set $\\{x\\}$ and left brace \\{}}')
      expect(entry.fields.title).to.equal('The set $\\{x\\}$ and left brace \\{')
    })

    it('handles escaped quotes inside quote-delimited values', function () {
      const [entry] = parseBibtex('@article{k, author = "Kurt G\\"{o}del", note = "A \\"quoted\\" text"}')
      expect(entry.fields.author).to.equal('Kurt G\\"{o}del')
      expect(entry.fields.note).to.equal('A \\"quoted\\" text')
    })

    it('lowercases field names', function () {
      const [entry] = parseBibtex('@article{k, TITLE = {X}}')
      expect(entry.fields.title).to.equal('X')
    })

    it('ignores @comment and @preamble', function () {
      expect(parseBibtex('@comment{ignored}\n@preamble{"x"}')).to.have.length(0)
    })

    it('returns an empty array for empty input', function () {
      expect(parseBibtex('')).to.deep.equal([])
    })
  })

  describe('searchBibtex', function () {
    it('matches on the key', function () {
      expect(searchBibtex(parseBibtex(BIB), 'knuth')).to.have.length(1)
    })

    it('matches on any field value, case-insensitively', function () {
      expect(searchBibtex(parseBibtex(BIB), 'LAMPORT')).to.have.length(1)
      expect(searchBibtex(parseBibtex(BIB), 'programming')).to.have.length(1)
    })

    it('returns everything for an empty query', function () {
      expect(searchBibtex(parseBibtex(BIB), '')).to.have.length(2)
    })
  })
})
