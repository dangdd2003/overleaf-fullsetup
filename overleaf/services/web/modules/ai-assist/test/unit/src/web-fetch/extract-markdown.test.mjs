import { describe, it } from 'vitest'
import { expect } from 'chai'
import {
  fragmentToMarkdown,
  htmlToMarkdown,
  withoutHiddenElements,
} from '../../../../app/src/web-fetch/extract/html.mjs'
import { lintMarkdown } from './helpers/lintMarkdown.mjs'

const md = html => fragmentToMarkdown(html, 'https://a.org/')

describe('Markdown conversion', function () {
  it('keeps bold, italic and strikethrough', function () {
    expect(
      md(
        '<p>A <strong>bold</strong>, <em>soft</em> and <del>old</del> word.</p>'
      )
    ).to.equal('A **bold**, *soft* and ~~old~~ word.')
  })

  it('moves spaces outside emphasis and drops empty emphasis', function () {
    expect(md('<p>A<b> spaced </b>word<i> </i>.</p>')).to.equal(
      'A **spaced** word .'
    )
  })

  it('writes superscripts and subscripts the LaTeX way', function () {
    expect(md('<p>x<sup>2</sup> and H<sub>2</sub>O</p>')).to.equal(
      'x^{2} and H_{2}O'
    )
  })

  it('prefixes quoted lines', function () {
    expect(
      md('<blockquote><p>First</p><p>Second</p></blockquote><p>After</p>')
    ).to.equal('> First\n>\n> Second\n\nAfter')
  })

  it('fences code with its language and a fence longer than any backticks inside', function () {
    expect(md('<pre class="language-latex">\\section{A}</pre>')).to.equal(
      '```latex\n\\section{A}\n```'
    )
    expect(md('<pre><code class="lang-md">a\n```\nb</code></pre>')).to.equal(
      '````md\na\n```\nb\n````'
    )
  })

  it('uses double backticks for inline code that contains a backtick', function () {
    expect(md('<p>Type <code>a`b</code> now</p>')).to.equal(
      'Type `` a`b `` now'
    )
  })

  // Review Focus 3
  it('escapes pipes in table cells and pads short rows', function () {
    const html =
      '<table><tr><th>Key</th><th>Value</th><th>Note</th></tr>' +
      '<tr><td colspan="2">a|b</td><td>c</td></tr><tr><td>d</td></tr></table>'
    expect(md(html)).to.equal(
      '| Key | Value | Note |\n| --- | --- | --- |\n| a\\|b | | c |\n| d | | |'
    )
  })

  it('writes a layout table as paragraphs', function () {
    expect(
      md('<table><tr><td><h2>Side</h2>Menu</td><td>Main text</td></tr></table>')
    ).to.equal('Side Menu\n\nMain text')
  })

  it('puts a caption above its table', function () {
    expect(
      md(
        '<table><caption>Units</caption><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>'
      )
    ).to.equal('Table: Units\n| A | B |\n| --- | --- |\n| 1 | 2 |')
  })

  it('keeps meaningful image descriptions and drops the rest', function () {
    expect(
      md(
        '<p><img src="a.png" alt="Diagram of the build pipeline"> <img alt="logo"> ' +
          '<img alt="photo.jpg"> <a href="/x"><img alt="Badge text"></a></p>'
      )
    ).to.equal('[Image: Diagram of the build pipeline]')
  })

  it('writes definition lists as term: definition', function () {
    expect(
      md(
        '<dl><dt>range-phrase</dt><dd>Text between numbers.</dd><dd>Default: to.</dd></dl>'
      )
    ).to.equal('- **range-phrase**: Text between numbers.\n  - Default: to.')
  })

  // Review Focus 1
  it('removes hidden elements and their text', function () {
    const html =
      '<p>Visible</p><p hidden>Hidden one</p>' +
      '<div aria-hidden="true">Hidden two</div>' +
      '<span style="display: none">Hidden three</span>' +
      '<p style="color:red; VISIBILITY:hidden">Hidden four</p>' +
      '<p style="color:red">Red</p>'
    expect(md(html)).to.equal('Visible\n\nRed')
  })

  it('leaves HTML without hidden markers untouched', function () {
    expect(withoutHiddenElements('<p>A</p>')).to.equal('<p>A</p>')
  })

  it('keeps every table row the same width and every fence closed', function () {
    const { markdown } = htmlToMarkdown(
      `<html><body><main><h2>T</h2><p>${'Words here. '.repeat(60)}</p>` +
        '<table><tr><th>a</th><th>b</th></tr><tr><td colspan="3">wide</td></tr></table>' +
        '<pre>x</pre></main></body></html>',
      'https://a.org/'
    )
    expect(lintMarkdown(markdown)).to.deep.equal([])
  })
})
