import { expect } from 'chai'
import { TOOLS } from '../../../../frontend/js/features/ai-assist/agent/tools/registry'
import { createFakeHandle } from './helpers/fake-handle'

const DOCS = {
  'main.tex': 'alpha\nbeta\ngamma\nbeta\n',
  'unique.tex': 'one\ntwo\nthree\n',
  'bib.tex': '@article{one,\n  title = {First}\n}\n',
}

describe('edit_file', function () {
  it('is marked as suspending, so the loop waits for the user', function () {
    expect(TOOLS.edit_file.suspends).to.equal(true)
  })

  it('reports a unique match as applied once the user accepts', async function () {
    const { handle, calls } = createFakeHandle({
      docs: DOCS,
      onEdit: () => ({ status: 'applied' }),
    })

    const result: any = await TOOLS.edit_file.execute(
      { path: 'unique.tex', oldText: 'two', newText: 'TWO' },
      handle
    )

    expect(result.status).to.equal('applied')
    expect(calls.filter(call => call.name === 'proposeEdit')).to.have.length(1)
  })

  it('appends to the file when oldText is empty', async function () {
    const { handle, calls } = createFakeHandle({
      docs: DOCS,
      onEdit: () => ({ status: 'applied' }),
    })

    const result: any = await TOOLS.edit_file.execute(
      { path: 'unique.tex', oldText: '', newText: 'four\n' },
      handle
    )

    expect(result.status).to.equal('applied')
    const propose = calls.find(call => call.name === 'proposeEdit')
    expect(propose).to.not.be.undefined
    expect((propose?.args as any).oldText).to.equal('')
    expect((propose?.args as any).newText).to.equal('four\n')
  })

  it('strips line numbers from oldText and matches uniquely', async function () {
    const { handle, calls } = createFakeHandle({
      docs: DOCS,
      onEdit: () => ({ status: 'applied' }),
    })

    const result: any = await TOOLS.edit_file.execute(
      { path: 'unique.tex', oldText: '2: two', newText: 'TWO' },
      handle
    )

    expect(result.status).to.equal('applied')
    const propose = calls.find(call => call.name === 'proposeEdit')
    expect(propose).to.not.be.undefined
    expect((propose?.args as any).oldText).to.equal('two')
  })

  it('matches anchors with minor whitespace differences', async function () {
    const { handle, calls } = createFakeHandle({
      docs: DOCS,
      onEdit: () => ({ status: 'applied' }),
    })

    const result: any = await TOOLS.edit_file.execute(
      { path: 'bib.tex', oldText: '@article{one,\n    title = {First}\n}', newText: 'REPLACED' },
      handle
    )

    expect(result.status).to.equal('applied')
    expect(calls.filter(call => call.name === 'proposeEdit')).to.have.length(1)
  })

  it('reports noMatch with guidance when anchor is absent', async function () {
    const { handle, calls } = createFakeHandle({ docs: DOCS })

    const result: any = await TOOLS.edit_file.execute(
      { path: 'unique.tex', oldText: 'absent', newText: 'x' },
      handle
    )

    expect(result.status).to.equal('noMatch')
    expect(result.message).to.match(/did not appear/i)
    expect(result.message).to.match(/oldText: ""/i)
    expect(calls.some(call => call.name === 'proposeEdit')).to.equal(false)
  })

  it('reports ambiguous with a count when the anchor appears twice', async function () {
    const { handle, calls } = createFakeHandle({ docs: DOCS })

    const result: any = await TOOLS.edit_file.execute(
      { path: 'main.tex', oldText: 'beta', newText: 'BETA' },
      handle
    )

    expect(result.status).to.equal('ambiguous')
    expect(result.matches).to.equal(2)
    expect(result.message).to.match(/more context|surrounding lines/i)
    expect(calls.some(call => call.name === 'proposeEdit')).to.equal(false)
  })

  it('passes a rejection and its note back to the model', async function () {
    const { handle } = createFakeHandle({
      docs: DOCS,
      onEdit: () => ({ status: 'rejected', note: 'keep the original wording' }),
    })

    const result: any = await TOOLS.edit_file.execute(
      { path: 'unique.tex', oldText: 'two', newText: 'TWO' },
      handle
    )

    expect(result.status).to.equal('rejected')
    expect(result.note).to.equal('keep the original wording')
    expect(result.message).to.include('keep the original wording')
    expect(result.message).to.match(/acknowledge the rejection/i)
  })

  it('reports drift when the document changed before the user accepted', async function () {
    const { handle } = createFakeHandle({
      docs: DOCS,
      onEdit: () => ({ status: 'drifted' }),
    })

    const result: any = await TOOLS.edit_file.execute(
      { path: 'unique.tex', oldText: 'two', newText: 'TWO' },
      handle
    )

    expect(result.status).to.equal('drifted')
    expect(result.message).to.match(/re-read/i)
  })

  it('reports a missing file rather than throwing', async function () {
    const { handle } = createFakeHandle({ docs: DOCS })

    const result: any = await TOOLS.edit_file.execute(
      { path: 'nope.tex', oldText: 'a', newText: 'b' },
      handle
    )

    expect(result.error).to.match(/not found/i)
  })
})
