import { expect } from 'chai'
import { extractReferences } from '../../../../frontend/js/features/ai-assist/agent/context/references'

const MAIN = `\\section{Intro}\\label{sec:intro}
See \\ref{sec:intro} and \\ref{sec:missing}.
Also \\eqref{eq:one} and \\autoref{sec:intro}.
\\cite{knuth1984,lamport1994}
\\citep{missingkey}
% \\label{sec:commented}
\\section{Dup}\\label{sec:intro}`

const BIB = `@book{knuth1984,
  title = {The TeXbook}
}
@article{lamport1994,
  title = {LaTeX}
}`

describe('extractReferences', function () {
  const docs = { 'main.tex': MAIN, 'refs.bib': BIB }

  it('finds label definitions with file and line', function () {
    const refs = extractReferences({ docs })
    expect(refs.labels[0]).to.deep.include({
      key: 'sec:intro',
      path: 'main.tex',
      line: 1,
    })
  })

  it('collects bib keys from .bib files', function () {
    const refs = extractReferences({ docs })
    expect(refs.bibKeys.map(entry => entry.key)).to.have.members([
      'knuth1984',
      'lamport1994',
    ])
  })

  it('resolves a reference that has a matching label', function () {
    const refs = extractReferences({ docs })
    const hit = refs.refs.find(entry => entry.key === 'sec:intro')
    expect(hit?.resolved).to.equal(true)
  })

  it('flags a reference with no label', function () {
    const refs = extractReferences({ docs })
    const miss = refs.refs.find(entry => entry.key === 'sec:missing')
    expect(miss?.resolved).to.equal(false)
  })

  it('treats \\eqref and \\autoref as references', function () {
    const refs = extractReferences({ docs })
    const keys = refs.refs.map(entry => entry.key)
    expect(keys).to.include('eq:one')
    expect(keys.filter(key => key === 'sec:intro')).to.have.length(2)
  })

  it('splits a multi-key \\cite', function () {
    const refs = extractReferences({ docs })
    const keys = refs.citations.map(entry => entry.key)
    expect(keys).to.include('knuth1984')
    expect(keys).to.include('lamport1994')
  })

  it('resolves citations against the bib keys', function () {
    const refs = extractReferences({ docs })
    expect(refs.citations.find(entry => entry.key === 'knuth1984')?.resolved).to.equal(true)
    expect(refs.citations.find(entry => entry.key === 'missingkey')?.resolved).to.equal(false)
  })

  it('treats \\citep as a citation', function () {
    const refs = extractReferences({ docs })
    expect(refs.citations.map(entry => entry.key)).to.include('missingkey')
  })

  it('ignores commented-out labels', function () {
    const refs = extractReferences({ docs })
    expect(refs.labels.map(entry => entry.key)).to.not.include('sec:commented')
  })

  it('reports a duplicate label', function () {
    const refs = extractReferences({ docs })
    expect(refs.duplicateLabels).to.deep.equal(['sec:intro'])
  })

  it('returns empty collections for an empty project', function () {
    const refs = extractReferences({ docs: {} })
    expect(refs.labels).to.deep.equal([])
    expect(refs.citations).to.deep.equal([])
    expect(refs.duplicateLabels).to.deep.equal([])
  })
})
