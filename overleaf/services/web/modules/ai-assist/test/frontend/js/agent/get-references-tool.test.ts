import { expect } from 'chai'
import { getReferencesTool } from '../../../../frontend/js/features/ai-assist/agent/tools/get-references'
import { createFakeHandle } from './helpers/fake-handle'

describe('get_references', function () {
  it('names its filter after the field it filters', function () {
    const props = (getReferencesTool.spec.parameters as any).properties
    expect(props).to.have.property('unresolvedOnly')
    expect(props).to.not.have.property('undefinedOnly')
  })

  it('documents a closed enum for kind', function () {
    const props = (getReferencesTool.spec.parameters as any).properties
    expect(props.kind.enum).to.deep.equal([
      'labels',
      'refs',
      'citations',
      'all',
    ])
  })

  it('cannot change the project', function () {
    expect(getReferencesTool.mutates).to.equal(false)
  })

  it('reports whether each reference resolves', async function () {
    const { handle } = createFakeHandle({
      docs: { 'main.tex': '\\label{a}\n\\ref{a}\n\\ref{missing}\n' },
    })
    const result: any = await getReferencesTool.execute({}, handle)
    const missing = result.refs.find((r: any) => r.key === 'missing')
    expect(missing.resolved).to.equal(false)
  })

  it('returns only unresolved entries when asked', async function () {
    const { handle } = createFakeHandle({
      docs: { 'main.tex': '\\label{a}\n\\ref{a}\n\\ref{missing}\n' },
    })
    const result: any = await getReferencesTool.execute(
      { unresolvedOnly: true },
      handle
    )
    expect(result.refs.every((r: any) => !r.resolved)).to.equal(true)
  })

  it('surfaces duplicate labels', async function () {
    const { handle } = createFakeHandle({
      docs: { 'main.tex': '\\label{dup}\nx\n\\label{dup}\n' },
    })
    const result: any = await getReferencesTool.execute({}, handle)
    expect(result.duplicateLabels).to.include('dup')
  })

  it('renders human-readable text representations', async function () {
    const { handle } = createFakeHandle({
      docs: { 'main.tex': '\\label{a}\n' },
    })
    const result: any = await getReferencesTool.execute({}, handle)
    expect(getReferencesTool.render!(result)).to.include('label a')
  })
})
