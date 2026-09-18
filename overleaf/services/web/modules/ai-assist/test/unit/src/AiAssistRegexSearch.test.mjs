import { expect } from 'chai'
import { regexSearch } from '../../../app/src/AiAssistRegexSearch.mjs'

const docs = [
  { path: 'main.tex', lines: ['\\section{Intro}', 'plain text', '\\SECTION{Loud}'] },
  { path: 'b.tex', lines: ['\\subsection{Deep}'] },
]

describe('regexSearch', function () {
  it('finds line matches case-insensitively by default', async function () {
    const res = await regexSearch({ query: '\\\\section\\{', caseSensitive: false, docs, limit: 50 })
    expect(res.hits).to.deep.equal([
      { path: 'main.tex', line: 1 },
      { path: 'main.tex', line: 3 },
    ])
    expect(res.total).to.equal(2)
  })

  it('honours caseSensitive and the hit limit', async function () {
    const res = await regexSearch({ query: 'section', caseSensitive: true, docs, limit: 1 })
    expect(res.hits).to.deep.equal([{ path: 'main.tex', line: 1 }])
    expect(res.total).to.equal(2)
  })

  it('rejects an invalid pattern', async function () {
    let caught = null
    try {
      await regexSearch({ query: '(', caseSensitive: false, docs, limit: 50 })
    } catch (err) {
      caught = err
    }
    expect(caught).to.be.instanceOf(SyntaxError)
  })

  it('times out a catastrophic pattern instead of blocking the server', async function () {
    const evil = [{ path: 'x.tex', lines: ['a'.repeat(40) + 'b'] }]
    const started = Date.now()
    let caught = null
    try {
      await regexSearch({ query: '(a+)+$', caseSensitive: false, docs: evil, limit: 50, timeoutMs: 300 })
    } catch (err) {
      caught = err
    }
    expect(caught?.code).to.equal('regexTimeout')
    expect(Date.now() - started).to.be.lessThan(3000)
  })
})
