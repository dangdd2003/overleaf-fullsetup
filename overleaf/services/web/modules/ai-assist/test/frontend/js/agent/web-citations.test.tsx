import { expect } from 'chai'
import { renderMarkdown } from '../../../../frontend/js/features/ai-assist/components/agent/markdown-content'
import {
  collectWebSources,
  siteName,
  WebSources,
} from '../../../../frontend/js/features/ai-assist/agent/web-sources'
import { shrinkCall } from '../../../../frontend/js/features/ai-assist/agent/conversation-store'
import { formatToday, renderEnvelope } from '../../../../frontend/js/features/ai-assist/agent/context/project-context'
import { summarise } from '../../../../frontend/js/features/ai-assist/components/agent/tool-call-card'

const fakeT = (_key: string, opts?: any) =>
  typeof opts === 'string' ? opts : opts?.defaultValue || _key

const sources: WebSources = new Map([
  [2, { n: 2, url: 'https://www.reuters.com/world/a', title: 'Reuters story' }],
  [5, { n: 5, url: 'https://en.wikipedia.org/wiki/B', title: 'Wikipedia B' }],
])

function render(markdown: string) {
  const container = document.createElement('div')
  container.innerHTML = renderMarkdown(markdown, sources)
  return container
}

describe('web citations', function () {
  it('renders a cited source as a pill naming the site, linking to the page', function () {
    const chips = render('Elected in April [2].').querySelectorAll(
      '.ai-assist-citation-chip'
    )
    expect(chips).to.have.length(1)
    expect(chips[0].textContent).to.equal('reuters')
    expect(chips[0].getAttribute('href')).to.equal('https://www.reuters.com/world/a')
  })

  it('folds adjacent citations, in either spelling, into one pill with a count', function () {
    for (const text of ['Claim [2][5].', 'Claim [2, 5].', 'Claim 【2†L4-L9】【5†L1】.']) {
      const container = render(text)
      const chips = container.querySelectorAll('.ai-assist-citation-chip')
      expect(chips, text).to.have.length(1)
      expect(chips[0].textContent, text).to.equal('reuters+1')
      expect(
        container.querySelectorAll('.ai-assist-citation-source'),
        text
      ).to.have.length(2)
      expect(container.textContent, text).to.match(/^Claim /)
    }
  })

  it('leaves an unknown [n] as text but drops an unknown 【n†…】 marker', function () {
    const container = render('Index [9] here 【9†L1】 end')
    expect(container.querySelector('.ai-assist-citation')).to.equal(null)
    expect(container.textContent).to.contain('Index [9] here')
    expect(container.textContent).not.to.contain('【')
  })

  it('keeps a Markdown link whose text is a number a normal link', function () {
    const link = render('See [2](https://example.org).').querySelector('a')
    expect(link?.className).to.equal('')
    expect(link?.getAttribute('href')).to.equal('https://example.org')
  })

  it('names sites by their registrable name', function () {
    expect(siteName('https://en.wikipedia.org/x')).to.equal('wikipedia')
    expect(siteName('https://www.bbc.co.uk/news')).to.equal('bbc')
    expect(siteName('https://vnexpress.net/a')).to.equal('vnexpress')
  })

  it('collects numbered sources from search and fetch results across turns', function () {
    const found = collectWebSources([
      {
        id: 'a1',
        role: 'assistant',
        text: '',
        toolCalls: [
          {
            id: 's',
            name: 'web_search',
            args: {},
            result: { results: [{ source: 1, url: 'https://a.org', title: 'A' }] },
          },
        ],
      },
      {
        id: 'a2',
        role: 'assistant',
        text: '',
        toolCalls: [
          { id: 'f', name: 'web_fetch', args: {}, result: { source: 2, url: 'https://b.org' } },
        ],
      },
    ] as any)
    expect([...found.keys()]).to.deep.equal([1, 2])
    expect(found.get(1)?.title).to.equal('A')
  })

  it('keeps search results and their source numbers when a call is stored', function () {
    const stored = shrinkCall({
      id: 's',
      name: 'web_search',
      args: {},
      result: {
        results: Array.from({ length: 5 }, (_, i) => ({
          source: i + 1,
          url: `https://a.org/${i}`,
          title: 'T',
          snippet: 'x'.repeat(900),
        })),
      },
    }) as any
    expect(stored.result.results).to.have.length(5)
    expect(stored.result.results[4].source).to.equal(5)
    expect(stored.result.results[0].snippet.length).to.be.at.most(300)
  })

  it("puts today's date first in the context envelope", function () {
    expect(formatToday(new Date(2026, 8, 24))).to.equal('2026-09-24 (Thursday)')
    const { text } = renderEnvelope({
      snapshot: {
        rootDocPath: null,
        files: [],
        openFile: null,
        selection: null,
        compile: null,
        today: '2026-09-24 (Thursday)',
      },
      attachments: [],
      turn: 1,
      previous: null,
    })
    expect(text.split('\n')[1]).to.equal('<date>2026-09-24 (Thursday)</date>')
  })

  it('names a page that could not be read instead of claiming it was read', function () {
    const summary = summarise(
      {
        id: 'f',
        name: 'web_fetch',
        args: { url: 'https://www.reuters.com/x' },
        result: { error: 'refused', url: 'https://www.reuters.com/x' },
      },
      fakeT
    )
    expect(summary.action).to.equal("Couldn't fetch")
    expect(summary.target).to.equal('reuters.com')
  })
})
