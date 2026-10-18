import { expect } from 'chai'
import {
  AdvancedToolId,
  deriveAdvancedTools,
  MAX_ADVANCED_TOOLS,
  MIN_AUDIT_LINES,
} from '../../../../../frontend/js/features/ai-assist/agent/starters/derive-advanced-tools'
import { StarterSignals } from '../../../../../frontend/js/features/ai-assist/agent/starters/derive-starters'
import { buildProjectIndex } from '../../../../../frontend/js/features/ai-assist/agent/context/project-index'
import { ProjectFile } from '../../../../../frontend/js/features/ai-assist/agent/project-handle'

function filesFor(docs: Record<string, string>): ProjectFile[] {
  return Object.entries(docs).map(([path, text]) => ({
    path,
    type: 'doc' as const,
    size: text.length,
    lines: text.split('\n').length,
  }))
}

function signals(docs: Record<string, string>): StarterSignals {
  return {
    index: buildProjectIndex({ docs, rootPath: 'main.tex' }),
    files: filesFor(docs),
    lastCompile: null,
    openFile: null,
  }
}

function ids(docs: Record<string, string>): AdvancedToolId[] {
  return deriveAdvancedTools(signals(docs)).map(tool => tool.id)
}

/** `count` lines of plain prose. */
function prose(count: number, text = 'Plain prose about the method and its behaviour.'): string[] {
  return Array.from({ length: count }, () => text)
}

function paper(body: string[], { documentClass = 'article', preamble = [] as string[] } = {}): string {
  return [
    `\\documentclass{${documentClass}}`,
    ...preamble,
    '\\begin{document}',
    ...body,
    '\\end{document}',
  ].join('\n')
}

function figure(label: string): string[] {
  return [
    '\\begin{figure}',
    '\\includegraphics{x}',
    '\\caption{A figure.}',
    `\\label{${label}}`,
    '\\end{figure}',
  ]
}

function equation(n: number): string[] {
  return ['\\begin{equation}', `x_${n} = ${n}`, '\\end{equation}']
}

describe('deriveAdvancedTools', function () {
  it('shows the two generic cards with no index', function () {
    const tools = deriveAdvancedTools({ index: null, files: [], lastCompile: null, openFile: null })
    expect(tools.map(tool => tool.id)).to.deep.equal(['unsupported_statements', 'reference_audit'])
    expect(tools.every(tool => Object.keys(tool.params).length === 0)).to.be.true
  })

  it('shows the generic cards for a project below the audit size', function () {
    const docs = { 'main.tex': paper(prose(MIN_AUDIT_LINES - 10)) }
    const tools = deriveAdvancedTools(signals(docs))
    expect(tools.map(tool => tool.id)).to.deep.equal(['unsupported_statements', 'reference_audit'])
    expect(tools[0].params).to.deep.equal({})
  })

  it('never shows more than MAX_ADVANCED_TOOLS cards', function () {
    const body = [
      '\\begin{abstract}', 'We show things.', '\\end{abstract}',
      '\\section{Intro}', ...prose(100),
      '\\section{Method}', ...figure('fig:a'), ...figure('fig:b'),
      ...Array.from({ length: 12 }, (_, i) => equation(i)).flat(),
      '\\section{Results}', ...prose(100),
      '\\section{Conclusion}', ...prose(100),
    ]
    const tools = deriveAdvancedTools(signals({ 'main.tex': paper(body, { documentClass: 'IEEEtran' }) }))
    expect(tools).to.have.lengthOf(MAX_ADVANCED_TOOLS)
  })

  it('is deterministic for the same project', function () {
    const docs = { 'main.tex': paper(['\\section{Intro}', ...prose(80), ...figure('fig:a'), ...figure('fig:b')]) }
    expect(deriveAdvancedTools(signals(docs))).to.deep.equal(deriveAdvancedTools(signals(docs)))
  })

  describe('unsupported statements', function () {
    it('leads with evidence when the paper cites nothing', function () {
      const docs = { 'main.tex': paper(['\\section{Intro}', ...prose(60)]) }
      const tools = deriveAdvancedTools(signals(docs))
      expect(tools[0].id).to.equal('unsupported_statements')
      expect(tools[0].params.citation_count).to.equal(0)
      expect(tools[0].params.line_count).to.be.above(60)
    })

    it('reports the citation density when citations are sparse', function () {
      const body = ['\\section{Intro}', 'Known \\cite{a}.', ...prose(130)]
      const docs = {
        'main.tex': paper(body),
        'refs.bib': '@article{a,\n title={A}\n}',
      }
      const tool = deriveAdvancedTools(signals(docs)).find(t => t.id === 'unsupported_statements')!
      expect(tool.params.citation_count).to.equal(1)
      expect(tool.params.lines_per_citation).to.be.at.least(60)
    })

    it('is left out of a Beamer deck', function () {
      const docs = { 'main.tex': paper(['\\section{Intro}', ...prose(60)], { documentClass: 'beamer' }) }
      expect(ids(docs)).to.not.include('unsupported_statements')
      expect(ids(docs)[0]).to.equal('slide_density')
    })
  })

  describe('figures and tables', function () {
    it('ranks first when a float is never referenced, with the count', function () {
      const body = [
        '\\section{Intro}', ...prose(50),
        ...figure('fig:a'), ...figure('fig:b'),
        'See Figure~\\ref{fig:a}.',
      ]
      const tools = deriveAdvancedTools(signals({ 'main.tex': paper(body) }))
      expect(tools[0].id).to.equal('figures_tables')
      expect(tools[0].params).to.deep.equal({ float_count: 2, unreferenced_count: 1 })
    })

    it('needs at least two floats', function () {
      const body = ['\\section{Intro}', ...prose(50), ...figure('fig:a')]
      expect(ids({ 'main.tex': paper(body) })).to.not.include('figures_tables')
    })
  })

  describe('reference audit', function () {
    it('gives up its slot when a starter already fixes broken refs', function () {
      const body = [
        '\\section{Intro}', ...prose(50),
        'See \\ref{sec:missing}.', '\\label{sec:intro}',
      ]
      expect(ids({ 'main.tex': paper(body) })).to.not.include('reference_audit')
    })

    it('reports labels nothing refers to', function () {
      const body = [
        '\\section{Intro}', '\\label{sec:intro}', ...prose(50),
        '\\section{Method}', '\\label{sec:method}', 'As in Section~\\ref{sec:intro}.',
      ]
      const tool = deriveAdvancedTools(signals({ 'main.tex': paper(body) })).find(t => t.id === 'reference_audit')!
      expect(tool.params).to.deep.equal({ label_count: 2, unreferenced_count: 1 })
    })
  })

  describe('bibliography', function () {
    it('counts entries never cited', function () {
      const docs = {
        'main.tex': paper(['\\section{Intro}', 'Known \\cite{a}.', ...prose(50)]),
        'refs.bib': ['@article{a,', ' title={A}', '}', '@article{b,', ' title={B}', '}', '@book{c,', ' title={C}', '}'].join('\n'),
      }
      const tool = deriveAdvancedTools(signals(docs)).find(t => t.id === 'unused_bib')
      expect(tool?.params).to.deep.equal({ unused_count: 2, entry_count: 3 })
    })
  })

  describe('notation', function () {
    it('fires from ten equations up and counts their files', function () {
      const main = paper(['\\section{Intro}', ...prose(50), '\\input{math}'])
      const math = Array.from({ length: 10 }, (_, i) => equation(i)).flat().join('\n')
      const tool = deriveAdvancedTools(signals({ 'main.tex': main, 'math.tex': math })).find(t => t.id === 'notation')
      expect(tool?.params).to.deep.equal({ equation_count: 10, file_count: 1 })
    })
  })

  describe('abstract and venue', function () {
    it('checks the abstract when the paper reports results', function () {
      const body = [
        '\\begin{abstract}', 'We show things.', '\\end{abstract}',
        '\\section{Intro}', '\\cite{a} ' + prose(1)[0], ...prose(20),
        '\\section{Results}', '\\cite{b} ' + prose(1)[0], ...prose(20),
      ]
      const docs = { 'main.tex': paper(body), 'refs.bib': '@article{a,\n}\n@article{b,\n}' }
      expect(ids(docs)).to.include('abstract_results')
    })

    it('names the venue of a known class', function () {
      const docs = {
        'main.tex': paper(['\\section{Intro}', '\\cite{a} ' + prose(1)[0], ...prose(50)], { documentClass: 'llncs' }),
        'refs.bib': '@article{a,\n}',
      }
      const tool = deriveAdvancedTools(signals(docs)).find(t => t.id === 'venue_format')
      expect(tool?.params).to.deep.equal({ venue: 'Springer LNCS' })
    })
  })

  describe('prompts', function () {
    it('ask for a report and no edits, in every card', function () {
      const body = [
        '\\begin{abstract}', 'We show things.', '\\end{abstract}',
        '\\section{A}', ...prose(100), '\\section{Results}', ...prose(100),
        '\\section{C}', ...prose(100), '\\section{D}', ...prose(100),
      ]
      const docs = { 'main.tex': paper(body) }
      const tools = [
        ...deriveAdvancedTools(signals(docs)),
        ...deriveAdvancedTools({ index: null, files: [], lastCompile: null, openFile: null }),
        ...deriveAdvancedTools(signals({ 'main.tex': paper(prose(60), { documentClass: 'beamer' }) })),
      ]
      for (const tool of tools) {
        expect(tool.prompt, tool.id).to.include('Do not edit any file until I say which fixes to apply')
        expect(tool.prompt, tool.id).to.not.include('\\\\')
      }
    })
  })
})
