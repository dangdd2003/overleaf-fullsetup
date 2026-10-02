import { expect } from 'chai'
import { webFetchNotes } from '../../../../../frontend/js/features/ai-assist/components/agent/tool-call-detail'

const labels = (result: any) => webFetchNotes(result).map(note => note.label)
const titles = (result: any) => webFetchNotes(result).map(note => note.title)

describe('web_fetch notes', function () {
  it('says nothing about the route for a direct read', function () {
    expect(
      webFetchNotes({
        url: 'https://a.org',
        via: 'direct',
        page: 1,
        totalPages: 1,
      })
    ).to.deep.equal([])
  })

  it('names the browser and the paid readers', function () {
    expect(
      webFetchNotes({ url: 'https://a.org', via: 'browser', totalPages: 1 })
    ).to.deep.equal([{ label: 'via browser', title: 'Read via browser' }])
    expect(
      labels({ url: 'https://a.org', via: 'ollama', totalPages: 1 })
    ).to.deep.equal(['via Ollama'])
    expect(
      labels({
        url: 'https://a.org',
        via: 'websearchapi',
        totalPages: 1,
      })
    ).to.deep.equal(['via WebSearchAPI.ai'])
  })

  it('names the archive and flags a partial read', function () {
    const archiveToday = {
      url: 'https://a.org',
      via: 'archive.today',
      archived: '2026-05-01',
      archiveUrl: 'https://archive.ph/x1',
      partial: true,
      totalPages: 1,
    }
    expect(labels(archiveToday)).to.deep.equal([
      'archive.today 2026-05-01',
      'Partial',
    ])
    expect(titles(archiveToday)).to.deep.equal([
      'Read from the archive.today copy of 2026-05-01',
      'Only part of this page could be read',
    ])
    expect(
      webFetchNotes({
        url: 'https://a.org',
        archived: '2026-04-07',
        totalPages: 1,
      })
    ).to.deep.equal([
      {
        label: 'Wayback 2026-04-07',
        title: 'Read from the Internet Archive copy of 2026-04-07',
      },
    ])
  })

  it('keeps an archived, dated page short', function () {
    const notes = labels({
      url: 'https://www.lsuagcenter.com/articles/page1669656019180',
      via: 'wayback',
      published: '2022-07-20',
      archived: '2026-05-19',
      totalPages: 1,
    })
    expect(notes).to.deep.equal(['Pub. 2022-07-20', 'Wayback 2026-05-19'])
    expect(notes.join(' · ').length).to.be.below(40)
  })

  it('names the search for a find instead of a page', function () {
    const multiPage = {
      url: 'https://a.org',
      find: 'range-phrase',
      matches: [{ page: 2, text: 'x' }],
      totalMatches: 3,
      matchPages: [1, 2],
      totalPages: 2,
    }
    expect(labels(multiPage)).to.deep.equal(['3 matches · 2 pp.'])
    expect(titles(multiPage)).to.deep.equal(['3 matches on 2 pages'])
    expect(
      webFetchNotes({
        url: 'https://a.org',
        find: 'History Tikhonov 1943 1963 ridge regression',
        matches: [{ page: 1, text: 'x' }],
        totalMatches: 1,
        totalPages: 2,
      })
    ).to.deep.equal([{ label: '1 match', title: '1 match on 1 page' }])
    expect(
      labels({
        url: 'https://a.org',
        find: 'nothing',
        matches: [],
        totalMatches: 0,
        totalPages: 1,
      })
    ).to.deep.equal(['No matches'])
  })

  it('keeps the page and date notes first', function () {
    const result = {
      url: 'https://a.org',
      page: 2,
      totalPages: 3,
      published: '2026-01-01',
      via: 'ollama',
    }
    expect(labels(result)).to.deep.equal([
      'p. 2/3',
      'Pub. 2026-01-01',
      'via Ollama',
    ])
    expect(titles(result)).to.deep.equal([
      'Page 2 of 3',
      'Published 2026-01-01',
      'Read via Ollama',
    ])
  })
})
