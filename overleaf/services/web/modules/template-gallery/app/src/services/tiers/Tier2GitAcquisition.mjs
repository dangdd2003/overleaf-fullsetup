import yauzl from 'yauzl'
import { requestRaw } from '../../transport/GuardedHttps.mjs'
import ZipInspector from '../../zip/ZipInspector.mjs'
import { commitZipBuffer, pickMainFile, resolveLimits } from './TierSupport.mjs'
import { logInfo, logWarn } from '../../observability/Log.mjs'

// Tier 2: when the template links its GitHub/GitLab repository, fetch the
// branch archive, strip the `<repo>-<branch>/` wrapper and use it as the
// project source.

const NAME = '[A-Za-z0-9_.-]+'
const REPO_URL_REGEX = new RegExp(
  `https?://(github\\.com|gitlab\\.com)/(${NAME})/(${NAME}?)(?:\\.git)?(?:/(?:-/)?tree/(${NAME}))?(?=[/\\s)"'<>,;]|$)`,
  'i'
)

/**
 * Detect a GitHub/GitLab repository URL in free text.
 *
 * @param {string} text
 * @returns {{ url: string, host: string, owner: string, repo: string, branch: string|null } | null}
 */
export function detectGitRepoUrl(text) {
  if (!text || typeof text !== 'string') return null
  const match = REPO_URL_REGEX.exec(text)
  if (!match) return null
  const host = match[1].toLowerCase()
  const owner = match[2]
  const repo = match[3].replace(/\.git$/i, '').replace(/\.$/, '')
  if (!repo) return null
  return {
    url: `https://${host}/${owner}/${repo}`,
    host,
    owner,
    repo,
    branch: match[4] || null,
  }
}

function archiveUrls({ host, owner, repo, branch }) {
  const branches = branch ? [branch] : ['main', 'master']
  return branches.map(name =>
    host === 'github.com'
      ? `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/${encodeURIComponent(name)}`
      : `https://gitlab.com/${owner}/${repo}/-/archive/${encodeURIComponent(name)}/${repo}-${encodeURIComponent(name)}.zip`
  )
}

function limitError(message) {
  const err = new Error(message)
  err.code = 'archive_limits_exceeded'
  return err
}

/**
 * Unpack a repository archive held in memory, enforcing the module zip limits
 * BEFORE decompressing anything (entry count, declared and streamed sizes,
 * total size), and drop the single top-level directory codeload/GitLab wrap
 * every archive in.
 *
 * @param {Buffer} zipBuffer
 * @param {object} limits - resolved cfg.limits
 * @returns {Promise<Array<{ name: string, content: Buffer }>>}
 */
export async function unpackArchive(zipBuffer, limits) {
  const zipfile = await new Promise((resolve, reject) => {
    yauzl.fromBuffer(zipBuffer, { lazyEntries: true }, (err, zf) =>
      err ? reject(err) : resolve(zf)
    )
  })

  const close = () => {
    try {
      zipfile.close()
    } catch {}
  }

  if (zipfile.entryCount > limits.maxEntries * 2) {
    close()
    throw limitError(`archive has ${zipfile.entryCount} entries`)
  }

  const readEntry = entry =>
    new Promise((resolve, reject) => {
      zipfile.openReadStream(entry, (err, stream) => {
        if (err) return reject(err)
        const chunks = []
        let bytes = 0
        stream.on('data', chunk => {
          bytes += chunk.length
          if (bytes > entry.uncompressedSize) {
            stream.destroy(limitError(`${entry.fileName} is larger than declared`))
            return
          }
          chunks.push(chunk)
        })
        stream.on('end', () => resolve(Buffer.concat(chunks)))
        stream.on('error', reject)
      })
    })

  const files = []
  let totalBytes = 0
  await new Promise((resolve, reject) => {
    const fail = err => {
      close()
      reject(err)
    }
    zipfile.on('error', fail)
    zipfile.on('end', resolve)
    zipfile.on('entry', entry => {
      const name = entry.fileName.replace(/\\/g, '/')
      if (name.endsWith('/') || name.startsWith('__MACOSX/')) {
        zipfile.readEntry()
        return
      }
      if (files.length + 1 > limits.maxEntries) {
        return fail(limitError(`more than ${limits.maxEntries} files`))
      }
      if (entry.uncompressedSize > limits.maxEntryBytes) {
        return fail(limitError(`${name} exceeds ${limits.maxEntryBytes} bytes`))
      }
      totalBytes += entry.uncompressedSize
      if (totalBytes > limits.maxUncompressedBytes) {
        return fail(limitError(`archive exceeds ${limits.maxUncompressedBytes} bytes`))
      }
      readEntry(entry).then(content => {
        files.push({ name, content })
        zipfile.readEntry()
      }, fail)
    })
    zipfile.readEntry()
  })

  const topDirs = new Set(files.map(file => file.name.split('/')[0]))
  const wrapped =
    topDirs.size === 1 && files.every(file => file.name.includes('/'))
  const prefixLength = wrapped ? [...topDirs][0].length + 1 : 0
  return files.map(file => ({ name: file.name.slice(prefixLength), content: file.content }))
}

/**
 * @param {object} item
 * @param {object} [cfg] - Settings.templateGallery
 * @param {{ storageDir?: string }} [opts]
 */
export async function acquireViaGitArchive(item, cfg = {}, opts = {}) {
  let repoInfo = null
  for (const text of [item.gitRepoUrl, item.description, item.abstractHtml]) {
    repoInfo = detectGitRepoUrl(text)
    if (repoInfo) break
  }
  if (!repoInfo) {
    return { acquired: false, reason: 'no_git_repo_detected' }
  }

  const limits = resolveLimits(cfg)
  let archive = null
  for (const url of archiveUrls(repoInfo)) {
    try {
      const res = await requestRaw(url, {
        method: 'GET',
        followRedirects: true,
        maxBytes: limits.maxZipBytes,
      })
      if (res.truncated) {
        return { acquired: false, reason: 'zip_too_large' }
      }
      if (res.status === 200 && res.body?.length) {
        archive = res.body
        break
      }
    } catch (err) {
      // 404 for a branch that does not exist; try the next one
      if (err?.status !== 404) {
        logWarn('tier2_download_failed', { url, err: err?.message })
      }
    }
  }
  if (!archive) {
    return { acquired: false, reason: 'git_archive_download_failed' }
  }

  try {
    const files = await unpackArchive(archive, limits)
    const texFiles = files.filter(file => /\.tex$/i.test(file.name))
    // A linked repository is only trusted as the template source when it
    // actually contains the template's main file.
    if (
      item.mainFile &&
      !texFiles.some(file => file.name.toLowerCase() === item.mainFile.toLowerCase())
    ) {
      return { acquired: false, reason: 'git_archive_main_file_missing' }
    }
    if (texFiles.length === 0) {
      return { acquired: false, reason: 'git_archive_has_no_tex' }
    }

    const zipBuffer = await ZipInspector.createZipBufferFromEntries(files)
    const committed = await commitZipBuffer(zipBuffer, { cfg, storageDir: opts.storageDir })
    logInfo('tier2_acquired', { token: item.token, repo: repoInfo.url })
    return {
      acquired: true,
      tier: 2,
      ...committed,
      mainFile: pickMainFile(committed.inspection.texCandidates, item.mainFile),
      hasMissingDependencies: false,
      missingFiles: [],
      gitRepoUrl: repoInfo.url,
    }
  } catch (err) {
    logWarn('tier2_failed', { token: item.token, repo: repoInfo.url, code: err?.code, err: err?.message })
    return { acquired: false, reason: err?.code || 'tier2_error', error: err?.message }
  }
}

export default {
  detectGitRepoUrl,
  unpackArchive,
  acquireViaGitArchive,
}
