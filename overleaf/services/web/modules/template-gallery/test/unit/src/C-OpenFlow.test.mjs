import os from 'node:os'
import fsp from 'node:fs/promises'
import Path from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import pug from 'pug'

vi.mock('../../../../../app/src/infrastructure/RedisWrapper.mjs', () => ({
  default: {
    client: () => ({
      on: () => {},
      once: () => {},
      disconnect: async () => {},
      quit: async () => {},
      defineCommand: () => {},
    }),
    cleanupTestRedis: async () => {},
  },
}))

import Settings from '@overleaf/settings'
import { DEFAULTS, mergePlain } from '../../../app/src/TemplateGalleryDefaults.mjs'
import { setCollectionOverrideForTests } from '../../../app/src/persistence/Collections.mjs'
import OpenService from '../../../app/src/services/OpenService.mjs'
import OpenController, { errorFor, openRateLimiter } from '../../../app/src/controllers/OpenController.mjs'
import Lifecycle from '../../../app/src/Lifecycle.mjs'
import AuthenticationController from '../../../../../app/src/Features/Authentication/AuthenticationController.mjs'
import AuthorizationManager from '../../../../../app/src/Features/Authorization/AuthorizationManager.mjs'
import ProjectUploadManager from '../../../../../app/src/Features/Uploads/ProjectUploadManager.mjs'
import ProjectRootDocManager from '../../../../../app/src/Features/Project/ProjectRootDocManager.mjs'
import { InvalidZipFileError } from '../../../../../app/src/Features/Uploads/ArchiveErrors.mjs'
import TemplateSourceAcquisitionService from '../../../app/src/services/TemplateSourceAcquisitionService.mjs'
import {
  acquireViaSynthesis,
  safeMainFileName,
  sourceTextSha,
} from '../../../app/src/services/tiers/Tier3SynthesisAcquisition.mjs'
import {
  ingestAdminZip,
  generateToken,
  buildUpsertUpdate,
} from '../../../app/src/services/tiers/Tier4AdminUploadAcquisition.mjs'
import {
  scanLatexDependencies,
  stripLatexComments,
} from '../../../app/src/zip/LatexDependencyScanner.mjs'
import ZipInspector from '../../../app/src/zip/ZipInspector.mjs'
import BlobStore from '../../../app/src/storage/BlobStore.mjs'
import { isValidToken } from '../../../app/src/util/GalleryUrls.mjs'

function mockResponse() {
  const res = {
    statusCode: 200,
    headers: {},
    rendered: null,
    jsonBody: null,
    redirectUrl: null,
    status(code) {
      res.statusCode = code
      return res
    },
    set(key, value) {
      res.headers[key.toLowerCase()] = String(value)
      return res
    },
    setHeader(key, value) {
      res.headers[key.toLowerCase()] = String(value)
      return res
    },
    json(body) {
      res.jsonBody = body
      return res
    },
    render(view, data) {
      res.rendered = { view, data }
      return res
    },
    redirect(arg1, arg2) {
      if (typeof arg1 === 'number') {
        res.statusCode = arg1
        res.redirectUrl = arg2
      } else {
        res.statusCode = 302
        res.redirectUrl = arg1
      }
      return res
    },
  }
  return res
}

function mockRequest({
  userId = null,
  token = 'abcdefghijkl',
  acceptJson = false,
  session = {},
} = {}) {
  return {
    params: { token },
    session: {
      ...session,
      user: userId ? { _id: userId } : undefined,
    },
    headers: {
      accept: acceptJson ? 'application/json' : 'text/html',
    },
    accepts: vi.fn(types => (acceptJson ? 'json' : 'html')),
  }
}

describe('Work Package C: Open Flow, Controller, Tier 3 & Tier 4', () => {
  let tmpDir

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(Path.join(os.tmpdir(), 'tg-c-openflow-test-'))
    Settings.enableTemplateGallery = true
    Settings.templateGallery = mergePlain(DEFAULTS, { storageDir: tmpDir })
    Settings.imageRoot = 'registry.example/texlive'
    Settings.currentImageName = 'registry.example/texlive/texlive-full:2026'
    Settings.allowedImageNames = [
      { imageName: 'texlive-full:2024', imageDesc: 'TeX Live 2024' },
      { imageName: 'texlive-full:2026', imageDesc: 'TeX Live 2026' },
    ]
    Settings.safeCompilers = ['pdflatex', 'latex', 'xelatex', 'lualatex']
    Settings.defaultLatexCompiler = 'pdflatex'
    Lifecycle.setReadyForTests(true)
    vi.spyOn(openRateLimiter, 'consume').mockResolvedValue({})
  })

  afterEach(async () => {
    Lifecycle.setReadyForTests(false)
    setCollectionOverrideForTests(null)
    vi.restoreAllMocks()
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true })
    }
  })

  describe('1. OpenService', () => {
    it('findOpenableItem works without opts', async () => {
      const publishedItem = {
        _id: 'item-1',
        token: 'publishedtok',
        state: 'published',
        title: 'Published Template',
      }
      const draftItem = {
        _id: 'item-2',
        token: 'draftitemtok',
        state: 'draft',
        title: 'Draft Template',
      }
      const items = [publishedItem, draftItem]

      const mockItemsCol = {
        findOne: vi.fn(async filter => {
          if (filter.token) {
            const found = items.find(i => i.token === filter.token)
            if (!found) return null
            if (filter.state && found.state !== filter.state) return null
            return found
          }
          return null
        }),
      }
      setCollectionOverrideForTests({ templateGalleryItems: mockItemsCol })

      // Call findOpenableItem with NO opts argument
      const resPublished = await OpenService.findOpenableItem('publishedtok')
      expect(resPublished).toEqual(publishedItem)

      // Draft template should not be returned without allowUnpublished
      const resDraft = await OpenService.findOpenableItem('draftitemtok')
      expect(resDraft).toBeNull()

      // Invalid tokens return null without querying DB
      expect(await OpenService.findOpenableItem('')).toBeNull()
      expect(await OpenService.findOpenableItem(null)).toBeNull()
      expect(await OpenService.findOpenableItem(undefined)).toBeNull()
    })

    it('openTemplate throws if userId is missing', async () => {
      let err1
      try {
        await OpenService.openTemplate('abcdefghijkl', null)
      } catch (e) {
        err1 = e
      }
      expect(err1).toBeDefined()
      expect(err1.message).toContain('userId is required')

      let err2
      try {
        await OpenService.openTemplate('abcdefghijkl', '')
      } catch (e) {
        err2 = e
      }
      expect(err2).toBeDefined()
      expect(err2.message).toContain('userId is required')
    })

    it('openTemplate throws item_not_found if item does not exist', async () => {
      const mockItemsCol = {
        findOne: vi.fn(async () => null),
      }
      setCollectionOverrideForTests({ templateGalleryItems: mockItemsCol })

      let err
      try {
        await OpenService.openTemplate('abcdefghijkl', 'user-1')
      } catch (e) {
        err = e
      }
      expect(err).toBeDefined()
      expect(err.code).toBe('item_not_found')
    })

    it('openTemplate works without opts argument when template exists', async () => {
      const item = {
        _id: 'item-101',
        token: 'abcdefghijkl',
        state: 'published',
        title: 'Awesome CV',
        mainFile: 'main.tex',
        latexEngine: 'pdflatex',
        texImage: 'texlive-full:2026.1',
      }

      const mockItemsCol = {
        findOne: vi.fn(async () => item),
        updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
      }
      setCollectionOverrideForTests({ templateGalleryItems: mockItemsCol })

      // Create a valid zip buffer and commit it to BlobStore
      const zipBuffer = await ZipInspector.createZipBufferFromEntries([
        {
          name: 'main.tex',
          content: '\\documentclass{article}\\begin{document}Hello\\end{document}',
        },
      ])
      const committed = await BlobStore.putBuffer(zipBuffer, { storageDir: tmpDir })

      vi.spyOn(TemplateSourceAcquisitionService, 'acquire').mockResolvedValueOnce({
        acquired: true,
        tier: 3,
        zipSha256: committed.sha256,
        mainFile: 'main.tex',
        hasMissingDependencies: false,
        missingFiles: [],
        item,
      })

      const uploadSpy = vi
        .spyOn(ProjectUploadManager.promises, 'createProjectFromZipArchiveWithName')
        .mockResolvedValueOnce({ project: { _id: 'proj-new-123' } })

      const rootDocSpy = vi
        .spyOn(ProjectRootDocManager.promises, 'setRootDocFromName')
        .mockResolvedValueOnce(true)

      // Invoke openTemplate with ONLY 2 arguments (token, userId) — no opts!
      const result = await OpenService.openTemplate('abcdefghijkl', 'user-456')

      expect(result).toEqual({
        projectId: 'proj-new-123',
        acquisitionTier: 3,
        hasMissingDependencies: false,
      })

      expect(uploadSpy).toHaveBeenCalledTimes(1)
      const [passedUserId, passedName, passedZipPath, passedAttrs] = uploadSpy.mock.calls[0]
      expect(passedUserId).toBe('user-456')
      expect(passedName).toBe('Awesome CV')
      expect(passedAttrs).toMatchObject({
        compiler: 'pdflatex',
        imageName: 'registry.example/texlive/texlive-full:2026',
      })
      expect(passedAttrs.brandVariationId).toBeUndefined()

      expect(rootDocSpy).toHaveBeenCalledWith('proj-new-123', 'main.tex')
      expect(mockItemsCol.updateOne).toHaveBeenCalledWith(
        { _id: 'item-101' },
        expect.objectContaining({
          $inc: { 'stats.opens': 1 },
        })
      )
    })

    it('openTemplate throws source_acquisition_failed with reasons if acquisition fails', async () => {
      const item = {
        _id: 'item-102',
        token: 'abcdefghijkl',
        state: 'published',
        title: 'Test',
      }
      setCollectionOverrideForTests({
        templateGalleryItems: { findOne: vi.fn(async () => item) },
      })

      vi.spyOn(TemplateSourceAcquisitionService, 'acquire').mockResolvedValueOnce({
        acquired: false,
        reasons: ['tier1:no_session_cookie', 'tier2:no_git_repo_detected', 'tier3:missing_main_text'],
      })

      let err
      try {
        await OpenService.openTemplate('abcdefghijkl', 'user-1')
      } catch (e) {
        err = e
      }
      expect(err).toBeDefined()
      expect(err.code).toBe('source_acquisition_failed')
      expect(err.reasons).toEqual([
        'tier1:no_session_cookie',
        'tier2:no_git_repo_detected',
        'tier3:missing_main_text',
      ])
    })

    it('openTemplate maps InvalidZipFileError to bundle_invalid', async () => {
      const item = {
        _id: 'item-103',
        token: 'abcdefghijkl',
        state: 'published',
        title: 'Broken Zip Template',
      }
      setCollectionOverrideForTests({
        templateGalleryItems: { findOne: vi.fn(async () => item) },
      })

      const committed = await BlobStore.putBuffer(Buffer.from('not-a-real-zip'), {
        storageDir: tmpDir,
      })

      vi.spyOn(TemplateSourceAcquisitionService, 'acquire').mockResolvedValueOnce({
        acquired: true,
        tier: 1,
        zipSha256: committed.sha256,
        item,
      })

      vi.spyOn(ProjectUploadManager.promises, 'createProjectFromZipArchiveWithName').mockRejectedValueOnce(
        new InvalidZipFileError({ message: 'zip corrupted' })
      )

      let err
      try {
        await OpenService.openTemplate('abcdefghijkl', 'user-1')
      } catch (e) {
        err = e
      }
      expect(err).toBeDefined()
      expect(err.code).toBe('bundle_invalid')
    })
  })

  describe('2. OpenController error status mapping & handlers', () => {
    it('errorFor correctly maps all domain error codes', () => {
      expect(errorFor('item_not_found')).toMatchObject({ status: 404, code: 'item_not_found' })
      expect(errorFor('template_not_found')).toMatchObject({ status: 404, code: 'template_not_found' })
      expect(errorFor('source_acquisition_failed')).toMatchObject({ status: 502, code: 'source_acquisition_failed' })
      expect(errorFor('gallery_unavailable')).toMatchObject({ status: 503, code: 'gallery_unavailable' })
      expect(errorFor('bundle_unavailable')).toMatchObject({ status: 503, code: 'bundle_unavailable' })
      expect(errorFor('bundle_invalid')).toMatchObject({ status: 422, code: 'bundle_invalid' })
      expect(errorFor('main_file_missing')).toMatchObject({ status: 422, code: 'main_file_missing' })
      expect(errorFor('image_unavailable')).toMatchObject({ status: 409, code: 'image_unavailable' })
      expect(errorFor('image_not_installed')).toMatchObject({ status: 409, code: 'image_not_installed' })
      expect(errorFor('rate_limited')).toMatchObject({ status: 429, code: 'rate_limited' })
      expect(errorFor('open_failed')).toMatchObject({ status: 500, code: 'open_failed' })
      expect(errorFor('something_unknown')).toMatchObject({ status: 500, code: 'open_failed' })
      expect(errorFor(undefined)).toMatchObject({ status: 500, code: 'open_failed' })
    })

    it('renderOpenLoader redirects anonymous users to /login and saves redirect', async () => {
      const setRedirectSpy = vi.spyOn(AuthenticationController, 'setRedirectInSession').mockImplementation(() => {})

      const req = mockRequest({ userId: null })
      const res = mockResponse()

      await OpenController.renderOpenLoader(req, res)
      expect(setRedirectSpy).toHaveBeenCalledWith(req)
      expect(res.redirectUrl).toBe('/login')
    })

    it('renderOpenLoader returns 503 when Lifecycle is not ready', async () => {
      Lifecycle.setReadyForTests(false)

      const req = mockRequest({ userId: 'user-1' })
      const res = mockResponse()

      await OpenController.renderOpenLoader(req, res)
      expect(res.statusCode).toBe(503)
      expect(res.rendered.data.code).toBe('gallery_unavailable')
    })

    it('renderOpenLoader returns 404 for missing item', async () => {
      vi.spyOn(OpenService, 'findOpenableItem').mockResolvedValueOnce(null)

      const req = mockRequest({ userId: 'user-1', token: 'abcdefghijkl' })
      const res = mockResponse()

      await OpenController.renderOpenLoader(req, res)
      expect(res.statusCode).toBe(404)
      expect(res.rendered.data.code).toBe('item_not_found')
    })

    it('renderOpenLoader renders loader form when item is found', async () => {
      const item = {
        token: 'abcdefghijkl',
        slug: 'my-template',
        title: 'My Template',
        family: 'template',
      }
      vi.spyOn(OpenService, 'findOpenableItem').mockResolvedValueOnce(item)

      const req = mockRequest({ userId: 'user-1', token: 'abcdefghijkl' })
      const res = mockResponse()

      await OpenController.renderOpenLoader(req, res)
      expect(res.statusCode).toBe(200)
      expect(res.rendered.data.formAction).toBe('/latex/templates/my-template/abcdefghijkl/open')
      expect(res.rendered.data.metadata.title).toBe('My Template')
    })

    it('openTemplate handles rate limiting with 429 and Retry-After header', async () => {
      openRateLimiter.consume.mockRejectedValueOnce({ msBeforeNext: 42000 })

      const req = mockRequest({ userId: 'user-rate-limited', token: 'abcdefghijkl', acceptJson: true })
      const res = mockResponse()

      await OpenController.openTemplate(req, res)
      expect(res.statusCode).toBe(429)
      expect(res.headers['retry-after']).toBe('42')
      expect(res.jsonBody).toMatchObject({ error: 'rate_limited' })
    })

    it('openTemplate maps service errors to json or rendered error', async () => {
      const acqError = new Error('Acquisition failed')
      acqError.code = 'source_acquisition_failed'
      vi.spyOn(OpenService, 'openTemplate').mockRejectedValueOnce(acqError)

      // JSON request receives status 502 with JSON body
      const reqJson = mockRequest({ userId: 'user-1', token: 'abcdefghijkl', acceptJson: true })
      const resJson = mockResponse()
      await OpenController.openTemplate(reqJson, resJson)
      expect(resJson.statusCode).toBe(502)
      expect(resJson.jsonBody).toMatchObject({ error: 'source_acquisition_failed' })

      // HTML request receives status 502 with rendered error view
      vi.spyOn(OpenService, 'openTemplate').mockRejectedValueOnce(acqError)
      const reqHtml = mockRequest({ userId: 'user-1', token: 'abcdefghijkl', acceptJson: false })
      const resHtml = mockResponse()
      await OpenController.openTemplate(reqHtml, resHtml)
      expect(resHtml.statusCode).toBe(502)
      expect(resHtml.rendered.data.code).toBe('source_acquisition_failed')
      expect(resHtml.rendered.data.title).toBe('Template source unavailable')
      expect(resHtml.rendered.data.message).toBe(
        'We could not fetch the files of this template. Please try again later.'
      )
    })

    it('error view renders contextual title and message when passed from OpenController', () => {
      const errorViewPath = Path.resolve(
        import.meta.dirname,
        '../../../app/views/error.pug'
      )
      const template = pug.compileFile(errorViewPath, {
        basedir: Path.resolve(import.meta.dirname, '../../../../../../app/views'),
      })
      const baseLocals = {
        settings: {
          appName: 'Overleaf',
          i18n: { subdomainLang: {} },
          nav: {},
          translatedLanguages: { en: 'English' },
          devToolbar: { enabled: false },
        },
        currentLngCode: 'en',
        nav: { header_extras: [] },
        ExposedSettings: {},
        translate: key => `TRANSLATED[${key}]`,
        buildBaseAssetPath: () => '/path/',
        buildCssPath: () => '/path/css',
        buildJsPath: () => '/path/js',
        entrypointStyles: () => [],
        entrypointScripts: () => [],
        getUserEmail: () => '',
        getLoggedInUserId: () => '',
        getSessionUser: () => null,
        hasAdminAccess: () => false,
        canRedirectToAdminDomain: () => false,
        hasAdminCapability: () => false,
        hasNonAdminDomainCapability: () => false,
        hasFeature: () => false,
        moduleIncludes: () => '',
        String,
      }

      // 1. Contextual title and message from OpenController
      const htmlContextual = template({
        ...baseLocals,
        title: 'Template not found',
        message: 'This template does not exist or is no longer available.',
      })
      expect(htmlContextual).toContain('<h1 class="h2">Template not found</h1>')
      expect(htmlContextual).toContain(
        '<p>This template does not exist or is no longer available.</p>'
      )
      expect(htmlContextual).toContain('<title translate="no">Template not found')

      // 2. Fallback to titleKey and messageKey
      const htmlKeys = template({
        ...baseLocals,
        titleKey: 'custom_title_key',
        messageKey: 'custom_message_key',
      })
      expect(htmlKeys).toContain('<h1 class="h2">TRANSLATED[custom_title_key]</h1>')
      expect(htmlKeys).toContain('<p>TRANSLATED[custom_message_key]</p>')

      // 3. Fallback to generic something went wrong
      const htmlGeneric = template({
        ...baseLocals,
      })
      expect(htmlGeneric).toContain(
        '<h1 class="h2">TRANSLATED[generic_something_went_wrong]</h1>'
      )
      expect(htmlGeneric).toContain(
        '<p>TRANSLATED[something_went_wrong_server]</p>'
      )
    })

    it('openTemplate redirects to /project/:id on success (HTML) or returns JSON', async () => {
      vi.spyOn(OpenService, 'openTemplate').mockResolvedValue({
        projectId: 'proj-777',
        acquisitionTier: 2,
        hasMissingDependencies: false,
      })

      // HTML request -> 302 redirect
      const reqHtml = mockRequest({ userId: 'user-1', token: 'abcdefghijkl', acceptJson: false })
      const resHtml = mockResponse()
      await OpenController.openTemplate(reqHtml, resHtml)
      expect(resHtml.statusCode).toBe(302)
      expect(resHtml.redirectUrl).toBe('/project/proj-777')

      // JSON request -> JSON object
      const reqJson = mockRequest({ userId: 'user-1', token: 'abcdefghijkl', acceptJson: true })
      const resJson = mockResponse()
      await OpenController.openTemplate(reqJson, resJson)
      expect(resJson.jsonBody).toEqual({
        projectId: 'proj-777',
        redirect: '/project/proj-777',
        acquisitionTier: 2,
        hasMissingDependencies: false,
      })
    })
  })

  describe('3. Tier 3 synthesis & missing dependency detection', () => {
    it('safeMainFileName sanitizes and normalizes file names', () => {
      expect(safeMainFileName('main.tex')).toBe('main.tex')
      expect(safeMainFileName('thesis')).toBe('thesis.tex')
      expect(safeMainFileName('nested/dir/mycv.tex')).toBe('mycv.tex')
      expect(safeMainFileName('win\\path\\paper.tex')).toBe('paper.tex')
      expect(safeMainFileName('.hidden.tex')).toBe('main.tex')
      expect(safeMainFileName('')).toBe('main.tex')
      expect(safeMainFileName(null)).toBe('main.tex')
    })

    it('sourceTextSha produces a consistent sha256', () => {
      const sha = sourceTextSha('\\documentclass{article}')
      expect(sha).toMatch(/^[0-9a-f]{64}$/)
      expect(sourceTextSha('\\documentclass{article}')).toBe(sha)
    })

    it('acquireViaSynthesis returns missing_main_text when text is empty', async () => {
      const res = await acquireViaSynthesis({ mainText: '' }, DEFAULTS, { storageDir: tmpDir })
      expect(res).toEqual({ acquired: false, reason: 'missing_main_text' })
    })

    it('detects missing dependencies and packages TEMPLATE-NOTES.txt', async () => {
      const tex = `
        \\documentclass{customthesis}
        \\usepackage{amsmath}
        \\input{chapters/chapter1}
        \\includegraphics{figures/diagram.png}
        \\bibliography{myreferences}
        \\begin{document}
        Testing dependencies.
        \\end{document}
      `
      const item = {
        token: 'abcdefghijkl',
        title: 'Custom Thesis',
        author: 'Alice Author',
        mainText: tex,
        mainFile: 'thesis.tex',
        licenseLabel: 'MIT',
        family: 'template',
        slug: 'custom-thesis',
      }

      const res = await acquireViaSynthesis(item, DEFAULTS, { storageDir: tmpDir })
      expect(res.acquired).toBe(true)
      expect(res.tier).toBe(3)
      expect(res.hasMissingDependencies).toBe(true)
      expect(res.missingFiles).toContain('customthesis.cls')
      expect(res.missingFiles).toContain('chapters/chapter1.tex')
      expect(res.missingFiles).toContain('figures/diagram.png')
      expect(res.missingFiles).toContain('myreferences.bib')
      expect(res.mainFile).toBe('thesis.tex')

      // Inspect committed zip file to confirm TEMPLATE-NOTES.txt exists
      const zipPath = Path.join(tmpDir, 'test-tier3.zip')
      await BlobStore.copyVerified(res.zipSha256, zipPath, tmpDir)
      const inspection = await ZipInspector.inspect(zipPath, DEFAULTS.limits)
      const names = inspection.manifest.map(m => m.path)
      expect(names).toContain('thesis.tex')
      expect(names).toContain('TEMPLATE-NOTES.txt')
    })

    it('marks hasMissingDependencies false when only standard TeX Live dependencies are used', async () => {
      const tex = `
        % Standard TeX Live article with standard amsmath and mwe example-image
        \\documentclass{article}
        \\usepackage{amsmath,graphicx}
        \\begin{document}
        \\includegraphics{example-image-a}
        All standard packages here.
        \\end{document}
      `
      const item = {
        token: 'abcdefghijkl',
        title: 'Standard Paper',
        mainText: tex,
        mainFile: 'main.tex',
      }

      const res = await acquireViaSynthesis(item, DEFAULTS, { storageDir: tmpDir })
      expect(res.acquired).toBe(true)
      expect(res.tier).toBe(3)
      expect(res.hasMissingDependencies).toBe(false)
      expect(res.missingFiles).toHaveLength(0)

      // Inspect committed zip: TEMPLATE-NOTES.txt must NOT be present
      const zipPath = Path.join(tmpDir, 'test-clean-tier3.zip')
      await BlobStore.copyVerified(res.zipSha256, zipPath, tmpDir)
      const inspection = await ZipInspector.inspect(zipPath, DEFAULTS.limits)
      const names = inspection.manifest.map(m => m.path)
      expect(names).toContain('main.tex')
      expect(names).not.toContain('TEMPLATE-NOTES.txt')
    })

    it('stripLatexComments removes comments without removing escaped percent signs', () => {
      const code = '100\\% success % this is a comment\n\\input{file} % another comment'
      const clean = stripLatexComments(code)
      expect(clean).toContain('100\\% success')
      expect(clean).not.toContain('this is a comment')
      expect(clean).not.toContain('another comment')
    })
  })

  describe('4. Tier 4 upsert without Mongo operator conflicts', () => {
    it('generateToken produces a valid 12-char lowercase token', () => {
      for (let i = 0; i < 20; i++) {
        const token = generateToken()
        expect(token).toMatch(/^[a-z]{12}$/)
        expect(isValidToken(token)).toBe(true)
      }
    })

    it('buildUpsertUpdate eliminates operator conflicts between $set and $setOnInsert', () => {
      const set = {
        title: 'Updated Title',
        'adminOverrides.title': true,
        sourceAcquired: true,
        'compile.compiler': 'pdflatex',
      }
      const insertDefaults = {
        title: 'Default Title',
        adminOverrides: {},
        'adminOverrides.title': false,
        sourceAcquired: false,
        createdAt: new Date(),
        slug: 'my-slug',
        'stats.opens': 0,
      }
      const inc = { revision: 1 }

      const update = buildUpsertUpdate(set, insertDefaults, inc)

      expect(update.$set).toEqual(set)
      expect(update.$inc).toEqual(inc)

      // Key in $set (title, sourceAcquired) must NOT be in $setOnInsert
      expect(update.$setOnInsert.title).toBeUndefined()
      expect(update.$setOnInsert.sourceAcquired).toBeUndefined()

      // Parent/child conflicts:
      // set has 'adminOverrides.title', so insertDefaults 'adminOverrides' and 'adminOverrides.title' must be omitted
      expect(update.$setOnInsert.adminOverrides).toBeUndefined()
      expect(update.$setOnInsert['adminOverrides.title']).toBeUndefined()

      // Non-conflicting fields must remain in $setOnInsert
      expect(update.$setOnInsert.createdAt).toBeDefined()
      expect(update.$setOnInsert.slug).toBe('my-slug')
      expect(update.$setOnInsert['stats.opens']).toBe(0)
    })

    it('ingestAdminZip creates a new admin template and stores it in BlobStore', async () => {
      const zipBuffer = await ZipInspector.createZipBufferFromEntries([
        {
          name: 'main.tex',
          content: '\\documentclass{article}\\begin{document}Admin\\end{document}',
        },
      ])
      const uploadZipPath = Path.join(tmpDir, 'admin-upload.zip')
      await fsp.writeFile(uploadZipPath, zipBuffer)

      let insertedDoc = null
      const mockItemsCol = {
        findOne: vi.fn(async () => null),
        findOneAndUpdate: vi.fn(async (filter, update) => {
          insertedDoc = {
            _id: 'admin-doc-1',
            ...update.$setOnInsert,
            ...update.$set,
          }
          return { value: insertedDoc }
        }),
      }
      const mockAuditCol = {
        insertOne: vi.fn(async () => ({ insertedId: 'audit-1' })),
      }
      setCollectionOverrideForTests({
        templateGalleryItems: mockItemsCol,
        templateGalleryAudit: mockAuditCol,
      })

      const result = await ingestAdminZip(
        uploadZipPath,
        {
          title: 'Custom Ingested Template',
          author: 'Admin User',
          compiler: 'xelatex',
          slug: 'custom-ingested',
        },
        'admin-user-42',
        DEFAULTS,
        { storageDir: tmpDir }
      )

      expect(result.ok).toBe(true)
      expect(result.zipSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(insertedDoc.source).toBe('upload')
      expect(insertedDoc.acquisitionTier).toBe(4)
      expect(insertedDoc.compile.compiler).toBe('xelatex')
      expect(insertedDoc['adminOverrides.title']).toBe(true)
      expect(isValidToken(insertedDoc.token)).toBe(true)

      // Blob must exist in BlobStore
      expect(await BlobStore.exists(result.zipSha256, tmpDir)).toBe(true)
      // Audit log must have been recorded
      expect(mockAuditCol.insertOne).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'TEMPLATE_ADMIN_ZIP_INGEST',
          userId: 'admin-user-42',
        })
      )
    })

    it('ingestAdminZip throws item_not_found when replacing non-existent item', async () => {
      const zipBuffer = await ZipInspector.createZipBufferFromEntries([
        { name: 'main.tex', content: '\\documentclass{article}\\begin{document}\\end{document}' },
      ])
      const uploadZipPath = Path.join(tmpDir, 'bad-replace.zip')
      await fsp.writeFile(uploadZipPath, zipBuffer)

      setCollectionOverrideForTests({
        templateGalleryItems: { findOne: vi.fn(async () => null) },
      })

      let err
      try {
        await ingestAdminZip(
          uploadZipPath,
          { itemId: 'abcdefghijkl', replaceExisting: true },
          'admin-1',
          DEFAULTS,
          { storageDir: tmpDir }
        )
      } catch (e) {
        err = e
      }
      expect(err).toBeDefined()
      expect(err.message).toContain('Template item not found')
    })
  })
})
