import { Readable } from 'node:stream'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Settings from '@overleaf/settings'
import SessionManager from '../../../../../app/src/Features/Authentication/SessionManager.mjs'
import AuthenticationController from '../../../../../app/src/Features/Authentication/AuthenticationController.mjs'
import AuthorizationManager from '../../../../../app/src/Features/Authorization/AuthorizationManager.mjs'
import { setCollectionOverrideForTests } from '../../../app/src/persistence/Collections.mjs'
import * as MirrorService from '../../../app/src/services/mirror/MirrorService.mjs'
import BlobStore from '../../../app/src/storage/BlobStore.mjs'
import {
  PAGINATION_WINDOW,
  buildPagination,
  totalPagesFor,
} from '../../../app/src/util/Pagination.mjs'
import {
  PAGE_SIZE,
  FAMILIES,
  SCOPES,
  isValidToken,
  scopeForFamily,
  familyForScope,
  scopeBase,
  itemHref,
  itemPdfHref,
  itemOpenHref,
  thumbHref,
  previewHref,
  recentHref,
  taggedHref,
  localizeGalleryUrl,
  parseItemUrl,
} from '../../../app/src/util/GalleryUrls.mjs'
import {
  CATEGORIES,
  LISTING_DESCRIPTION_KEY,
  isScope,
  scopeCopy,
  categoryTiles,
  filterLinks,
} from '../../../app/src/util/GalleryCopy.mjs'
import GalleryReadService from '../../../app/src/services/GalleryReadService.mjs'
import GalleryController from '../../../app/src/controllers/GalleryController.mjs'
import TemplateGalleryRouter from '../../../app/src/TemplateGalleryRouter.mjs'

function makeCursor(docs) {
  const cursor = {
    _sort: null,
    _skip: 0,
    _limit: null,
    sort: vi.fn(s => {
      cursor._sort = s
      return cursor
    }),
    skip: vi.fn(n => {
      cursor._skip = n
      return cursor
    }),
    limit: vi.fn(n => {
      cursor._limit = n
      return cursor
    }),
    toArray: vi.fn(async () => docs),
  }
  return cursor
}

function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    headersSent: false,
    viewName: null,
    locals: null,
    redirectStatus: null,
    redirectUrl: null,
    body: null,
    ended: false,
    status(code) {
      res.statusCode = code
      return res
    },
    sendStatus(code) {
      res.statusCode = code
      res.ended = true
      return res
    },
    setHeader(name, value) {
      res.headers[name] = value
    },
    render(viewName, locals) {
      res.viewName = viewName
      res.locals = locals
      res.headersSent = true
      return res
    },
    redirect(status, url) {
      res.redirectStatus = status
      res.redirectUrl = url
      res.headersSent = true
      return res
    },
    send(payload) {
      res.body = payload
      res.headersSent = true
      res.ended = true
      return res
    },
    end() {
      res.ended = true
      return res
    },
  }
  return res
}

describe('A1 Pagination', function () {
  const basePath = '/latex/templates/tagged/cv'

  it('builds window for N=36 at c=1, 2, 10, 36 matching official gallery', function () {
    expect(PAGINATION_WINDOW).toBe(4)

    const p1 = buildPagination({ current: 1, total: 36, basePath })
    expect(p1).toEqual({
      current: 1,
      total: 36,
      first: null,
      prev: null,
      leadingEllipsis: false,
      pages: [
        { number: 1, href: '/latex/templates/tagged/cv/page/1', current: true },
        {
          number: 2,
          href: '/latex/templates/tagged/cv/page/2',
          current: false,
        },
        {
          number: 3,
          href: '/latex/templates/tagged/cv/page/3',
          current: false,
        },
        {
          number: 4,
          href: '/latex/templates/tagged/cv/page/4',
          current: false,
        },
        {
          number: 5,
          href: '/latex/templates/tagged/cv/page/5',
          current: false,
        },
      ],
      trailingEllipsis: true,
      next: '/latex/templates/tagged/cv/page/2',
      last: '/latex/templates/tagged/cv/page/36',
    })

    const p2 = buildPagination({ current: 2, total: 36, basePath })
    expect(p2.first).toBe('/latex/templates/tagged/cv')
    expect(p2.prev).toBe('/latex/templates/tagged/cv/page/1')
    expect(p2.leadingEllipsis).toBe(false)
    expect(p2.pages.map(p => p.number)).toEqual([1, 2, 3, 4, 5, 6])
    expect(p2.pages.find(p => p.current)?.number).toBe(2)
    expect(p2.trailingEllipsis).toBe(true)
    expect(p2.next).toBe('/latex/templates/tagged/cv/page/3')
    expect(p2.last).toBe('/latex/templates/tagged/cv/page/36')

    const p10 = buildPagination({ current: 10, total: 36, basePath })
    expect(p10.first).toBe('/latex/templates/tagged/cv')
    expect(p10.prev).toBe('/latex/templates/tagged/cv/page/9')
    expect(p10.leadingEllipsis).toBe(true)
    expect(p10.pages.map(p => p.number)).toEqual([
      6, 7, 8, 9, 10, 11, 12, 13, 14,
    ])
    expect(p10.pages.find(p => p.current)?.number).toBe(10)
    expect(p10.trailingEllipsis).toBe(true)
    expect(p10.next).toBe('/latex/templates/tagged/cv/page/11')
    expect(p10.last).toBe('/latex/templates/tagged/cv/page/36')

    const p36 = buildPagination({ current: 36, total: 36, basePath })
    expect(p36.first).toBe('/latex/templates/tagged/cv')
    expect(p36.prev).toBe('/latex/templates/tagged/cv/page/35')
    expect(p36.leadingEllipsis).toBe(true)
    expect(p36.pages.map(p => p.number)).toEqual([32, 33, 34, 35, 36])
    expect(p36.pages.find(p => p.current)?.number).toBe(36)
    expect(p36.trailingEllipsis).toBe(false)
    expect(p36.next).toBeNull()
    expect(p36.last).toBeNull()
  })

  it('returns null when N <= 1 or current page is out of range', function () {
    expect(buildPagination({ current: 1, total: 1, basePath })).toBeNull()
    expect(buildPagination({ current: 1, total: 0, basePath })).toBeNull()
    expect(buildPagination({ current: 0, total: 10, basePath })).toBeNull()
    expect(buildPagination({ current: 11, total: 10, basePath })).toBeNull()
  })

  it('computes totalPagesFor with ceiling division', function () {
    expect(totalPagesFor(0, 9)).toBe(0)
    expect(totalPagesFor(1, 9)).toBe(1)
    expect(totalPagesFor(9, 9)).toBe(1)
    expect(totalPagesFor(322, 9)).toBe(36)
  })
})

describe('A1 GalleryUrls & GalleryCopy', function () {
  it('validates 12-letter lowercase tokens and builds family/scope URLs', function () {
    expect(PAGE_SIZE).toBe(9)
    expect(FAMILIES).toEqual(['template', 'example', 'article'])
    expect(SCOPES).toEqual(['templates', 'examples', 'articles', 'gallery'])

    expect(isValidToken('fqrcrzrkynpp')).toBe(true)
    expect(isValidToken('FQRCRZRKYNPP')).toBe(false)
    expect(isValidToken('short')).toBe(false)
    expect(isValidToken('fqrcrzrkynp1')).toBe(false)

    expect(scopeForFamily('template')).toBe('templates')
    expect(scopeForFamily('example')).toBe('examples')
    expect(scopeForFamily('article')).toBe('articles')
    expect(familyForScope('templates')).toBe('template')
    expect(familyForScope('gallery')).toBeNull()

    const item = {
      family: 'template',
      slug: 'kit-de-automa-c~ao-{1}',
      token: 'fqrcrzrkynpp',
    }
    expect(itemHref(item)).toBe(
      '/latex/templates/kit-de-automa-c~ao-%7B1%7D/fqrcrzrkynpp'
    )
    expect(itemPdfHref(item)).toBe(
      '/latex/templates/kit-de-automa-c~ao-%7B1%7D/fqrcrzrkynpp.pdf'
    )
    expect(itemOpenHref(item)).toBe(
      '/latex/templates/kit-de-automa-c~ao-%7B1%7D/fqrcrzrkynpp/open'
    )
    expect(thumbHref(item)).toBe('/gallery/_media/fqrcrzrkynpp/thumb.jpg')
    expect(previewHref(item)).toBe('/gallery/_media/fqrcrzrkynpp/preview.jpg')

    expect(recentHref('templates', 1)).toBe('/latex/templates')
    expect(recentHref('templates', 2)).toBe('/latex/templates/recent/page/2')
    expect(taggedHref('gallery', 'cv', 1)).toBe('/gallery/tagged/cv')
    expect(taggedHref('gallery', 'cv', 3)).toBe('/gallery/tagged/cv/page/3')
  })

  it('localizes overleaf.com gallery URLs and parses item URLs', function () {
    expect(
      localizeGalleryUrl(
        'https://www.overleaf.com/latex/templates/lecture-notes/fqrcrzrkynpp?foo=1#bar'
      )
    ).toBe('/latex/templates/lecture-notes/fqrcrzrkynpp?foo=1#bar')
    expect(localizeGalleryUrl('https://www.overleaf.com/about')).toBeNull()
    expect(
      localizeGalleryUrl('https://example.com/latex/templates/a/fqrcrzrkynpp')
    ).toBeNull()

    expect(
      parseItemUrl(
        'https://www.overleaf.com/articles/my-%7Bslug%7D/abcdefghijkl'
      )
    ).toEqual({
      family: 'article',
      slug: 'my-{slug}',
      token: 'abcdefghijkl',
    })
    expect(parseItemUrl('/latex/templates/tagged/cv')).toBeNull()
  })

  it('provides 11 category tiles, scope copy and filter strip links', function () {
    expect(CATEGORIES).toHaveLength(11)
    expect(CATEGORIES.map(c => c.slug)).toEqual([
      'academic-journal',
      'bibliography',
      'book',
      'calendar',
      'cv',
      'formal-letter',
      'homework',
      'newsletter',
      'poster',
      'presentation',
      'thesis',
    ])
    expect(LISTING_DESCRIPTION_KEY).toBe('hundreds_templates_info')
    expect(isScope('templates')).toBe(true)
    expect(isScope('unknown')).toBe(false)

    expect(scopeCopy('templates').hasFeatured).toBe(true)
    expect(scopeCopy('gallery').hasFeatured).toBe(true)
    expect(scopeCopy('examples').hasFeatured).toBe(false)
    expect(scopeCopy('articles').hasFeatured).toBe(false)

    const tiles = categoryTiles('examples')
    expect(tiles[0].href).toBe('/latex/examples/tagged/academic-journal')

    const rootFilters = filterLinks('templates')
    expect(rootFilters).toEqual([
      { scope: 'gallery', labelKey: 'all', href: '/gallery', active: false },
      {
        scope: 'templates',
        labelKey: 'templates',
        href: '/latex/templates',
        active: true,
      },
      {
        scope: 'examples',
        labelKey: 'examples',
        href: '/latex/examples',
        active: false,
      },
      {
        scope: 'articles',
        labelKey: 'community_articles',
        href: '/articles',
        active: false,
      },
    ])

    const tagFilters = filterLinks('articles', 'cv')
    expect(tagFilters.map(f => f.href)).toEqual([
      '/gallery/tagged/cv',
      '/latex/templates/tagged/cv',
      '/latex/examples/tagged/cv',
      '/articles/tagged/cv',
    ])
    expect(tagFilters.find(f => f.active)?.scope).toBe('articles')
  })
})

describe('A1 GalleryReadService', function () {
  beforeEach(function () {
    GalleryReadService.clearComputedTagCacheForTests()
  })

  afterEach(function () {
    setCollectionOverrideForTests(null)
    vi.restoreAllMocks()
  })

  it('normalizes tag names and rejects slashes or empty values', function () {
    expect(GalleryReadService.normalizeTagName('  cv ')).toBe('cv')
    expect(GalleryReadService.normalizeTagName('')).toBeNull()
    expect(GalleryReadService.normalizeTagName('a/b')).toBeNull()
    expect(GalleryReadService.normalizeTagName('x'.repeat(101))).toBeNull()
  })

  it('lists a page sorted by recentOrder and skips find when out of range', async function () {
    const sample = [{ token: 'aaaaaaaaaaaa', family: 'template', slug: 's' }]
    const cursor = makeCursor(sample)
    const mockItems = {
      countDocuments: vi.fn(async () => 20),
      find: vi.fn(() => cursor),
    }
    setCollectionOverrideForTests({ templateGalleryItems: mockItems })

    const page2 = await GalleryReadService.listPage({
      scope: 'templates',
      tagName: 'cv',
      page: 2,
    })
    expect(mockItems.countDocuments).toHaveBeenCalledWith({
      state: 'published',
      'mirror.removedAt': null,
      family: 'template',
      'tags.name': 'cv',
    })
    expect(cursor._sort).toEqual({ recentOrder: -1, objectIDNum: -1 })
    expect(cursor._skip).toBe(9)
    expect(cursor._limit).toBe(9)
    expect(page2).toEqual({
      items: sample,
      total: 20,
      totalPages: 3,
      page: 2,
    })

    mockItems.find.mockClear()
    const outOfRange = await GalleryReadService.listPage({
      scope: 'templates',
      tagName: 'cv',
      page: 99,
    })
    expect(mockItems.find).not.toHaveBeenCalled()
    expect(outOfRange).toEqual({
      items: [],
      total: 20,
      totalPages: 3,
      page: 99,
    })
  })

  it('lists featured items from scraped slot order with fallback to featured flag', async function () {
    const t1 = { token: 'aaaaaaaaaaaa', title: 'First' }
    const t2 = { token: 'bbbbbbbbbbbb', title: 'Second' }
    const mockListings = {
      findOne: vi.fn(async () => ({
        _id: 'featured:templates',
        tokens: ['bbbbbbbbbbbb', 'aaaaaaaaaaaa'],
      })),
    }
    const mockItems = {
      find: vi.fn(() => makeCursor([t1, t2])),
    }
    setCollectionOverrideForTests({
      templateGalleryListings: mockListings,
      templateGalleryItems: mockItems,
    })

    const featured = await GalleryReadService.listFeatured('templates')
    expect(featured.map(i => i.token)).toEqual(['bbbbbbbbbbbb', 'aaaaaaaaaaaa'])
    expect(await GalleryReadService.listFeatured('examples')).toEqual([])
  })

  it('builds tag view from scraped metadata or falls back to computed co-occurring tags', async function () {
    const topPickDoc = {
      token: 'cccccccccccc',
      family: 'template',
      slug: 'cv-1',
      title: 'CV 1',
    }
    const mockTags = {
      findOne: vi.fn(async () => ({
        _id: 'cv',
        canonicalTitle: 'CVs and résumés',
        byScope: {
          templates: {
            h1Title: 'LaTeX templates — CVs and résumés',
            summary: 'Curated CV summary.',
            related: [
              { name: 'formal-letter', title: 'Formal letters' },
              { name: 'cv', title: 'Self should be filtered' },
            ],
            topPicks: ['cccccccccccc'],
          },
        },
      })),
    }
    const mockItems = {
      find: vi.fn(() => makeCursor([topPickDoc])),
      aggregate: vi.fn(() =>
        makeCursor([
          { _id: { name: 'cv', title: 'CVs and résumés' }, count: 10 },
          { _id: { name: 'bibliography', title: 'Bibliographies' }, count: 4 },
        ])
      ),
    }
    setCollectionOverrideForTests({
      templateGalleryTags: mockTags,
      templateGalleryItems: mockItems,
    })

    const p1 = await GalleryReadService.getTagView({
      scope: 'templates',
      tagName: 'cv',
      page: 1,
      count: 10,
    })
    expect(p1).toEqual({
      name: 'cv',
      known: true,
      title: 'CVs and résumés',
      summary: 'Curated CV summary.',
      related: [{ name: 'formal-letter', title: 'Formal letters' }],
      topPicks: [topPickDoc],
    })

    // Page 2 omits topPicks
    const p2 = await GalleryReadService.getTagView({
      scope: 'templates',
      tagName: 'cv',
      page: 2,
      count: 10,
    })
    expect(p2.topPicks).toEqual([])

    // Unscraped scope triggers ensureTag and falls back to computeTagFallback
    const ensureTagSpy = vi
      .spyOn(MirrorService, 'ensureTag')
      .mockResolvedValue(null)
    const fallbackView = await GalleryReadService.getTagView({
      scope: 'examples',
      tagName: 'cv',
      page: 1,
      count: 5,
    })
    expect(ensureTagSpy).toHaveBeenCalledWith('examples', 'cv', {
      priority: 'interactive',
    })
    expect(fallbackView.title).toBe('CVs and résumés')
    expect(fallbackView.related).toEqual([
      { name: 'bibliography', title: 'Bibliographies' },
    ])

    // Unknown tag with 0 items does not call MirrorService.ensureTag
    ensureTagSpy.mockClear()
    mockTags.findOne.mockResolvedValueOnce(null)
    const unknownView = await GalleryReadService.getTagView({
      scope: 'templates',
      tagName: 'nonexistent-tag',
      page: 1,
      count: 0,
    })
    expect(ensureTagSpy).not.toHaveBeenCalled()
    expect(unknownView.known).toBe(false)
    expect(unknownView.title).toBe('nonexistent-tag')
  })

  it('fetches detail on demand when mirror.detailAt is missing', async function () {
    const unhydrated = {
      token: 'fqrcrzrkynpp',
      objectID: '12345',
      state: 'published',
      mirror: {},
    }
    const hydrated = {
      ...unhydrated,
      abstractHtml: '<p>Hydrated</p>',
      mirror: { detailAt: new Date() },
    }
    const mockItems = {
      findOne: vi
        .fn()
        .mockResolvedValueOnce(unhydrated)
        .mockResolvedValueOnce(hydrated),
    }
    setCollectionOverrideForTests({ templateGalleryItems: mockItems })
    const spy = vi
      .spyOn(MirrorService, 'ensureDetail')
      .mockResolvedValue(hydrated)

    const result = await GalleryReadService.getItemByToken('fqrcrzrkynpp')
    expect(spy).toHaveBeenCalledWith('fqrcrzrkynpp', {
      priority: 'interactive',
    })
    expect(result.abstractHtml).toBe('<p>Hydrated</p>')
  })
})

describe('A1 TemplateGalleryRouter & GalleryController', function () {
  beforeEach(function () {
    Settings.siteUrl = 'https://overleaf.example.com'
    vi.spyOn(SessionManager, 'getLoggedInUserId').mockReturnValue(null)
  })

  afterEach(function () {
    setCollectionOverrideForTests(null)
    vi.restoreAllMocks()
  })

  it('registers all public gallery routes and never touches /project/new/template', function () {
    const routes = []
    const webRouter = {
      get: (path, ...handlers) =>
        routes.push({ method: 'GET', path, handlers }),
      post: (path, ...handlers) =>
        routes.push({ method: 'POST', path, handlers }),
      patch: (path, ...handlers) =>
        routes.push({ method: 'PATCH', path, handlers }),
      delete: (path, ...handlers) =>
        routes.push({ method: 'DELETE', path, handlers }),
      use: vi.fn(),
    }
    TemplateGalleryRouter.apply(webRouter)

    const getPaths = routes.filter(r => r.method === 'GET').map(r => r.path)
    for (const base of [
      '/latex/templates',
      '/latex/examples',
      '/articles',
      '/gallery',
    ]) {
      expect(getPaths).toContain(base)
      expect(getPaths).toContain(`${base}/recent`)
      expect(getPaths).toContain(`${base}/recent/page/:page`)
      expect(getPaths).toContain(`${base}/tagged/:name`)
      expect(getPaths).toContain(`${base}/tagged/:name/page/:page`)
    }
    expect(getPaths).toContain('/gallery/_media/:token/thumb.jpg')
    expect(getPaths).toContain('/gallery/_media/:token/preview.jpg')
    expect(getPaths).toContain('/gallery/api/search')
    expect(getPaths).toContain('/latex/templates/:slug/:token([a-z]{12})')
    expect(getPaths).toContain('/latex/templates/:slug/:token([a-z]{12}).pdf')
    expect(getPaths).toContain('/latex/templates/:slug/:token([a-z]{12})/open')
    expect(getPaths).toContain('/templates')
    expect(getPaths).toContain('/templates/t/:slug')

    const postPaths = routes.filter(r => r.method === 'POST').map(r => r.path)
    expect(postPaths).toContain('/templates/t/:slug/open')

    const touchedCore = routes.some(r =>
      r.path.startsWith('/project/new/template')
    )
    expect(touchedCore).toBe(false)
  })

  it('registers global login whitelist excluding /open routes with and without trailing slash', function () {
    let capturedRegex = null
    const origAdd = AuthenticationController.addEndpointToLoginWhitelist
    AuthenticationController.addEndpointToLoginWhitelist = vi.fn(re => {
      capturedRegex = re
    })
    try {
      TemplateGalleryRouter.apply({
        get: vi.fn(),
        post: vi.fn(),
        patch: vi.fn(),
        delete: vi.fn(),
        use: vi.fn(),
      })
      expect(capturedRegex).toBeInstanceOf(RegExp)
      // Public routes match whitelist
      expect(capturedRegex.test('/latex/templates')).toBe(true)
      expect(capturedRegex.test('/latex/templates/thesis/gwtjmqdbfxgm')).toBe(
        true
      )
      expect(capturedRegex.test('/templates/t/my-template')).toBe(true)
      expect(capturedRegex.test('/articles')).toBe(true)
      expect(capturedRegex.test('/gallery')).toBe(true)
      // Open routes must NOT match whitelist (must require authentication)
      expect(
        capturedRegex.test('/latex/templates/thesis/gwtjmqdbfxgm/open')
      ).toBe(false)
      expect(
        capturedRegex.test('/latex/templates/thesis/gwtjmqdbfxgm/open/')
      ).toBe(false)
      expect(
        capturedRegex.test('/latex/templates/thesis/gwtjmqdbfxgm/open?cid=123')
      ).toBe(false)
      expect(capturedRegex.test('/templates/t/my-template/open')).toBe(false)
      expect(capturedRegex.test('/templates/t/my-template/open/')).toBe(false)
    } finally {
      AuthenticationController.addEndpointToLoginWhitelist = origAdd
    }
  })

  it('renders scope root, redirects /recent/page/1, and rejects invalid page params', async function () {
    vi.spyOn(GalleryReadService, 'listPage').mockResolvedValue({
      items: [
        {
          token: 'fqrcrzrkynpp',
          family: 'template',
          slug: 'lecture-notes',
          title: 'Lecture Notes',
          author: 'Author',
          description: 'Desc',
        },
      ],
      total: 18,
      totalPages: 2,
      page: 1,
    })
    vi.spyOn(GalleryReadService, 'listFeatured').mockResolvedValue([
      {
        token: 'wwwwwwwwwwww',
        family: 'template',
        slug: 'wiley',
        title: 'Wiley',
        author: 'Wiley',
        description: 'Official template',
        official: true,
      },
    ])

    const rootRes = makeRes()
    await GalleryController.renderScopeRoot('templates')(
      { path: '/latex/templates', query: { q: 'cv' } },
      rootRes
    )
    expect(rootRes.viewName).toMatch(/listing$/)
    expect(rootRes.locals.isRoot).toBe(true)
    expect(rootRes.locals.canonicalURL).toBe(
      'https://overleaf.example.com/latex/templates'
    )
    expect(rootRes.locals.categories).toHaveLength(11)
    expect(rootRes.locals.featured[0].badge).toBe('official')
    expect(rootRes.locals.search).toEqual({ query: 'cv', page: '' })

    const page1Res = makeRes()
    const next = vi.fn()
    await GalleryController.renderRecent('templates')(
      { path: '/latex/templates/recent/page/1', params: { page: '1' } },
      page1Res,
      next
    )
    expect(page1Res.redirectStatus).toBe(301)
    expect(page1Res.redirectUrl).toBe('/latex/templates/recent')

    const badPageRes = makeRes()
    await GalleryController.renderRecent('templates')(
      { path: '/latex/templates/recent/page/0', params: { page: '0' } },
      badPageRes,
      next
    )
    expect(next).toHaveBeenCalled()
  })

  it('renders detail page with canonical URL for wrong slug and supports admin preview', async function () {
    vi.spyOn(GalleryReadService, 'getItemByToken').mockResolvedValue({
      token: 'fqrcrzrkynpp',
      family: 'template',
      slug: 'lecture-notes',
      state: 'draft',
      title: 'Lecture Notes',
      author: 'Dr. Smith',
      official: true,
      licenseLabel: 'LPPL 1.3c',
      abstractHtml: '<p>Notes</p>',
      description: 'Plain description',
      mainText: '\\documentclass{article}',
      lastUpdatedAt: new Date('2026-01-01T00:00:00Z'),
      tags: [{ name: 'cv', title: 'CVs and résumés' }],
    })
    vi.spyOn(SessionManager, 'getLoggedInUserId').mockReturnValue('admin-1')
    vi.spyOn(
      AuthorizationManager.promises,
      'isUserSiteAdmin'
    ).mockResolvedValue(true)

    const res = makeRes()
    const next = vi.fn()
    await GalleryController.renderDetail(
      {
        path: '/latex/templates/wrong-slug-xyz/fqrcrzrkynpp',
        params: { slug: 'wrong-slug-xyz', token: 'fqrcrzrkynpp' },
        session: {},
      },
      res,
      next
    )
    expect(next).not.toHaveBeenCalled()
    expect(res.viewName).toMatch(/detail$/)
    expect(res.locals.canonicalURL).toBe(
      'https://overleaf.example.com/latex/templates/lecture-notes/fqrcrzrkynpp'
    )
    expect(res.locals.adminPreviewState).toBe('draft')
    expect(res.locals.item.openHref).toBe(
      '/latex/templates/lecture-notes/fqrcrzrkynpp/open'
    )
    expect(res.locals.item.tags[0].href).toBe('/gallery/tagged/cv')

    // Uppercase token falls through to 404
    const nextUpper = vi.fn()
    await GalleryController.renderDetail(
      {
        path: '/latex/templates/lecture-notes/FQRCRZRKYNPP',
        params: { slug: 'lecture-notes', token: 'FQRCRZRKYNPP' },
      },
      makeRes(),
      nextUpper
    )
    expect(nextUpper).toHaveBeenCalled()
  })

  it('serves thumbnails (ETag 304, data URI fallback) and rejects uppercase .PDF', async function () {
    vi.spyOn(GalleryReadService, 'getMediaItem').mockResolvedValue({
      token: 'fqrcrzrkynpp',
      media: { thumbSha: 'sha-123', thumbMime: 'image/jpeg' },
      thumbDataUri: 'data:image/jpeg;base64,/9j/4AAQ',
    })
    vi.spyOn(BlobStore, 'exists').mockResolvedValue(true)
    vi.spyOn(BlobStore, 'getStream').mockImplementation(() =>
      Readable.from([Buffer.from('jpeg-bytes')])
    )

    const res304 = makeRes()
    await GalleryController.serveThumbnail(
      {
        params: { token: 'fqrcrzrkynpp' },
        headers: { 'if-none-match': '"sha-123"' },
      },
      res304
    )
    expect(res304.statusCode).toBe(304)

    // Data URI fallback when blob is absent
    BlobStore.exists.mockResolvedValue(false)
    vi.spyOn(GalleryReadService, 'ensureMedia').mockResolvedValue(null)
    const resFallback = makeRes()
    await GalleryController.serveThumbnail(
      { params: { token: 'fqrcrzrkynpp' }, headers: {} },
      resFallback
    )
    expect(resFallback.statusCode).toBe(200)
    expect(resFallback.headers['Content-Type']).toBe('image/jpeg')
    expect(Buffer.isBuffer(resFallback.body)).toBe(true)

    // Uppercase .PDF falls through to 404 via next()
    const nextPdf = vi.fn()
    await GalleryController.servePdf(
      {
        path: '/latex/templates/lecture-notes/fqrcrzrkynpp.PDF',
        params: { slug: 'lecture-notes', token: 'fqrcrzrkynpp' },
      },
      makeRes(),
      nextPdf
    )
    expect(nextPdf).toHaveBeenCalled()
  })

  it('redirects legacy /templates and /templates/t/:slug URLs with 301', async function () {
    const resRoot = makeRes()
    GalleryController.redirectLegacyGallery(
      { query: { q: 'beamer theme' } },
      resRoot
    )
    expect(resRoot.redirectStatus).toBe(301)
    expect(resRoot.redirectUrl).toBe('/latex/templates?q=beamer%20theme')

    vi.spyOn(GalleryReadService, 'findLegacyItemBySlug').mockResolvedValue({
      token: 'fqrcrzrkynpp',
      family: 'template',
      slug: 'lecture-notes',
    })
    const resItem = makeRes()
    await GalleryController.redirectLegacyItem('pdf')(
      { params: { slug: 'lecture-notes' } },
      resItem,
      vi.fn()
    )
    expect(resItem.redirectStatus).toBe(301)
    expect(resItem.redirectUrl).toBe(
      '/latex/templates/lecture-notes/fqrcrzrkynpp.pdf'
    )
  })

  it('resolves legacy slug for /templates/t/:slug/open before delegating to openTemplate', async function () {
    vi.spyOn(GalleryReadService, 'findLegacyItemBySlug').mockResolvedValue({
      token: 'fqrcrzrkynpp',
      family: 'template',
      slug: 'lecture-notes',
    })
    const routes = []
    const webRouter = {
      get: vi.fn(),
      post: (path, ...handlers) =>
        routes.push({ method: 'POST', path, handlers }),
      patch: vi.fn(),
      delete: vi.fn(),
      use: vi.fn(),
    }
    TemplateGalleryRouter.apply(webRouter)
    const legacyOpenRoute = routes.find(
      r => r.method === 'POST' && r.path === '/templates/t/:slug/open'
    )
    expect(legacyOpenRoute).toBeDefined()
    const resolver = legacyOpenRoute.handlers.find(
      h => typeof h === 'function' && h.name === 'resolveLegacySlug'
    )
    expect(resolver).toBeDefined()

    const req = { params: { slug: 'lecture-notes' } }
    const next = vi.fn()
    await resolver(req, {}, next)
    expect(req.params.token).toBe('fqrcrzrkynpp')
    expect(next).toHaveBeenCalled()

    vi.spyOn(GalleryReadService, 'findLegacyItemBySlug').mockResolvedValue(null)
    const reqNotFound = { params: { slug: 'unknown' } }
    const nextNotFound = vi.fn()
    await resolver(reqNotFound, {}, nextNotFound)
    expect(reqNotFound.params.token).toBeUndefined()
    expect(nextNotFound).toHaveBeenCalled()
  })

  it('delegates rate limiting to OpenController instead of route-level RateLimiterMiddleware', function () {
    const routes = []
    const webRouter = {
      get: vi.fn(),
      post: (path, ...handlers) =>
        routes.push({ method: 'POST', path, handlers }),
      patch: vi.fn(),
      delete: vi.fn(),
      use: vi.fn(),
    }
    TemplateGalleryRouter.apply(webRouter)

    const familyOpen = routes.find(
      r =>
        r.method === 'POST' &&
        r.path === '/latex/templates/:slug/:token([a-z]{12})/open'
    )
    expect(familyOpen).toBeDefined()
    // Exactly [requireLogin, OpenController.openTemplate]
    expect(familyOpen.handlers).toHaveLength(2)

    const legacyOpen = routes.find(
      r => r.method === 'POST' && r.path === '/templates/t/:slug/open'
    )
    expect(legacyOpen).toBeDefined()
    // Exactly [requireLogin, resolveLegacySlug, OpenController.openTemplate]
    expect(legacyOpen.handlers).toHaveLength(3)

    expect(TemplateGalleryRouter.openRateLimiter).toBeDefined()
  })
})
