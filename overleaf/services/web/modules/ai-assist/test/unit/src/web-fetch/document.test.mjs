import { describe, it } from 'vitest'
import { expect } from 'chai'
import {
  makeDocument,
  outline,
  pageCharsFor,
  pageText,
  splitPages,
} from '../../../../app/src/web-fetch/document.mjs'
import { findPassages } from '../../../../app/src/web-fetch/find.mjs'
import { lintMarkdown } from './helpers/lintMarkdown.mjs'

describe('document paging', function () {
  it('fits the page size to the model', function () {
    expect(pageCharsFor(undefined)).to.equal(12000)
    expect(pageCharsFor(8192)).to.equal(4000)
    expect(pageCharsFor(32000)).to.equal(10240)
    expect(pageCharsFor(200000)).to.equal(24000)
  })

  it('never cuts inside a code block when a paragraph break is available', function () {
    const code = '```js\n' + 'let x = 1\n\n'.repeat(40) + '```'
    const text = `${'Intro words. '.repeat(30)}\n\n${code}\n\nAfter the code.`
    const pages = splitPages(text, 500)
    for (let page = 1; page <= pages.length; page++) {
      expect(lintMarkdown(pageText({ text, pages }, page))).to.deep.equal([])
    }
  })

  // Review Focus 2
  it('repeats the opening fence and closes it when a code block is longer than a page', function () {
    const text = '```latex\n' + '\\item a\n'.repeat(200) + '```'
    const pages = splitPages(text, 500)
    expect(pages.length).to.be.greaterThan(1)
    expect(pageText({ text, pages }, 2).startsWith('```latex\n')).to.equal(true)
    for (let page = 1; page <= pages.length; page++) {
      expect(lintMarkdown(pageText({ text, pages }, page))).to.deep.equal([])
    }
  })

  it('repeats the table header on a page that starts inside a table', function () {
    const rows = Array.from(
      { length: 60 },
      (_, i) => `| row ${i} | value ${i} |`
    ).join('\n')
    const text = `| Name | Value |\n| --- | --- |\n${rows}`
    const pages = splitPages(text, 500)
    expect(
      pageText({ text, pages }, 2).startsWith(
        '| Name | Value |\n| --- | --- |\n| row'
      )
    ).to.equal(true)
  })

  it('prefers to start a page at a heading', function () {
    const text = `${'Para one. '.repeat(40)}\n\n## Next\n\n${'Para two. '.repeat(40)}\n\nTail line.`
    const pages = splitPages(text, 600)
    expect(pageText({ text, pages }, 2).startsWith('## Next')).to.equal(true)
  })

  it('lists the ## and ### headings with their pages', function () {
    const text = `## One\n\n${'a '.repeat(300)}\n\n### Sub\n\n${'b '.repeat(300)}\n\n## Two\n\nEnd`
    const pages = splitPages(text, 700)
    expect(outline(text, pages)).to.deep.equal([
      { level: 2, title: 'One', page: 1 },
      { level: 3, title: 'Sub', page: 2 },
      { level: 2, title: 'Two', page: 2 },
    ])
  })

  it('spreads the contents of a long document over all of it', function () {
    const text = Array.from(
      { length: 60 },
      (_, i) => `## Section ${i + 1}\n\n${'words '.repeat(80)}`
    ).join('\n\n')
    const pages = splitPages(text, 2000)
    const entries = outline(text, pages)
    expect(entries.length).to.equal(30)
    expect(entries[0].title).to.equal('Section 1')
    expect(entries[entries.length - 1]).to.deep.equal({
      level: 2,
      title: 'Section 60',
      page: pages.length,
    })
  })

  it('keeps a document whole however long it is', function () {
    const doc = makeDocument({
      url: 'u',
      title: '',
      text: 'a'.repeat(500_000),
      format: 'text',
    })
    expect(doc.text.length).to.equal(500_000)
    expect(doc.truncated).to.equal(false)
  })

  it('cleans Markdown documents but not PDF or plain text', function () {
    expect(
      makeDocument({ url: 'u', title: '', text: '# T\n\nx' }).text
    ).to.equal('## T\n\nx')
    expect(
      makeDocument({ url: 'u', title: '', text: '# T\n\nx', format: 'text' })
        .text
    ).to.equal('# T\n\nx')
    expect(
      makeDocument({ url: 'u', title: '', text: '# T\n\nx', format: 'pdf' })
        .text
    ).to.equal('# T\n\nx')
  })
})

describe('findPassages', function () {
  const doc = makeDocument({
    url: 'u',
    title: '',
    text: '# Ranges\n\nThe range-phrase option sets the word.\n\nThe range-units option repeats units.\n\nNothing here.',
    format: 'pdf',
  })

  it('returns the passages matching any of several alternatives, with their section', function () {
    const found = findPassages(doc, 'range-units | range-phrase')
    expect(found.term).to.equal('range-units | range-phrase')
    expect(found.total).to.equal(2)
    // Neighbouring short matches come back as one passage
    expect(found.matches).to.have.length(1)
    expect(found.matches[0]).to.deep.include({ page: 1, heading: 'Ranges' })
    expect(found.matches[0].text).to.include(
      'The range-phrase option sets the word.'
    )
    expect(found.matches[0].text).to.include(
      'The range-units option repeats units.'
    )
  })

  it('keeps only the alternatives the document mentions', function () {
    const found = findPassages(doc, 'missing | range-units')
    expect(found.term).to.equal('range-units')
    expect(found.total).to.equal(1)
  })

  it('reads a bar without spaces as part of the text', function () {
    const found = findPassages(doc, 'range-units|range-phrase')
    expect(found.term).to.equal('range-units|range-phrase')
    // Not split into two exact alternatives: only some of its words match
    expect(found.total).to.equal(2)
    expect(found.matches.every(match => match.match === 'some words')).to.equal(
      true
    )
  })

  it('ignores case, Markdown formatting and hyphens versus spaces', function () {
    const md = makeDocument({
      url: 'https://example.org/',
      title: '',
      text: 'The `per\\_mode` key and the **Range Phrase** option.',
    })
    expect(findPassages(md, 'per-mode').total).to.equal(1)
    expect(findPassages(md, 'range-phrase').total).to.equal(1)
    expect(findPassages(md, 'per_mode').matches[0]).to.not.have.property(
      'match'
    )
  })

  it('falls back to passages with all the words, and says so', function () {
    const md = makeDocument({
      url: 'u',
      title: '',
      text: 'A unit is typeset after a thin space.\n\nNothing else.',
      format: 'text',
    })
    const found = findPassages(md, 'typeset unit space')
    expect(found.total).to.equal(1)
    expect(found.matches[0].match).to.equal('all words')
    expect(found.matches[0].text).to.include('thin space')
  })

  it('cuts a long paragraph around its match, not from its start', function () {
    const filler = 'filler words here. '.repeat(400)
    const md = makeDocument({
      url: 'u',
      title: '',
      text: `${filler}The needle phrase sits here. ${filler}`,
      format: 'text',
    })
    const [match] = findPassages(md, 'needle phrase').matches
    expect(match.text).to.include('The needle phrase sits here.')
    expect(match.text.startsWith('…')).to.equal(true)
    expect(match.text.length).to.be.at.most(1600)
  })

  it('ranks the section named after the term first, with the start of that section', function () {
    const parts = Array.from(
      { length: 15 },
      (_, i) =>
        `## Part ${i + 1}\n\n${'Other text. '.repeat(60)}\n\nSee siunitx for this.\n\n${'More text. '.repeat(60)}`
    )
    parts.push('## siunitx options\n\nThe options are set with sisetup.')
    const md = makeDocument({ url: 'u', title: '', text: parts.join('\n\n') })
    const found = findPassages(md, 'siunitx')
    expect(found.total).to.equal(16)
    expect(found.matches).to.have.length(12)
    expect(found.matches[found.matches.length - 1].text).to.equal(
      '## siunitx options\n\nThe options are set with sisetup.'
    )
  })

  it('keeps the header row of a long table with the matching rows', function () {
    const rows = Array.from(
      { length: 100 },
      (_, i) => `| row ${i} | value ${i} |`
    ).join('\n')
    const md = makeDocument({
      url: 'u',
      title: '',
      text: `| Name | Value |\n| --- | --- |\n${rows}`,
    })
    const [match] = findPassages(md, 'row 57').matches
    expect(match.text).to.equal(
      '| Name | Value |\n| --- | --- |\n| row 57 | value 57 |'
    )
  })
})
