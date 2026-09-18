import { expect } from 'chai'
import * as server from '../../../app/src/AiAssistProjectIndex.mjs'
// Vitest loads TypeScript directly. These are the browser originals the server
// port must match byte for byte.
import * as browserIndex from '../../../frontend/js/features/ai-assist/agent/context/project-index.ts'
import * as browserOutline from '../../../frontend/js/features/ai-assist/agent/context/outline.ts'
import * as browserRefs from '../../../frontend/js/features/ai-assist/agent/context/references.ts'

const PROJECT = {
  rootPath: 'main.tex',
  docs: {
    'main.tex': [
      '\\documentclass[11pt]{article}',
      '\\usepackage[utf8]{inputenc}',
      '\\usepackage{amsmath, graphicx}',
      '\\RequirePackage{hyperref}',
      '% \\usepackage{commentedout}',
      '\\title{A \\textbf{Bold} Paper}',
      '\\begin{document}',
      '\\section{Introduction}\\label{sec:intro}',
      'See \\ref{sec:method} and \\eqref{eq:one} and \\cite{knuth84, missing99}.',
      '\\input{sections/method}',
      '\\include{sections/missing}',
      '\\section*{Acknowledgements \\emph{(thanks)}}',
      '\\begin{figure}[h]\\end{figure}',
      '\\begin{equation*}x\\end{equation*}',
      '\\section{Broken {title',
      '\\end{document}',
    ].join('\n'),
    'sections/method.tex': [
      '\\section{Method}\\label{sec:method}',
      '\\subsection{Setup}',
      '\\begin{equation}\\label{eq:one}a=b\\end{equation}',
      '\\label{sec:intro}',
      '\\begin{table}\\end{table}',
      '\\citep[p.~3]{knuth84}',
      '50\\% of \\ref{undefined:key}',
    ].join('\n'),
    'refs.bib': ['@book{knuth84,', '  title={TAOCP}', '}', '@article{ other , x}'].join('\n'),
    'appendix.tex': [
      '\\chapter{Appendix}',
      '\\begin{thebibliography}{9}\\end{thebibliography}',
      '\\paragraph{Notes}',
    ].join('\n'),
  },
}

describe('AiAssistProjectIndex (server port)', function () {
  it('builds the same project index as the browser', function () {
    const expected = browserIndex.buildProjectIndex(PROJECT)
    const actual = server.buildProjectIndex(PROJECT)
    expect(JSON.stringify(actual)).to.equal(JSON.stringify(expected))
  })

  it('builds the same index when there is no root path', function () {
    const input = { docs: PROJECT.docs, rootPath: null }
    expect(JSON.stringify(server.buildProjectIndex(input))).to.equal(
      JSON.stringify(browserIndex.buildProjectIndex(input))
    )
  })

  it('parses outlines and references identically', function () {
    expect(JSON.stringify(server.parseOutline(PROJECT))).to.equal(
      JSON.stringify(browserOutline.parseOutline(PROJECT))
    )
    expect(JSON.stringify(server.extractReferences(PROJECT))).to.equal(
      JSON.stringify(browserRefs.extractReferences(PROJECT))
    )
  })

  it('matches sections identically', function () {
    const outline = browserOutline.parseOutline(PROJECT)
    for (const query of ['Introduction', 'intro', 'method', 'Setup', 'Acknowledgements', 'nothing', '', 'A']) {
      expect(
        JSON.stringify(server.matchSection(outline, query)),
        `matchSection(${JSON.stringify(query)})`
      ).to.equal(JSON.stringify(browserIndex.matchSection(outline, query)))
    }
  })

  it('reuses the previous index when nothing changed', function () {
    const first = server.buildProjectIndex(PROJECT)
    const second = server.buildProjectIndex(PROJECT, first)
    expect(second).to.equal(first)
  })

  it('skips files above MAX_INDEXED_BYTES like the browser', function () {
    const big = { rootPath: null, docs: { 'big.tex': '\\usepackage{x}\n' + 'a'.repeat(server.MAX_INDEXED_BYTES + 1) } }
    expect(JSON.stringify(server.buildProjectIndex(big))).to.equal(
      JSON.stringify(browserIndex.buildProjectIndex(big))
    )
  })
})
