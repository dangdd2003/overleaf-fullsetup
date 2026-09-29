import { expect } from 'chai'
import { summarise } from '../../../../../frontend/js/features/ai-assist/components/agent/tool-call-card'
import { summariseToolCallActions } from '../../../../../frontend/js/features/ai-assist/components/agent/subresult-group'

const fakeT = (_key: string, opts?: any) =>
  typeof opts === 'string' ? opts : opts?.defaultValue || _key

describe('web tool cards', function () {
  it('summarises a search by its query alone, as Claude.ai does', function () {
    const summary = summarise(
      {
        id: '1',
        name: 'web_search',
        args: { query: 'siunitx range' },
        result: {
          results: [{ url: 'https://a.org' }, { url: 'https://b.org' }],
        },
      },
      fakeT
    )
    expect(summary).to.deep.equal({
      action: 'Searched the web',
      target: 'siunitx range',
    })
  })

  it('names a fetched page by title, else host, as Claude.ai does', function () {
    const summary1 = summarise(
      {
        id: '1',
        name: 'web_fetch',
        args: { url: 'https://ctan.org/pkg/siunitx' },
        result: {
          url: 'https://ctan.org/pkg/siunitx',
          title: 'CTAN: siunitx',
          page: 2,
          totalPages: 3,
        },
      },
      fakeT
    )
    expect(summary1).to.deep.equal({ action: 'Fetched', target: 'CTAN: siunitx' })

    const summary2 = summarise(
      {
        id: '2',
        name: 'web_fetch',
        args: { url: 'https://www.ctan.org/x' },
        result: {
          url: 'https://www.ctan.org/x',
          find: '\\qty',
          totalPages: 1,
        },
      },
      fakeT
    )
    expect(summary2).to.deep.equal({ action: 'Fetched', target: 'ctan.org' })
  })

  it('counts web work in the activity tally', function () {
    expect(
      summariseToolCallActions([
        { name: 'web_search', result: { results: [] } },
        { name: 'web_fetch', result: { url: 'https://a.org' } },
        { name: 'web_fetch', result: { url: 'https://b.org' } },
      ])
    ).to.equal('Searched the web, fetched 2 pages')
  })
})
