import { describe, it } from 'vitest'
import { expect } from 'chai'
import { renderToolResult } from '../../../app/src/AiAssistToolRender.mjs'

describe('renderToolResult', function () {
  it('renders read_file as a fenced block with a header and continuation hint', function () {
    const text = renderToolResult('read_file', {
      path: 'main.tex',
      from: 1,
      to: 2,
      totalLines: 5,
      content: '1: a\n2: b',
      truncated: true,
      nextRange: { from: 3, to: 5 },
    })
    expect(text).to.equal(
      'main.tex lines 1-2 of 5\n```\n1: a\n2: b\n```\n(truncated - call read_file with from=3, to=5 for the rest)'
    )
  })

  it('renders list_files rows and marks binaries', function () {
    const text = renderToolResult('list_files', {
      files: [
        { path: 'main.tex', type: 'doc', lines: 12 },
        { path: 'fig.png', type: 'binary' },
      ],
      total: 3,
      truncated: true,
    })
    expect(text).to.equal('main.tex  doc  12\nfig.png  binary\n(1 more; narrow with glob=)')
  })

  it('renders get_outline as an indented tree', function () {
    const text = renderToolResult('get_outline', {
      documentClass: 'article',
      sections: [
        { path: 'main.tex', line: 4, level: 1, title: 'Intro' },
        { path: 'main.tex', line: 6, level: 2, title: 'Background' },
      ],
      includes: [{ from: 'main.tex', to: 'b.tex', line: 9, resolved: false }],
      notes: [],
    })
    expect(text).to.equal(
      'documentclass: article\n    main.tex:4 Intro\n      main.tex:6 Background\n\\input main.tex:9 -> b.tex (UNRESOLVED)'
    )
  })

  it('renders get_packages and get_references', function () {
    expect(renderToolResult('get_packages', {
      documentClass: 'article',
      packages: [{ name: 'geometry', path: 'main.tex', line: 2 }],
    })).to.equal('documentclass: article\ngeometry  (main.tex:2)')

    expect(renderToolResult('get_references', {
      refs: [{ command: 'ref', key: 'sec:x', path: 'main.tex', line: 5, resolved: false }],
    })).to.equal('ref sec:x  main.tex:5  UNRESOLVED')

    expect(renderToolResult('get_references', {})).to.equal(
      '(no labels, references, or citations found in project)'
    )
  })

  it('keeps errors and unknown tools as JSON', function () {
    expect(renderToolResult('read_file', { error: 'File not found: x' })).to.equal('{"error":"File not found: x"}')
    expect(renderToolResult('compile_project', { status: 'success' })).to.equal('{"status":"success"}')
    expect(renderToolResult('no_such_tool', { a: 1 })).to.equal('{"a":1}')
    expect(renderToolResult('read_file', null)).to.equal('null')
  })

  it('renders compile_project as compact text without repeating the primary error', function () {
    const error = { file: 'main.tex', line: 3, message: 'Undefined control sequence.', excerpt: 'l.3 \\foo' }
    const text = renderToolResult('compile_project', {
      status: 'failure',
      errorCount: 2,
      warningCount: 1,
      message: 'The project compiled with 2 error(s) and 1 warning(s).',
      primaryError: error,
      errors: [error, { file: null, line: null, message: 'Emergency stop.' }],
      warnings: [{ file: 'main.tex', line: null, message: 'Label(s) may have changed.' }],
    })
    expect(text).to.equal([
      'The project compiled with 2 error(s) and 1 warning(s).',
      'Errors after the first often cascade from it.',
      'error main.tex:3: Undefined control sequence.',
      '    l.3 \\foo',
      'error unknown location: Emergency stop.',
      'warning main.tex: Label(s) may have changed.',
    ].join('\n'))
  })

  it('says how many diagnostics compile_project left out', function () {
    const text = renderToolResult('compile_project', {
      status: 'failure',
      errorCount: 25,
      warningCount: 0,
      message: 'm',
      errors: [{ file: 'a.tex', line: 1, message: 'x' }],
      warnings: [],
    })
    expect(text).to.include('(24 more error(s) and 0 more warning(s) not shown; call get_compile_result with a higher limit)')
  })

  it('renders get_compile_result, including the nothing-compiled case', function () {
    expect(renderToolResult('get_compile_result', { status: 'none', message: 'No compile yet.' })).to.equal('No compile yet.')
    expect(renderToolResult('get_compile_result', {
      status: 'success',
      errorCount: 0,
      warningCount: 1,
      errors: [],
      warnings: [{ file: 'main.tex', line: 7, message: 'Overfull \\hbox' }],
      truncated: false,
    })).to.equal('Last compile: success - 0 error(s), 1 warning(s)\nwarning main.tex:7: Overfull \\hbox')
  })

  it('renders an applied edit with its new line numbers and the shift below it', function () {
    expect(renderToolResult('edit_file', {
      status: 'applied',
      path: 'main.tex',
      startLine: 2,
      endLine: 3,
      lineDelta: 1,
      excerpt: '1: line 1\n2: a\n3: b\n4: line 3',
    })).to.equal(
      'Applied to main.tex, now lines 2-3. Later lines moved by +1; use these line numbers, not ones read before this edit.\n```\n1: line 1\n2: a\n3: b\n4: line 3\n```'
    )

    expect(renderToolResult('edit_file', {
      status: 'applied',
      path: 'main.tex',
      startLine: 2,
      endLine: null,
      lineDelta: -2,
      excerpt: '1: line 1',
    })).to.equal(
      'Applied to main.tex, removed text at line 2. Later lines moved by -2; use these line numbers, not ones read before this edit.\n```\n1: line 1\n```'
    )

    expect(renderToolResult('edit_file', { status: 'noMatch', error: 'x' })).to.equal('{"status":"noMatch","error":"x"}')
  })

  it('renders search context lines in file order', function () {
    expect(renderToolResult('search_text', {
      hits: [{ path: 'main.tex', line: 5, text: 'hit', before: ['b1', 'b2'], after: ['a1'] }],
      total: 1,
      truncated: false,
    })).to.equal('Found 1 hit(s):\n  3: b1\n  4: b2\nmain.tex:5: hit\n  6: a1')
  })
})
