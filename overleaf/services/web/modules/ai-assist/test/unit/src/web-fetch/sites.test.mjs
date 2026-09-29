import { describe, it } from 'vitest'
import { expect } from 'chai'
import sinon from 'sinon'
import {
  ctanAdapter,
  githubAdapter,
  githubTarget,
  redditAdapter,
  stackexchangeAdapter,
  wikipediaAdapter,
} from '../../../../app/src/web-fetch/adapters/sites.mjs'
import {
  ADAPTERS,
  matchAdapter,
} from '../../../../app/src/web-fetch/adapters/index.mjs'
import { adapterContext } from '../../../../app/src/web-fetch/adapters/common.mjs'
import { webError } from '../../../../app/src/web-fetch/util.mjs'
import { ARTICLE_TEXT, articlePage, htmlResponse } from './helpers/pages.mjs'

const json = (url, body) => ({
  url,
  contentType: 'application/json',
  body: Buffer.from(JSON.stringify(body)),
})
const text = (url, body) => ({
  url,
  contentType: 'text/plain; charset=utf-8',
  body: Buffer.from(body),
})

function routes(map) {
  return sinon.stub().callsFake(async url => {
    for (const [prefix, answer] of Object.entries(map)) {
      if (url.startsWith(prefix)) return answer(url)
    }
    throw webError(`${url} returned HTTP 404.`, { status: 404, kind: 'http' })
  })
}
const ctxFor = fetchPage => adapterContext({ fetchPage, ladder: sinon.stub() })

describe('site adapters', function () {
  it('are all registered, arXiv and DOI first', function () {
    expect(ADAPTERS.map(a => a.name)).to.deep.equal([
      'arxiv',
      'doi',
      'github',
      'wikipedia',
      'stackexchange',
      'reddit',
      'ctan',
    ])
    expect(
      matchAdapter('https://tex.stackexchange.com/questions/13048/x').name
    ).to.equal('stackexchange')
    expect(matchAdapter('https://example.com/')).to.equal(null)
  })

  it('GitHub: knows which links the API covers', function () {
    const target = link => githubTarget(new URL(link))
    expect(target('https://github.com/josephwright/siunitx')).to.deep.equal({
      kind: 'repo',
      owner: 'josephwright',
      repo: 'siunitx',
    })
    expect(target('https://github.com/o/r/tree/main')).to.deep.equal({
      kind: 'repo',
      owner: 'o',
      repo: 'r',
    })
    expect(target('https://github.com/o/r/blob/main/src/a.tex')).to.deep.equal({
      kind: 'file',
      owner: 'o',
      repo: 'r',
      path: 'main/src/a.tex',
    })
    expect(target('https://github.com/o/r/issues/12')).to.deep.equal({
      kind: 'issue',
      owner: 'o',
      repo: 'r',
      number: '12',
    })
    expect(target('https://github.com/o/r/pull/3')).to.deep.equal({
      kind: 'issue',
      owner: 'o',
      repo: 'r',
      number: '3',
    })
    expect(
      target('https://gist.github.com/u/0123456789abcdef0123')
    ).to.deep.equal({ kind: 'gist', id: '0123456789abcdef0123' })
    expect(target('https://github.com/o/r/tree/main/src')).to.equal(null)
    expect(target('https://github.com/o/r/wiki')).to.equal(null)
    expect(target('https://github.com/orgs/overleaf')).to.equal(null)
  })

  it('GitHub: reads a file view as the raw file', async function () {
    const fetchPage = routes({
      'https://raw.githubusercontent.com/o/r/main/src/a.tex': url =>
        text(url, '\\documentclass{article}'),
    })
    const doc = await githubAdapter.read(
      'https://github.com/o/r/blob/main/src/a.tex',
      ctxFor(fetchPage)
    )
    expect(doc.text).to.equal('\\documentclass{article}')
    expect(doc.url).to.equal('https://github.com/o/r/blob/main/src/a.tex')
    expect(doc.title).to.equal('o/r: src/a.tex')
  })

  it('GitHub: reads a repository as its summary and README', async function () {
    const fetchPage = routes({
      'https://api.github.com/repos/o/r/readme': url =>
        json(url, {
          name: 'README.md',
          content: Buffer.from('# siunitx\n\nUnits for LaTeX.').toString(
            'base64'
          ),
        }),
      'https://api.github.com/repos/o/r': url =>
        json(url, {
          full_name: 'o/r',
          description: 'SI units',
          stargazers_count: 0,
          license: { spdx_id: 'LPPL-1.3c' },
          pushed_at: '2026-09-18T10:00:00Z',
        }),
    })
    const doc = await githubAdapter.read(
      'https://github.com/o/r',
      ctxFor(fetchPage)
    )
    expect(doc.title).to.equal('o/r: SI units')
    expect(doc.text).to.include('**Stars:** 0')
    expect(doc.text).to.include(
      '### README.md\n\n## siunitx\n\nUnits for LaTeX.'
    )
    expect(doc.modified).to.equal('2026-09-18')
  })

  it('GitHub: reads an issue with its comments', async function () {
    const fetchPage = routes({
      'https://api.github.com/repos/o/r/issues/12/comments': url =>
        json(url, [
          {
            user: { login: 'bob' },
            created_at: '2026-01-02T00:00:00Z',
            body: 'Fixed in 3.1.',
          },
        ]),
      'https://api.github.com/repos/o/r/issues/12': url =>
        json(url, {
          number: 12,
          title: 'Range bug',
          state: 'closed',
          user: { login: 'amy' },
          created_at: '2026-01-01T00:00:00Z',
          comments: 1,
          body: 'Ranges break.',
        }),
    })
    const doc = await githubAdapter.read(
      'https://github.com/o/r/issues/12',
      ctxFor(fetchPage)
    )
    expect(doc.text).to.include('# Range bug (#12)')
    expect(doc.text).to.include('**Type:** Issue · **State:** closed')
    expect(doc.text).to.include('**bob** · 2026-01-02\n\nFixed in 3.1.')
  })

  it('Wikipedia: reads the clean REST HTML of the article', async function () {
    const fetchPage = routes({
      'https://de.wikipedia.org/api/rest_v1/page/html/LaTeX': url =>
        htmlResponse(url, articlePage(ARTICLE_TEXT, 'LaTeX')),
    })
    const doc = await wikipediaAdapter.read(
      'https://de.m.wikipedia.org/wiki/LaTeX',
      ctxFor(fetchPage)
    )
    expect(doc.url).to.equal('https://de.m.wikipedia.org/wiki/LaTeX')
    expect(doc.text).to.include('siunitx')
  })

  it('StackExchange: question, then the accepted answer, then the rest by score', async function () {
    const fetchPage = routes({
      'https://api.stackexchange.com/2.3/questions/13048/answers': url =>
        json(url, {
          items: [
            {
              is_accepted: false,
              score: 90,
              creation_date: 1299700000,
              owner: { display_name: 'Top' },
              body: '<p>Popular answer.</p>',
            },
            {
              is_accepted: true,
              score: 40,
              creation_date: 1299690000,
              owner: { display_name: 'Egreg &amp; co' },
              body: '<p>Use <code>\\textup</code>.</p>',
            },
          ],
        }),
      'https://api.stackexchange.com/2.3/questions/13048': url =>
        json(url, {
          items: [
            {
              title: 'Upright parentheses in &quot;italic&quot; text',
              score: 62,
              creation_date: 1299678064,
              answer_count: 2,
              tags: ['fonts', 'italic'],
              body: '<p>How?</p>',
            },
          ],
        }),
    })
    const doc = await stackexchangeAdapter.read(
      'https://tex.stackexchange.com/questions/13048/upright',
      ctxFor(fetchPage)
    )
    expect(fetchPage.firstCall.args[0]).to.include('site=tex.stackexchange.com')
    expect(doc.title).to.equal('Upright parentheses in "italic" text')
    const accepted = doc.text.indexOf('## Accepted answer')
    const other = doc.text.indexOf('Popular answer.')
    expect(accepted).to.be.greaterThan(0)
    expect(other).to.be.greaterThan(accepted)
    expect(doc.text).to.include('Use `\\textup`.')
    expect(doc.text).to.include('**By:** Egreg & co')
  })

  it('Reddit: reads the thread JSON, best comments first', async function () {
    const listing = [
      {
        data: {
          children: [
            {
              kind: 't3',
              data: {
                title: 'Best LaTeX editor?',
                selftext: 'Asking.',
                author: 'op',
                score: 10,
                created_utc: 1767225600,
                subreddit_name_prefixed: 'r/LaTeX',
                num_comments: 2,
                is_self: true,
              },
            },
          ],
        },
      },
      {
        data: {
          children: [
            {
              kind: 't1',
              data: {
                author: 'low',
                body: 'Vim.',
                score: 1,
                created_utc: 1767225700,
              },
            },
            {
              kind: 't1',
              data: {
                author: 'high',
                body: 'Overleaf.',
                score: 50,
                created_utc: 1767225800,
              },
            },
            { kind: 'more', data: {} },
          ],
        },
      },
    ]
    const fetchPage = routes({
      'https://www.reddit.com/r/LaTeX/comments/abc123.json': url =>
        json(url, listing),
    })
    const doc = await redditAdapter.read(
      'https://old.reddit.com/r/LaTeX/comments/abc123/best_latex_editor/',
      ctxFor(fetchPage)
    )
    expect(doc.title).to.equal('Best LaTeX editor?')
    expect(doc.text.indexOf('Overleaf.')).to.be.lessThan(
      doc.text.indexOf('Vim.')
    )
  })

  it('Reddit: falls back to old.reddit when the JSON is refused', async function () {
    const fetchPage = routes({
      'https://old.reddit.com/r/LaTeX/comments/abc123/': url =>
        htmlResponse(url, articlePage()),
    })
    const doc = await redditAdapter.read(
      'https://www.reddit.com/r/LaTeX/comments/abc123/x/',
      ctxFor(fetchPage)
    )
    expect(doc.text).to.include('siunitx')
  })

  it('CTAN: reads the package record and links its manuals', async function () {
    const fetchPage = routes({
      'https://ctan.org/json/2.0/pkg/siunitx': url =>
        json(url, {
          id: 'siunitx',
          name: 'siunitx',
          caption: 'A comprehensive (SI) units package',
          license: 'lppl1.3c',
          version: { number: '3.6.2', date: '2026-09-18' },
          descriptions: [
            {
              language: null,
              text: '<p>Physical quantities have <tt>units</tt>.</p>',
            },
          ],
          documentation: [
            {
              details: 'User manual',
              href: 'ctan:/macros/latex/contrib/siunitx/siunitx.pdf',
            },
          ],
          ctan: { path: '/macros/latex/contrib/siunitx' },
          repository: 'https://github.com/josephwright/siunitx',
        }),
    })
    const doc = await ctanAdapter.read(
      'https://ctan.org/pkg/siunitx',
      ctxFor(fetchPage)
    )
    expect(doc.title).to.equal(
      'CTAN: siunitx – A comprehensive (SI) units package'
    )
    expect(doc.modified).to.equal('2026-09-18')
    expect(doc.text).to.include(
      '**Version:** 3.6.2 · **Date:** 2026-09-18 · **Licence:** lppl1.3c'
    )
    expect(doc.text).to.include(
      '- [User manual](https://mirrors.ctan.org/macros/latex/contrib/siunitx/siunitx.pdf)'
    )
    expect(doc.text).to.include('Physical quantities have')
  })
})
