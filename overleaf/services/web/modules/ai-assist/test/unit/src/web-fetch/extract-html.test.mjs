import { describe, it } from 'vitest'
import { expect } from 'chai'
import {
  embeddedText,
  fragmentToMarkdown,
  htmlText,
  htmlToMarkdown,
} from '../../../../app/src/web-fetch/extract/html.mjs'

const PROSE =
  'Readable article sentence about typesetting units with enough words to count. '.repeat(
    12
  )

describe('HTML extraction', function () {
  it('uses Readability on a page with no <main>, dropping sidebars and headers', function () {
    const { markdown } = htmlToMarkdown(
      `<html><head><title>Post</title></head><body>
        <header><a href="/">Blog</a> <a href="/about">About us</a></header>
        <div class="sidebar"><ul><li><a href="/1">Related post one</a></li><li><a href="/2">Related post two</a></li></ul></div>
        <div class="post-body"><h1>Post</h1><p>${PROSE}</p>
          <p>Math <math alttext="x^2"><mi>x</mi></math> inline.</p></div>
        <div class="comments">Comment spam</div></body></html>`,
      'https://blog.example.org/post'
    )
    expect(markdown).to.include('Readable article sentence')
    expect(markdown).to.include('$x^2$')
    expect(markdown).not.to.include('Related post one')
    expect(markdown).not.to.include('About us')
  })

  it("keeps a page's own <main> exactly as before", function () {
    const html = `<html><body><nav>Menu</nav><main><h2>Ranges</h2><p>${PROSE}</p></main><aside>Side</aside></body></html>`
    const { markdown } = htmlToMarkdown(html, 'https://a.org/')
    expect(markdown.startsWith('## Ranges')).to.equal(true)
    expect(markdown).not.to.match(/Menu|Side/)
  })

  // Review Focus 1
  it('skips Readability on a page over 3 MB', function () {
    const huge = `<html><body><div>${'<p>filler words here</p>'.repeat(140_000)}</div></body></html>`
    expect(huge.length).to.be.greaterThan(3 * 1024 * 1024)
    const started = Date.now()
    const { markdown } = htmlToMarkdown(huge, 'https://a.org/')
    expect(markdown).to.include('filler words here')
    expect(Date.now() - started).to.be.lessThan(20_000)
  }, 60_000)

  it('reads the article body a JavaScript page ships as JSON-LD', function () {
    const html = `<html><head><title>News</title>
      <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage"},{"@type":"NewsArticle","headline":"H","articleBody":"${PROSE}"}]}</script>
      </head><body><div id="root"></div></body></html>`
    const { markdown } = htmlToMarkdown(html, 'https://news.example.org/a')
    expect(markdown).to.include('Readable article sentence')
  })

  it('reads long text out of Next.js page data', function () {
    const data = {
      props: {
        pageProps: { post: { title: 'T', body: `<p>${PROSE}</p>`, slug: 'x' } },
      },
    }
    const html = `<html><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></body></html>`
    expect(embeddedText(html)).to.include('Readable article sentence')
    expect(embeddedText(html)).not.to.include('<p>')
  })

  it('falls back to the description when a page has nothing else', function () {
    const html =
      '<html><head><meta name="description" content="A page about siunitx."></head><body><div id="app"></div></body></html>'
    expect(htmlToMarkdown(html, 'https://a.org/').markdown).to.equal(
      'A page about siunitx.'
    )
  })

  it('turns an HTML fragment into Markdown, and into plain text', function () {
    expect(
      fragmentToMarkdown(
        '<p>Use <code>\\qty</code> <a href="/pkg">here</a>.</p>',
        'https://ctan.org/'
      )
    ).to.equal('Use `\\qty` [here](https://ctan.org/pkg).')
    expect(htmlText('<jats:p>Deep &amp; wide <i>nets</i>.</jats:p>')).to.equal(
      'Deep & wide nets.'
    )
  })
})
