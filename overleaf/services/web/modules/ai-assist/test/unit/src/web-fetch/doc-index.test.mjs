import { afterAll, describe, it } from 'vitest'
import { expect } from 'chai'
import {
  INDEXED_DOCUMENT_CHARS,
  closeDocumentIndexes,
  documentIndex,
} from '../../../../app/src/web-fetch/doc-index.mjs'
import { runJobInline } from '../../../../app/src/web-fetch/extract/jobs.mjs'
import { findPassages } from '../../../../app/src/web-fetch/find.mjs'
import { pageMap, pageText } from '../../../../app/src/web-fetch/pages.mjs'

/** A long manual: many sections of filler, a few with what gets searched for. */
function longManual() {
  const sections = []
  for (
    let i = 1;
    sections.join('\n\n').length < INDEXED_DOCUMENT_CHARS * 1.2;
    i++
  ) {
    sections.push(
      `## Section ${i}\n\n${`Filler sentence number ${i} about nothing. `.repeat(20)}`
    )
    if (i === 40) {
      sections.push(
        '## Ranges\n\nThe `range\\-phrase` option sets the word between two numbers.'
      )
    }
    if (i === 900) {
      sections.push(
        '## Quantities\n\n```latex\n\\qty{1}{\\metre}\n```\n\nA unit is typeset after a thin space.'
      )
    }
    if (i === 1000) {
      sections.push(
        '| Key | Meaning |\n| --- | --- |\n| per-mode | fraction or power |\n| round-mode | figures or places |'
      )
    }
  }
  return {
    url: 'https://example.org/manual',
    fetchedAt: '2026-09-27T00:00:00.000Z',
    text: sections.join('\n\n'),
  }
}

describe('document index', function () {
  afterAll(function () {
    closeDocumentIndexes()
  })

  const doc = longManual()

  it('pages a long document the same way as the text itself', async function () {
    const index = await documentIndex(doc, 12_000, { runJob: runJobInline })
    const expected = pageMap(doc.text, 12_000)
    expect(index.map.starts).to.deep.equal(expected.starts)
    expect(index.map.outline).to.deep.equal(expected.outline)
    const last = index.map.starts.length
    expect(
      pageText(
        { text: doc.text, pages: index.map.starts, open: index.map.open },
        last
      )
    ).to.equal(pageText({ text: doc.text, pages: expected.starts }, last))
  })

  it('finds the same passages through the index as by scanning', async function () {
    const index = await documentIndex(doc, 12_000, { runJob: runJobInline })
    for (const query of [
      'range-phrase',
      'range phrase',
      '\\\\qty',
      'typeset unit space',
      'per-mode | round-mode',
    ]) {
      const scanned = findPassages(doc, query, { pages: index.map.starts })
      const indexed = findPassages(doc, query, {
        source: index.source,
        pages: index.map.starts,
      })
      expect(indexed, query).to.deep.equal(scanned)
      expect(indexed.total, query).to.be.greaterThan(0)
    }
  })

  it('reuses an index once built, and counts every match of a common word', async function () {
    const first = await documentIndex(doc, 12_000, { runJob: runJobInline })
    let built = 0
    const again = await documentIndex(doc, 12_000, {
      runJob: job => {
        built++
        return runJobInline(job)
      },
    })
    expect(built).to.equal(0)
    const found = findPassages(doc, 'filler sentence', {
      source: again.source,
      pages: first.map.starts,
    })
    expect(found.total).to.be.greaterThan(1000)
    expect(found.matches).to.have.length.within(1, 12)
    expect(found.pages[0]).to.equal(1)
  })
})
