import { expect } from 'chai'
import {
  parseOutline,
  readBraceGroup,
} from '../../../../frontend/js/features/ai-assist/agent/context/outline'

const MAIN = `\\documentclass[11pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage{amsmath, graphicx}
\\begin{document}
\\section{Introduction}
Some text.
\\input{sections/method}
\\include{sections/results.tex}
\\section*{Unnumbered}
\\subsection{Detail with \\textbf{bold} inside}
\\end{document}`

const METHOD = `\\section{Method}
\\subsection{Setup}`

describe('readBraceGroup', function () {
  it('reads a simple group', function () {
    const result = readBraceGroup('\\section{Hello}', 8)
    expect(result?.body).to.equal('Hello')
  })

  it('reads a group containing nested braces', function () {
    const result = readBraceGroup('\\section{a \\textbf{b} c}', 8)
    expect(result?.body).to.equal('a \\textbf{b} c')
  })

  it('returns null for an unterminated group', function () {
    expect(readBraceGroup('\\section{oops', 8)).to.equal(null)
  })
})

describe('parseOutline', function () {
  const docs = { 'main.tex': MAIN, 'sections/method.tex': METHOD }

  it('reads the document class without its options', function () {
    const outline = parseOutline({ docs, rootPath: 'main.tex' })
    expect(outline.documentClass).to.equal('article')
  })

  it('collects packages, splitting comma-separated lists', function () {
    const outline = parseOutline({ docs, rootPath: 'main.tex' })
    expect(outline.packages).to.have.members([
      'inputenc',
      'amsmath',
      'graphicx',
    ])
  })

  it('records sections with file, line and level', function () {
    const outline = parseOutline({ docs, rootPath: 'main.tex' })
    const intro = outline.sections.find(section => section.title === 'Introduction')
    expect(intro).to.deep.include({ path: 'main.tex', line: 5, level: 1 })
  })

  it('keeps nested braces in a title', function () {
    const outline = parseOutline({ docs, rootPath: 'main.tex' })
    const titles = outline.sections.map(section => section.title)
    expect(titles).to.include('Detail with \\textbf{bold} inside')
  })

  it('marks starred sections as unnumbered', function () {
    const outline = parseOutline({ docs, rootPath: 'main.tex' })
    const starred = outline.sections.find(section => section.title === 'Unnumbered')
    expect(starred?.numbered).to.equal(false)
  })

  it('levels subsections below sections', function () {
    const outline = parseOutline({ docs, rootPath: 'main.tex' })
    const section = outline.sections.find(entry => entry.title === 'Introduction')
    const subsection = outline.sections.find(entry => entry.title.startsWith('Detail'))
    expect(subsection!.level).to.be.greaterThan(section!.level)
  })

  it('resolves \\input and \\include, adding the .tex extension', function () {
    const outline = parseOutline({ docs, rootPath: 'main.tex' })
    expect(outline.includes).to.deep.include({
      from: 'main.tex',
      to: 'sections/method.tex',
      line: 7,
      resolved: true,
    })
    expect(outline.includes).to.deep.include({
      from: 'main.tex',
      to: 'sections/results.tex',
      line: 8,
      resolved: false,
    })
  })

  it('includes sections from included files', function () {
    const outline = parseOutline({ docs, rootPath: 'main.tex' })
    const method = outline.sections.find(section => section.title === 'Method')
    expect(method?.path).to.equal('sections/method.tex')
  })

  it('ignores commented-out commands', function () {
    const outline = parseOutline({
      docs: { 'main.tex': '% \\section{Hidden}\n\\section{Shown}' },
      rootPath: 'main.tex',
    })
    expect(outline.sections.map(section => section.title)).to.deep.equal(['Shown'])
  })

  it('survives a malformed file and says so', function () {
    const outline = parseOutline({
      docs: { 'main.tex': '\\section{Unterminated' },
      rootPath: 'main.tex',
    })
    expect(outline.sections).to.deep.equal([])
    expect(outline.notes.join(' ')).to.match(/could not be parsed|unterminated/i)
  })

  it('works with no root document set', function () {
    const outline = parseOutline({ docs, rootPath: null })
    expect(outline.sections.length).to.be.greaterThan(0)
  })
})
