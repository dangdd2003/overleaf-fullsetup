import { expect } from 'chai'
import {
  buildProjectIndex,
  hashContent,
  matchSection,
  scanEnvironments,
  scanPackages,
} from '../../../../frontend/js/features/ai-assist/agent/context/project-index'

const PAPER = {
  'main.tex': [
    '\\documentclass{article}',
    '\\usepackage{graphicx}',
    '\\begin{document}',
    '\\section{Intro}',
    '\\begin{figure}',
    'x',
    '\\end{figure}',
    '\\section{Method}',
    '\\input{method.tex}',
    '\\end{document}',
  ].join('\n'),
  'method.tex': [
    '\\subsection{Setup}',
    '\\begin{table}',
    'y',
    '\\end{table}',
    '\\begin{table}',
    'z',
    '\\end{table}',
  ].join('\n'),
}

describe('scanEnvironments', function () {
  it('counts environments with their line numbers', function () {
    const envs = scanEnvironments(PAPER['main.tex'])
    const figure = envs.find(e => e.name === 'figure')
    expect(figure?.count).to.equal(1)
    expect(figure?.lines).to.deep.equal([5])
  })

  it('counts repeated environments in one file', function () {
    const envs = scanEnvironments(PAPER['method.tex'])
    expect(envs.find(e => e.name === 'table')?.count).to.equal(2)
  })

  it('ignores commented-out environments', function () {
    expect(scanEnvironments('% \\begin{figure}\nreal text')).to.deep.equal([])
  })

  it('caps lines at MAX_ENV_LINES while count stays true', function () {
    // Build a file with 60 figures
    const content = Array.from({ length: 60 }, (_, i) => [
      `\\section{Section ${i}}`,
      '\\begin{figure}',
      'content',
      '\\end{figure}',
    ].join('\n')).join('\n')
    const envs = scanEnvironments(content)
    const figure = envs.find(e => e.name === 'figure')
    expect(figure?.count).to.equal(60)
    expect(figure?.lines.length).to.equal(50)
  })
})

describe('scanPackages', function () {
  it('finds graphicx at line 2 of a fixture and ignores a commented-out \\usepackage', function () {
    const fixture = [
      '\\documentclass{article}',
      '\\usepackage{graphicx}',
      '% \\usepackage{amsmath}',
      '\\begin{document}',
      'hello',
      '\\end{document}',
    ].join('\n')
    const pkgs = scanPackages(fixture)
    expect(pkgs).to.deep.equal([{ name: 'graphicx', line: 2 }])
  })
})

describe('buildProjectIndex', function () {
  it('returns the previous index untouched when nothing changed', function () {
    const first = buildProjectIndex({ docs: PAPER, rootPath: 'main.tex' })
    const second = buildProjectIndex(
      { docs: { ...PAPER }, rootPath: 'main.tex' },
      first
    )
    expect(second).to.equal(first)
  })

  it('rebuilds when a file changes and reflects the new structure', function () {
    const first = buildProjectIndex({ docs: PAPER, rootPath: 'main.tex' })
    const changed = {
      ...PAPER,
      'main.tex': PAPER['main.tex'].replace('\\section{Method}', '\\section{Methods}'),
    }
    const second = buildProjectIndex({ docs: changed, rootPath: 'main.tex' }, first)
    expect(second).to.not.equal(first)
    expect(second.outline.sections.map(s => s.title)).to.include('Methods')
  })

  it('carries the outline and references across the whole graph', function () {
    const index = buildProjectIndex({ docs: PAPER, rootPath: 'main.tex' })
    expect(index.outline.documentClass).to.equal('article')
    expect(index.outline.packages).to.deep.equal(['graphicx'])
    // method.tex is reached through \input, so its section is in the tree.
    expect(index.outline.sections.map(s => s.title)).to.include('Setup')
  })

  it('collects packages with name, path, and line', function () {
    const index = buildProjectIndex({ docs: PAPER, rootPath: 'main.tex' })
    expect(index.packages).to.deep.include({
      name: 'graphicx',
      path: 'main.tex',
      line: 2,
    })
  })

  it('flags files over the size cap instead of parsing them', function () {
    const huge = 'x'.repeat(600 * 1024)
    const index = buildProjectIndex({
      docs: { ...PAPER, 'big.tex': huge },
      rootPath: 'main.tex',
    })
    const big = index.files.find(f => f.path === 'big.tex')
    expect(big?.tooLarge).to.equal(true)
    expect(big?.environments).to.deep.equal([])
  })
})

describe('matchSection', function () {
  const outline = buildProjectIndex({ docs: PAPER, rootPath: 'main.tex' }).outline

  it('matches a title case-insensitively with commands stripped', function () {
    const match = matchSection(outline, 'method')
    expect(match.kind).to.equal('exact')
  })

  it('matches a unique prefix', function () {
    const match = matchSection(outline, 'intro')
    expect(match.kind).to.equal('exact')
  })

  it('matches exact title even when it is a prefix of another section', function () {
    const exactWins = buildProjectIndex({
      docs: {
        'main.tex': '\\section{Data}\n\\section{Data Sets}\n',
      },
      rootPath: 'main.tex',
    }).outline
    const match = matchSection(exactWins, 'data')
    expect(match.kind).to.equal('exact')
    if (match.kind === 'exact') expect(match.section.title).to.equal('Data')
  })

  it('lists candidates when ambiguous rather than guessing', function () {
    const ambiguous = buildProjectIndex({
      docs: {
        'main.tex': '\\section{Data One}\n\\section{Data Two}\n',
      },
      rootPath: 'main.tex',
    }).outline
    const match = matchSection(ambiguous, 'data')
    expect(match.kind).to.equal('ambiguous')
    if (match.kind === 'ambiguous') expect(match.candidates).to.have.length(2)
  })

  it('reports none for an unknown section', function () {
    expect(matchSection(outline, 'conclusion').kind).to.equal('none')
  })
})

describe('hashContent', function () {
  it('is stable and length-aware', function () {
    expect(hashContent('abc')).to.equal(hashContent('abc'))
    expect(hashContent('abc')).to.not.equal(hashContent('abd'))
    expect(hashContent('ab')).to.not.equal(hashContent('abc'))
  })
})
