import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Settings from '@overleaf/settings'
import ImageMapper from '../../../app/src/services/ImageMapper.mjs'
import { DEFAULTS } from '../../../app/src/TemplateGalleryDefaults.mjs'

const KEYS = ['allowedImageNames', 'imageRoot', 'currentImageName', 'safeCompilers', 'defaultLatexCompiler']

describe('C ImageMapper', () => {
  let saved

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map(key => [key, Settings[key]]))
    Settings.imageRoot = 'registry.example/texlive'
    Settings.currentImageName = 'registry.example/texlive/texlive-full:2026'
    Settings.allowedImageNames = [
      { imageName: 'texlive-full:2024', imageDesc: 'TeX Live 2024' },
      { imageName: 'texlive-full:2026', imageDesc: 'TeX Live 2026' },
    ]
    Settings.safeCompilers = ['xelatex', 'pdflatex', 'latex', 'lualatex']
    Settings.defaultLatexCompiler = 'pdflatex'
  })

  afterEach(() => {
    for (const key of KEYS) Settings[key] = saved[key]
  })

  it('maps the official texlive-full:YYYY.N revision onto the allowed image', () => {
    const res = ImageMapper.resolveImage({ texImage: 'texlive-full:2026.1' }, DEFAULTS)
    expect(res).toMatchObject({
      ok: true,
      imageName: 'registry.example/texlive/texlive-full:2026',
      imageBasename: 'texlive-full:2026',
      source: 'mapped',
    })
  })

  it('accepts an exact allowed image', () => {
    const res = ImageMapper.resolveImage({ texImage: 'texlive-full:2024' }, DEFAULTS)
    expect(res.imageBasename).toBe('texlive-full:2024')
    expect(res.source).toBe('exact')
  })

  it('falls back to the closest same-or-newer TeX Live year', () => {
    expect(ImageMapper.resolveImage({ texImage: 'texlive-full:2025.1' }, DEFAULTS).imageBasename).toBe(
      'texlive-full:2026'
    )
    expect(ImageMapper.resolveImage({ texImage: 'texlive-full:2022.1' }, DEFAULTS).imageBasename).toBe(
      'texlive-full:2024'
    )
    expect(ImageMapper.resolveImage({ texImage: 'texlive-full:2030.1' }, DEFAULTS).imageBasename).toBe(
      'texlive-full:2026'
    )
  })

  it('never throws for legacy or unknown images', () => {
    const legacy = ImageMapper.resolveImage({ texImage: 'wl_texlive:2018.1' }, DEFAULTS)
    expect(legacy.ok).toBe(true)
    expect(legacy.imageBasename).toBe('texlive-full:2024')

    const unknown = ImageMapper.resolveImage({ texImage: 'something-else' }, DEFAULTS)
    expect(unknown.ok).toBe(true)
    expect(unknown.imageName).toBe('registry.example/texlive/texlive-full:2026')
    expect(unknown.source).toBe('default')

    expect(ImageMapper.resolveImage(undefined, DEFAULTS).imageBasename).toBe('texlive-full:2026')
  })

  it('uses the instance default image when no image choice is configured', () => {
    Settings.allowedImageNames = []
    const res = ImageMapper.resolveImage({ texImage: 'texlive-full:2026.1' }, DEFAULTS)
    expect(res).toMatchObject({
      ok: true,
      imageName: 'registry.example/texlive/texlive-full:2026',
      source: 'default',
    })

    Settings.currentImageName = undefined
    expect(ImageMapper.resolveImage({ texImage: 'texlive-full:2026.1' }, DEFAULTS)).toMatchObject({
      ok: true,
      imageName: null,
      source: 'none',
    })
  })

  it('maps latexEngine values to CE compilers without throwing', () => {
    expect(ImageMapper.resolveCompiler('pdflatex').compiler).toBe('pdflatex')
    expect(ImageMapper.resolveCompiler('latex_dvipdf').compiler).toBe('latex')
    expect(ImageMapper.resolveCompiler('XeLaTeX').compiler).toBe('xelatex')
    expect(ImageMapper.resolveCompiler('lualatex').compiler).toBe('lualatex')
    expect(ImageMapper.resolveCompiler('')).toEqual({
      compiler: 'pdflatex',
      compilerSource: 'default-assumed',
    })
    expect(ImageMapper.resolveCompiler('mystery-engine')).toEqual({
      compiler: 'pdflatex',
      compilerSource: 'default-assumed',
    })
  })
})
