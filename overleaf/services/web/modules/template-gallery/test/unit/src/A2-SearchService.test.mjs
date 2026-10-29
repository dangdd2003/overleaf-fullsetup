import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setCollectionOverrideForTests } from '../../../app/src/persistence/Collections.mjs'
import SearchService, {
  buildSnippetHtml,
  parseQueryTerms,
  escapeHtml,
} from '../../../app/src/services/SearchService.mjs'

function makeItem(overrides = {}) {
  return {
    token: 'abcdefghijkl',
    family: 'template',
    slug: 'modern-cv',
    title: 'Modern CV',
    author: 'Jane Doe',
    description: 'A modern CV template.',
    official: true,
    tags: [
      { name: 'cv', title: 'CVs and résumés' },
      { name: 'two-column', title: 'Two column' },
    ],
    ...overrides,
  }
}

// Records every find/count call so tests can assert on filters and paging.
function makeCollection({ docs = [], total = docs.length, textIndex = true } = {}) {
  const calls = { find: [], count: [] }
  const missingIndex = () =>
    Object.assign(new Error('text index required for $text query'), {
      code: 27,
    })
  return {
    calls,
    find(filter, options) {
      const call = { filter, options }
      calls.find.push(call)
      const cursor = {
        sort(sort) {
          call.sort = sort
          return cursor
        },
        skip(skip) {
          call.skip = skip
          return cursor
        },
        limit(limit) {
          call.limit = limit
          return cursor
        },
        async toArray() {
          if (filter.$text && !textIndex) throw missingIndex()
          return docs
        },
      }
      return cursor
    },
    async countDocuments(filter) {
      calls.count.push(filter)
      if (filter.$text && !textIndex) throw missingIndex()
      return total
    },
  }
}

describe('A2 SearchService', function () {
  afterEach(function () {
    setCollectionOverrideForTests(null)
  })

  describe('parseQueryTerms', function () {
    it('folds case and diacritics and de-duplicates', function () {
      expect(parseQueryTerms('Résumé  resume CV')).toEqual(['resume', 'cv'])
    })

    it('drops Mongo text operators and punctuation', function () {
      expect(parseQueryTerms('-thesis "beamer" c++')).toEqual([
        'thesis',
        'beamer',
        'c',
      ])
    })

    it('caps the query length and term count', function () {
      expect(parseQueryTerms('a'.repeat(150))).toEqual(['a'.repeat(100)])
      const many = Array.from({ length: 20 }, (_, i) => `w${i}`).join(' ')
      expect(parseQueryTerms(many)).toHaveLength(10)
    })
  })

  describe('buildSnippetHtml', function () {
    it('escapes HTML before adding highlights', function () {
      expect(buildSnippetHtml('<b>CV</b> & "cv"', ['cv'])).toBe(
        '&lt;b&gt;<strong>CV</strong>&lt;/b&gt; &amp; &quot;<strong>cv</strong>&quot;'
      )
    })

    it('keeps short descriptions whole', function () {
      expect(buildSnippetHtml('Spider CV/resume.', ['cv'])).toBe(
        'Spider <strong>CV</strong>/resume.'
      )
    })

    it('matches accented words with folded terms', function () {
      expect(buildSnippetHtml('Un résumé simple', ['resume'])).toBe(
        'Un <strong>résumé</strong> simple'
      )
    })

    it('highlights the matched prefix of the last term only', function () {
      expect(buildSnippetHtml('Theses and thesis', ['thes'])).toBe(
        '<strong>Thes</strong>es and <strong>thes</strong>is'
      )
      expect(buildSnippetHtml('Theses thesis', ['thes', 'x'])).toBe(
        'Theses thesis'
      )
    })

    it('truncates at the end with an ellipsis when matches are early', function () {
      const words = Array.from({ length: 80 }, (_, i) => `w${i}`)
      words[2] = 'CV'
      const html = buildSnippetHtml(words.join(' '), ['cv'], 64)
      expect(html.startsWith('w0 w1 <strong>CV</strong> w3')).toBe(true)
      expect(html.endsWith('w63 …')).toBe(true)
    })

    it('moves the window to cover the most matches (Algolia autoCVmkr case)', function () {
      const words = Array.from({ length: 81 }, (_, i) => `w${i}`)
      words[18] = 'CV'
      words[70] = 'CV'
      words[78] = 'CV'
      const html = buildSnippetHtml(`${words.join(' ')}.`, ['cv'], 64)
      // window = last 64 words, one word of context before the first match
      expect(html.startsWith('… w17 <strong>CV</strong>')).toBe(true)
      expect(html.endsWith('w80.')).toBe(true)
      expect(html.match(/<strong>/g)).toHaveLength(3)
    })

    it('shows the leading words when only the title matched', function () {
      const words = Array.from({ length: 70 }, (_, i) => `w${i}`)
      const html = buildSnippetHtml(words.join(' '), ['zzz'], 64)
      expect(html.startsWith('w0 w1')).toBe(true)
      expect(html.endsWith('w63 …')).toBe(true)
      expect(html).not.toContain('<strong>')
    })
  })

  describe('search', function () {
    let col

    beforeEach(function () {
      col = makeCollection({ docs: [makeItem()], total: 1 })
      setCollectionOverrideForTests({ templateGalleryItems: col })
    })

    it('returns an empty result without querying for a blank query', async function () {
      const result = await SearchService.search({ q: '   ' })
      expect(result).toMatchObject({ hits: [], nbHits: 0, nbPages: 0, page: 0 })
      expect(col.calls.find).toHaveLength(0)
    })

    it('runs an AND text search over published items sorted by relevance then recency', async function () {
      await SearchService.search({ q: 'Modern -CV', page: '0' })
      const [call] = col.calls.find
      expect(call.filter).toEqual({
        state: 'published',
        token: { $type: 'string' },
        family: { $in: ['template', 'example', 'article'] },
        'mirror.removedAt': null,
        $text: { $search: '"modern" "cv"' },
      })
      expect(call.sort).toEqual({
        score: { $meta: 'textScore' },
        recentOrder: -1,
        objectIDNum: -1,
      })
      expect(call.options.projection.score).toEqual({ $meta: 'textScore' })
      expect(call.skip).toBe(0)
      expect(call.limit).toBe(10)
    })

    it('formats hits with local hrefs, snippets, tags and thumbnails', async function () {
      const result = await SearchService.search({ q: 'cv' })
      expect(result).toMatchObject({ nbHits: 1, nbPages: 1, page: 0 })
      expect(result.hits[0]).toEqual({
        token: 'abcdefghijkl',
        family: 'template',
        href: '/latex/templates/modern-cv/abcdefghijkl',
        title: 'Modern CV',
        author: 'Jane Doe',
        snippetHtml: 'A modern <strong>CV</strong> template.',
        official: true,
        tags: [
          {
            name: 'cv',
            title: 'CVs and résumés',
            href: '/gallery/tagged/cv',
          },
          {
            name: 'two-column',
            title: 'Two column',
            href: '/gallery/tagged/two-column',
          },
        ],
        thumbUrl: '/gallery/_media/abcdefghijkl/thumb.jpg',
      })
    })

    it('links examples and articles under their own family paths', async function () {
      col = makeCollection({
        docs: [
          makeItem({ family: 'example', slug: 'ieee', official: null }),
          makeItem({ family: 'article', slug: 'a~b', tags: undefined }),
        ],
      })
      setCollectionOverrideForTests({ templateGalleryItems: col })
      const { hits } = await SearchService.search({ q: 'cv' })
      expect(hits[0].href).toBe('/latex/examples/ieee/abcdefghijkl')
      expect(hits[0].official).toBe(false)
      expect(hits[1].href).toBe('/articles/a~b/abcdefghijkl')
      expect(hits[1].tags).toEqual([])
    })

    it('pages with a 0-based index and caps hitsPerPage', async function () {
      col = makeCollection({ docs: [], total: 95 })
      setCollectionOverrideForTests({ templateGalleryItems: col })
      const result = await SearchService.search({
        q: 'cv',
        page: 3,
        hitsPerPage: 500,
      })
      expect(col.calls.find[0].skip).toBe(150)
      expect(col.calls.find[0].limit).toBe(50)
      expect(result).toMatchObject({ page: 3, nbPages: 2, hitsPerPage: 50 })
    })

    it('mirrors the Algolia 1000-hit pagination limit', async function () {
      col = makeCollection({ docs: [], total: 10498 })
      setCollectionOverrideForTests({ templateGalleryItems: col })
      const last = await SearchService.search({ q: 'a', page: 99 })
      expect(last.nbPages).toBe(100)
      expect(last.nbHits).toBe(10498)
      expect(col.calls.find[0].limit).toBe(10)

      const beyond = await SearchService.search({ q: 'a', page: 100 })
      expect(beyond.hits).toEqual([])
      expect(beyond.nbHits).toBe(10498)
      expect(col.calls.find).toHaveLength(1)
    })

    it('falls back to a regex AND search when the text index is missing', async function () {
      col = makeCollection({ docs: [makeItem()], textIndex: false })
      setCollectionOverrideForTests({ templateGalleryItems: col })
      const result = await SearchService.search({ q: 'modern cv' })
      expect(result.nbHits).toBe(1)
      const fallback = col.calls.find.at(-1)
      expect(fallback.filter.$text).toBeUndefined()
      expect(fallback.filter.$and).toHaveLength(2)
      expect(fallback.filter.$and[0].$or[0].title).toEqual(/modern/i)
      expect(fallback.sort).toEqual({ recentOrder: -1, objectIDNum: -1 })
    })

    it('rethrows unexpected database errors', async function () {
      col = makeCollection()
      col.countDocuments = async () => {
        throw new Error('connection reset')
      }
      setCollectionOverrideForTests({ templateGalleryItems: col })
      let error
      try {
        await SearchService.search({ q: 'cv' })
      } catch (err) {
        error = err
      }
      expect(error?.message).toBe('connection reset')
    })
  })

  it('escapeHtml escapes all HTML-significant characters', function () {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;'
    )
  })
})
