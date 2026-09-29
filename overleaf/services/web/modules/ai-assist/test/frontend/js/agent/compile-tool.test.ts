import { expect } from 'chai'
import { TOOLS } from '../../../../frontend/js/features/ai-assist/agent/tools/registry'
import { wantsCleanCompile } from '../../../../frontend/js/features/ai-assist/agent/tools/compile-args'
import { LogEntrySummary } from '../../../../frontend/js/features/ai-assist/agent/project-handle'
import { toCompileOutcome } from '../../../../frontend/js/features/ai-assist/agent/use-project-handle'
import { createFakeHandle } from './helpers/fake-handle'

describe('compile_project', function () {
  it('supports excerpt field in error summaries', function () {
    const error: LogEntrySummary = {
      message: 'Undefined control sequence',
      file: 'main.tex',
      line: 12,
      excerpt: '! Undefined control sequence.\nl.12 \\foo',
    }
    expect(error.excerpt).to.equal('! Undefined control sequence.\nl.12 \\foo')
  })

  it('summarises errors and warnings', async function () {
    const { handle } = createFakeHandle({
      compileResult: {
        status: 'failure',
        errors: [
          { message: 'Undefined control sequence', file: 'main.tex', line: 12 },
        ],
        warnings: [{ message: 'Overfull hbox', file: 'main.tex', line: 40 }],
      },
    })

    const result: any = await TOOLS.compile_project.execute({}, handle)

    expect(result.status).to.equal('failure')
    expect(result.errorCount).to.equal(1)
    expect(result.warningCount).to.equal(1)
    expect(result.errors[0].message).to.equal('Undefined control sequence')
  })

  it('says so plainly when the compile succeeded with nothing to report', async function () {
    const { handle } = createFakeHandle({
      compileResult: { status: 'success', errors: [], warnings: [] },
    })

    const result: any = await TOOLS.compile_project.execute({}, handle)

    expect(result.errorCount).to.equal(0)
    expect(result.message).to.match(/compiled/i)
  })

  it('recovers after a compile throws instead of wedging for the session', async function () {
    const { handle } = createFakeHandle()
    handle.compile = () => Promise.reject(new Error('clsi unreachable'))

    const failed: any = await TOOLS.compile_project.execute({}, handle)
    expect(failed.error).to.match(/clsi unreachable/i)

    handle.compile = async () => ({ status: 'success', errors: [], warnings: [] })
    const recovered: any = await TOOLS.compile_project.execute({}, handle)
    expect(recovered.status).to.equal('success')
  })

  it('cancels a compile on abort and stays usable afterwards', async function () {
    const controller = new AbortController()
    const { handle } = createFakeHandle()
    handle.compile = (options?: { signal?: AbortSignal }) => {
      return new Promise((resolve, reject) => {
        if (options?.signal?.aborted) return reject(new Error('Compile cancelled'))
        options?.signal?.addEventListener('abort', () => reject(new Error('Compile cancelled')))
      })
    }

    const compilePromise = (TOOLS.compile_project as any).execute({}, handle, { signal: controller.signal })
    controller.abort()
    const result: any = await compilePromise

    expect(result.error).to.match(/cancelled/i)

    handle.compile = async () => ({ status: 'success', errors: [], warnings: [] })
    const second: any = await TOOLS.compile_project.execute({}, handle)
    expect(second.status).to.equal('success')
  })

  it('does not ask for a clean rebuild unless the model did', async function () {
    const { handle, calls } = createFakeHandle({
      compileResult: { status: 'success', errors: [], warnings: [] },
    })

    await TOOLS.compile_project.execute({}, handle)

    const compile = calls.find(call => call.name === 'compile')
    expect((compile?.args as any)?.clean).to.equal(undefined)
  })

  it('passes a clean rebuild through to the handle and says so', async function () {
    const { handle, calls } = createFakeHandle({
      compileResult: { status: 'success', errors: [], warnings: [] },
    })

    const result: any = await TOOLS.compile_project.execute({ clean: true }, handle)

    const compile = calls.find(call => call.name === 'compile')
    expect((compile?.args as any)?.clean).to.equal(true)
    expect(result.clean).to.equal(true)
    expect(result.message).to.match(/cache was cleared/i)
    expect(result.message).to.match(/rebuilt/i)
  })

  it('forwards the abort signal alongside the clean flag', async function () {
    const controller = new AbortController()
    const { handle, calls } = createFakeHandle({
      compileResult: { status: 'success', errors: [], warnings: [] },
    })

    await TOOLS.compile_project.execute({ clean: true }, handle, {
      signal: controller.signal,
    })

    const compile = calls.find(call => call.name === 'compile')
    expect((compile?.args as any)?.signal).to.equal(controller.signal)
  })
})

describe('a compile that produced nothing the model could act on', function () {
  // The point of naming these: "0 errors" on a build that never finished is what
  // lets a model tell the user its fix worked.
  it('names a build with no parsable output and points at a clean rebuild', async function () {
    const { handle } = createFakeHandle({
      compileResult: { status: 'no-output', errors: [], warnings: [] },
    })

    const result: any = await TOOLS.compile_project.execute({}, handle)

    expect(result.status).to.equal('no-output')
    expect(result.message).to.match(/no parsable output/i)
    expect(result.message).to.match(/clean/i)
    expect(result.message).to.not.match(/without errors/i)
  })

  it('does not suggest a clean rebuild after one already failed to help', async function () {
    const { handle } = createFakeHandle({
      compileResult: { status: 'no-output', errors: [], warnings: [] },
    })

    const result: any = await TOOLS.compile_project.execute({ clean: true }, handle)

    expect(result.message).to.match(/did not complete normally/i)
    expect(result.message).to.not.match(/with clean set to true/i)
  })

  it('names a timeout and points at a clean rebuild', async function () {
    const { handle } = createFakeHandle({
      compileResult: { status: 'timedout', errors: [], warnings: [] },
    })

    const result: any = await TOOLS.compile_project.execute({}, handle)

    expect(result.status).to.equal('timedout')
    expect(result.message).to.match(/timed out/i)
    expect(result.message).to.match(/clean/i)
  })

  it('says a skipped compile ran nothing, rather than reporting the old result', async function () {
    const { handle } = createFakeHandle({
      compileResult: { status: 'skipped', errors: [], warnings: [] },
    })

    const result: any = await TOOLS.compile_project.execute({}, handle)

    expect(result.message).to.match(/no compile ran/i)
    expect(result.message).to.not.match(/without errors/i)
  })

  it('names a server-side status the log cannot explain', async function () {
    const { handle } = createFakeHandle({
      compileResult: { status: 'clsi-unavailable', errors: [], warnings: [] },
    })

    const result: any = await TOOLS.compile_project.execute({}, handle)

    expect(result.status).to.equal('clsi-unavailable')
    expect(result.message).to.match(/clsi-unavailable/)
    expect(result.message).to.match(/nothing was verified/i)
  })

  it('still reports real errors alongside a failing status', async function () {
    const { handle } = createFakeHandle({
      compileResult: {
        status: 'failure',
        errors: [{ message: 'Undefined control sequence', file: 'main.tex', line: 3 }],
        warnings: [],
      },
    })

    const result: any = await TOOLS.compile_project.execute({}, handle)

    expect(result.message).to.match(/1 error/)
    expect(result.message).to.not.match(/nothing was verified/i)
  })

  it('reports warnings on an otherwise clean build', async function () {
    const { handle } = createFakeHandle({
      compileResult: {
        status: 'success',
        errors: [],
        warnings: [{ message: 'Overfull hbox', file: 'main.tex', line: 9 }],
      },
    })

    const result: any = await TOOLS.compile_project.execute({}, handle)

    expect(result.message).to.match(/0 errors and 1 warning/i)
  })
})

describe('wantsCleanCompile', function () {
  // Providers vary in how faithfully they honour a boolean schema, and the flag
  // has to survive that without the prompt having to spell it out.
  it('takes a real boolean', function () {
    expect(wantsCleanCompile({ clean: true })).to.equal(true)
    expect(wantsCleanCompile({ clean: false })).to.equal(false)
  })

  it('coerces the strings models send for booleans', function () {
    for (const value of ['true', 'TRUE', ' true ', '1', 'yes', 'on']) {
      expect(wantsCleanCompile({ clean: value }), JSON.stringify(value)).to.equal(true)
    }
    for (const value of ['false', '0', 'no', '']) {
      expect(wantsCleanCompile({ clean: value }), JSON.stringify(value)).to.equal(false)
    }
  })

  it('coerces numbers', function () {
    expect(wantsCleanCompile({ clean: 1 })).to.equal(true)
    expect(wantsCleanCompile({ clean: 0 })).to.equal(false)
  })

  it('accepts the ways models phrase a rebuild', function () {
    for (const args of [
      { clearCache: true },
      { clear_cache: true },
      { fromScratch: true },
      { from_scratch: true },
      { rebuild: true },
    ]) {
      expect(wantsCleanCompile(args), JSON.stringify(args)).to.equal(true)
    }
  })

  it('prefers the documented name when a synonym disagrees with it', function () {
    expect(wantsCleanCompile({ clean: false, rebuild: true })).to.equal(false)
  })

  it('defaults to an incremental compile for anything unrecognised', function () {
    expect(wantsCleanCompile(undefined)).to.equal(false)
    expect(wantsCleanCompile(null)).to.equal(false)
    expect(wantsCleanCompile({})).to.equal(false)
    expect(wantsCleanCompile('clean')).to.equal(false)
    expect(wantsCleanCompile({ clean: 'maybe' })).to.equal(false)
    expect(wantsCleanCompile({ clean: {} })).to.equal(false)
  })
})

describe('toCompileOutcome', function () {
  it('attaches raw log excerpts to error summaries when rawLog is provided', function () {
    const rawLog = [
      'This is pdfTeX',
      '(./main.tex',
      '! Undefined control sequence.',
      'l.15 \\badcmd',
      '?',
    ].join('\n')

    const entries = {
      errors: [
        { message: 'Undefined control sequence.', file: 'main.tex', line: 15 },
      ],
      warnings: [],
    }

    const outcome = toCompileOutcome(entries, rawLog)
    expect(outcome.status).to.equal('failure')
    expect(outcome.errors[0].excerpt).to.include('l.15 \\badcmd')
  })

  it('handles clean 0-error 0-warning compilation gracefully', function () {
    const entries = { errors: [], warnings: [] }
    const outcome = toCompileOutcome(entries, 'Output written on main.pdf')
    expect(outcome.status).to.equal('success')
    expect(outcome.errors).to.deep.equal([])
    expect(outcome.warnings).to.deep.equal([])
  })

  it('takes each error excerpt from its own raw lines, so repeated messages keep their context', function () {
    const rawLog = '! Undefined control sequence.\nl.3 \\foo\n\n! Undefined control sequence.\nl.9 \\bar\n'
    const entries = {
      errors: [
        { message: 'Undefined control sequence.', file: 'main.tex', line: 3, raw: '! Undefined control sequence.\nl.3 \\foo\n' },
        { message: 'Undefined control sequence.', file: 'main.tex', line: 9, raw: '! Undefined control sequence.\nl.9 \\bar\n' },
      ],
      warnings: [],
    }

    const outcome = toCompileOutcome(entries, rawLog)

    expect(outcome.errors[0].excerpt).to.equal('l.3 \\foo')
    expect(outcome.errors[1].excerpt).to.equal('l.9 \\bar')
  })
})

describe('compile_project regression delta and primary error', function () {
  it('reports error delta and warns when compilation regresses', async function () {
    const previousCompile = {
      status: 'failure',
      errors: [
        { message: 'Undefined control sequence \\foo', file: 'main.tex', line: 10 },
      ],
      warnings: [],
      rawLog: null,
    }

    const newOutcome = {
      status: 'failure',
      errors: [
        { message: 'Undefined control sequence \\foo', file: 'main.tex', line: 15 }, // shifted line, same error
        { message: 'Missing $ inserted', file: 'main.tex', line: 20 },               // new error 1
        { message: 'Extra }, or forgotten $', file: 'main.tex', line: 22 },           // new error 2
      ],
      warnings: [],
    }

    const { handle } = createFakeHandle({
      lastCompile: previousCompile,
      compileResult: newOutcome,
    })

    const result: any = await TOOLS.compile_project.execute({}, handle)

    expect(result.status).to.equal('failure')
    expect(result.errorCount).to.equal(3)
    expect(result.errorDelta).to.equal(2)
    expect(result.newErrorsCount).to.equal(2)
    expect(result.resolvedErrorsCount).to.equal(0)
    expect(result.regressed).to.equal(true)
    expect(result.message).to.match(/WARNING: Compilation worsened/i)
    expect(result.primaryError.message).to.equal('Undefined control sequence \\foo')
    expect(result.cascadingErrorsCount).to.equal(2)
  })

  it('reports improvement when errors are resolved without regressions', async function () {
    const previousCompile = {
      status: 'failure',
      errors: [
        { message: 'Undefined control sequence \\foo', file: 'main.tex', line: 10 },
        { message: 'Missing $ inserted', file: 'main.tex', line: 20 },
      ],
      warnings: [],
      rawLog: null,
    }

    const newOutcome = {
      status: 'failure',
      errors: [
        { message: 'Undefined control sequence \\foo', file: 'main.tex', line: 10 },
      ],
      warnings: [],
    }

    const { handle } = createFakeHandle({
      lastCompile: previousCompile,
      compileResult: newOutcome,
    })

    const result: any = await TOOLS.compile_project.execute({}, handle)

    expect(result.errorDelta).to.equal(-1)
    expect(result.newErrorsCount).to.equal(0)
    expect(result.resolvedErrorsCount).to.equal(1)
    expect(result.regressed).to.equal(false)
    expect(result.message).to.include('1 error(s) resolved')
  })

  it('uses get_compile_result in tool description', function () {
    expect(TOOLS.compile_project.spec.description).to.include('get_compile_result')
    expect(TOOLS.compile_project.spec.description).to.not.include('get_compile_log')
  })
})
