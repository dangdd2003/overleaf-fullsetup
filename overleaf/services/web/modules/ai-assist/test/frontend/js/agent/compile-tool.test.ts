import { expect } from 'chai'
import { TOOLS } from '../../../../frontend/js/features/ai-assist/agent/tools/registry'
import { createFakeHandle } from './helpers/fake-handle'

describe('compile_project', function () {
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

  it('refuses a second compile while one is still running', async function () {
    let release: (value: any) => void = () => {}
    const pending = new Promise(resolve => {
      release = resolve
    })

    const { handle } = createFakeHandle()
    handle.compile = () => pending as any

    const first = TOOLS.compile_project.execute({}, handle)
    const second: any = await TOOLS.compile_project.execute({}, handle)

    expect(second.error).to.match(/already in progress/i)

    release({ status: 'success', errors: [], warnings: [] })
    await first
  })

  it('clears the in-flight guard after a compile throws', async function () {
    const { handle } = createFakeHandle()
    handle.compile = () => Promise.reject(new Error('clsi unreachable'))

    const failed: any = await TOOLS.compile_project.execute({}, handle)
    expect(failed.error).to.match(/clsi unreachable/i)

    handle.compile = async () => ({ status: 'success', errors: [], warnings: [] })
    const recovered: any = await TOOLS.compile_project.execute({}, handle)
    expect(recovered.status).to.equal('success')
  })
})
