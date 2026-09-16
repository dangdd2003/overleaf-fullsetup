import { expect } from 'chai'
import {
  docToProjectFile,
  findUniqueSpan,
  folderIdForPath,
  spanToLineRange,
  toCompileOutcome,
  toLastCompile,
} from '../../../../frontend/js/features/ai-assist/agent/use-project-handle'

const TEXT = 'alpha\nbeta\ngamma\nbeta\n'

describe('findUniqueSpan', function () {
  it('returns the index of a single occurrence', function () {
    expect(findUniqueSpan(TEXT, 'gamma')).to.deep.equal({
      status: 'found',
      index: 11,
    })
  })

  it('reports no match', function () {
    expect(findUniqueSpan(TEXT, 'delta')).to.deep.equal({ status: 'noMatch' })
  })

  it('reports how many times an ambiguous span appears', function () {
    expect(findUniqueSpan(TEXT, 'beta')).to.deep.equal({
      status: 'ambiguous',
      matches: 2,
    })
  })
})

describe('spanToLineRange', function () {
  it('maps a span onto 1-indexed inclusive lines', function () {
    const index = TEXT.indexOf('gamma')
    expect(spanToLineRange(TEXT, index, 'gamma'.length)).to.deep.equal({
      from: 3,
      to: 3,
    })
  })

  it('covers every line a multi-line span touches', function () {
    const index = TEXT.indexOf('beta')
    expect(spanToLineRange(TEXT, index, 'beta\ngamma'.length)).to.deep.equal({
      from: 2,
      to: 3,
    })
  })
})

describe('docToProjectFile', function () {
  it('counts the lines of a document, which is what the model ranges over', function () {
    expect(docToProjectFile('main.tex', 'one\ntwo\nthree')).to.deep.equal({
      path: 'main.tex',
      type: 'doc',
      size: 13,
      lines: 3,
    })
  })

  it('counts a trailing newline as opening a further line', function () {
    expect(docToProjectFile('main.tex', 'one\ntwo\n').lines).to.equal(3)
  })

  // Every readable document has a line, even when that line is empty, so 0 is
  // reserved for "contents unavailable".
  it('reports one line for an empty document', function () {
    expect(docToProjectFile('empty.tex', '')).to.deep.equal({
      path: 'empty.tex',
      type: 'doc',
      size: 0,
      lines: 1,
    })
  })

  it('reports no lines when the contents are unavailable', function () {
    expect(docToProjectFile('gone.tex', null)).to.deep.equal({
      path: 'gone.tex',
      type: 'doc',
      size: 0,
      lines: 0,
    })
    expect(docToProjectFile('gone.tex', undefined).lines).to.equal(0)
  })
})

describe('toLastCompile', function () {
  // No log entries at all means the project has not compiled in this session,
  // which is different from a compile that produced no errors.
  it('reports nothing when there are no log entries', function () {
    expect(toLastCompile(null, 'some log')).to.equal(null)
    expect(toLastCompile(undefined, 'some log')).to.equal(null)
  })

  it('reports a failure when the log holds any error', function () {
    const compile = toLastCompile(
      { errors: [{ message: 'boom' }], warnings: [{ message: 'meh' }] },
      '! boom'
    )
    expect(compile).to.deep.equal({
      status: 'failure',
      errors: [{ message: 'boom', file: null, line: null }],
      warnings: [{ message: 'meh', file: null, line: null }],
      rawLog: '! boom',
    })
  })

  it('reports a success when the log holds no error', function () {
    const compile = toLastCompile({ errors: [], warnings: [] }, 'all good')
    expect(compile?.status).to.equal('success')
    expect(compile?.errors).to.deep.equal([])
  })

  it('reports a success when a warning-only log omits its error list', function () {
    const compile = toLastCompile({ warnings: [{ message: 'meh' }] }, null)
    expect(compile?.status).to.equal('success')
    expect(compile?.errors).to.deep.equal([])
  })

  it('defaults the fields a sparse log entry leaves out', function () {
    const compile = toLastCompile(
      { errors: [{}, { file: 'main.tex', line: 3 }] },
      null
    )
    expect(compile?.errors).to.deep.equal([
      { message: '', file: null, line: null },
      { message: '', file: 'main.tex', line: 3 },
    ])
  })

  it('reports no raw log rather than an undefined one', function () {
    expect(toLastCompile({ errors: [] }, undefined)?.rawLog).to.equal(null)
    expect(toLastCompile({ errors: [] }, null)?.rawLog).to.equal(null)
  })
})

describe('toCompileOutcome', function () {
  // `compile()` returns a CompileOutcome, which carries no raw log.
  it('summarises a compile without a raw log', function () {
    expect(
      toCompileOutcome({ errors: [{ message: 'boom', line: 3 }] })
    ).to.deep.equal({
      status: 'failure',
      errors: [{ message: 'boom', file: null, line: 3 }],
      warnings: [],
    })
  })
})

describe('folderIdForPath', function () {
  const ROOT_FOLDER: any = {
    _id: 'root-1',
    name: 'root',
    docs: [],
    fileRefs: [],
    folders: [
      {
        _id: 'folder-sections',
        name: 'sections',
        docs: [],
        fileRefs: [],
        folders: [
          {
            _id: 'folder-sub',
            name: 'sub',
            docs: [],
            fileRefs: [],
            folders: [],
          },
        ],
      },
    ],
  }

  it('returns the root folder id when segments is empty', function () {
    expect(folderIdForPath(ROOT_FOLDER, [])).to.equal('root-1')
  })

  it('resolves a single segment to the child folder id', function () {
    expect(folderIdForPath(ROOT_FOLDER, ['sections'])).to.equal(
      'folder-sections'
    )
  })

  it('resolves nested segments through the folder tree', function () {
    expect(folderIdForPath(ROOT_FOLDER, ['sections', 'sub'])).to.equal(
      'folder-sub'
    )
  })

  it('returns null when a folder segment is missing', function () {
    expect(folderIdForPath(ROOT_FOLDER, ['missing'])).to.equal(null)
    expect(folderIdForPath(ROOT_FOLDER, ['sections', 'missing'])).to.equal(null)
  })
})
