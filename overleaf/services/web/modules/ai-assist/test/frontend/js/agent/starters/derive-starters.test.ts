import { expect } from 'chai'
import {
  deriveStarters,
  MAX_STARTERS,
  StarterSignals,
} from '../../../../../frontend/js/features/ai-assist/agent/starters/derive-starters'
import { buildProjectIndex } from '../../../../../frontend/js/features/ai-assist/agent/context/project-index'
import { LastCompile, ProjectFile } from '../../../../../frontend/js/features/ai-assist/agent/project-handle'

function filesFor(docs: Record<string, string>): ProjectFile[] {
  return Object.entries(docs).map(([path, text]) => ({
    path,
    type: 'doc' as const,
    size: text.length,
    lines: text.split('\n').length,
  }))
}

function signals(
  docs: Record<string, string>,
  {
    lastCompile = null,
    openFile = null,
    rootPath = 'main.tex',
  }: {
    lastCompile?: LastCompile | null
    openFile?: { path: string; cursorLine: number | null } | null
    rootPath?: string | null
  } = {}
): StarterSignals {
  return {
    index: buildProjectIndex({ docs, rootPath }),
    files: filesFor(docs),
    lastCompile,
    openFile,
  }
}

const BROKEN: Record<string, string> = {
  'main.tex': [
    '\\documentclass{article}',
    '\\usepackage{graphicx}',
    '\\title{On Things}',
    '\\begin{document}',
    '\\section{Introduction}',
    'As shown by \\cite{vaswani2017attention} and \\cite{devlin2019bert},',
    'see \\ref{sec:results} and \\ref{fig:arch}.',
    '\\end{document}',
  ].join('\n'),
  'sections/methods.tex': [
    '\\section{Methods}',
    '\\begin{tikzpicture}',
    '\\draw (0,0) -- (1,1);',
    '\\end{tikzpicture}',
  ].join('\n'),
}

describe('deriveStarters', function () {
  it('ranks the failing build first and names the real errors', function () {
    const starters = deriveStarters(
      signals(BROKEN, {
        lastCompile: {
          status: 'failure',
          errors: [
            { message: 'Undefined control sequence.', file: 'main.tex', line: 6 },
            { message: 'Missing $ inserted.', file: 'main.tex', line: 7 },
          ],
          warnings: [],
          rawLog: null,
        },
      })
    )

    expect(starters).to.have.lengthOf(MAX_STARTERS)
    expect(starters[0].id).to.equal('fix_compile_errors')
    expect(starters[0].params.error_count).to.equal(2)
    expect(starters.map(starter => starter.id)).to.include.members([
      'add_missing_package',
      'add_bibliography',
      'resolve_broken_refs',
    ])
    // Four rules fire, so no fallback slot is left — and a fallback that
    // twins a fired rule must never appear even when a slot is free.
    expect(starters.map(starter => starter.id)).to.not.include.members([
      'manage_bibliography',
      'generate_tikz',
    ])
  })

  it('names the missing package and the citation keys in the prompts', function () {
    const starters = deriveStarters(signals(BROKEN))
    const pkg = starters.find(starter => starter.id === 'add_missing_package')
    const bib = starters.find(starter => starter.id === 'add_bibliography')

    expect(pkg?.prompt).to.include('\\usepackage{tikz}')
    expect(pkg?.prompt).to.include('sections/methods.tex')
    expect(bib?.prompt).to.include('vaswani2017attention')
    expect(bib?.prompt).to.include('references.bib')
  })

  it('never shows a bibliography starter for a hand-rolled one', function () {
    const docs = {
      'main.tex': [
        '\\begin{document}',
        'Seen in \\cite{knuth1984}.',
        '\\begin{thebibliography}{9}',
        '\\bibitem{knuth1984} Donald Knuth.',
        '\\end{thebibliography}',
        '\\end{document}',
      ].join('\n'),
    }

    const ids = deriveStarters(signals(docs)).map(starter => starter.id)
    expect(ids).to.not.include('add_bibliography')
  })

  it('does not propose packages the document class provides', function () {
    const docs = {
      'main.tex': [
        '\\documentclass{beamer}',
        '\\begin{document}',
        '\\begin{algorithm}',
        'x',
        '\\end{algorithm}',
        '\\end{document}',
      ].join('\n'),
    }

    const ids = deriveStarters(signals(docs)).map(starter => starter.id)
    expect(ids).to.not.include('add_missing_package')
  })

  it('offers warnings only when the build itself passes', function () {
    const docs = {
      'main.tex': [
        '\\documentclass{article}',
        '\\begin{document}',
        '\\section{Introduction}',
        'Text.',
        '\\end{document}',
      ].join('\n'),
    }
    const starters = deriveStarters(
      signals(docs, {
        lastCompile: {
          status: 'success',
          errors: [],
          warnings: [{ message: 'Overfull hbox.', file: 'main.tex', line: 5 }],
          rawLog: null,
        },
      })
    )

    expect(starters[0].id).to.equal('resolve_warnings')
    expect(starters.map(starter => starter.id)).to.not.include('fix_compile_errors')
  })

  it('offers a first draft for a skeleton project', function () {
    const docs = {
      'main.tex': [
        '\\documentclass{article}',
        '\\begin{document}',
        '',
        '\\end{document}',
      ].join('\n'),
    }

    const ids = deriveStarters(signals(docs)).map(starter => starter.id)
    expect(ids).to.include('init_document_structure')
  })

  it('does not claim emptiness before the file listing has loaded', function () {
    const base = signals(BROKEN)
    const ids = deriveStarters({ ...base, files: [] }).map(
      starter => starter.id
    )
    expect(ids).to.not.include('init_document_structure')
  })

  it('falls back to generics, never duplicating a fired rule', function () {
    const healthy = {
      'main.tex': [
        '\\documentclass{article}',
        '\\usepackage{graphicx}',
        '\\title{On Things}',
        '\\begin{document}',
        '\\begin{abstract}',
        'We study things.',
        '\\end{abstract}',
        '\\section{Introduction}',
        ...Array.from({ length: 50 }, (_, i) => `Line ${i} of prose about things.`),
        '\\section{Methods}',
        'See \\ref{fig:arch} and \\cite{vaswani2017attention}.',
        '\\begin{figure}',
        '\\label{fig:arch}',
        '\\end{figure}',
        '\\section{Results}',
        '\\section{Conclusion}',
        'We conclude.',
        '\\end{document}',
      ].join('\n'),
      'refs.bib': '@article{vaswani2017attention,\n  title={Attention}}\n',
    }

    const starters = deriveStarters(
      signals(healthy, {
        lastCompile: { status: 'success', errors: [], warnings: [], rawLog: null },
        openFile: { path: 'main.tex', cursorLine: 10 },
      })
    )

    expect(starters).to.have.lengthOf(MAX_STARTERS)
    const ids = starters.map(starter => starter.id)
    expect(ids).to.not.include.members([
      'fix_compile_errors',
      'resolve_warnings',
      'add_bibliography',
      'resolve_broken_refs',
      'add_missing_package',
      'init_document_structure',
    ])
    // The one fired rule keeps its slot; the remaining slots come from the
    // generic pool, distinct, in whatever order the shuffle lands on.
    expect(ids).to.include('proofread_active_file')
    const pool = [
      'what_can_you_do',
      'beamer',
      'generate_table',
      'manage_bibliography',
      'generate_tikz',
      'insert_equation',
      'summarize',
    ]
    const fillers = ids.filter(id => id !== 'proofread_active_file')
    expect(fillers).to.have.lengthOf(MAX_STARTERS - 1)
    expect(new Set(fillers).size).to.equal(fillers.length)
    for (const id of fillers) expect(pool).to.include(id)
  })

  it('offers to proofread a substantial open file in a clean project', function () {
    const healthy = {
      'main.tex': [
        '\\documentclass{article}',
        '\\title{On Things}',
        '\\begin{document}',
        ...Array.from({ length: 60 }, (_, i) => `Line ${i} of passive prose was written.`),
        '\\end{document}',
      ].join('\n'),
    }

    const ids = deriveStarters(
      signals(healthy, {
        lastCompile: { status: 'success', errors: [], warnings: [], rawLog: null },
        openFile: { path: 'main.tex', cursorLine: 10 },
      })
    ).map(starter => starter.id)

    expect(ids).to.include('proofread_active_file')
  })

  // Insertion starters must send the model to read this project, not hand it a
  // template to paste. The prompt names the file and what to ground the content
  // in; it never dictates the markup or a line to insert at.
  it('points insertion starters at the open file instead of a template', function () {
    const cited = {
      'main.tex': [
        '\\documentclass{article}',
        '\\begin{document}',
        '\\section{Introduction}',
        'Throughput rose from 12 to 31 requests per second \\cite{smith2020}.',
        '\\end{document}',
      ].join('\n'),
    }

    const starters = deriveStarters(
      signals(cited, { openFile: { path: 'main.tex', cursorLine: 4 } })
    )
    const table = starters.find(starter => starter.id === 'generate_table')

    expect(table, 'generate_table should fill a free slot here').to.exist
    expect(table!.prompt).to.include('Read main.tex')
    expect(table!.prompt).to.match(/actual values/)
    // No markup dictated, and no mechanical insertion point.
    expect(table!.prompt).to.not.match(/booktabs/)
    expect(table!.prompt).to.not.match(/cursor|line \d/)
  })

  it('always returns exactly MAX_STARTERS', function () {
    expect(deriveStarters(signals({}, { rootPath: null }))).to.have.lengthOf(
      MAX_STARTERS
    )
    expect(deriveStarters(signals(BROKEN))).to.have.lengthOf(MAX_STARTERS)
  })

  it('derives fix_duplicate_labels when references contain duplicate labels', function () {
    const sigs: any = {
      index: {
        rootPath: 'main.tex',
        references: {
          duplicateLabels: ['fig:plot', 'sec:intro'],
          refs: [],
          citations: [],
          labels: [],
          bibKeys: [],
        },
        outline: { sections: [], hasTitle: true },
        packages: [],
        files: [],
      },
      files: [{ path: 'main.tex', type: 'doc' }],
      lastCompile: { status: 'success', errors: [], warnings: [] },
      openFile: null,
    }

    const starters = deriveStarters(sigs)
    const dupStarter = starters.find(s => s.id === 'fix_duplicate_labels')
    expect(dupStarter).to.exist
    expect(dupStarter!.priority).to.equal(87)
    expect(dupStarter!.params.count).to.equal(2)
    expect(dupStarter!.prompt).to.include('duplicate')
  })

  it('marks derived starters as oneShot: true and fallbacks as oneShot: false', function () {
    const sigs: any = {
      index: null,
      files: [{ path: 'main.tex', type: 'doc' }],
      lastCompile: {
        status: 'failure',
        errors: [{ message: 'err', file: 'main.tex', line: 1 }],
        warnings: [],
      },
      openFile: null,
    }

    const starters = deriveStarters(sigs)
    const errStarter = starters.find(s => s.id === 'fix_compile_errors')
    expect(errStarter!.oneShot).to.equal(true)

    const fallbackStarter = starters.find(s => s.priority === 0)
    if (fallbackStarter) {
      expect(fallbackStarter.oneShot).to.equal(false)
    }
  })
})
