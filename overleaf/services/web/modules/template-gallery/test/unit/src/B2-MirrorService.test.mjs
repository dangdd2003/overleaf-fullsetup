import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Settings from '@overleaf/settings'
import { DEFAULTS } from '../../../app/src/TemplateGalleryDefaults.mjs'
import { setCollectionOverrideForTests } from '../../../app/src/persistence/Collections.mjs'
import * as BlobStore from '../../../app/src/storage/BlobStore.mjs'
import GuardedHttps, {
  redirectHeaders,
  parseRetryAfter,
  httpError,
} from '../../../app/src/transport/GuardedHttps.mjs'
import ListingParser, {
  parsePublishedImage,
  parseCard,
  parseListingPage,
} from '../../../app/src/services/mirror/ListingParser.mjs'
import DetailParser, {
  parseOpenTemplateHref,
  computeDetailHash,
  parseDetailPage,
} from '../../../app/src/services/mirror/DetailParser.mjs'
import TagParser, {
  tagNameFromHref,
  tagTitleFromHeading,
  parseTagPage,
} from '../../../app/src/services/mirror/TagParser.mjs'
import AbstractSanitizer, {
  resolveAbstractHref,
  sanitizeAbstractHtml,
} from '../../../app/src/services/mirror/AbstractSanitizer.mjs'
import * as Fetch from '../../../app/src/services/mirror/Fetch.mjs'
import * as MirrorService from '../../../app/src/services/mirror/MirrorService.mjs'
import TemplateHydrationService, {
  parseDetailPageHtml,
  hydrateItem,
} from '../../../app/src/services/TemplateHydrationService.mjs'
import HydrationJob from '../../../app/src/jobs/handlers/HydrationJob.mjs'

// ---------------------------------------------------------------------------
// In-memory Mongo collection mocks
// ---------------------------------------------------------------------------

function getDeep(obj, propPath) {
  if (!obj || !propPath) return undefined
  const parts = propPath.split('.')
  let curr = obj
  for (const part of parts) {
    if (curr == null) return undefined
    curr = curr[part]
  }
  return curr
}

function setDeep(obj, propPath, value) {
  const parts = propPath.split('.')
  let curr = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]
    if (!curr[p] || typeof curr[p] !== 'object') {
      curr[p] = {}
    }
    curr = curr[p]
  }
  curr[parts[parts.length - 1]] = value
}

function matchesFilter(doc, query) {
  if (!query || Object.keys(query).length === 0) return true
  for (const [k, v] of Object.entries(query)) {
    if (k === '$or') {
      if (!v.some(subQ => matchesFilter(doc, subQ))) return false
      continue
    }
    const val = getDeep(doc, k)
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      if ('$ne' in v && val === v.$ne) return false
      if ('$in' in v && (!Array.isArray(v.$in) || !v.$in.includes(val))) return false
      if ('$type' in v) {
        if (v.$type === 'number' && (typeof val !== 'number' || !Number.isFinite(val))) return false
      }
      if ('$gt' in v && !(val > v.$gt)) return false
      if ('$lt' in v && !(val < v.$lt)) return false
      if ('$not' in v) {
        if (matchesFilter({ [k]: val }, { [k]: v.$not })) return false
      }
      continue
    }
    if (val !== v) return false
  }
  return true
}

function applyUpdates(doc, update) {
  if (update.$set) {
    for (const [k, v] of Object.entries(update.$set)) {
      setDeep(doc, k, v)
    }
  }
  if (update.$setOnInsert && doc._isInsert) {
    for (const [k, v] of Object.entries(update.$setOnInsert)) {
      setDeep(doc, k, v)
    }
    delete doc._isInsert
  }
}

function createMockCollection(initialDocs = []) {
  const docs = new Map()
  for (const d of initialDocs) {
    const key = d._id ?? d.token
    docs.set(String(key), JSON.parse(JSON.stringify(d)))
  }

  return {
    _docs: docs,
    async findOne(query = {}, options = {}) {
      const all = []
      for (const d of docs.values()) {
        if (matchesFilter(d, query)) {
          all.push(JSON.parse(JSON.stringify(d)))
        }
      }
      if (options.sort) {
        const [sortKey, sortDir] = Object.entries(options.sort)[0] || []
        all.sort((a, b) => {
          const va = getDeep(a, sortKey) ?? 0
          const vb = getDeep(b, sortKey) ?? 0
          return (va - vb) * sortDir
        })
      }
      return all[0] || null
    },
    find(query = {}, options = {}) {
      const matched = []
      for (const d of docs.values()) {
        if (matchesFilter(d, query)) {
          matched.push(JSON.parse(JSON.stringify(d)))
        }
      }
      let sortKey = null
      let sortDir = 1
      let skipCount = 0
      let limitCount = matched.length

      const cursor = {
        sort(s) {
          if (s) {
            const [k, dir] = Object.entries(s)[0] || []
            sortKey = k
            sortDir = dir
          }
          return cursor
        },
        skip(n) {
          skipCount = n || 0
          return cursor
        },
        limit(n) {
          limitCount = n || matched.length
          return cursor
        },
        async toArray() {
          const res = [...matched]
          if (sortKey) {
            res.sort((a, b) => {
              const va = getDeep(a, sortKey) ?? 0
              const vb = getDeep(b, sortKey) ?? 0
              return (va - vb) * sortDir
            })
          }
          return res.slice(skipCount, skipCount + limitCount)
        },
      }
      return cursor
    },
    async updateOne(filter, update, options = {}) {
      for (const d of docs.values()) {
        if (matchesFilter(d, filter)) {
          applyUpdates(d, update)
          return { acknowledged: true, matchedCount: 1, modifiedCount: 1 }
        }
      }
      if (options.upsert) {
        const newDoc = { _isInsert: true }
        if (filter._id) newDoc._id = filter._id
        if (filter.token) newDoc.token = filter.token
        applyUpdates(newDoc, update)
        delete newDoc._isInsert
        const key = newDoc._id ?? newDoc.token ?? Math.random().toString()
        docs.set(String(key), newDoc)
        return { acknowledged: true, matchedCount: 0, upsertedCount: 1, upsertedId: key }
      }
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0 }
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('B2 Mirror Service & Parsers', () => {
  let tmpStorageDir
  let mockItemsCol
  let mockTagsCol
  let mockListingsCol

  beforeEach(async () => {
    tmpStorageDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tg-b2-test-'))
    Settings.templateGallery = {
      ...DEFAULTS,
      storageDir: tmpStorageDir,
    }

    mockItemsCol = createMockCollection()
    mockTagsCol = createMockCollection()
    mockListingsCol = createMockCollection()

    setCollectionOverrideForTests({
      templateGalleryItems: mockItemsCol,
      templateGalleryTags: mockTagsCol,
      templateGalleryListings: mockListingsCol,
    })
  })

  afterEach(async () => {
    setCollectionOverrideForTests(null)
    Fetch.setFetchOverridesForTests(null)
    vi.restoreAllMocks()
    if (tmpStorageDir) {
      await fs.promises.rm(tmpStorageDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  // -------------------------------------------------------------------------
  // 1. ListingParser tests
  // -------------------------------------------------------------------------
  describe('ListingParser', () => {
    it('parsePublishedImage extracts publishedId and full URL for S3 images', () => {
      const valid = 'https://writelatex.s3.amazonaws.com/published_ver/12345.jpeg?X-Amz-Signature=test'
      expect(parsePublishedImage(valid)).toEqual({
        publishedId: 12345,
        url: valid,
      })

      const jpg = 'https://writelatex.s3.amazonaws.com/published_ver/67890.jpg'
      expect(parsePublishedImage(jpg)).toEqual({
        publishedId: 67890,
        url: 'https://writelatex.s3.amazonaws.com/published_ver/67890.jpg',
      })

      expect(parsePublishedImage('https://evil.com/published_ver/12345.jpeg')).toBeNull()
      expect(parsePublishedImage('https://writelatex.s3.amazonaws.com/other/12345.jpeg')).toBeNull()
      expect(parsePublishedImage(null)).toBeNull()
      expect(parsePublishedImage('')).toBeNull()
      expect(parsePublishedImage('not-a-url')).toBeNull()
    })

    it('parseCard extracts item card details and ignores category tiles', () => {
      const $ = cheerioLoad(`
        <div class="gallery-thumbnail">
          <a href="/latex/templates/sample-cv/abcdefghijkl">
            <div class="thumbnail">
              <img src="https://writelatex.s3.amazonaws.com/published_ver/11020.jpeg" alt="Sample CV Alt" />
            </div>
            <div class="caption">
              <div class="caption-title">Sample CV</div>
              <div class="author-name">Jane Doe</div>
              <div class="caption-description">A sample curriculum vitae</div>
            </div>
            <div class="badge-container">
              <span class="badge-content">Top Pick</span>
              <span class="badge-content">Official</span>
            </div>
          </a>
        </div>
      `)

      const card = parseCard($, $('.gallery-thumbnail').first())
      expect(card).toMatchObject({
        family: 'template',
        slug: 'sample-cv',
        token: 'abcdefghijkl',
        title: 'Sample CV',
        author: 'Jane Doe',
        description: 'A sample curriculum vitae',
        publishedId: 11020,
        imageUrl: 'https://writelatex.s3.amazonaws.com/published_ver/11020.jpeg',
        badges: ['top-pick', 'official'],
      })

      // Category tile that points to a tag page should return null
      const $tag = cheerioLoad(`
        <div class="gallery-thumbnail">
          <a href="/latex/templates/tagged/cv">
            <div class="caption-title">CVs</div>
          </a>
        </div>
      `)
      expect(parseCard($tag, $tag('.gallery-thumbnail').first())).toBeNull()
    })

    it('parseListingPage separates recent, featured, and topPicks and parses pagination', () => {
      const html = `
        <div class="featured-docs">
          <div class="gallery-thumbnail">
            <a href="/latex/templates/featured-one/aaaaabbbbbba">
              <div class="caption-title">Featured One</div>
            </a>
          </div>
        </div>
        <div class="top-picks-banner">
          <div class="gallery-thumbnail">
            <a href="/latex/templates/pick-one/bbbbbaaaaaab">
              <div class="caption-title">Pick One</div>
            </a>
          </div>
        </div>
        <div class="gallery-grid">
          <div class="gallery-thumbnail">
            <a href="/latex/templates/recent-one/cccccaaaaaac">
              <div class="caption-title">Recent One</div>
            </a>
          </div>
        </div>
        <ul class="pagination">
          <li class="active"><a href="#">1</a></li>
          <li><a href="/gallery/recent/page/2">2</a></li>
          <li><a href="/gallery/recent/page/42" aria-label="Go to last page">Last</a></li>
        </ul>
      `
      const result = parseListingPage(html)
      expect(result.featured).toHaveLength(1)
      expect(result.featured[0].token).toBe('aaaaabbbbbba')
      expect(result.topPicks).toHaveLength(1)
      expect(result.topPicks[0].token).toBe('bbbbbaaaaaab')
      expect(result.recent).toHaveLength(1)
      expect(result.recent[0].token).toBe('cccccaaaaaac')
      expect(result.lastPage).toBe(42)
      expect(result.noResults).toBe(false)
    })

    it('parseListingPage detects empty search / no results and active page fallback', () => {
      const html = `
        <div class="no-articles-matching">No templates found</div>
        <ul class="pagination">
          <li class="active"><a>5</a></li>
        </ul>
      `
      const result = parseListingPage(html)
      expect(result.noResults).toBe(true)
      expect(result.lastPage).toBe(5)
      expect(result.recent).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // 2. DetailParser tests
  // -------------------------------------------------------------------------
  describe('DetailParser', () => {
    it('parseOpenTemplateHref parses CTA query parameters into structured object', () => {
      const href =
        '/project/new/template/11020?id=30526827&latexEngine=pdflatex&mainFile=main.tex&templateName=Modern+CV&texImage=texlive-2024.1&brandVariationId=69'
      const parsed = parseOpenTemplateHref(href)
      expect(parsed).toEqual({
        publishedId: 11020,
        objectID: '30526827',
        templateName: 'Modern CV',
        mainFile: 'main.tex',
        latexEngine: 'pdflatex',
        texImage: 'texlive-2024.1',
        brandVariationId: 69,
      })

      expect(parseOpenTemplateHref('/some/other/link')).toBeNull()
      expect(parseOpenTemplateHref(null)).toBeNull()
    })

    it('computeDetailHash produces deterministic digest sensitive to content changes', () => {
      const d1 = {
        title: 'Sample Title',
        author: 'Author A',
        official: true,
        lastUpdatedAt: new Date(1700000000000),
        licenseLabel: 'MIT',
        abstractHtml: '<p>Abstract</p>',
        tags: [{ name: 'cv', title: 'CV' }],
        cta: { publishedId: 1 },
        mainText: '\\documentclass{article}',
      }
      const hash1 = computeDetailHash(d1)
      expect(hash1).toMatch(/^[0-9a-f]{64}$/)
      expect(computeDetailHash(d1)).toBe(hash1)

      const d2 = { ...d1, title: 'Changed Title' }
      expect(computeDetailHash(d2)).not.toBe(hash1)
    })

    it('parseDetailPage extracts full metadata, tags, preview image, view source, and PDF links', () => {
      const html = `
        <div class="gallery-item-title">
          <h1>Modern Simple CV</h1>
          <div class="gallery-item-title-badge-container">
            <span class="badge-content">Official</span>
          </div>
        </div>
        <div class="template-detail"><b>Author:</b><div>Sarah Lang</div></div>
        <div class="template-detail"><b>License:</b><div>CC BY 4.0</div></div>
        <div class="template-detail"><span data-timestamp-for-title="1600000000">timestamp</span></div>
        <div class="template-detail tags">
          <b>Tags:</b>
          <div>
            <a href="/latex/templates/tagged/cv"><span class="badge-content" data-bs-title="Curriculum Vitae">CV</span></a>
          </div>
        </div>
        <div class="gallery-abstract"><p>Abstract with <script>alert(1)</script>safe text.</p></div>
        <div class="cta-links">
          <a class="cta-link" href="/project/new/template/11020?id=30526827&amp;templateName=Modern+CV">Open as Template</a>
          <a class="cta-link" href="/latex/templates/sample/abcdefghijkl.pdf">Download PDF</a>
        </div>
        <div class="gallery-large-pdf-preview">
          <img src="https://writelatex.s3.amazonaws.com/published_ver/11020.jpeg" />
        </div>
        <div id="modalViewSource"><pre><code>\\documentclass{article}\n\\begin{document}Hello\\end{document}</code></pre></div>
      `
      const detail = parseDetailPage(html)
      expect(detail).not.toBeNull()
      expect(detail.title).toBe('Modern Simple CV')
      expect(detail.official).toBe(true)
      expect(detail.author).toBe('Sarah Lang')
      expect(detail.licenseLabel).toBe('CC BY 4.0')
      expect(detail.lastUpdatedAt).toEqual(new Date(1600000000 * 1000))
      expect(detail.tags).toEqual([{ name: 'cv', title: 'Curriculum Vitae' }])
      expect(detail.cta.publishedId).toBe(11020)
      expect(detail.mainText).toContain('\\documentclass{article}')
      expect(detail.preview.publishedId).toBe(11020)
      expect(detail.pdfHref).toBe('/latex/templates/sample/abcdefghijkl.pdf')
      expect(detail.detailHash).toMatch(/^[0-9a-f]{64}$/)
      // XSS script stripped
      expect(detail.abstractHtml).not.toContain('<script>')
    })

    it('parseDetailPage returns null when title or CTA link is missing', () => {
      const noTitle = '<a href="/project/new/template/1">Open</a>'
      expect(parseDetailPage(noTitle)).toBeNull()

      const noCta = '<div class="gallery-item-title"><h1>Title Only</h1></div>'
      expect(parseDetailPage(noCta)).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // 3. TagParser tests
  // -------------------------------------------------------------------------
  describe('TagParser', () => {
    it('tagNameFromHref extracts and decodes tag slug from varied href formats', () => {
      expect(tagNameFromHref('/latex/templates/tagged/academic-journal')).toBe('academic-journal')
      expect(tagNameFromHref('/latex/examples/tagged/cv/page/3')).toBe('cv')
      expect(tagNameFromHref('/articles/tagged/resum%C3%A9')).toBe('resumé')
      expect(tagNameFromHref('/latex/templates/recent')).toBeNull()
      expect(tagNameFromHref(null)).toBeNull()
    })

    it('tagTitleFromHeading extracts suffix after em-dash separator', () => {
      expect(tagTitleFromHeading('LaTeX templates — CVs and résumés')).toBe('CVs and résumés')
      expect(tagTitleFromHeading('Gallery — Academic Journals')).toBe('Academic Journals')
      expect(tagTitleFromHeading('No Separator Heading')).toBeNull()
      expect(tagTitleFromHeading('')).toBeNull()
    })

    it('parseTagPage parses official tag metadata and detects fallback pages', () => {
      const knownHtml = `
        <h1 class="gallery-title">LaTeX templates — Academic Journals</h1>
        <div class="gallery-filters">
          <a class="active" href="/latex/templates/tagged/academic-journal">Active</a>
        </div>
        <p class="gallery-summary">Curated academic journal templates.</p>
        <ul id="related-tags">
          <li><a href="/latex/templates/tagged/peer-review"><span class="badge-content">Peer Review</span></a></li>
        </ul>
        <div class="gallery-thumbnail">
          <a href="/latex/templates/item-one/abcdefghijkl"><div class="caption-title">Paper 1</div></a>
        </div>
      `
      const parsedKnown = parseTagPage(knownHtml, 'academic-journal')
      expect(parsedKnown.known).toBe(true)
      expect(parsedKnown.title).toBe('Academic Journals')
      expect(parsedKnown.summary).toBe('Curated academic journal templates.')
      expect(parsedKnown.related).toEqual([{ name: 'peer-review', title: 'Peer Review' }])
      expect(parsedKnown.cards).toHaveLength(1)

      // Fallback page rendered when requested tag does not match active filter
      const fallbackHtml = `
        <h1 class="gallery-title">LaTeX templates — Academic Journals</h1>
        <div class="gallery-filters">
          <a class="active" href="/latex/templates/tagged/academic-journal">Active</a>
        </div>
      `
      const parsedUnknown = parseTagPage(fallbackHtml, 'non-existent-tag')
      expect(parsedUnknown.known).toBe(false)
      expect(parsedUnknown.title).toBeNull()
      expect(parsedUnknown.summary).toBe('')
      expect(parsedUnknown.related).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // 4. AbstractSanitizer tests
  // -------------------------------------------------------------------------
  describe('AbstractSanitizer', () => {
    it('resolveAbstractHref localizes overleaf gallery links and preserves external links', () => {
      const localItem = resolveAbstractHref('https://www.overleaf.com/latex/templates/sample-slug/abcdefghijkl')
      expect(localItem).toEqual({
        href: '/latex/templates/sample-slug/abcdefghijkl',
        external: false,
      })

      const localTag = resolveAbstractHref('https://www.overleaf.com/latex/templates/tagged/cv')
      expect(localTag).toEqual({
        href: '/latex/templates/tagged/cv',
        external: false,
      })

      const external = resolveAbstractHref('https://github.com/latex-ninja/template')
      expect(external).toEqual({
        href: 'https://github.com/latex-ninja/template',
        external: true,
      })

      const mailto = resolveAbstractHref('mailto:author@example.com')
      expect(mailto).toEqual({
        href: 'mailto:author@example.com',
        external: true,
      })

      // Dangerous schemes and credentials rejected
      expect(resolveAbstractHref('javascript:alert(1)')).toBeNull()
      expect(resolveAbstractHref('data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==')).toBeNull()
      expect(resolveAbstractHref('https://user:pass@example.com')).toBeNull()
      expect(resolveAbstractHref('')).toBeNull()
    })

    it('sanitizeAbstractHtml strips XSS vectors, scripts, styles, objects, and event handlers', () => {
      const malicious = `
        <p>Safe paragraph</p>
        <script>alert("xss")</script>
        <style>body { display: none; }</style>
        <iframe src="https://evil.com"></iframe>
        <object data="malware.swf"></object>
        <svg onload="alert(1)"></svg>
        <img src="x" onerror="alert(2)" />
        <a href="javascript:alert(3)" onclick="alert(4)">Click me</a>
      `
      const clean = sanitizeAbstractHtml(malicious)
      expect(clean).not.toContain('<script>')
      expect(clean).not.toContain('<style>')
      expect(clean).not.toContain('<iframe>')
      expect(clean).not.toContain('<object>')
      expect(clean).not.toContain('<svg>')
      expect(clean).not.toContain('onerror')
      expect(clean).not.toContain('onclick')
      expect(clean).not.toContain('javascript:')
      expect(clean).toContain('<p>Safe paragraph</p>')
      expect(clean).toContain('Click me') // text survives link rejection
    })

    it('sanitizeAbstractHtml localizes gallery links and adds rel="nofollow noopener" to external links', () => {
      const html = `
        <div>
          Check out the <a href="https://www.overleaf.com/latex/templates/cv/abcdefghijkl">CV Template</a>
          and the <a href="https://github.com/user/repo">GitHub source</a>.
        </div>
      `
      const clean = sanitizeAbstractHtml(html)
      expect(clean).toContain('<a href="/latex/templates/cv/abcdefghijkl">CV Template</a>')
      expect(clean).toContain('<a href="https://github.com/user/repo" rel="nofollow noopener">GitHub source</a>')
    })

    it('sanitizeAbstractHtml allows safe formatting tags and returns empty string for blank content', () => {
      const formatting = '<p>Text with <strong>bold</strong>, <em>italic</em>, <code>code</code>.</p>'
      expect(sanitizeAbstractHtml(formatting)).toBe(formatting)

      expect(sanitizeAbstractHtml('')).toBe('')
      expect(sanitizeAbstractHtml('   ')).toBe('')
      expect(sanitizeAbstractHtml('<p>   </p>')).toBe('')
      expect(sanitizeAbstractHtml('<script>evil()</script>')).toBe('')
    })
  })

  // -------------------------------------------------------------------------
  // 5. GuardedHttps redirect headers & error surfacing
  // -------------------------------------------------------------------------
  describe('GuardedHttps cross-host redirect cookie stripping & error surfacing', () => {
    it('redirectHeaders strips Cookie and Authorization across different origins', () => {
      const headers = {
        Cookie: 'session=123; user=abc',
        cookie: 'duplicate=xyz',
        Authorization: 'Bearer secret-token',
        'proxy-authorization': 'Basic credentials',
        'User-Agent': 'TestAgent',
        'X-Custom-Header': 'CustomValue',
      }

      // Cross-origin redirect
      const crossResult = redirectHeaders(
        headers,
        'https://www.overleaf.com/latex/templates',
        'https://writelatex.s3.amazonaws.com/image.jpg'
      )
      expect(crossResult).toEqual({
        'User-Agent': 'TestAgent',
        'X-Custom-Header': 'CustomValue',
      })
      expect(crossResult.Cookie).toBeUndefined()
      expect(crossResult.cookie).toBeUndefined()
      expect(crossResult.Authorization).toBeUndefined()
      expect(crossResult['proxy-authorization']).toBeUndefined()

      // Same-origin redirect preserves credentials
      const sameResult = redirectHeaders(
        headers,
        'https://www.overleaf.com/page1',
        'https://www.overleaf.com/page2'
      )
      expect(sameResult).toBe(headers)
      expect(sameResult.Cookie).toBe('session=123; user=abc')
    })

    it('parseRetryAfter parses seconds and HTTP-date strings into milliseconds', () => {
      expect(parseRetryAfter('120')).toBe(120_000)
      expect(parseRetryAfter('0')).toBe(0)
      expect(parseRetryAfter(null)).toBeNull()
      expect(parseRetryAfter('')).toBeNull()

      const futureDate = new Date(Date.now() + 60_000).toUTCString()
      const parsedMs = parseRetryAfter(futureDate)
      expect(parsedMs).toBeGreaterThan(50_000)
      expect(parsedMs).toBeLessThanOrEqual(60_000)
    })

    it('httpError surfaces 401, 403, and 429 with .status and .retryAfterMs', () => {
      const err401 = httpError(401, 'https://www.overleaf.com/api', {})
      expect(err401.status).toBe(401)
      expect(err401.statusCode).toBe(401)
      expect(err401.retryAfterMs).toBeNull()

      const err403 = httpError(403, 'https://www.overleaf.com/api', {})
      expect(err403.status).toBe(403)
      expect(err403.statusCode).toBe(403)
      expect(err403.retryAfterMs).toBeNull()

      const err429 = httpError(429, 'https://www.overleaf.com/api', { 'retry-after': '45' })
      expect(err429.status).toBe(429)
      expect(err429.statusCode).toBe(429)
      expect(err429.retryAfterMs).toBe(45_000)

      // Capitalized header variant
      const err429Cap = httpError(429, 'https://www.overleaf.com/api', { 'Retry-After': '90' })
      expect(err429Cap.retryAfterMs).toBe(90_000)
    })
  })

  // -------------------------------------------------------------------------
  // 6. MirrorService tests (scan, featured, tag, detail, pdf, single-flight)
  // -------------------------------------------------------------------------
  describe('MirrorService', () => {
    // 12-letter lowercase tokens [a-z]{12}
    function make12Token(prefixChar, index) {
      const letter = String.fromCharCode(97 + (index % 26))
      return prefixChar.repeat(8) + letter + 'xyz'
    }

    function makeCardHtml(token, title = `Item ${token}`) {
      return `
        <div class="gallery-thumbnail">
          <a href="/latex/templates/sample-${token}/${token}">
            <div class="caption"><div class="caption-title">${title}</div></div>
          </a>
        </div>
      `
    }

    it('scanGalleryRecent ordering: full scan assigns strictly descending recentOrder across pages', async () => {
      const p1Cards = Array.from({ length: 9 }, (_, i) => makeCardHtml(make12Token('a', i))).join('\n')
      const p2Cards = Array.from({ length: 9 }, (_, i) => makeCardHtml(make12Token('b', i))).join('\n')
      const featToken = make12Token('f', 0)

      const page1Html = `
        <div class="featured-docs">${makeCardHtml(featToken)}</div>
        <div class="gallery-grid">${p1Cards}</div>
        <ul class="pagination">
          <li class="active"><a href="#">1</a></li>
          <li><a href="/gallery/recent/page/2">2</a></li>
          <li><a href="/gallery/recent/page/2" aria-label="Go to last page">Last</a></li>
        </ul>
      `
      const page2Html = `
        <div class="gallery-grid">${p2Cards}</div>
        <ul class="pagination">
          <li><a href="/gallery/recent/page/1">1</a></li>
          <li class="active"><a href="#">2</a></li>
        </ul>
      `

      vi.spyOn(Fetch, 'fetchOverleafPage').mockImplementation(async path => {
        if (path.includes('page/2')) return { status: 200, html: page2Html, url: path }
        return { status: 200, html: page1Html, url: path }
      })

      const scanResult = await MirrorService.scanGalleryRecent({
        fromPage: 1,
        toPage: 2,
        mode: 'full',
      })

      expect(scanResult.pages).toBe(2)
      expect(scanResult.items).toBe(18)
      expect(scanResult.done).toBe(true)

      const firstPageItem = await mockItemsCol.findOne({ token: make12Token('a', 0) })
      const lastPage1Item = await mockItemsCol.findOne({ token: make12Token('a', 8) })
      const firstPage2Item = await mockItemsCol.findOne({ token: make12Token('b', 0) })
      const lastPage2Item = await mockItemsCol.findOne({ token: make12Token('b', 8) })

      expect(firstPageItem.recentOrder).toBeGreaterThan(lastPage1Item.recentOrder)
      expect(lastPage1Item.recentOrder).toBeGreaterThan(firstPage2Item.recentOrder)
      expect(firstPage2Item.recentOrder).toBeGreaterThan(lastPage2Item.recentOrder)

      // Featured items saved to listings collection
      const featuredListing = await mockListingsCol.findOne({ _id: 'featured:gallery' })
      expect(featuredListing.tokens).toContain(featToken)

      // Checkpoint recorded
      const checkpoint = await mockListingsCol.findOne({ _id: 'scan:gallery-recent' })
      expect(checkpoint.finishedAt).toBeTruthy()
    })

    it('scanGalleryRecent ordering: incremental scan places fresh items above existing order', async () => {
      const existingToken = make12Token('e', 0)
      const freshToken = make12Token('m', 0)

      // Seed existing item with recentOrder 500
      await mockItemsCol.updateOne(
        { token: existingToken },
        {
          $set: {
            token: existingToken,
            family: 'template',
            slug: 'existing',
            recentOrder: 500,
          },
        },
        { upsert: true }
      )

      const pageHtml = `
        <div class="gallery-grid">
          ${makeCardHtml(freshToken)}
          ${makeCardHtml(existingToken)}
        </div>
      `
      vi.spyOn(Fetch, 'fetchOverleafPage').mockResolvedValue({
        status: 200,
        html: pageHtml,
        url: '/gallery',
      })

      const res = await MirrorService.scanGalleryRecent({
        fromPage: 1,
        toPage: 1,
        mode: 'incremental',
      })
      expect(res.items).toBe(2)

      const freshDoc = await mockItemsCol.findOne({ token: freshToken })
      const existingDoc = await mockItemsCol.findOne({ token: existingToken })

      // Existing item preserves its order
      expect(existingDoc.recentOrder).toBe(500)
      // Fresh item gets placed above the existing max
      expect(freshDoc.recentOrder).toBeGreaterThan(500)
    })

    it('scanFeatured scrapes /latex/templates and /gallery and stores featured token sets', async () => {
      const t1 = make12Token('t', 1)
      const t2 = make12Token('t', 2)
      const g1 = make12Token('g', 1)

      const templatesHtml = `
        <div class="featured-docs">
          ${makeCardHtml(t1)}
          ${makeCardHtml(t2)}
        </div>
      `
      const galleryHtml = `
        <div class="featured-docs">
          ${makeCardHtml(g1)}
        </div>
      `
      vi.spyOn(Fetch, 'fetchOverleafPage').mockImplementation(async path => {
        if (path === '/latex/templates') return { status: 200, html: templatesHtml, url: path }
        return { status: 200, html: galleryHtml, url: path }
      })

      const counts = await MirrorService.scanFeatured()
      expect(counts).toEqual({ templates: 2, gallery: 1 })

      const tList = await mockListingsCol.findOne({ _id: 'featured:templates' })
      expect(tList.tokens).toEqual([t1, t2])

      const gList = await mockListingsCol.findOne({ _id: 'featured:gallery' })
      expect(gList.tokens).toEqual([g1])
    })

    it('ensureTag scrapes official tag page, caches result, and forces refresh when requested', async () => {
      const tagHtml = `
        <h1 class="gallery-title">LaTeX templates — Curricula Vitae</h1>
        <div class="gallery-filters"><a class="active" href="/latex/templates/tagged/cv">Active</a></div>
        <p class="gallery-summary">A curated list of CV templates.</p>
        <ul id="related-tags">
          <li><a href="/latex/templates/tagged/resumes"><span class="badge-content">Resumes</span></a></li>
        </ul>
      `
      const fetchSpy = vi.spyOn(Fetch, 'fetchOverleafPage').mockResolvedValue({
        status: 200,
        html: tagHtml,
        url: '/latex/templates/tagged/cv',
      })

      const doc1 = await MirrorService.ensureTag('templates', 'cv')
      expect(doc1._id).toBe('cv')
      expect(doc1.canonicalTitle).toBe('Curricula Vitae')
      expect(doc1.byScope.templates.summary).toBe('A curated list of CV templates.')
      expect(doc1.byScope.templates.related).toEqual([{ name: 'resumes', title: 'Resumes' }])
      expect(fetchSpy).toHaveBeenCalledTimes(1)

      // Second call without force should hit cache and not invoke fetch
      const doc2 = await MirrorService.ensureTag('templates', 'cv')
      expect(doc2.canonicalTitle).toBe('Curricula Vitae')
      expect(fetchSpy).toHaveBeenCalledTimes(1)

      // Third call with force: true re-scrapes
      await MirrorService.ensureTag('templates', 'cv', { force: true })
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    })

    it('ensureDetail fetches detail metadata, updates mongo, handles 404 removed items', async () => {
      const detailToken = make12Token('d', 0)
      const goneToken = make12Token('g', 0)

      const detailHtml = `
        <div class="gallery-item-title"><h1>Test Detail</h1></div>
        <div class="template-detail"><b>Author:</b><div>Jane Author</div></div>
        <div class="template-detail"><b>License:</b><div>MIT</div></div>
        <div class="cta-links">
          <a class="cta-link" href="/project/new/template/999?id=12345&amp;mainFile=main.tex">Open</a>
        </div>
        <div class="gallery-abstract"><p>Detailed abstract</p></div>
        <div id="modalViewSource"><pre><code>\\documentclass{article}</code></pre></div>
      `
      // Seed item
      await mockItemsCol.updateOne(
        { token: detailToken },
        {
          $set: {
            token: detailToken,
            family: 'template',
            slug: 'test-detail',
            title: 'Initial Title',
          },
        },
        { upsert: true }
      )

      const fetchSpy = vi.spyOn(Fetch, 'fetchOverleafPage').mockResolvedValue({
        status: 200,
        html: detailHtml,
        url: `/latex/templates/test-detail/${detailToken}`,
      })

      const detailed = await MirrorService.ensureDetail(detailToken)
      expect(detailed.author).toBe('Jane Author')
      expect(detailed.licenseLabel).toBe('MIT')
      expect(detailed.mainText).toBe('\\documentclass{article}')
      expect(detailed.mirror.detailAt).toBeTruthy()
      expect(fetchSpy).toHaveBeenCalledTimes(1)

      // Next call returns cached item
      await MirrorService.ensureDetail(detailToken)
      expect(fetchSpy).toHaveBeenCalledTimes(1)

      // 404 response upstream marks item removed
      await mockItemsCol.updateOne(
        { token: goneToken },
        {
          $set: {
            token: goneToken,
            family: 'template',
            slug: 'gone-item',
          },
        },
        { upsert: true }
      )
      fetchSpy.mockResolvedValueOnce({ status: 404 })

      const goneResult = await MirrorService.ensureDetail(goneToken)
      expect(goneResult).toBeNull()
      const goneDoc = await mockItemsCol.findOne({ token: goneToken })
      expect(goneDoc.mirror.removedAt).toBeTruthy()
    })

    it('ensurePdf fetches and records PDF metadata, reuses existing blob when present', async () => {
      const pdfToken = make12Token('p', 0)

      // Seed item
      await mockItemsCol.updateOne(
        { token: pdfToken },
        {
          $set: {
            token: pdfToken,
            family: 'template',
            slug: 'pdf-sample',
          },
        },
        { upsert: true }
      )

      const testSha = 'a'.repeat(64)
      const pdfSpy = vi.spyOn(Fetch, 'storeOverleafPdf').mockResolvedValue({
        status: 200,
        sha256: testSha,
        sizeBytes: 12345,
      })

      const res = await MirrorService.ensurePdf(pdfToken)
      expect(res).toEqual({ sha: testSha, bytes: 12345 })
      expect(pdfSpy).toHaveBeenCalledTimes(1)

      const updated = await mockItemsCol.findOne({ token: pdfToken })
      expect(updated.media.pdfSha).toBe(testSha)
      expect(updated.media.pdfBytes).toBe(12345)

      // Mock BlobStore.exists returning true so second call reuses blob without fetching
      vi.spyOn(BlobStore, 'exists').mockResolvedValue(true)
      const cachedRes = await MirrorService.ensurePdf(pdfToken)
      expect(cachedRes).toEqual({ sha: testSha, bytes: 12345 })
      expect(pdfSpy).toHaveBeenCalledTimes(1)
    })

    it('single-flight: concurrent requests for the same token or tag coalesce to one fetch', async () => {
      const flightToken = make12Token('l', 0)

      // Seed item
      await mockItemsCol.updateOne(
        { token: flightToken },
        {
          $set: {
            token: flightToken,
            family: 'template',
            slug: 'flight-test',
          },
        },
        { upsert: true }
      )

      const detailHtml = `
        <div class="gallery-item-title"><h1>Flight Title</h1></div>
        <div class="cta-links"><a class="cta-link" href="/project/new/template/1">Open</a></div>
      `
      let resolveFetch
      const pendingPromise = new Promise(resolve => {
        resolveFetch = resolve
      })

      const fetchSpy = vi.spyOn(Fetch, 'fetchOverleafPage').mockImplementation(async () => {
        await pendingPromise
        return { status: 200, html: detailHtml, url: '/test' }
      })

      // Launch 3 concurrent ensureDetail calls
      const p1 = MirrorService.ensureDetail(flightToken)
      const p2 = MirrorService.ensureDetail(flightToken)
      const p3 = MirrorService.ensureDetail(flightToken)

      // Resolve the single pending fetch
      resolveFetch()

      const [r1, r2, r3] = await Promise.all([p1, p2, p3])
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expect(r1.title).toBe('Flight Title')
      expect(r2.title).toBe('Flight Title')
      expect(r3.title).toBe('Flight Title')
    })

    it('refreshPdf on non-200 / 404 does NOT mark template as removed and records PDF metadata', async () => {
      const pdf404Token = make12Token('m', 1)
      await mockItemsCol.updateOne(
        { token: pdf404Token },
        {
          $set: {
            token: pdf404Token,
            family: 'template',
            slug: 'pdf-404-sample',
            state: 'published',
          },
        },
        { upsert: true }
      )

      vi.spyOn(Fetch, 'storeOverleafPdf').mockResolvedValue({ status: 404 })

      const res = await MirrorService.ensurePdf(pdf404Token)
      expect(res).toBeNull()

      const doc = await mockItemsCol.findOne({ token: pdf404Token })
      expect(doc.state).toBe('published')
      expect(doc.mirror?.removedAt).toBeFalsy()
      expect(doc.mirror?.pdfAt).toBeTruthy()
      expect(doc.mirror?.pdfLastError).toContain('HTTP 404')
      expect(doc.mirror?.pdfNextAttemptAt).toBeNull()
    })

    it('scanGalleryRecent throws on HTTP non-200 rather than falsely marking scan done', async () => {
      vi.spyOn(Fetch, 'fetchOverleafPage').mockResolvedValue({ status: 500 })

      const scanResult = await MirrorService.scanGalleryRecent({
        fromPage: 1,
        toPage: 5,
        mode: 'full',
      })
      expect(scanResult.done).toBe(false)
      expect(scanResult.error).toBeTruthy()

      const checkpoint = await mockListingsCol.findOne({ _id: 'scan:gallery-recent' })
      expect(checkpoint?.finishedAt).toBeFalsy()
    })

    it('refreshPdf preserves adminOverrides on media.pdfSha', async () => {
      const overrideToken = make12Token('o', 1)
      const adminSha = 'e'.repeat(64)
      await mockItemsCol.updateOne(
        { token: overrideToken },
        {
          $set: {
            token: overrideToken,
            family: 'template',
            slug: 'pdf-override-sample',
            media: {
              pdfSha: adminSha,
              pdfBytes: 8888,
            },
            adminOverrides: {
              'media.pdfSha': true,
            },
          },
        },
        { upsert: true }
      )

      const upstreamSha = 'f'.repeat(64)
      vi.spyOn(Fetch, 'storeOverleafPdf').mockResolvedValue({
        status: 200,
        sha256: upstreamSha,
        sizeBytes: 1234,
      })

      const res = await MirrorService.ensurePdf(overrideToken, { force: true })
      expect(res.sha).toBe(adminSha)
      expect(res.bytes).toBe(8888)

      const doc = await mockItemsCol.findOne({ token: overrideToken })
      expect(doc.media.pdfSha).toBe(adminSha)
      expect(doc.media.pdfBytes).toBe(8888)
      expect(doc.mirror?.pdfAt).toBeTruthy()
    })
  })

  // -------------------------------------------------------------------------
  // 7. TemplateHydrationService & HydrationJob tests
  // -------------------------------------------------------------------------
  describe('TemplateHydrationService & HydrationJob', () => {
    it('parseDetailPageHtml converts canonical detail to legacy shape', () => {
      const html = `
        <div class="gallery-item-title"><h1>Legacy View</h1></div>
        <div class="template-detail"><b>Author:</b><div>Old Author</div></div>
        <div class="template-detail"><b>License:</b><div>GPL</div></div>
        <div class="cta-links">
          <a class="cta-link" href="/project/new/template/42?id=99&amp;mainFile=main.tex">Open</a>
          <a class="cta-link" href="/latex/templates/legacy/abcdefghijkl.pdf">PDF</a>
        </div>
        <div class="gallery-abstract"><p>Visit https://github.com/sample/repo</p></div>
        <div id="modalViewSource"><pre><code>\\documentclass{article}</code></pre></div>
      `
      const legacy = parseDetailPageHtml(html)
      expect(legacy.title).toBe('Legacy View')
      expect(legacy.author).toBe('Old Author')
      expect(legacy.licenseLabel).toBe('GPL')
      expect(legacy.openParams.templateVersionId).toBe('42')
      expect(legacy.openParams.templateId).toBe('99')
      expect(legacy.latexSourcePreview).toBe('\\documentclass{article}')
      expect(legacy.gitRepoUrl).toBe('https://github.com/sample/repo')
    })

    it('hydrateItem refreshes detail and PDF via MirrorService', async () => {
      const hydrateToken = 'hhhhhhhhaxyz'
      await mockItemsCol.updateOne(
        { token: hydrateToken },
        {
          $set: {
            _id: 'sample-id-123',
            token: hydrateToken,
            family: 'template',
            slug: 'hydrate-test',
          },
        },
        { upsert: true }
      )

      vi.spyOn(MirrorService, 'ensureDetail').mockResolvedValue({
        token: hydrateToken,
        mirror: { detailAt: new Date() },
      })
      vi.spyOn(MirrorService, 'ensurePdf').mockResolvedValue({
        sha: 'b'.repeat(64),
        bytes: 5000,
      })

      const hydrated = await hydrateItem(hydrateToken, { cachePdfPreviews: true })
      expect(hydrated.token).toBe(hydrateToken)
      expect(MirrorService.ensureDetail).toHaveBeenCalledWith(
        hydrateToken,
        expect.objectContaining({ priority: 'interactive', throwOnError: true })
      )
      expect(MirrorService.ensurePdf).toHaveBeenCalledWith(
        hydrateToken,
        expect.objectContaining({ priority: 'interactive', throwOnError: false })
      )
    })

    it('HydrationJob runs targeted item refresh and batch trickling', async () => {
      const jobToken = 'jjjjjjjjaxyz'

      // 1. Targeted item run
      vi.spyOn(MirrorService, 'ensureDetail').mockResolvedValue({
        token: jobToken,
        mirror: { detailAt: new Date() },
      })
      vi.spyOn(MirrorService, 'ensurePdf').mockResolvedValue({ sha: 'c'.repeat(64), bytes: 100 })

      const itemJobResult = await HydrationJob.run({
        payload: { token: jobToken, pdf: true },
      })
      expect(itemJobResult).toEqual({
        ok: true,
        token: jobToken,
        detail: true,
        removed: false,
        pdf: true,
      })

      // 2. Batch trickle run
      vi.spyOn(MirrorService, 'runDetailBatch').mockResolvedValue({ processed: 5, failed: 0 })
      vi.spyOn(MirrorService, 'runPdfBatch').mockResolvedValue({ processed: 2, failed: 0 })

      const batchResult = await HydrationJob.run({
        payload: { detailLimit: 5, pdfLimit: 2 },
      })
      expect(batchResult).toEqual({
        ok: true,
        detail: { processed: 5, failed: 0 },
        pdf: { processed: 2, failed: 0 },
      })
    })
  })
})

function cheerioLoad(html) {
  const cheerio = require('cheerio')
  return cheerio.load(html)
}
