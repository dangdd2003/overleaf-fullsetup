import { describe, it } from 'vitest'
import { expect } from 'chai'
import {
  cleanMarkdown,
  splitBlocks,
} from '../../../../app/src/web-fetch/extract/markdown-clean.mjs'
import {
  cacheKeyFor,
  stripTrackingParams,
} from '../../../../app/src/web-fetch/urls.mjs'

describe('cacheKeyFor', function () {
  it('lowercases host, removes fragment, default port, and tracking params', function () {
    expect(
      cacheKeyFor(
        'HTTPS://EXAMPLE.COM:443/docs?id=123&utm_source=twitter#heading'
      )
    ).to.equal('https://example.com/docs?id=123')
  })

  it('keeps non-default port and non-tracking search params', function () {
    expect(
      cacheKeyFor('http://example.com:8080/path?q=test&utm_campaign=winter')
    ).to.equal('http://example.com:8080/path?q=test')
  })

  it('gives the www and trailing-slash spellings of a page one key', function () {
    expect(cacheKeyFor('https://www.ctan.org/pkg/siunitx/')).to.equal(
      cacheKeyFor('https://ctan.org/pkg/siunitx')
    )
    expect(cacheKeyFor('https://www.example.com/')).to.equal(
      'https://example.com/'
    )
  })

  it('returns invalid URL string trimmed', function () {
    expect(cacheKeyFor('not a valid url')).to.equal('not a valid url')
  })
})

describe('stripTrackingParams', function () {
  it('drops tracking parameters and keeps the rest', function () {
    expect(
      stripTrackingParams('https://a.org/p?id=7&utm_source=x&fbclid=y')
    ).to.equal('https://a.org/p?id=7')
  })

  it('drops the ? when nothing is left', function () {
    expect(
      stripTrackingParams('https://a.org/p?utm_medium=mail&gclid=1')
    ).to.equal('https://a.org/p')
  })

  it('returns a URL without tracking parameters unchanged', function () {
    expect(stripTrackingParams('https://a.org/p?q=a%20b')).to.equal(
      'https://a.org/p?q=a%20b'
    )
  })

  it('returns a string that is not a URL unchanged', function () {
    expect(stripTrackingParams('not a url')).to.equal('not a url')
  })
})

describe('splitBlocks', function () {
  it('keeps a fenced block with blank lines as one block', function () {
    const text = 'Intro\n\n```js\na\n\nb\n```\n\n| a | b |\n| --- | --- |'
    expect(splitBlocks(text)).to.deep.equal([
      { text: 'Intro', kind: 'text' },
      { text: '```js\na\n\nb\n```', kind: 'fence' },
      { text: '| a | b |\n| --- | --- |', kind: 'table' },
    ])
  })
})

describe('cleanMarkdown', function () {
  it('removes invisible characters', function () {
    expect(cleanMarkdown('Zero​width soft­hyphen')).to.equal(
      'Zerowidth softhyphen'
    )
  })

  it('strips tracking parameters from link URLs', function () {
    expect(cleanMarkdown('See [docs](https://a.org/d?utm_source=x).')).to.equal(
      'See [docs](https://a.org/d).'
    )
  })

  it('drops a repeated block of 40 characters or more, keeping the first', function () {
    const para = 'This paragraph is long enough to count as a repeat.'
    expect(cleanMarkdown(`${para}\n\nMiddle.\n\n${para}`)).to.equal(
      `${para}\n\nMiddle.`
    )
  })

  it('keeps short repeated blocks', function () {
    expect(cleanMarkdown('Share\n\nText\n\nShare')).to.equal(
      'Share\n\nText\n\nShare'
    )
  })

  it('drops a block that is mostly links', function () {
    const nav = ['Home', 'About', 'Blog', 'Contact', 'Login']
      .map(word => `- [${word}](https://a.org/${word})`)
      .join('\n')
    expect(cleanMarkdown(`Body text.\n\n${nav}`)).to.equal('Body text.')
  })

  it('keeps prose that has a few links', function () {
    const text =
      'Read [one](https://a.org/1) and [two](https://a.org/2) for the whole story of this package.'
    expect(cleanMarkdown(text)).to.equal(text)
  })

  it('shifts headings so the highest is ##, and strips links from them', function () {
    expect(
      cleanMarkdown('# Title\n\n## [Part](https://a.org/p)\n\nText')
    ).to.equal('## Title\n\n### Part\n\nText')
  })

  it('never touches a code fence', function () {
    const code = '```\n# not a heading\n\n# still code\n```'
    expect(cleanMarkdown(`## Real\n\n${code}`)).to.equal(`## Real\n\n${code}`)
  })

  // Review Focus 5
  it('is idempotent', function () {
    const text =
      '# A\n\nPara [x](https://a.org/?utm_source=1)\n\n### B\n\nPara [x](https://a.org/?utm_source=1)'
    const once = cleanMarkdown(text)
    expect(cleanMarkdown(once)).to.equal(once)
  })
})
