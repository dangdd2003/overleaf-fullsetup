import { expect } from 'chai'
import {
  renderMarkdown,
  renderMarkdownStreaming,
} from '../../../../frontend/js/features/ai-assist/components/agent/markdown-content'
import { splitMarkdownBlocks } from '../../../../frontend/js/features/ai-assist/components/agent/markdown-repair'

const WEB_SOURCES = new Map([
  [1, { n: 1, url: 'https://example.com/a', title: 'A' }],
  [2, { n: 2, url: 'https://example.org/b', title: 'B' }],
])

const DOCUMENTS: Record<string, string> = {
  paragraphs: 'First **bold** paragraph.\n\nSecond one with `code`.\n\nThird.',
  headings: '# Title\n\nIntro text.\n\n## Part\n\n- one\n- two',
  lists:
    '- one\n\n- two\n\n  continued in two\n\n1. first\n2. second\n\n> quoted\n\n> quoted again',
  fences:
    'Before.\n\n```latex\n\\section{A}\n\nmore text inside the fence\n```\n\nAfter.\n\n~~~\nplain\n\nstill fenced\n~~~\n\nEnd.',
  displayMath:
    'Here:\n\n$$\na^2 + b^2\n\n= c^2\n$$\n\nand \\[\nx = 1\n\nspans\n\\]\n\nthen \\begin{align}\na &= b\n\nc &= d\n\\end{align}\n\nDone with $x^2$ inline.',
  tables:
    'Lead text\n\n| Name | Value |\n| --- | --- |\n| a | 1 |\n\nTable 2: caption under\n\n## Heading\n\n| x | y |\n|---|---|\n| $a|b$ | 2 |\n\nTail.',
  citations:
    'Claim one [1].\n\nClaim two [2][1].\n\nA bracket [3] in prose.\n\nMore 【2†L4-L9】 text.',
  footnotes: 'A claim[^1].\n\nAnother.\n\n[^1]: The note.',
  linkDefinition: 'See [the docs][docs].\n\nAnd more.\n\n[docs]: https://docs.overleaf.com',
  htmlComment: 'Text.\n\n<!-- hidden\n\nstill comment -->\n\nAfter.',
  rawHtml: 'Plain.\n\n<details>\n<summary>More</summary>\n\nHidden **body**\n</details>\n\nDone.',
  unclosedFence: 'Start.\n\n```js\nconst a = 1\n\nconst b = 2',
  unclosedMath: 'Start.\n\n$$\nx = y\n\nnever closed',
  mixed:
    '# Plan\n\n1. Read the file `main.tex`.\n2. Edit it.\n\n```python\nprint("hi")\n\nprint("bye")\n```\n\n$$\\frac{1}{2}$$\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nDone [1].',
}

function streamed(content: string, step: number) {
  const cache = new Map<string, string>()
  let html = ''
  for (let end = step; ; end += step) {
    const prefix = content.slice(0, end)
    html = renderMarkdownStreaming(prefix, WEB_SOURCES, undefined, cache)
    if (end >= content.length) break
  }
  return html
}

describe('splitMarkdownBlocks', function () {
  it('cuts a reply at blank lines, keeping the block being written as the tail', function () {
    expect(splitMarkdownBlocks('a\n\nb\n\nc')).to.deep.equal({
      stable: ['a\n', 'b\n'],
      tail: 'c',
    })
  })

  it('keeps a paragraph whose blank line is not yet followed by text as the tail', function () {
    expect(splitMarkdownBlocks('a\n\n')).to.deep.equal({
      stable: [],
      tail: 'a\n\n',
    })
  })

  it('keeps fenced code together across blank lines', function () {
    const { stable, tail } = splitMarkdownBlocks(
      'x\n\n```\nline\n\nline two\n```\n\ny'
    )
    expect(stable).to.deep.equal(['x\n', '```\nline\n\nline two\n```\n'])
    expect(tail).to.equal('y')
  })

  it('keeps an unclosed fence as the tail, however long it grows', function () {
    expect(splitMarkdownBlocks('a\n\n```\nb\n\nc')).to.deep.equal({
      stable: ['a\n'],
      tail: '```\nb\n\nc',
    })
  })

  it('does not let a closing fence indented four spaces close the fence', function () {
    const text = '```\ncode\n    ```\n\nafter'
    expect(splitMarkdownBlocks(text)).to.deep.equal({
      stable: [],
      tail: text,
    })
  })

  it('keeps display math together across blank lines', function () {
    const { stable, tail } = splitMarkdownBlocks(
      'a\n\n$$\nx\n\ny\n$$\n\nb'
    )
    expect(stable).to.deep.equal(['a\n', '$$\nx\n\ny\n$$\n'])
    expect(tail).to.equal('b')
  })

  it('keeps \\[ \\] and \\begin{align} blocks together across blank lines', function () {
    const { stable } = splitMarkdownBlocks(
      'a\n\n\\[\nx\n\ny\n\\]\n\nb\n\n\\begin{align}\nu\n\nv\n\\end{align}\n\nc'
    )
    expect(stable).to.deep.equal([
      'a\n',
      '\\[\nx\n\ny\n\\]\n',
      'b\n',
      '\\begin{align}\nu\n\nv\n\\end{align}\n',
    ])
  })

  it('does not cut before a list item, which continues the list', function () {
    expect(splitMarkdownBlocks('- one\n\n- two')).to.deep.equal({
      stable: [],
      tail: '- one\n\n- two',
    })
    expect(splitMarkdownBlocks('1. one\n\n2. two').stable).to.deep.equal([])
  })

  it('does not cut before an indented or quoted line', function () {
    expect(splitMarkdownBlocks('- one\n\n  more').stable).to.deep.equal([])
    expect(splitMarkdownBlocks('> one\n\n> two').stable).to.deep.equal([])
  })

  it('does not cut next to a table row', function () {
    expect(splitMarkdownBlocks('| a | b |\n| - | - |\n\nafter').stable).to.deep.equal([])
    expect(splitMarkdownBlocks('before\n\n| a |\n| - |').stable).to.deep.equal([])
    expect(splitMarkdownBlocks('| a |\n| - |\n\nTable 1: after').stable).to.deep.equal([])
  })

  it('keeps a reply with a link or footnote definition, or a raw HTML comment, as one block', function () {
    for (const key of ['linkDefinition', 'footnotes', 'htmlComment']) {
      const text = DOCUMENTS[key]
      expect(splitMarkdownBlocks(text)).to.deep.equal({ stable: [], tail: text })
    }
  })
})

describe('renderMarkdownStreaming', function () {
  describe('the final render', function () {
    for (const [name, content] of Object.entries(DOCUMENTS)) {
      it(`matches a full render for ${name}`, function () {
        const cache = new Map<string, string>()
        const html = renderMarkdownStreaming(content, WEB_SOURCES, undefined, cache)
        expect(html).to.equal(renderMarkdown(content, WEB_SOURCES))
      })
    }
  })

  describe('while the reply streams in', function () {
    for (const [name, content] of Object.entries(DOCUMENTS)) {
      it(`matches a full render at every chunk for ${name}`, function () {
        const cache = new Map<string, string>()
        for (let end = 1; end <= content.length; end += 3) {
          const prefix = content.slice(0, end)
          expect(
            renderMarkdownStreaming(prefix, WEB_SOURCES, undefined, cache),
            `prefix ${JSON.stringify(prefix)}`
          ).to.equal(renderMarkdown(prefix, WEB_SOURCES))
        }
      })
    }
  })

  it('draws each completed block once', function () {
    const cache = new Map<string, string>()
    renderMarkdownStreaming('one\n\ntwo\n\nthr', WEB_SOURCES, undefined, cache)
    expect([...cache.keys()]).to.deep.equal(['one\n', 'two\n', 'thr'])
    renderMarkdownStreaming('one\n\ntwo\n\nthree', WEB_SOURCES, undefined, cache)
    expect([...cache.keys()]).to.deep.equal(['one\n', 'two\n', 'three'])
  })

  it('reaches the same final HTML however the reply was chunked', function () {
    const content = DOCUMENTS.mixed
    expect(streamed(content, 1)).to.equal(renderMarkdown(content, WEB_SOURCES))
    expect(streamed(content, 17)).to.equal(renderMarkdown(content, WEB_SOURCES))
  })

  it('keeps raw HTML styles and unsafe links out of every block', function () {
    const content = [
      'Intro.',
      '<div style="position:fixed;background-image:url(https://evil.example/x)">x</div>',
      '[bad](javascript:alert(1))',
      '<img src="x" onerror="alert(1)">',
      '<span style="color:red">styled</span>',
      'Ends [1].',
    ].join('\n\n')
    const cache = new Map<string, string>()
    const html = renderMarkdownStreaming(content, WEB_SOURCES, undefined, cache)
    expect(html).to.equal(renderMarkdown(content, WEB_SOURCES))

    const dom = document.createElement('div')
    dom.innerHTML = html
    expect(dom.querySelector('[style]:not(.ai-assist-citation-icon)')).to.not.exist
    expect(dom.querySelector('img')).to.not.exist
    expect(dom.querySelector('[onerror]')).to.not.exist
    for (const link of Array.from(dom.querySelectorAll('a'))) {
      expect(link.getAttribute('href') ?? '').not.to.match(/^javascript:/i)
    }
    expect(dom.textContent).to.contain('<div style=')
  })
})
