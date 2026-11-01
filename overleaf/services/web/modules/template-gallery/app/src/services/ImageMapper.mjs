import Path from 'node:path'
import Settings from '@overleaf/settings'
import ProjectHelper from '../../../../../app/src/Features/Project/ProjectHelper.mjs'
import { DEFAULTS } from '../TemplateGalleryDefaults.mjs'

// Maps the TeX Live image and LaTeX engine an overleaf.com template asks for
// (CTA params `texImage=texlive-full:2026.1`, `latexEngine=pdflatex`) onto what
// this instance can actually compile with. Nothing here throws: an image or
// engine we cannot honour degrades to the instance default, exactly like a
// blank project would get.

const SAFE_COMPILERS_FALLBACK = ['pdflatex', 'latex', 'xelatex', 'lualatex']

function allowedImageBasenames(allowed) {
  if (!Array.isArray(allowed)) return []
  return allowed
    .map(entry => (typeof entry === 'string' ? entry : entry?.imageName))
    .filter(name => typeof name === 'string' && name.trim())
    .map(name => Path.basename(name.trim()).toLowerCase())
}

function texLiveYear(imageName) {
  const match = /:(\d{4})(?:\.\d+)?$/.exec(typeof imageName === 'string' ? imageName : '')
  return match ? Number(match[1]) : null
}

function withImageRoot(basename) {
  return Settings.imageRoot ? `${Settings.imageRoot}/${basename}` : basename
}

// Picks the allowed image closest to the requested TeX Live year, preferring
// the same or a newer release (old templates generally compile on newer TeX
// Live, the reverse is less likely).
function closestAllowedByYear(year, allowedNames) {
  const dated = (allowedNames || [])
    .map(name => ({ name, year: texLiveYear(name) }))
    .filter(entry => entry.year != null)
  if (dated.length === 0) return null
  if (year != null) {
    const sameOrNewer = dated
      .filter(entry => entry.year >= year)
      .sort((a, b) => a.year - b.year)
    if (sameOrNewer.length > 0) return sameOrNewer[0].name
  }
  return dated.sort((a, b) => b.year - a.year)[0].name
}

/**
 * Resolve the compile image for a template.
 *
 * @param {{ imageBasename?: string, texImage?: string }} [requested]
 * @param {object} [cfg] - TemplateGalleryDefaults shape (for `images.map`)
 * @param {Array<string|{imageName: string}>} [allowed] - Settings.allowedImageNames
 * @returns {{ ok: true, imageName: string|null, imageBasename: string|null, source: 'exact'|'mapped'|'closest'|'default'|'none', requested: string|null }}
 */
export function resolveImage(
  { imageBasename, texImage } = {},
  cfg = DEFAULTS,
  allowed = Settings.allowedImageNames
) {
  const requestedRaw = imageBasename || texImage
  const requested =
    typeof requestedRaw === 'string' && requestedRaw.trim()
      ? Path.basename(requestedRaw.trim()).toLowerCase()
      : null
  const allowedNames = allowedImageBasenames(allowed)

  const result = (basename, source) => ({
    ok: true,
    imageName: basename ? withImageRoot(basename) : null,
    imageBasename: basename,
    source,
    requested,
  })

  if (allowedNames.length === 0) {
    // No image choice on this instance (CE without sandboxed compiles):
    // projects use the default image, so do not pin one.
    const current = Settings.currentImageName
    return current
      ? {
          ok: true,
          imageName: current,
          imageBasename: Path.basename(current),
          source: 'default',
          requested,
        }
      : result(null, 'none')
  }

  if (requested) {
    if (allowedNames.includes(requested)) return result(requested, 'exact')

    const configured = cfg?.images?.map?.[requested]
    const candidates = [
      configured && Path.basename(String(configured)).toLowerCase(),
      // texlive-full:2026.1 -> texlive-full:2026
      requested.replace(/^(.*:\d{4})\.\d+$/, '$1'),
    ].filter(Boolean)
    for (const candidate of candidates) {
      if (allowedNames.includes(candidate)) return result(candidate, 'mapped')
    }

    const year = texLiveYear(requested)
    const closest = year != null ? closestAllowedByYear(year, allowedNames) : null
    if (closest) return result(closest, 'closest')
  }

  const current = Settings.currentImageName
    ? Path.basename(Settings.currentImageName).toLowerCase()
    : null
  if (current && allowedNames.includes(current)) {
    return result(current, 'default')
  }
  return result(closestAllowedByYear(null, allowedNames) || allowedNames[0], 'default')
}

/**
 * Resolve the CE compiler for an overleaf.com `latexEngine` value. Unknown
 * values fall back to the instance default.
 *
 * @param {string} [latexEngine]
 * @param {string} [defaultCompiler]
 * @returns {{ compiler: string, compilerSource: 'upstream'|'default-assumed' }}
 */
export function resolveCompiler(
  latexEngine,
  defaultCompiler = Settings.defaultLatexCompiler || 'pdflatex'
) {
  const safeCompilers = Array.isArray(Settings.safeCompilers)
    ? Settings.safeCompilers
    : SAFE_COMPILERS_FALLBACK
  const engine =
    typeof latexEngine === 'string' ? latexEngine.trim().toLowerCase() : ''

  const compiler = ProjectHelper.compilerFromV1Engine(engine) || engine
  if (compiler && safeCompilers.includes(compiler)) {
    return { compiler, compilerSource: 'upstream' }
  }
  return { compiler: defaultCompiler, compilerSource: 'default-assumed' }
}

const ImageMapper = {
  resolveImage,
  resolveCompiler,
}

export default ImageMapper
