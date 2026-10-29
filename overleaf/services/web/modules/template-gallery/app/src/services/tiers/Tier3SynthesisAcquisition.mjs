import crypto from 'node:crypto'
import Path from 'node:path'
import { scanLatexDependencies } from '../../zip/LatexDependencyScanner.mjs'
import { createZipBufferFromEntries } from '../../zip/ZipInspector.mjs'
import { itemHref } from '../../util/GalleryUrls.mjs'
import { commitZipBuffer } from './TierSupport.mjs'
import { logInfo, logWarn } from '../../observability/Log.mjs'

// Tier 3: build a one-file project from the main .tex text mirrored from the
// official "View Source" modal. Works for every crawled item, but anything the
// main file pulls in (images, \input files, custom classes, .bib) is missing.

const NOTES_FILE = 'TEMPLATE-NOTES.txt'

export function sourceTextSha(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex')
}

/**
 * Reduce an upstream mainFile value to a safe root-level .tex file name.
 *
 * @param {string} [mainFile]
 * @returns {string}
 */
export function safeMainFileName(mainFile) {
  let name = Path.posix
    .basename(String(mainFile || '').replace(/\\/g, '/'))
    .replace(/[\0-\x1f\x7f]/g, '')
    .trim()
  if (!name || name.startsWith('.') || name.length > 150) return 'main.tex'
  if (!/\.tex$/i.test(name)) name = `${name}.tex`
  return name
}

function buildNotes(item, mainFile, missingFiles) {
  const lines = [
    `This project was created from the template "${item.title || 'Untitled'}"` +
      (item.author ? ` by ${item.author}.` : '.'),
  ]
  if (item.source !== 'upload' && item.token) {
    lines.push(`Original: https://www.overleaf.com${itemHref(item)}`)
  }
  if (item.licenseLabel) lines.push(`License: ${item.licenseLabel}`)
  lines.push(
    '',
    `Only the main file (${mainFile}) of this template is available here.`,
    'It references the following files, which must be added before it compiles:',
    ...missingFiles.map(file => `  - ${file}`),
    ''
  )
  return lines.join('\n')
}

/**
 * @param {object} item
 * @param {object} [cfg] - Settings.templateGallery
 * @param {{ storageDir?: string }} [opts]
 */
export async function acquireViaSynthesis(item, cfg = {}, opts = {}) {
  const texSource =
    typeof item.mainText === 'string' && item.mainText
      ? item.mainText
      : typeof item.latexSourcePreview === 'string'
        ? item.latexSourcePreview
        : ''
  if (!texSource.trim()) {
    return { acquired: false, reason: 'missing_main_text' }
  }

  try {
    const mainFile = safeMainFileName(item.mainFile || item.openParams?.mainFile)
    const scan = scanLatexDependencies(texSource, [mainFile], {
      checkPackages: false,
    })
    const missingFiles = scan.missingFiles
    const entries = [{ name: mainFile, content: Buffer.from(texSource, 'utf8') }]
    if (missingFiles.length > 0) {
      entries.push({
        name: NOTES_FILE,
        content: Buffer.from(buildNotes(item, mainFile, missingFiles), 'utf8'),
      })
    }

    const zipBuffer = await createZipBufferFromEntries(entries)
    const committed = await commitZipBuffer(zipBuffer, { cfg, storageDir: opts.storageDir })
    logInfo('tier3_synthesized', {
      token: item.token,
      zipSha256: committed.zipSha256,
      missing: missingFiles.length,
    })
    return {
      acquired: true,
      tier: 3,
      ...committed,
      mainFile,
      hasMissingDependencies: missingFiles.length > 0,
      missingFiles,
      sourceTextSha: sourceTextSha(texSource),
    }
  } catch (err) {
    logWarn('tier3_failed', { token: item.token, code: err?.code, err: err?.message })
    return { acquired: false, reason: err?.code || 'tier3_error', error: err?.message }
  }
}

export default {
  safeMainFileName,
  sourceTextSha,
  acquireViaSynthesis,
}
