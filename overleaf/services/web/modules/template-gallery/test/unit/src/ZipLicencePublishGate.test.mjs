import os from 'node:os'
import fs from 'node:fs'
import Path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import ZipInspector, { createZipBufferFromEntries } from '../../../app/src/zip/ZipInspector.mjs'
import { scanLatexDependencies } from '../../../app/src/zip/LatexDependencyScanner.mjs'
import LicenceService from '../../../app/src/services/LicenceService.mjs'
import ImageMapper from '../../../app/src/services/ImageMapper.mjs'
import PublishGate from '../../../app/src/services/PublishGate.mjs'
import { DEFAULTS } from '../../../app/src/TemplateGalleryDefaults.mjs'

describe('ZipInspector & LatexDependencyScanner', () => {
  let tmpDir

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(Path.join(os.tmpdir(), 'tg-zip-test-'))
  })

  afterEach(async () => {
    if (tmpDir) {
      await fs.promises.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('inspects a valid template ZIP and extracts LICENSE and .tex candidates', async () => {
    const zipBuf = await createZipBufferFromEntries([
      {
        name: 'main.tex',
        content: '\\documentclass{article}\n\\begin{document}\nHello World\n\\end{document}\n',
      },
      {
        name: 'LICENSE.txt',
        content: 'Creative Commons Attribution 4.0 International (CC BY 4.0)',
      },
    ])
    const zipPath = Path.join(tmpDir, 'valid.zip')
    await fs.promises.writeFile(zipPath, zipBuf)

    const result = await ZipInspector.inspect(zipPath, DEFAULTS.limits)
    expect(result.zipSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(result.entryCount).toBe(2)
    expect(result.texCandidates.some(c => c.path === 'main.tex' && c.hasDocumentclass)).toBe(true)
    expect(result.licenceFile).toBeTruthy()
    expect(result.licenceFile.text).toContain('CC BY 4.0')
  })

  it('rejects non-ZIP files and archives without .tex files', async () => {
    const badPath = Path.join(tmpDir, 'notazip.zip')
    await fs.promises.writeFile(badPath, 'plain text not a zip')
    let err1 = null
    try {
      await ZipInspector.inspect(badPath, DEFAULTS.limits)
    } catch (e) {
      err1 = e
    }
    expect(err1).toBeTruthy()
    expect(err1.code).toBe('not_a_zip')

    const noTexBuf = await createZipBufferFromEntries([{ name: 'readme.txt', content: 'hello' }])
    const noTexPath = Path.join(tmpDir, 'notex.zip')
    await fs.promises.writeFile(noTexPath, noTexBuf)
    let err2 = null
    try {
      await ZipInspector.inspect(noTexPath, DEFAULTS.limits)
    } catch (e) {
      err2 = e
    }
    expect(err2).toBeTruthy()
    expect(err2.code).toBe('no_tex')
  })

  it('scans LaTeX source for missing local sibling files vs standard TeX Live packages', () => {
    const standaloneTex = `
      \\documentclass{article}
      \\usepackage{amsmath,graphicx,hyperref}
      \\begin{document}
      Standalone math $E=mc^2$
      \\end{document}
    `
    const scan1 = scanLatexDependencies(standaloneTex)
    expect(scan1.hasMissingDependencies).toBe(false)
    expect(scan1.missingFiles).toHaveLength(0)

    const multiFileTex = `
      \\documentclass{mycustomcv}
      \\input{sections/education}
      \\includegraphics[width=2cm]{avatar.png}
      \\addbibresource{refs.bib}
      \\begin{document}
      \\end{document}
    `
    const scan2 = scanLatexDependencies(multiFileTex)
    expect(scan2.hasMissingDependencies).toBe(true)
    expect(scan2.missingFiles).toEqual(
      expect.arrayContaining(['mycustomcv.cls', 'sections/education.tex', 'avatar.png', 'refs.bib'])
    )
  })
})

describe('LicenceService, ImageMapper & PublishGate', () => {
  it('prioritizes non-commercial license detection over generic CC BY', () => {
    const ncSaText =
      'This work is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0).'
    expect(LicenceService.detectFromText(ncSaText)).toBe('cc-by-nc-sa-4.0')

    const ccByText = 'Licensed under Creative Commons Attribution 4.0 International (CC BY 4.0).'
    expect(LicenceService.detectFromText(ccByText)).toBe('cc-by-4.0')

    const evalRes = LicenceService.evaluateLicence(
      {
        declared: 'Creative Commons CC BY 4.0',
        code: 'cc-by-4.0',
        detected: 'cc-by-nc-sa-4.0',
      },
      DEFAULTS.licence
    )
    expect(evalRes.conflict).toBe(true)
    expect(evalRes.isBlocked).toBe(true)
  })

  it('maps upstream texImage and latexEngine accurately and falls back on 2018/2019', () => {
    const allowed = ['texlive-full:2026', 'texlive-full:2025', 'texlive-full:2024']
    const mapped = ImageMapper.resolveImage(
      { texImage: 'texlive-full:2026.1' },
      DEFAULTS,
      allowed
    )
    expect(mapped.imageBasename).toBe('texlive-full:2026')

    const res2018 = ImageMapper.resolveImage({ texImage: 'wl_texlive:2018.1' }, DEFAULTS, allowed)
    expect(res2018.ok).toBe(true)
    expect(res2018.imageBasename).toBe('texlive-full:2024')

    const res2019 = ImageMapper.resolveImage({ texImage: 'texlive-full:2019.1' }, DEFAULTS, allowed)
    expect(res2019.ok).toBe(true)
    expect(res2019.imageBasename).toBe('texlive-full:2024')

    expect(ImageMapper.resolveCompiler('pdflatex').compiler).toBe('pdflatex')
    expect(ImageMapper.resolveCompiler('latex_dvipdf').compiler).toBe('latex')
    expect(ImageMapper.resolveCompiler('').compilerSource).toBe('default-assumed')
  })

  it('PublishGate returns the full unmet gate list when blocked', () => {
    const item = {
      state: 'ready',
      title: 'Modern Simple CV',
      author: 'Sarah Lang',
      sourceAcquired: true,
      sourceBlobStoreKey: 'a'.repeat(64),
      licence: {
        declared: 'Creative Commons CC BY 4.0',
        code: 'cc-by-4.0',
        detected: 'cc-by-nc-sa-4.0',
        conflict: true,
      },
      compile: {
        imageBasename: 'texlive-full:2026',
        imageName: 'dangdoan2003/texlive-full:2026',
        compiler: 'pdflatex',
        mainFile: 'main.tex',
      },
    }
    const gate = PublishGate.evaluate(item, DEFAULTS, {})
    expect(gate.ok).toBe(false)
    expect(gate.unmet.some(u => u.code === 'licence_blocked')).toBe(true)
  })
})
