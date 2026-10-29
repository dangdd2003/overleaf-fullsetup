import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import pug from 'pug'
import GalleryController from '../../../app/src/controllers/GalleryController.mjs'
import GalleryReadService from '../../../app/src/services/GalleryReadService.mjs'
import SessionManager from '../../../../../app/src/Features/Authentication/SessionManager.mjs'
import AuthorizationManager from '../../../../../app/src/Features/Authorization/AuthorizationManager.mjs'

const VIEWS_DIR = path.resolve(import.meta.dirname, '../../../app/views')
const WEB_VIEWS_DIR = path.resolve(
  import.meta.dirname,
  '../../../../../app/views'
)

function makeRes() {
  return {
    statusCode: 200,
    viewName: null,
    locals: null,
    status(code) {
      this.statusCode = code
      return this
    },
    render(name, locals) {
      this.viewName = name
      this.locals = locals
      return this
    },
    redirect: vi.fn(),
  }
}

describe('Parity Markup - Footer and CTA Action Buttons', () => {
  describe('Finding 1: Footer renders fat-footer-website-redesign with Templates link', () => {
    it.each(['listing.pug', 'tagged.pug', 'detail.pug', 'error.pug'])(
      '%s declares showThinFooter = false under block vars',
      viewFile => {
        const filePath = path.join(VIEWS_DIR, viewFile)
        const content = fs.readFileSync(filePath, 'utf8')
        expect(content).toMatch(/block vars[\s\S]*?-\s*showThinFooter\s*=\s*false/)
      }
    )

    it('GalleryController passes showThinFooter: false in renderListing', async () => {
      vi.spyOn(GalleryReadService, 'listPage').mockResolvedValue({
        items: [],
        page: 1,
        totalPages: 1,
        total: 0,
      })
      vi.spyOn(GalleryReadService, 'listFeatured').mockResolvedValue([])

      const res = makeRes()
      await GalleryController.renderScopeRoot('templates')(
        { path: '/latex/templates', query: {} },
        res
      )
      expect(res.locals.showThinFooter).toBe(false)
    })

    it('GalleryController passes showThinFooter: false in renderTagged', async () => {
      vi.spyOn(GalleryReadService, 'listPage').mockResolvedValue({
        items: [],
        page: 1,
        totalPages: 1,
        total: 0,
      })
      vi.spyOn(GalleryReadService, 'getTagView').mockResolvedValue({
        name: 'cv',
        title: 'CVs',
        summary: 'CV templates',
        related: [],
        topPicks: [],
      })

      const res = makeRes()
      const next = vi.fn()
      await GalleryController.renderTagged('templates')(
        { path: '/latex/templates/tagged/cv', params: { name: 'cv' } },
        res,
        next
      )
      expect(res.locals.showThinFooter).toBe(false)
    })

    it('GalleryController passes showThinFooter: false in renderDetail', async () => {
      vi.spyOn(SessionManager, 'getLoggedInUserId').mockReturnValue(null)
      vi.spyOn(GalleryReadService, 'getItemByToken').mockResolvedValue({
        token: 'abcdefghijkl',
        family: 'template',
        slug: 'test-template',
        state: 'published',
        title: 'Test Template',
        author: 'Author',
        official: false,
        licenseLabel: null,
        abstractHtml: null,
        description: 'Description',
        mainText: null,
        lastUpdatedAt: null,
        tags: [],
      })

      const res = makeRes()
      const next = vi.fn()
      await GalleryController.renderDetail(
        {
          path: '/latex/templates/test-template/abcdefghijkl',
          params: { slug: 'test-template', token: 'abcdefghijkl' },
          session: {},
        },
        res,
        next
      )
      expect(res.locals.showThinFooter).toBe(false)
    })

    it('listing.pug renders fat-footer-website-redesign with templates link even if showThinFooter was true in Express locals', () => {
      const listingPath = path.join(VIEWS_DIR, 'listing.pug')
      const compiled = pug.compileFile(listingPath, {
        basedir: WEB_VIEWS_DIR,
      })

      const html = compiled({
        translate: k => (k === 'templates' ? 'Templates' : k),
        settings: {
          i18n: { subdomainLang: {} },
          translatedLanguages: { en: 'English' },
          nav: { header_extras: [] },
          devToolbar: {},
        },
        nav: { header_extras: [], left_footer: [], right_footer: [] },
        currentLngCode: 'en',
        hasFeature: f => f === 'template-gallery' || f === 'registration-page',
        getSessionUser: () => null,
        getUserEmail: () => null,
        getLoggedInUserId: () => null,
        hasAdminAccess: () => false,
        canRedirectToAdminDomain: () => false,
        // CE ExpressLocals sets showThinFooter = true by default; block vars in listing.pug must override it
        showThinFooter: true,
        suppressAnalytics: true,
        ExposedSettings: {},
        copy: { pageTitleKey: 't', titleKey: 't', summaryKey: 's' },
        filters: [],
        canonicalURL: 'http://test',
        isRoot: true,
        categories: [],
        recent: [],
        pagination: null,
        featured: [],
        search: null,
        buildCssPath: () => '',
        buildJsPath: () => '',
        entrypointStyles: () => [],
        entrypointScripts: () => [],
        buildBaseAssetPath: () => '',
        moduleIncludes: () => '',
        buildImgPath: () => '',
      })

      expect(html).toContain('website-redesign-fat-footer')
      expect(html).not.toContain('site-footer')
      expect(html).toMatch(/href="\/latex\/templates"[^>]*>Templates<\/a>/)
      expect(html).not.toMatch(/class="[^"]*thin-footer[^"]*"/)
    })
  })

  describe('Finding 2: Begin-now CTA card checks registration-page flag', () => {
    it('_mixins.pug checks hasFeature("registration-page")', () => {
      const mixinsPath = path.join(VIEWS_DIR, '_mixins.pug')
      const content = fs.readFileSync(mixinsPath, 'utf8')
      expect(content).toMatch(/hasFeature\('registration-page'\)\s*&&\s*!getSessionUser\(\)/)
      expect(content).not.toMatch(/hasFeature\('registration'\)\s*&&\s*!getSessionUser\(\)/)
    })

    it('renders "Sign up for free" link for unauthenticated users when registration-page is enabled', () => {
      const template = `
include ./_mixins.pug
+gallery-begin-now()
`
      const compiled = pug.compile(template, {
        filename: path.join(VIEWS_DIR, 'test-render.pug'),
        basedir: WEB_VIEWS_DIR,
      })

      const html = compiled({
        translate: k => (k === 'sign_up_for_free' ? 'Sign up for free' : k),
        settings: {},
        hasFeature: f => f === 'registration-page',
        getSessionUser: () => null,
      })

      expect(html).toContain('<p class="card-links">')
      expect(html).toMatch(
        /<a class="btn btn-primary card-link" href="\/register">Sign up for free<\/a>/
      )
    })

    it('omits sign-up link for authenticated users', () => {
      const template = `
include ./_mixins.pug
+gallery-begin-now()
`
      const compiled = pug.compile(template, {
        filename: path.join(VIEWS_DIR, 'test-render.pug'),
        basedir: WEB_VIEWS_DIR,
      })

      const html = compiled({
        translate: k => k,
        settings: {},
        hasFeature: f => f === 'registration-page',
        getSessionUser: () => ({ _id: 'user1' }),
      })

      expect(html).not.toContain('card-links')
      expect(html).not.toContain('/register')
    })

    it('omits sign-up link when registration-page feature is disabled in CE', () => {
      const template = `
include ./_mixins.pug
+gallery-begin-now()
`
      const compiled = pug.compile(template, {
        filename: path.join(VIEWS_DIR, 'test-render.pug'),
        basedir: WEB_VIEWS_DIR,
      })

      const html = compiled({
        translate: k => k,
        settings: {},
        hasFeature: () => false,
        getSessionUser: () => null,
      })

      expect(html).not.toContain('card-links')
      expect(html).not.toContain('/register')
    })
  })
})
