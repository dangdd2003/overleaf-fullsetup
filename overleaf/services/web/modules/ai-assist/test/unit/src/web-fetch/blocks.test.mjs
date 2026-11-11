import { describe, it } from 'vitest'
import { expect } from 'chai'
import { searchText } from '../../../../app/src/web-fetch/blocks.mjs'

describe('searchText', function () {
  it('drops the target of a Markdown link, including one parenthesis level', function () {
    expect(searchText('See [Docs](https://example.test/a_(b)) now')).to.equal(
      'see docs now'
    )
  })

  it('finishes in linear time on long runs of unclosed brackets', function () {
    const started = Date.now()
    searchText('['.repeat(200000))
    searchText('[a]('.repeat(50000))
    expect(Date.now() - started).to.be.below(1000)
  })
})
