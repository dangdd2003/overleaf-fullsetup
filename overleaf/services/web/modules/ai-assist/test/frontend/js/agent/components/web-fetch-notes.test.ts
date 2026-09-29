import { expect } from 'chai'
import { webFetchNotes } from '../../../../../frontend/js/features/ai-assist/components/agent/tool-call-detail'

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
    ).to.deep.equal(['Read via browser'])
    expect(
      webFetchNotes({ url: 'https://a.org', via: 'ollama', totalPages: 1 })
    ).to.deep.equal(['Read via Ollama'])
    expect(
      webFetchNotes({
        url: 'https://a.org',
        via: 'websearchapi',
        totalPages: 1,
      })
    ).to.deep.equal(['Read via WebSearchAPI.ai'])
  })

  it('names the archive and flags a partial read', function () {
    expect(
      webFetchNotes({
        url: 'https://a.org',
        via: 'archive.today',
        archived: '2026-05-01',
        archiveUrl: 'https://archive.ph/x1',
        partial: true,
        totalPages: 1,
      })
    ).to.deep.equal([
      'Read from the archive.today copy of 2026-05-01',
      'Only part of this page could be read',
    ])
    expect(
      webFetchNotes({
        url: 'https://a.org',
        archived: '2026-04-07',
        totalPages: 1,
      })
    ).to.deep.equal(['Read from the Internet Archive copy of 2026-04-07'])
  })

  it('keeps the page and date notes first', function () {
    expect(
      webFetchNotes({
        url: 'https://a.org',
        page: 2,
        totalPages: 3,
        published: '2026-01-01',
        via: 'ollama',
      })
    ).to.deep.equal(['Page 2 of 3', 'Published 2026-01-01', 'Read via Ollama'])
  })
})
