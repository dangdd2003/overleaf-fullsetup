import os from 'node:os'
import fs from 'node:fs'
import Path from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Settings from '@overleaf/settings'
import { DEFAULTS } from '../../../app/src/TemplateGalleryDefaults.mjs'
import { mergePlain } from './support/mergePlain.mjs'
import { extractMetaFromHtml } from '../../../app/src/services/AlgoliaConfigManager.mjs'
import {
  transformHit,
  chooseSplit,
} from '../../../app/src/services/TemplateCrawlerService.mjs'
import { parseItemUrl } from '../../../app/src/util/GalleryUrls.mjs'
import { encryptCookie, decryptCookie } from '../../../app/src/crypto/SessionCredentialStore.mjs'
import { acquireViaSynthesis } from '../../../app/src/services/tiers/Tier3SynthesisAcquisition.mjs'
import { setCollectionOverrideForTests } from '../../../app/src/persistence/Collections.mjs'
import ProjectUploadManager from '../../../../../app/src/Features/Uploads/ProjectUploadManager.mjs'
import ProjectRootDocManager from '../../../../../app/src/Features/Project/ProjectRootDocManager.mjs'
import ProjectDetailsHandler from '../../../../../app/src/Features/Project/ProjectDetailsHandler.mjs'
import OpenService from '../../../app/src/services/OpenService.mjs'

describe('Algolia Bootstrapper, Partition Crawler & Detail Hydrator', () => {
  it('extracts Algolia credentials from <meta name="ol-algolia">', () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta name="ol-algolia" data-type="json" content="{&quot;appId&quot;:&quot;SK53GL4JLY&quot;,&quot;apiKey&quot;:&quot;9ac63d917afab223adbd2cd09ad0eb17&quot;,&quot;indexes&quot;:{&quot;wiki&quot;:&quot;learn-wiki&quot;,&quot;gallery&quot;:&quot;gallery-production&quot;}}">
      </head>
      </html>
    `
    const cfg = extractMetaFromHtml(html)
    expect(cfg).toMatchObject({
      appId: 'SK53GL4JLY',
      apiKey: '9ac63d917afab223adbd2cd09ad0eb17',
      indexName: 'gallery-production',
    })
  })

  it('parses slug/token and builds partition plan splitting overflow tags > 1000', () => {
    const parsed = parseItemUrl('https://www.overleaf.com/latex/templates/modern-simple-cv/kwrxbwthgrwr')
    expect(parsed.slug).toBe('modern-simple-cv')
    expect(parsed.token).toBe('kwrxbwthgrwr')

    const doc = transformHit({
      objectID: '30526827',
      title: 'Modern Simple CV',
      author: 'Sarah Lang',
      description: 'Clean CV template',
      url: '/latex/templates/modern-simple-cv/kwrxbwthgrwr',
      tags: [{ id: 1, name: 'cv', title: 'CV' }],
      type: 'template',
      isTemplate: true,
      imageUrl: 'data:image/jpeg;base64,/9j/4AAQ',
    })
    expect(doc.slug).toBe('modern-simple-cv')
    expect(doc.token).toBe('kwrxbwthgrwr')
    expect(doc.objectID).toBe('30526827')

    const split = chooseSplit(
      {
        'tags.title': {
          CV: 420,
          University: 4278,
          Theses: 1993,
        },
      },
      6691
    )
    expect(split).toBeDefined()
    expect(split.positive).toContain('University')
  })

})

describe('SessionCredentialStore, Tier 3 Synthesis & OpenService', () => {
  let tmpDir

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(Path.join(os.tmpdir(), 'tg-open-test-'))
    Settings.enableTemplateGallery = true
    Settings.templateGallery = mergePlain(DEFAULTS, { storageDir: tmpDir })
  })

  afterEach(async () => {
    setCollectionOverrideForTests(null)
    vi.restoreAllMocks()
    if (tmpDir) {
      await fs.promises.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('encrypts and decrypts overleaf_session2 cookies with AES-256-GCM', () => {
    const rawCookie = 's%3Aabcd1234567890.signaturexyz'
    const encrypted = encryptCookie(rawCookie, 'test-secret-key')
    expect(encrypted).toMatch(/^v2:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/)
    const decrypted = decryptCookie(encrypted, 'test-secret-key')
    expect(decrypted).toBe(rawCookie)
    expect(() => decryptCookie(encrypted, 'wrong-secret-key')).toThrow()
  })

  it('synthesizes a valid Tier 3 ZIP from #modalViewSource and opens a local project via OpenService', async () => {
    const item = {
      _id: 'item-1',
      objectID: '30526827',
      slug: 'modern-simple-cv',
      token: 'kwrxbwthgrwr',
      title: 'Modern Simple CV',
      author: 'Sarah Lang',
      state: 'published',
      publishedId: 11020,
      mainText: '\\documentclass{article}\n\\begin{document}\nHello CV\n\\end{document}\n',
      hydrated: true,
      url: 'https://www.overleaf.com/latex/templates/modern-simple-cv/kwrxbwthgrwr',
      license: { declared: 'Creative Commons CC BY 4.0', code: 'cc-by-4.0' },
      openParams: {
        templateId: '30526827',
        templateVersionId: '11020',
        latexEngine: 'pdflatex',
        mainFile: 'main.tex',
        texImage: 'texlive-full:2026.1',
      },
      compile: {
        compiler: 'pdflatex',
        mainFile: 'main.tex',
        imageBasename: 'texlive-full:2026',
        imageName: 'dangdoan2003/texlive-full:2026',
      },
      latexSourcePreview: '\\documentclass{article}\n\\begin{document}\nHello CV\n\\end{document}\n',
    }

    const cfg = mergePlain(Settings.templateGallery, {
      storageDir: tmpDir,
      sourceAcquisition: {
        tier1Enabled: false,
        tier3Enabled: true,
      },
    })
    const synth = await acquireViaSynthesis(item, cfg, { storageDir: tmpDir })
    expect(synth.acquired).toBe(true)
    expect(synth.tier).toBe(3)
    expect(synth.zipSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(synth.hasMissingDependencies).toBe(false)

    item.sourceAcquired = true
    item.acquisitionTier = 3
    item.sourceBlobStoreKey = synth.zipSha256
    item.sourcePackageHash = synth.zipSha256
    item.zip = { sha256: synth.zipSha256, tier: 3, sourceTextSha: synth.sourceTextSha }

    const mockItemsCol = {
      findOne: vi.fn(async () => item),
      updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
    }
    setCollectionOverrideForTests({
      templateGalleryItems: mockItemsCol,
      templateGalleryConfig: { findOne: vi.fn(async () => null) },
    })

    const uploadSpy = vi
      .spyOn(ProjectUploadManager.promises, 'createProjectFromZipArchiveWithName')
      .mockResolvedValueOnce({ project: { _id: 'proj-999' } })
    const rootDocSpy = vi
      .spyOn(ProjectRootDocManager.promises, 'setRootDocFromName')
      .mockResolvedValueOnce(true)
    vi.spyOn(ProjectDetailsHandler, 'fixProjectName').mockImplementation(s => s)

    const opened = await OpenService.openTemplate('kwrxbwthgrwr', 'user-123', {
      cfg,
      storageDir: tmpDir,
    })
    expect(opened.projectId).toBe('proj-999')
    expect(uploadSpy).toHaveBeenCalledTimes(1)
    const passedAttrs = uploadSpy.mock.calls[0][3]
    expect(passedAttrs.compiler).toBe('pdflatex')
    expect(passedAttrs.brandVariationId).toBeUndefined()
    expect(rootDocSpy).toHaveBeenCalledWith('proj-999', 'main.tex')
  })
})
