import { describe, it } from 'vitest'
import { expect } from 'chai'
import { renderToolResult } from '../../../app/src/AiAssistToolRender.mjs'
import {
  SYSTEM_PROMPT,
  systemBlocksFor,
} from '../../../app/src/AiAssistSystemPrompt.mjs'
import { withErrorsStatus } from '../../../app/src/AiAssistTools.mjs'

const PAGE = {
  status: 'ok',
  page: 2,
  pageCount: 4,
  chosenBy: 'page',
  sourceMap: [],
  badBoxes: [],
}

describe('withErrorsStatus', function () {
  it('reports a build with errors that still wrote a PDF as success_with_errors', function () {
    expect(withErrorsStatus('failure', 3, true)).to.equal('success_with_errors')
    expect(withErrorsStatus('success', 1, true)).to.equal('success_with_errors')
  })

  it('keeps failure when no PDF was written', function () {
    expect(withErrorsStatus('failure', 3, false)).to.equal('failure')
  })

  it('leaves clean builds and other statuses alone', function () {
    expect(withErrorsStatus('success', 0, true)).to.equal('success')
    expect(withErrorsStatus('timedout', 2, true)).to.equal('timedout')
  })
})

describe('system prompt PDF paragraph', function () {
  it('names every PDF tool and the banned quick fixes', function () {
    for (const text of [SYSTEM_PROMPT, systemBlocksFor('manual').shared]) {
      expect(text).to.include('view_compiled_pdf_page shows one page')
      expect(text).to.include('view_compiled_pdf_overview')
      expect(text).to.include('search_compiled_pdf')
      expect(text).to.include('resolve_pdf_block')
      expect(text).to.include('diff_compiled_pdf')
      expect(text).to.include('inspect_compiled_style')
      expect(text).to.include('\\resizebox')
    }
  })
})

describe('renderToolResult for PDF staleness and source status', function () {
  it('names the reason and the changed files when the build is out of date', function () {
    const text = renderToolResult('view_compiled_pdf_page', {
      ...PAGE,
      buildStale: {
        reason: 'docs_changed',
        changed: ['chapters/intro.tex', 'refs.bib'],
      },
    })
    expect(text).to.include('The PDF is out of date: project files changed')
    expect(text).to.include('Changed: chapters/intro.tex, refs.bib.')
    expect(text).to.include('whoever made the change')
  })

  it('asks for a clean compile when the compiler changed', function () {
    const text = renderToolResult('view_compiled_pdf_page', {
      ...PAGE,
      buildStale: { reason: 'compiler_changed', changed: [] },
    })
    expect(text).to.include('compiler or TeX image changed')
    expect(text).to.include('clean set to true')
  })

  it('keeps the agent-edit hint next to the fingerprint reason', function () {
    const text = renderToolResult('view_compiled_pdf_overview', {
      status: 'ok',
      fromPage: 1,
      toPage: 1,
      pageCount: 1,
      pages: [],
      stale: true,
      buildStale: { reason: 'root_changed', changed: ['main.tex'] },
    })
    expect(text).to.include('root document changed')
    expect(text).to.include('You edited the project after this build')
  })

  it.each([
    ['no_synctex', 'compile_project with clean'],
    ['probe_missed', 'Pass path and line again'],
    ['line_not_in_build', 'is not typeset in this build'],
  ])('gives guidance for %s', function (sourceStatus, expected) {
    const text = renderToolResult('view_compiled_pdf_page', {
      ...PAGE,
      sourceStatus,
      focus: { path: 'main.tex', line: 12, endLine: 12 },
      span: { top: 10, bottom: 20 },
    })
    expect(text).to.include(expected)
  })

  it('says nothing extra when the source is mapped', function () {
    const text = renderToolResult('view_compiled_pdf_page', {
      ...PAGE,
      sourceStatus: 'mapped',
    })
    expect(text).not.to.include('SyncTeX did not')
    expect(text).not.to.include('out of date')
  })

  it('renders a success_with_errors compile as viewable', function () {
    const text = renderToolResult('compile_project', {
      status: 'success_with_errors',
      pdfProduced: true,
      buildId: '1700000000-abcdef',
      clean: false,
      errorCount: 2,
      warningCount: 0,
      errors: [{ file: 'main.tex', line: 3, message: 'Undefined control sequence.' }],
      warnings: [],
      message:
        'The project has 2 error(s), but LaTeX still wrote a PDF, so the pages can be viewed: parts after an error may be missing or misplaced. Fix the errors first, then compile again.',
    })
    expect(text).to.include('LaTeX still wrote a PDF')
  })

  it('always carries the style memory section', function () {
    expect(systemBlocksFor('manual', {}).shared).to.include(
      '# Style preferences'
    )
  })
})

describe('renderToolResult for labels, defects and visual diff', function () {
  it('renders the block table and the defect with its banned fixes', function () {
    const text = renderToolResult('view_compiled_pdf_page', {
      ...PAGE,
      sourceStatus: 'mapped',
      blocks: [
        {
          id: 'B3',
          page: 2,
          bbox: { x: 72, y: 300, w: 400, h: 40 },
          path: 'main.tex',
          line: 40,
          endLine: 44,
          text: 'A wide table',
        },
      ],
      defects: [
        {
          id: 'D1',
          category: 'overflow',
          page: 2,
          path: 'main.tex',
          line: 41,
          severity: 'error',
          evidence: 'ink 4mm past the right margin',
          bannedFixes: ['\\resizebox', '\\small'],
        },
      ],
    })
    expect(text).to.include('B3  300pt  main.tex:40-44')
    expect(text).to.include('D1 error overflow  main.tex:41')
    expect(text).to.include('do not use: \\resizebox, \\small')
  })

  it('renders a block resolution as a file and line range', function () {
    const text = renderToolResult('resolve_pdf_block', {
      status: 'ok',
      block: 'B3',
      page: 2,
      path: 'main.tex',
      line: 40,
      endLine: 44,
    })
    expect(text).to.equal('Block B3 on page 2 is main.tex lines 40-44.')
  })

  it('renders the visual diff summary and says when nothing changed', function () {
    const changed = renderToolResult('diff_compiled_pdf', {
      status: 'ok',
      changed: true,
      summary: ['Page 2 changed: changed 10%-14% of page height.'],
      image: { mediaType: 'image/png', data: 'iVBORw0KGgo=', width: 1, height: 1 },
    })
    expect(changed).to.include('Compared with the build before the last compile')
    expect(changed).to.include('Page 2 changed')
    const same = renderToolResult('diff_compiled_pdf', {
      status: 'ok',
      changed: false,
      summary: [],
    })
    expect(same).to.include('No visible change')
  })
})
