import { expect } from 'chai'
import { compileProjectTool } from '../../../../frontend/js/features/ai-assist/agent/tools/compile-project'

function handleWith(outcome: any) {
  return {
    lastCompile: () => null,
    compile: async () => outcome,
  } as any
}

describe('compile_project PDF fields', function () {
  it('omits pdfProduced and buildId when compile results do not report them', async function () {
    const result: any = await compileProjectTool.execute(
      {},
      handleWith({ status: 'success', errors: [], warnings: [] })
    )
    expect(result).to.not.have.property('pdfProduced')
    expect(result).to.not.have.property('buildId')
  })

  it('reports a PDF written alongside errors as success_with_errors', async function () {
    const result: any = await compileProjectTool.execute(
      {},
      handleWith({
        status: 'success_with_errors',
        errors: [{ message: 'Undefined control sequence', file: 'main.tex', line: 3 }],
        warnings: [],
        pdfProduced: true,
        buildId: 'b7',
      })
    )
    expect(result.status).to.equal('success_with_errors')
    expect(result.pdfProduced).to.equal(true)
    expect(result.buildId).to.equal('b7')
    expect(result.errorCount).to.equal(1)
  })

  it('reports no buildId when no PDF was written', async function () {
    const result: any = await compileProjectTool.execute(
      {},
      handleWith({
        status: 'failure',
        errors: [{ message: 'boom', file: 'main.tex', line: 1 }],
        warnings: [],
        pdfProduced: false,
        buildId: null,
      })
    )
    expect(result.pdfProduced).to.equal(false)
    expect(result.buildId).to.equal(null)
  })
})
