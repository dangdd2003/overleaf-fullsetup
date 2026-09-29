import { describe, it } from 'vitest'
import { expect } from 'chai'
import sinon from 'sinon'
import {
  arxivAdapter,
  arxivIdOf,
  doiAdapter,
  doiOf,
  invertedAbstract,
} from '../../../../app/src/web-fetch/adapters/scholarly.mjs'
import { adapterContext } from '../../../../app/src/web-fetch/adapters/common.mjs'
import { makeDocument } from '../../../../app/src/web-fetch/document.mjs'
import { WebFetcher } from '../../../../app/src/web-fetch/WebFetcher.mjs'
import { webError } from '../../../../app/src/web-fetch/util.mjs'
import { ARTICLE_TEXT, articlePage, htmlResponse } from './helpers/pages.mjs'
import { PDF_LINE, makePdf } from './helpers/makePdf.mjs'

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>arXiv Query: id_list=1706.03762</title>
  <entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <updated>2023-08-02T00:41:18Z</updated>
    <published>2017-06-12T17:57:34Z</published>
    <title>Attention Is All You
  Need</title>
    <summary>  The dominant sequence transduction models are complex &amp; recurrent.
</summary>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
  </entry>
</feed>`

const json = (url, body) => ({
  url,
  contentType: 'application/json',
  body: Buffer.from(JSON.stringify(body)),
})
const notFound = url =>
  webError(`${url} returned HTTP 404.`, { status: 404, kind: 'http' })

/** fetchPage that answers each URL prefix from `routes`, else 404. */
function routes(map) {
  return sinon.stub().callsFake(async url => {
    for (const [prefix, answer] of Object.entries(map)) {
      if (url.startsWith(prefix)) {
        return typeof answer === 'function' ? answer(url) : answer
      }
    }
    throw notFound(url)
  })
}

const ctxFor = (
  fetchPage,
  ladder = sinon.stub().rejects(new Error('unused'))
) => adapterContext({ fetchPage, ladder })

describe('arXiv adapter', function () {
  it('finds the identifier in every kind of arXiv link', function () {
    const id = link => arxivIdOf(new URL(link))
    expect(id('https://arxiv.org/abs/1706.03762')).to.equal('1706.03762')
    expect(id('https://arxiv.org/pdf/1706.03762v7')).to.equal('1706.03762v7')
    expect(id('https://arxiv.org/pdf/1706.03762.pdf')).to.equal('1706.03762')
    expect(id('https://www.arxiv.org/html/2310.06825v1/')).to.equal(
      '2310.06825v1'
    )
    expect(id('https://arxiv.org/abs/hep-th/9901001')).to.equal(
      'hep-th/9901001'
    )
    expect(id('https://arxiv.org/abs/math.GT/0309136')).to.equal(
      'math.GT/0309136'
    )
    expect(id('https://arxiv.org/list/cs.CL/recent')).to.equal(null)
    expect(id('https://example.org/abs/1706.03762')).to.equal(null)
  })

  it('reads the metadata and the HTML full text', async function () {
    const fetchPage = routes({
      'https://export.arxiv.org/api/query': url => ({
        url,
        contentType: 'application/atom+xml',
        body: Buffer.from(ATOM),
      }),
      'https://arxiv.org/html/1706.03762': url =>
        htmlResponse(url, articlePage(ARTICLE_TEXT, 'Attention')),
    })
    const doc = await arxivAdapter.read(
      'https://arxiv.org/abs/1706.03762',
      ctxFor(fetchPage)
    )
    expect(doc.title).to.equal('Attention Is All You Need')
    expect(doc.published).to.equal('2017-06-12')
    expect(doc.text).to.include('# Attention Is All You Need')
    expect(doc.text).to.include('**Authors:** Ashish Vaswani, Noam Shazeer')
    expect(doc.text).to.include('**arXiv:** 1706.03762')
    expect(doc.text).to.include(
      '**Abstract:** The dominant sequence transduction models are complex & recurrent.'
    )
    expect(doc.text).to.include('siunitx')
  })

  it('falls back to the PDF when there is no HTML version', async function () {
    const fetchPage = routes({
      'https://export.arxiv.org/api/query': url => ({
        url,
        contentType: 'application/atom+xml',
        body: Buffer.from(ATOM),
      }),
      'https://arxiv.org/pdf/1706.03762': url => ({
        url,
        contentType: 'application/pdf',
        body: makePdf([PDF_LINE, PDF_LINE]),
      }),
    })
    const doc = await arxivAdapter.read(
      'https://arxiv.org/abs/1706.03762',
      ctxFor(fetchPage)
    )
    expect(doc.text).to.include('--- PDF page 1 ---')
  })

  it('hands back the metadata as a fallback when no full text can be read', async function () {
    const fetchPage = routes({
      'https://export.arxiv.org/api/query': url => ({
        url,
        contentType: 'application/atom+xml',
        body: Buffer.from(ATOM),
      }),
    })
    const outcome = await arxivAdapter.read(
      'https://arxiv.org/abs/1706.03762',
      ctxFor(fetchPage)
    )
    expect(outcome.fallback.text).to.include('**Abstract:**')
  })
})

describe('DOI adapter', function () {
  const CROSSREF = {
    message: {
      title: ['Deep learning'],
      author: [
        { given: 'Yann', family: 'LeCun' },
        { given: 'Yoshua', family: 'Bengio' },
      ],
      'container-title': ['Nature'],
      published: { 'date-parts': [[2015, 5, 27]] },
    },
  }

  it('finds the DOI in doi.org links and publisher paths', function () {
    const doi = link => doiOf(new URL(link))
    expect(doi('https://doi.org/10.1038/nature14539')).to.equal(
      '10.1038/nature14539'
    )
    expect(doi('https://dx.doi.org/10.1145/3290605.3300233')).to.equal(
      '10.1145/3290605.3300233'
    )
    expect(doi('https://dl.acm.org/doi/pdf/10.1145/3290605.3300233')).to.equal(
      '10.1145/3290605.3300233'
    )
    expect(
      doi('https://onlinelibrary.wiley.com/doi/10.1002/anie.201915678/abstract')
    ).to.equal('10.1002/anie.201915678')
    expect(
      doi('https://link.springer.com/article/10.1007/s11263-015-0816-y')
    ).to.equal('10.1007/s11263-015-0816-y')
    expect(doi('https://www.nature.com/articles/nature14539')).to.equal(null)
    expect(doi('https://doi.org/not-a-doi')).to.equal(null)
  })

  it('rebuilds an OpenAlex abstract', function () {
    expect(
      invertedAbstract({ learning: [1], Deep: [0], works: [2, 4], well: [3] })
    ).to.equal('Deep learning works well works')
    expect(invertedAbstract(null)).to.equal('')
  })

  it('reads the open-access copy through the ladder, under the metadata', async function () {
    const fetchPage = routes({
      'https://api.crossref.org/works/10.1038%2Fnature14539': url =>
        json(url, CROSSREF),
      'https://api.openalex.org/works/doi:10.1038%2Fnature14539': url =>
        json(url, {
          best_oa_location: {
            pdf_url: null,
            landing_page_url: 'https://hal.science/hal-04206682',
          },
        }),
    })
    const ladder = sinon.stub().callsFake(async url =>
      makeDocument({
        url,
        title: 'HAL copy',
        text: `Full text of the paper. ${ARTICLE_TEXT}`,
      })
    )
    const doc = await doiAdapter.read(
      'https://doi.org/10.1038/nature14539',
      ctxFor(fetchPage, ladder)
    )
    expect(ladder.calledOnceWith('https://hal.science/hal-04206682')).to.equal(
      true
    )
    expect(doc.title).to.equal('Deep learning')
    expect(doc.published).to.equal('2015-05-27')
    expect(doc.text).to.include('**Authors:** Yann LeCun, Yoshua Bengio')
    expect(doc.text).to.include(
      '**DOI:** 10.1038/nature14539 · **Published in:** Nature'
    )
    expect(doc.text).to.include(
      '**Open-access copy:** https://hal.science/hal-04206682'
    )
    expect(doc.text).to.include('Full text of the paper.')
  })

  it('falls back to metadata and abstract when there is no open copy', async function () {
    const fetchPage = routes({
      'https://api.crossref.org/': url => json(url, CROSSREF),
      'https://api.openalex.org/': url =>
        json(url, {
          abstract_inverted_index: { Deep: [0], learning: [1], works: [2] },
        }),
    })
    const ladder = sinon.stub()
    const outcome = await doiAdapter.read(
      'https://doi.org/10.1038/nature14539',
      ctxFor(fetchPage, ladder)
    )
    expect(ladder.called).to.equal(false)
    expect(outcome.fallback.text).to.include(
      '**Abstract:** Deep learning works'
    )
  })

  // Review Focus 5
  it('falls through to the direct read when the DOI is unknown', async function () {
    const page = 'https://reports.example.com/files/10.1234/annual-report'
    const fetchPage = routes({
      [page]: url => htmlResponse(url, articlePage()),
    })
    const doc = await new WebFetcher({ fetchPage }).read(page)
    expect(doc.via).to.equal('direct')
    expect(fetchPage.args.map(args => args[0])).to.include.members([
      'https://api.crossref.org/works/10.1234%2Fannual-report',
      page,
    ])
  })
})
