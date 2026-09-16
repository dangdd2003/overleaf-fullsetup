import { expect } from 'chai'
import { listFilesTool } from '../../../../frontend/js/features/ai-assist/agent/tools/list-files'
import { createFakeHandle } from './helpers/fake-handle'

describe('list_files', function () {
  it('takes glob, never path, so the vocabulary stays honest', function () {
    const params = listFilesTool.spec.parameters as any
    const props = params.properties
    expect(props).to.have.property('glob')
    expect(props).to.not.have.property('path')
    expect(params.required).to.deep.equal([])
  })

  it('cannot change the project', function () {
    expect(listFilesTool.mutates).to.equal(false)
  })

  it('lists every file when given no glob', async function () {
    const { handle } = createFakeHandle({
      docs: { 'main.tex': 'a', 'sections/intro.tex': 'b' },
    })
    const result: any = await listFilesTool.execute({}, handle)
    expect(result.files.map((f: any) => f.path)).to.have.members([
      'main.tex',
      'sections/intro.tex',
    ])
  })

  it('narrows to the glob when given one', async function () {
    const { handle } = createFakeHandle({
      docs: { 'main.tex': 'a', 'sections/intro.tex': 'b' },
    })
    const result: any = await listFilesTool.execute(
      { glob: 'sections/*.tex' },
      handle
    )
    expect(result.files.map((f: any) => f.path)).to.deep.equal([
      'sections/intro.tex',
    ])
  })

  it('renders human-readable text representations', async function () {
    const { handle } = createFakeHandle({
      docs: { 'main.tex': 'a' },
    })
    const result: any = await listFilesTool.execute({}, handle)
    expect(listFilesTool.render!(result)).to.include('main.tex')
  })
})
