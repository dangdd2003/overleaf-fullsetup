import { expect } from 'chai'
import {
  parseAttachmentRef,
  resolveAttachments,
} from '../../../../frontend/js/features/ai-assist/agent/context/attachments'
import { createFakeHandle } from '../agent/helpers/fake-handle'

const DOCS = {
  'main.tex': 'one\ntwo\nthree\nfour\nfive',
  'refs.bib': '@book{a}',
}

describe('parseAttachmentRef', function () {
  it('parses a bare path', function () {
    expect(parseAttachmentRef('main.tex')).to.deep.equal({ path: 'main.tex' })
  })

  it('parses a line range', function () {
    expect(parseAttachmentRef('sections/results.tex:40-80')).to.deep.equal({
      path: 'sections/results.tex',
      from: 40,
      to: 80,
    })
  })

  it('parses a single line as a one-line range', function () {
    expect(parseAttachmentRef('main.tex:12')).to.deep.equal({
      path: 'main.tex',
      from: 12,
      to: 12,
    })
  })

  it('rejects an empty token', function () {
    expect(parseAttachmentRef('')).to.equal(null)
  })

  it('treats a colon with no numbers as part of the path', function () {
    expect(parseAttachmentRef('odd:name.tex')).to.deep.equal({ path: 'odd:name.tex' })
  })

  it('swaps a reversed range rather than returning nothing', function () {
    expect(parseAttachmentRef('main.tex:9-2')).to.deep.equal({
      path: 'main.tex',
      from: 2,
      to: 9,
    })
  })
})

describe('resolveAttachments', function () {
  it('resolves a whole file', async function () {
    const { handle } = createFakeHandle({ docs: DOCS })
    const [attachment] = await resolveAttachments([{ path: 'refs.bib' }], handle)

    expect(attachment.text).to.equal('@book{a}')
  })

  it('resolves a line range', async function () {
    const { handle } = createFakeHandle({ docs: DOCS })
    const [attachment] = await resolveAttachments(
      [{ path: 'main.tex', from: 2, to: 3 }],
      handle
    )

    expect(attachment.text).to.equal('two\nthree')
  })

  it('marks a missing file as gone instead of throwing', async function () {
    const { handle } = createFakeHandle({ docs: DOCS })
    const [attachment] = await resolveAttachments([{ path: 'ghost.tex' }], handle)

    expect(attachment.text).to.equal(null)
    expect(attachment.path).to.equal('ghost.tex')
  })

  it('marks a binary as gone rather than sending bytes to the model', async function () {
    const { handle } = createFakeHandle({ docs: DOCS, binaries: ['plot.pdf'] })
    const [attachment] = await resolveAttachments([{ path: 'plot.pdf' }], handle)

    expect(attachment.text).to.equal(null)
  })

  it('resolves several at once, preserving order', async function () {
    const { handle } = createFakeHandle({ docs: DOCS })
    const resolved = await resolveAttachments(
      [{ path: 'refs.bib' }, { path: 'main.tex', from: 1, to: 1 }],
      handle
    )

    expect(resolved.map(entry => entry.path)).to.deep.equal(['refs.bib', 'main.tex'])
    expect(resolved[1].text).to.equal('one')
  })

  it('returns an empty array for no refs', async function () {
    const { handle } = createFakeHandle({ docs: DOCS })
    expect(await resolveAttachments([], handle)).to.deep.equal([])
  })
})
