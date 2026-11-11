/**
 * Static LaTeX source code dependency scanner.
 * Strips comments, parses \documentclass, \usepackage, \input, \include, \includegraphics, \bibliography,
 * and matches against standard TeX Live bundles vs provided files.
 */

// Standard TeX Live packages and classes bundled in full distribution
export const STANDARD_TEXLIVE_CLASSES = new Set([
  'article',
  'report',
  'book',
  'letter',
  'slides',
  'beamer',
  'memoir',
  'scrartcl',
  'scrreprt',
  'scrbook',
  'standalone',
  'proc',
  'minimal',
  // Common journal/CV/thesis classes shipped with texlive-full
  'amsart',
  'amsbook',
  'amsproc',
  'extarticle',
  'extreport',
  'extbook',
  'scrlttr2',
  'exam',
  'ieeetran',
  'elsarticle',
  'acmart',
  'llncs',
  'revtex4',
  'revtex4-1',
  'revtex4-2',
  'aastex631',
  'aastex7',
  'mnras',
  'moderncv',
  'europasscv',
  'altacv',
  'tufte-book',
  'tufte-handout',
  'tikzposter',
  'a0poster',
  'beamerposter',
  'ctexart',
  'ctexrep',
  'ctexbook',
  'ctexbeamer',
  'elegantbook',
  'elegantpaper',
  'elegantnote',
  'jsarticle',
  'jsbook',
  'kaobook',
  'novel',
  'ltxdoc',
])

// Files resolved from the TeX distribution rather than the project
const DISTRIBUTION_INPUTS = new Set(['glyphtounicode', 'glyphtounicode.tex'])

// Placeholder targets that are not plain file names (\jobname, #1, ...)
function isMacroTarget(target) {
  return /[\\#]/.test(target)
}

export const STANDARD_TEXLIVE_PACKAGES = new Set([
  'amsmath',
  'amssymb',
  'amsfonts',
  'amsthm',
  'babel',
  'inputenc',
  'fontenc',
  'geometry',
  'graphicx',
  'hyperref',
  'xcolor',
  'color',
  'tikz',
  'pgfplots',
  'booktabs',
  'array',
  'tabularx',
  'microtype',
  'fancyhdr',
  'natbib',
  'biblatex',
  'caption',
  'subcaption',
  'float',
  'url',
  'listings',
  'csquotes',
  'enumitem',
  'parskip',
  'setspace',
  'titlesec',
  'wrapfig',
  'multicol',
  'lipsum',
  'blindtext',
  'etoolbox',
  'kvoptions',
  'xparse',
  'expl3',
  'fontspec',
  'unicode-math',
  'cleveref',
  'tcolorbox',
  'authorblk',
  'algorithm',
  'algorithmic',
  'algpseudocode',
  'textcomp',
  'marvosym',
  'fontawesome',
  'fontawesome5',
  'pifont',
  'adjustbox',
  'rotating',
  'makecell',
  'multirow',
  'cite',
  'moderncv',
])

/**
 * Remove LaTeX comments (% until end of line, avoiding escaped \%).
 */
export function stripLatexComments(source) {
  if (typeof source !== 'string') return ''
  return source.replace(/(^|[^\\])%.*$/gm, '$1')
}

/**
 * Scan LaTeX dependencies and check for missing sibling files.
 */
export function scanLatexDependencies(texSource, providedFiles = [], opts = {}) {
  const checkPackages = opts.checkPackages !== false
  const cleanSource = stripLatexComments(texSource || '')
  // Command arguments are bounded to 1024 characters (1024 in each regex below).
  // Without the bound, an unclosed `{` makes the regex scan to the end of the
  // file for every such command, which is quadratic on a crafted main.tex.

  const providedNormalized = new Set(
    (providedFiles || []).map(f => String(f).trim().replace(/^\.\//, '').toLowerCase())
  )

  let documentClass = null
  const referencedPackages = []
  const inputs = []
  const graphics = []
  const bibliographies = []
  const missingFiles = []

  // 1. \documentclass[...]{name}
  const docClassMatch = /\\documentclass(?:\s*\[[^\]]{0,1024}\])?\s*\{([^}]{1,1024})\}/.exec(cleanSource)
  if (docClassMatch) {
    documentClass = docClassMatch[1].trim()
    const clsFile = `${documentClass}.cls`.toLowerCase()
    if (!STANDARD_TEXLIVE_CLASSES.has(documentClass.toLowerCase()) && !providedNormalized.has(clsFile)) {
      missingFiles.push(`${documentClass}.cls`)
    }
  }

  // 2. \usepackage[...]{pkg1,pkg2}
  const usepackageRegex = /\\usepackage(?:\s*\[[^\]]{0,1024}\])?\s*\{([^}]{1,1024})\}/g
  let match
  while ((match = usepackageRegex.exec(cleanSource)) !== null) {
    const rawList = match[1].split(',')
    for (const rawPkg of rawList) {
      const pkg = rawPkg.trim()
      if (!pkg) continue
      referencedPackages.push(pkg)
      const styFile = `${pkg}.sty`.toLowerCase()
      // If not in standard TeX Live and not in provided files, flag missing .sty
      if (
        checkPackages &&
        !STANDARD_TEXLIVE_PACKAGES.has(pkg.toLowerCase()) &&
        !providedNormalized.has(styFile)
      ) {
        // Only flag if it looks like a custom local file, or if neither standard nor provided
        // We track custom non-standard packages
        missingFiles.push(`${pkg}.sty`)
      }
    }
  }

  // 3. \input{path} and \include{path}
  const inputRegex = /\\(?:input|include)\s*\{([^}]{1,1024})\}/g
  while ((match = inputRegex.exec(cleanSource)) !== null) {
    const target = match[1].trim()
    if (!target || isMacroTarget(target)) continue
    inputs.push(target)
    if (DISTRIBUTION_INPUTS.has(target.toLowerCase())) continue

    const targetLower = target.toLowerCase()
    const targetWithTex = targetLower.endsWith('.tex') ? targetLower : `${targetLower}.tex`
    if (!providedNormalized.has(targetLower) && !providedNormalized.has(targetWithTex)) {
      missingFiles.push(target.endsWith('.tex') ? target : `${target}.tex`)
    }
  }

  // 4. \includegraphics[...]{path}
  const graphicsRegex = /\\includegraphics(?:\s*\[[^\]]{0,1024}\])?\s*\{([^}]{1,1024})\}/g
  const standardExts = ['.png', '.jpg', '.jpeg', '.pdf', '.eps']
  while ((match = graphicsRegex.exec(cleanSource)) !== null) {
    const target = match[1].trim()
    if (!target || isMacroTarget(target)) continue
    graphics.push(target)
    // example-image* placeholders ship with the mwe package
    if (/^example-image/i.test(target)) continue

    const targetLower = target.toLowerCase()
    const hasExt = standardExts.some(ext => targetLower.endsWith(ext))
    let found = false
    if (hasExt) {
      found = providedNormalized.has(targetLower)
    } else {
      found =
        providedNormalized.has(targetLower) ||
        standardExts.some(ext => providedNormalized.has(`${targetLower}${ext}`))
    }

    if (!found) {
      missingFiles.push(target)
    }
  }

  // 5. \bibliography{file1,file2} and \addbibresource{file.bib}
  const bibRegex = /\\(?:bibliography|addbibresource(?:\s*\[[^\]]{0,1024}\])?)\s*\{([^}]{1,1024})\}/g
  while ((match = bibRegex.exec(cleanSource)) !== null) {
    const rawList = match[1].split(',')
    for (const rawBib of rawList) {
      const bib = rawBib.trim()
      if (!bib || isMacroTarget(bib)) continue
      bibliographies.push(bib)

      const bibLower = bib.toLowerCase()
      const bibWithExt = bibLower.endsWith('.bib') ? bibLower : `${bibLower}.bib`
      if (!providedNormalized.has(bibLower) && !providedNormalized.has(bibWithExt)) {
        missingFiles.push(bib.endsWith('.bib') ? bib : `${bib}.bib`)
      }
    }
  }

  // Deduplicate missing files
  const uniqueMissing = Array.from(new Set(missingFiles))

  return {
    hasMissingDependencies: uniqueMissing.length > 0,
    missingFiles: uniqueMissing,
    referencedPackages,
    documentClass,
    inputs,
    graphics,
    bibliographies,
  }
}

export default {
  scanLatexDependencies,
  stripLatexComments,
  STANDARD_TEXLIVE_CLASSES,
  STANDARD_TEXLIVE_PACKAGES,
}
