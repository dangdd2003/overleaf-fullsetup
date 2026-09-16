import { expect } from 'chai'
import {
  compileResultTool,
  excerptAround,
} from '../../../../frontend/js/features/ai-assist/agent/tools/compile-result'
import { createFakeHandle } from './helpers/fake-handle'

const RAW = [
  'This is pdfTeX',
  '(./main.tex',
  '! Undefined control sequence.',
  'l.3 \\foo',
  '        bar',
  '?',
].join('\n')

const COMPILE = {
  status: 'failure',
  errors: [{ message: 'Undefined control sequence.', file: 'main.tex', line: 3 }],
  warnings: [{ message: 'Overfull \\hbox', file: 'main.tex', line: 9 }],
  rawLog: RAW,
}

describe('excerptAround', function () {
  it('returns the matching line with surrounding context', function () {
    const excerpt = excerptAround(RAW, 'Undefined control sequence.', 1)
    expect(excerpt).to.equal('(./main.tex\n! Undefined control sequence.\nl.3 \\foo')
  })

  it('returns null when the message is not in the log', function () {
    expect(excerptAround(RAW, 'nothing like this', 1)).to.equal(null)
  })

  it('clamps at the start of the log', function () {
    expect(excerptAround(RAW, 'This is pdfTeX', 2)).to.include('This is pdfTeX')
  })
})

describe('get_compile_result', function () {
  it('caps results with limit, not maxEntries', function () {
    const props = (compileResultTool.spec.parameters as any).properties
    expect(props).to.have.property('limit')
    expect(props).to.not.have.property('maxEntries')
  })

  it('documents a closed enum for severity', function () {
    const props = (compileResultTool.spec.parameters as any).properties
    expect(props.severity.enum).to.deep.equal(['errors', 'warnings', 'all'])
  })

  it('cannot change the project', function () {
    expect(compileResultTool.mutates).to.equal(false)
  })

  it('does not suspend and does not compile', async function () {
    const { handle, calls } = createFakeHandle({
      docs: { 'main.tex': 'x' },
      lastCompile: COMPILE,
    })

    await compileResultTool.execute({}, handle)

    expect(compileResultTool.suspends).to.equal(false)
    expect(calls.some(call => call.name === 'compile')).to.equal(false)
  })

  it('returns errors and warnings from the last compile', async function () {
    const { handle } = createFakeHandle({ docs: { 'main.tex': 'x' }, lastCompile: COMPILE })
    const result: any = await compileResultTool.execute({}, handle)

    expect(result.status).to.equal('failure')
    expect(result.errors).to.have.length(1)
    expect(result.warnings).to.have.length(1)
  })

  it('narrows to errors when asked', async function () {
    const { handle } = createFakeHandle({ docs: { 'main.tex': 'x' }, lastCompile: COMPILE })
    const result: any = await compileResultTool.execute({ severity: 'errors' }, handle)

    expect(result.errors).to.have.length(1)
    expect(result.warnings).to.equal(undefined)
  })

  it('caps the number of entries using limit', async function () {
    const many = {
      ...COMPILE,
      errors: Array.from({ length: 10 }, () => COMPILE.errors[0]),
    }
    const { handle } = createFakeHandle({ docs: { 'main.tex': 'x' }, lastCompile: many })
    const result: any = await compileResultTool.execute({ limit: 3 }, handle)

    expect(result.errors).to.have.length(3)
    expect(result.truncated).to.equal(true)
  })

  it('attaches raw log excerpts only when asked', async function () {
    const { handle } = createFakeHandle({ docs: { 'main.tex': 'x' }, lastCompile: COMPILE })

    const without: any = await compileResultTool.execute({}, handle)
    expect(without.errors[0].excerpt).to.equal(undefined)

    const with_: any = await compileResultTool.execute({ includeRaw: true }, handle)
    expect(with_.errors[0].excerpt).to.include('l.3 \\foo')
  })

  it('ignores includeRaw when there is no raw log', async function () {
    const { handle } = createFakeHandle({
      docs: { 'main.tex': 'x' },
      lastCompile: { ...COMPILE, rawLog: null },
    })
    const result: any = await compileResultTool.execute({ includeRaw: true }, handle)

    expect(result.errors[0].excerpt).to.equal(undefined)
    expect(result.errors).to.have.length(1)
  })

  it('tells the model to compile when nothing has been built yet', async function () {
    const { handle } = createFakeHandle({ docs: { 'main.tex': 'x' } })
    const result: any = await compileResultTool.execute({}, handle)

    expect(result.status).to.equal('none')
    expect(result.message).to.include('compile_project')
  })

  it('renders as readable text rather than escaped JSON', async function () {
    const { handle } = createFakeHandle({ docs: { 'main.tex': 'x' }, lastCompile: COMPILE })
    const result = await compileResultTool.execute({ includeRaw: true }, handle)

    const rendered = compileResultTool.render!(result)
    expect(rendered).to.include('main.tex:3')
    expect(rendered).to.not.include('\\n')
  })
})
