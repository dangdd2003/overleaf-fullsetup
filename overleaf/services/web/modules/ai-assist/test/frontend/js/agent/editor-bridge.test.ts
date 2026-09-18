import { expect } from 'chai'
import {
  docToProjectFile,
  ensureFolderPath,
  findUniqueSpan,
  folderIdForPath,
  resolveCompileOutcome,
  spanToLineRange,
  toCompileOutcome,
  toLastCompile,
  waitFor,
} from '../../../../frontend/js/features/ai-assist/agent/use-project-handle'

const TEXT = 'alpha\nbeta\ngamma\nbeta\n'

describe('findUniqueSpan', function () {
  it('returns the index of a single occurrence', function () {
    expect(findUniqueSpan(TEXT, 'gamma')).to.deep.equal({
      status: 'found',
      index: 11,
      matchedLength: 5,
    })
  })

  it('returns matchedLength alongside index for exact matches', function () {
    expect(findUniqueSpan(TEXT, 'gamma')).to.deep.equal({
      status: 'found',
      index: 11,
      matchedLength: 5,
    })
  })

  it('matches multi-line blocks containing blank lines in Tier 3', function () {
    const docWithBlanks = 'line 1\n\nline 2\nline 3\n'
    const needleWithBlanks = '  line 1  \n\n  line 2  '
    const result = findUniqueSpan(docWithBlanks, needleWithBlanks)
    expect(result.status).to.equal('found')
    if (result.status === 'found') {
      expect(result.index).to.equal(0)
      expect(result.matchedLength).to.equal('line 1\n\nline 2'.length)
    }
  })

  it('handles empty oldText for append mode', function () {
    expect(findUniqueSpan(TEXT, '')).to.deep.equal({
      status: 'found',
      index: TEXT.length,
      matchedLength: 0,
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

  it('does not advance to line when span ends with a newline', function () {
    // TEXT = 'alpha\nbeta\ngamma\nbeta\n'
    // 'beta\n' at index 6 has length 5 (indices 6..10). It occupies line 2 only.
    const index = TEXT.indexOf('beta\n')
    expect(spanToLineRange(TEXT, index, 'beta\n'.length)).to.deep.equal({
      from: 2,
      to: 2,
    })
  })

  it('calculates accurate line ranges for multi-line anchors ending with newline', function () {
    // 'beta\ngamma\n' starts at line 2 and ends at line 3.
    const index = TEXT.indexOf('beta\ngamma\n')
    expect(spanToLineRange(TEXT, index, 'beta\ngamma\n'.length)).to.deep.equal({
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

  it('lets an explicit status win over the entries', function () {
    // A build that timed out still parses whatever partial log it left. Counting
    // zero errors in it and calling that a success is the wrong verdict.
    const outcome = toCompileOutcome({ errors: [], warnings: [] }, 'timedout')
    expect(outcome.status).to.equal('timedout')
    expect(outcome.errors).to.deep.equal([])
  })

  it('tolerates missing entries entirely', function () {
    expect(toCompileOutcome(null, 'no-output')).to.deep.equal({
      status: 'no-output',
      errors: [],
      warnings: [],
    })
    expect(toCompileOutcome(undefined)).to.deep.equal({
      status: 'success',
      errors: [],
      warnings: [],
    })
  })
})

describe('resolveCompileOutcome', function () {
  // The whole point of these verdicts: a build that did not produce a result is
  // never reported as a clean one, because "0 errors" is what the model repeats
  // back to the user as proof its fix worked.
  it('reports a clean build with no entries as a success', function () {
    const outcome = resolveCompileOutcome({
      kind: 'responded',
      settled: true,
      entries: { errors: [], warnings: [], all: [] },
    })
    expect(outcome.status).to.equal('success')
    expect(outcome.errors).to.deep.equal([])
  })

  it('reports parsed errors from a settled build', function () {
    const outcome = resolveCompileOutcome({
      kind: 'responded',
      settled: true,
      entries: { errors: [{ message: 'boom', file: 'main.tex', line: 7 }], warnings: [] },
    })
    expect(outcome.status).to.equal('failure')
    expect(outcome.errors).to.deep.equal([
      { message: 'boom', file: 'main.tex', line: 7 },
    ])
  })

  it('names a build that responded but never produced a parsable log', function () {
    const outcome = resolveCompileOutcome({ kind: 'responded', settled: false })
    expect(outcome.status).to.equal('no-output')
  })

  it('lets the editor error name a settled build that failed', function () {
    // A timedout build can still settle an empty log afterwards. Without the
    // error winning here it would read as a clean success.
    const outcome = resolveCompileOutcome({
      kind: 'responded',
      settled: true,
      entries: { errors: [], warnings: [] },
      error: 'timedout',
    })
    expect(outcome.status).to.equal('timedout')
  })

  it('does not treat a failed cache clear as the compile status', function () {
    const outcome = resolveCompileOutcome({
      kind: 'responded',
      settled: true,
      entries: { errors: [], warnings: [] },
      error: 'clear-cache',
    })
    expect(outcome.status).to.equal('success')
  })

  it('names a wait that ran out with no sign of life', function () {
    expect(
      resolveCompileOutcome({ kind: 'no-response', timedOut: true })
    ).to.deep.equal({ status: 'timedout', errors: [], warnings: [] })
  })

  it('reports the request failure when the compile never produced a response', function () {
    for (const error of ['clsi-unavailable', 'rate-limited', 'project-too-large']) {
      const outcome = resolveCompileOutcome({
        kind: 'no-response',
        timedOut: false,
        error,
      })
      expect(outcome.status, error).to.equal(error)
    }
  })

  it('says failure rather than success when a response-less build explains nothing', function () {
    expect(
      resolveCompileOutcome({ kind: 'no-response', timedOut: false })
    ).to.deep.equal({ status: 'failure', errors: [], warnings: [] })
  })

  it('reports a repeat timeout on its own terms', function () {
    // Two timeouts in a row produce the same error string, so the verdict cannot
    // come from comparing it against a snapshot of itself.
    const first = resolveCompileOutcome({
      kind: 'no-response',
      timedOut: false,
      error: 'timedout',
    })
    const second = resolveCompileOutcome({
      kind: 'no-response',
      timedOut: false,
      error: 'timedout',
    })
    expect(first.status).to.equal('timedout')
    expect(second.status).to.equal('timedout')
  })
})

describe('waitFor', function () {
  it('resolves true as soon as the condition holds', async function () {
    let ready = false
    setTimeout(() => {
      ready = true
    }, 30)

    expect(await waitFor(() => ready, { timeoutMs: 2000 })).to.equal(true)
  })

  it('is already true when the condition holds before the first poll', async function () {
    expect(await waitFor(() => true, { timeoutMs: 10 })).to.equal(true)
  })

  it('gives up with false once the budget is spent', async function () {
    expect(await waitFor(() => false, { timeoutMs: 100 })).to.equal(false)
  })

  it('throws on an abort signal rather than waiting the budget out', async function () {
    const controller = new AbortController()
    controller.abort()

    try {
      await waitFor(() => false, { timeoutMs: 5000, signal: controller.signal })
      expect.fail('should have thrown')
    } catch (error: any) {
      expect(error.message).to.match(/cancelled/i)
    }
  })

  it('stops waiting when the signal aborts mid-wait', async function () {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 60)

    const started = Date.now()
    try {
      await waitFor(() => false, { timeoutMs: 5000, signal: controller.signal })
      expect.fail('should have thrown')
    } catch (error: any) {
      expect(error.message).to.match(/cancelled/i)
      expect(Date.now() - started).to.be.lessThan(2000)
    }
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

describe('ensureFolderPath recursive folder creation', function () {
  it('returns root folder id when segments is empty', async function () {
    const root: any = { _id: 'root-1', folders: [] }
    const id = await ensureFolderPath('p-1', root, [])
    expect(id).to.equal('root-1')
  })

  it('navigates existing folders without calling entity creation', async function () {
    const root: any = {
      _id: 'root-1',
      folders: [
        {
          _id: 'f-sections',
          name: 'sections',
          folders: [{ _id: 'f-sub', name: 'sub', folders: [] }],
        },
      ],
    }
    const id = await ensureFolderPath('p-1', root, ['sections', 'sub'])
    expect(id).to.equal('f-sub')
  })
})

describe('bridge event payload and timeout handling', function () {
  it('passes target path in agentReadDoc and receives text', async function () {
    const onRead = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail?.path === 'sections/ch1.tex') {
        window.dispatchEvent(
          new CustomEvent('aiAssist:agentReadDocResult', {
            detail: { text: 'chapter one content' },
          })
        )
      } else {
        window.dispatchEvent(
          new CustomEvent('aiAssist:agentReadDocResult', {
            detail: { text: null, error: 'pathMismatch' },
          })
        )
      }
    }
    window.addEventListener('aiAssist:agentReadDoc', onRead)

    // Verify through window dispatch
    const readPromise = new Promise(resolve => {
      const onRes = (e: Event) => {
        window.removeEventListener('aiAssist:agentReadDocResult', onRes)
        resolve((e as CustomEvent).detail)
      }
      window.addEventListener('aiAssist:agentReadDocResult', onRes)
      window.dispatchEvent(
        new CustomEvent('aiAssist:agentReadDoc', {
          detail: { path: 'sections/ch1.tex' },
        })
      )
    })

    const res: any = await readPromise
    window.removeEventListener('aiAssist:agentReadDoc', onRead)
    expect(res.text).to.equal('chapter one content')
  })
})
