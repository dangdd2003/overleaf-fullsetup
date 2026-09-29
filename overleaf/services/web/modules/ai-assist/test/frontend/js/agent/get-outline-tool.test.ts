import { expect } from 'chai'
import { getOutlineTool } from '../../../../frontend/js/features/ai-assist/agent/tools/get-outline'
import { createFakeHandle } from './helpers/fake-handle'

describe('get_outline', function () {
  it('has one optional param and no mode discriminator', function () {
    const params = getOutlineTool.spec.parameters as any
    const props = params.properties
    expect(Object.keys(props)).to.deep.equal(['section'])
    expect(params.required).to.deep.equal([])
    expect(props).to.not.have.property('view')
  })

  it('cannot change the project', function () {
    expect(getOutlineTool.mutates).to.equal(false)
  })

  it('returns sections with the line ranges read_file needs', async function () {
    const { handle } = createFakeHandle({
      docs: {
        'main.tex':
          '\\title{T}\n\\section{Intro}\nhello\n\\section{Method}\nworld\n',
      },
    })
    const result: any = await getOutlineTool.execute({ section: 'Intro' }, handle)
    expect(result.range.from).to.be.a('number')
    expect(result.range.to).to.be.at.least(result.range.from)
  })

  it('narrows to one subtree when given a section', async function () {
    const { handle } = createFakeHandle({
      docs: { 'main.tex': '\\section{Intro}\na\n\\section{Method}\nb\n' },
    })
    const result: any = await getOutlineTool.execute(
      { section: 'Method' },
      handle
    )
    expect(result.sections.map((s: any) => s.title)).to.deep.equal(['Method'])
  })

  it('renders human-readable text representations', async function () {
    const { handle } = createFakeHandle({
      docs: { 'main.tex': '\\section{Intro}\na\n' },
    })
    const result: any = await getOutlineTool.execute({}, handle)
    expect(getOutlineTool.render!(result)).to.include('Intro')
  })

  it('bounds the final section range to file line count and avoids to=end hint', async function () {
    const { handle } = createFakeHandle({
      docs: { 'main.tex': '\\section{Intro}\na\n\\section{Method}\nb\nc\n' },
    })
    const result: any = await getOutlineTool.execute(
      { section: 'Method' },
      handle
    )
    expect(result.range.to).to.equal(6)
    expect(result.hint).to.include('to=6')
    expect(result.hint).to.not.include('to=end')
  })
})
