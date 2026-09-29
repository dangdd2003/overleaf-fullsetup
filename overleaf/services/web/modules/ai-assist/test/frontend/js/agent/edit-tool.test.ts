import { expect } from 'chai'
import { endDocumentLine } from '../../../../frontend/js/features/ai-assist/agent/tools/edit-file'
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

  it('refuses to append after \\end{document} without proposing an edit', async function () {
    const { handle, calls } = createFakeHandle({
      docs: { 'paper.tex': '\\begin{document}\nHi\n\\end{document}\n' },
      onEdit: () => ({ status: 'applied' }),
    })

    const result: any = await TOOLS.edit_file.execute(
      { path: 'paper.tex', oldText: '', newText: 'more' },
      handle
    )

    expect(result.error).to.include('line 3')
    expect(calls.some(call => call.name === 'proposeEdit')).to.equal(false)
  })

  it('endDocumentLine ignores a commented-out \\end{document}', function () {
    expect(endDocumentLine('x\n% \\end{document}')).to.equal(null)
    expect(endDocumentLine('x\n\\end{document}\n')).to.equal(2)
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
    expect(result.message).to.match(/NOT applied/)
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

  it('reports a timeout status with an actionable message', async function () {
    const { handle } = createFakeHandle({
      docs: DOCS,
      onEdit: () => ({ status: 'timeout', message: 'Editor bridge timed out.' }),
    })

    const result: any = await TOOLS.edit_file.execute(
      { path: 'unique.tex', oldText: 'two', newText: 'TWO' },
      handle
    )

    expect(result.status).to.equal('timeout')
    expect(result.message).to.match(/timed out/i)
  })

  it('reports an error status without collapsing to drifted', async function () {
    const { handle } = createFakeHandle({
      docs: DOCS,
      onEdit: () => ({ status: 'error', message: 'Document mismatch.' }),
    })

    const result: any = await TOOLS.edit_file.execute(
      { path: 'unique.tex', oldText: 'two', newText: 'TWO' },
      handle
    )

    expect(result.status).to.equal('error')
    expect(result.message).to.include('Document mismatch.')
  })

  it('reports a missing file rather than throwing', async function () {
    const { handle } = createFakeHandle({ docs: DOCS })

    const result: any = await TOOLS.edit_file.execute(
      { path: 'nope.tex', oldText: 'a', newText: 'b' },
      handle
    )

    expect(result.error).to.match(/not found/i)
  })

  it('matches double-escaped LaTeX macro backslashes', async function () {
    const { handle, calls } = createFakeHandle({
      docs: { 'doc.tex': '\\begin{equation}\nx = 1\n\\end{equation}\n' },
      onEdit: () => ({ status: 'applied' }),
    })

    const result: any = await TOOLS.edit_file.execute(
      { path: 'doc.tex', oldText: '\\\\begin{equation}\nx = 1', newText: '\\begin{equation}\nx = 2' },
      handle
    )

    expect(result.status).to.equal('applied')
    expect(calls.filter(call => call.name === 'proposeEdit')).to.have.length(1)
  })

  it('sanitizes line-number prefixes from newText when contaminated by read_file', async function () {
    const { handle, calls } = createFakeHandle({
      docs: { 'packages.tex': '\\usepackage{amsmath}\n\\usepackage{amssymb}\n' },
      onEdit: () => ({ status: 'applied' }),
    })

    const result: any = await TOOLS.edit_file.execute(
      {
        path: 'packages.tex',
        oldText: '\\usepackage{amsmath}\n\\usepackage{amssymb}',
        newText: '1: \\usepackage{amsmath}\n2: \\usepackage{amssymb}\n3: \\usepackage{graphicx}',
      },
      handle
    )

    expect(result.status).to.equal('applied')
    const propose = calls.find(call => call.name === 'proposeEdit')
    expect((propose?.args as any).newText).to.equal(
      '\\usepackage{amsmath}\n\\usepackage{amssymb}\n\\usepackage{graphicx}'
    )
  })

  it('reports candidate line numbers on ambiguous matches', async function () {
    const { handle, calls } = createFakeHandle({ docs: DOCS })

    const result: any = await TOOLS.edit_file.execute(
      { path: 'main.tex', oldText: 'beta', newText: 'BETA' },
      handle
    )

    expect(result.status).to.equal('ambiguous')
    expect(result.matches).to.equal(2)
    expect(result.message).to.include('around line(s) 2, 4')
    expect(calls.some(call => call.name === 'proposeEdit')).to.equal(false)
  })

  it('reports ambiguous when double-escaped or line-prefixed anchor appears multiple times', async function () {
    const { handle, calls } = createFakeHandle({
      docs: { 'multi.tex': 'line 1\n\\section{Beta}\nline 3\n\\section{Beta}\nline 5\n' },
    })

    const result: any = await TOOLS.edit_file.execute(
      { path: 'multi.tex', oldText: '\\\\section{Beta}', newText: '\\section{Beta 2}' },
      handle
    )

    expect(result.status).to.equal('ambiguous')
    expect(result.matches).to.equal(2)
    expect(calls.some(call => call.name === 'proposeEdit')).to.equal(false)
  })

  it('reports candidate line numbers on noMatch when similar line is found', async function () {
    const { handle, calls } = createFakeHandle({ docs: DOCS })

    const result: any = await TOOLS.edit_file.execute(
      { path: 'main.tex', oldText: 'gamma\nnonexistent line', newText: 'REPLACED' },
      handle
    )

    expect(result.status).to.equal('noMatch')
    expect(result.message).to.include('Found similar line around line(s) 3')
    expect(calls.some(call => call.name === 'proposeEdit')).to.equal(false)
  })

  it('disambiguates repeated anchor using startLine and endLine', async function () {
    const { handle, calls } = createFakeHandle({
      docs: DOCS,
      onEdit: () => ({ status: 'applied' }),
    })

    const result: any = await TOOLS.edit_file.execute(
      { path: 'main.tex', oldText: 'beta', newText: 'BETA_SECOND', startLine: 3, endLine: 5 },
      handle
    )

    expect(result.status).to.equal('applied')
    const propose = calls.find(call => call.name === 'proposeEdit')
    expect((propose?.args as any).startLine).to.equal(3)
  })

  it('disambiguates repeated anchor using startLine alone when endLine is omitted', async function () {
    const { handle, calls } = createFakeHandle({
      docs: DOCS,
      onEdit: () => ({ status: 'applied' }),
    })

    const result: any = await TOOLS.edit_file.execute(
      { path: 'main.tex', oldText: 'beta', newText: 'BETA_FIRST', startLine: 2 },
      handle
    )

    expect(result.status).to.equal('applied')
    const propose = calls.find(call => call.name === 'proposeEdit')
    expect((propose?.args as any).startLine).to.equal(2)
  })

  it('successfully matches and edits a wrapped multi-line paragraph using a single-line query', async function () {
    const paragraphDoc =
      '\\section{Conclusion}\n' +
      'Our empirical results on the LogicBench dataset indicate a significant\n' +
      'improvement over baseline models, particularly in tasks requiring\n' +
      'recursive reasoning and adherence to strict constraints. The $15\\%$ increase\n' +
      'in consistency suggests that the HLT architecture effectively bridges the gap\n' +
      'between pattern recognition and symbolic manipulation.\n' +
      '\\subsection{Future Work}'

    const { handle, calls } = createFakeHandle({
      docs: { 'conclusion.tex': paragraphDoc },
      onEdit: () => ({ status: 'applied' }),
    })

    const singleLineQuery =
      'Our empirical results on the LogicBench dataset indicate a significant improvement over baseline models, particularly in tasks requiring recursive reasoning and adherence to strict constraints. The 15% increase in consistency suggests that the HLT architecture effectively bridges the gap between pattern recognition and symbolic manipulation.'

    const result: any = await TOOLS.edit_file.execute(
      { path: 'conclusion.tex', oldText: singleLineQuery, newText: 'New empirical summary.' },
      handle
    )

    expect(result.status).to.equal('applied')
    const propose = calls.find(call => call.name === 'proposeEdit')
    expect(propose).to.exist
    expect((propose?.args as any).oldText).to.include('Our empirical results')
    expect((propose?.args as any).oldText).to.include('symbolic manipulation.')
  })

  it('provides rich contextual previews when an anchor is ambiguous', async function () {
    const { handle } = createFakeHandle({ docs: DOCS })

    const result: any = await TOOLS.edit_file.execute(
      { path: 'main.tex', oldText: 'beta', newText: 'BETA' },
      handle
    )

    expect(result.status).to.equal('ambiguous')
    expect(result.message).to.include('Occurrence around line 2:')
    expect(result.message).to.include('Occurrence around line 4:')
    expect(result.message).to.include('pass startLine to target a specific line')
  })

  it('rejects call when oldText parameter is missing or non-string', async function () {
    const { handle } = createFakeHandle({ docs: DOCS })

    const result: any = await TOOLS.edit_file.execute(
      { path: 'main.tex', newText: 'BETA' } as any,
      handle
    )

    expect(result.error).to.include("Parameter 'oldText' is required")
  })
})
