import { expect } from 'chai'
import {
  cleanOldText,
  cleanLineNumbers,
  cleanLineNumberPrefixes,
  tokenizeCode,
  countOccurrences,
  findWhitespaceAgnosticAnchor,
  findFuzzyUniqueAnchor,
  findFuzzyWordWindow,
  formatAmbiguousOccurrences,
  locateAnchorInText,
  findMatchingLines,
} from '../../../../frontend/js/features/ai-assist/agent/latex-matcher'

describe('latex-matcher', function () {
  describe('cleanOldText', function () {
    it('normalizes double-escaped LaTeX macro backslashes', function () {
      expect(cleanOldText('\\\\begin{equation}')).to.equal('\\begin{equation}')
      expect(cleanOldText('\\\\centering\\\\small')).to.equal('\\centering\\small')
      expect(cleanOldText('\\\\usepackage[utf8]{inputenc}')).to.equal('\\usepackage[utf8]{inputenc}')
    })

    it('strips line-number prefixes from oldText', function () {
      expect(cleanOldText('14: \\usepackage{amsmath}')).to.equal('\\usepackage{amsmath}')
      expect(cleanOldText('  102| \\begin{document}')).to.equal('\\begin{document}')
    })
  })

  describe('cleanLineNumberPrefixes (The Numbering Trap Guard)', function () {
    it('strips line numbers when majority of lines contain "N: " prefix', function () {
      const contaminated = '14: \\usepackage{amsmath}\n15: \\usepackage{amssymb}\n16: \\usepackage{graphicx}'
      const cleaned = cleanLineNumberPrefixes(contaminated)
      expect(cleaned).to.equal('\\usepackage{amsmath}\n\\usepackage{amssymb}\n\\usepackage{graphicx}')
    })

    it('strips single line prefix when oldTextWasStripped is true', function () {
      const contaminated = '14: \\usepackage{amsmath}'
      expect(cleanLineNumberPrefixes(contaminated, true)).to.equal('\\usepackage{amsmath}')
    })

    it('preserves legitimate numbered lists and text containing numbers without colon prefix', function () {
      const list = '\\begin{enumerate}\n\\item 1. First point\n\\item 2. Second point\n\\end{enumerate}'
      expect(cleanLineNumberPrefixes(list)).to.equal(list)
    })

    it('preserves legitimate text where only an isolated single line starts with a number', function () {
      const text = 'Some introductory text.\n42 is the answer to the universe.\nMore text here.'
      expect(cleanLineNumberPrefixes(text)).to.equal(text)
    })
  })

  describe('locateAnchorInText 4-tier hierarchy', function () {
    const doc = '\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\n\\section{Intro}\nHello world\n\\end{document}'

    it('tier 1: matches exact text', function () {
      const match = locateAnchorInText(doc, '\\section{Intro}')
      expect(match).to.deep.equal({ type: 'exact', anchor: '\\section{Intro}' })
    })

    it('tier 2: matches double-escaped backslashes and cleaned line numbers', function () {
      const match = locateAnchorInText(doc, '\\\\section{Intro}')
      expect(match).to.deep.equal({ type: 'cleaned', anchor: '\\section{Intro}' })
      const matchWithLine = locateAnchorInText(doc, '4: \\section{Intro}')
      expect(matchWithLine).to.deep.equal({ type: 'cleaned', anchor: '\\section{Intro}' })
    })

    it('tier 3: matches fuzzy trimmed anchor with whitespace/indentation differences', function () {
      const docWithIndent = '\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\n  \\section{Intro}\nHello world\n\\end{document}'
      const match = locateAnchorInText(docWithIndent, '    \\section{Intro}')
      expect(match).to.deep.equal({ type: 'fuzzy', anchor: '  \\section{Intro}' })
    })

    it('tier 4: matches whitespace-agnostic LaTeX tokens', function () {
      const match = locateAnchorInText(doc, '\\section  {Intro}')
      expect(match?.type).to.equal('whitespace')
      expect(match?.anchor).to.equal('\\section{Intro}')
    })

    it('tier 5: matches multi-line wrapped paragraph from a single-line search query', function () {
      const longDoc =
        '\\section{Conclusion}\n' +
        'Our empirical results on the LogicBench dataset indicate a significant\n' +
        'improvement over baseline models, particularly in tasks requiring\n' +
        'recursive reasoning and adherence to strict constraints. The $15\\%$ increase\n' +
        'in consistency suggests that the HLT architecture effectively bridges the gap\n' +
        'between pattern recognition and symbolic manipulation.\n' +
        '\\subsection{Future Work}'

      const query =
        'Our empirical results on the LogicBench dataset indicate a significant improvement over baseline models, particularly in tasks requiring recursive reasoning and adherence to strict constraints. The 15% increase in consistency suggests that the HLT architecture effectively bridges the gap between pattern recognition and symbolic manipulation.'

      const match = locateAnchorInText(longDoc, query)
      expect(match).to.exist
      expect(match?.type).to.equal('fuzzy_words')
      expect(match?.anchor).to.include('Our empirical results')
      expect(match?.anchor).to.include('symbolic manipulation.')
    })

    it('tier 5: matches across LaTeX quote differences and math symbol escaping', function () {
      const quoteDoc =
        '\\section{Discussion}\n' +
        'The model remains susceptible to ``logical hallucinations,\'\' where the\n' +
        'system finds a mathematically valid but semantically nonsensical path to\n' +
        'a conclusion in about 10% of cases.\n'

      const query =
        'The model remains susceptible to "logical hallucinations," where the system finds a mathematically valid but semantically nonsensical path to a conclusion in about 10\\% of cases.'

      const match = locateAnchorInText(quoteDoc, query)
      expect(match).to.exist
      expect(match?.type).to.equal('fuzzy_words')
      expect(match?.anchor).to.include('logical hallucinations')
    })

    it('returns null when anchor is absent', function () {
      const match = locateAnchorInText(doc, '\\section{NonExistent}')
      expect(match).to.equal(null)
    })
  })

  describe('formatAmbiguousOccurrences', function () {
    it('returns formatted snippets with line numbers around candidate lines', function () {
      const doc =
        '\\begin{definition}[Prior Knowledge]\n' +
        '  Some text\n' +
        '\\end{definition}\n\n' +
        '\\begin{definition}[Soundness]\n' +
        '  Other text\n' +
        '\\end{definition}'

      const formatted = formatAmbiguousOccurrences(doc, [1, 5])
      expect(formatted).to.include('Occurrence around line 1:')
      expect(formatted).to.include('1: \\begin{definition}[Prior Knowledge]')
      expect(formatted).to.include('Occurrence around line 5:')
      expect(formatted).to.include('5: \\begin{definition}[Soundness]')
    })
  })

  describe('findMatchingLines', function () {
    const doc = 'alpha\nbeta\ngamma\nbeta\nepsilon'

    it('returns 1-based candidate line numbers for occurrences', function () {
      const lines = findMatchingLines(doc, 'beta')
      expect(lines).to.deep.equal([2, 4])
    })

    it('finds candidate line for first line of multi-line anchor', function () {
      const lines = findMatchingLines(doc, 'gamma\nunknown')
      expect(lines).to.deep.equal([3])
    })

    it('returns empty array when no line matches', function () {
      expect(findMatchingLines(doc, 'zeta')).to.deep.equal([])
    })
  })
})
