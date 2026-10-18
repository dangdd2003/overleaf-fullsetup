import fs from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import ProjectEntityHandler from '../../../../app/src/Features/Project/ProjectEntityHandler.mjs'
import DocstoreManager from '../../../../app/src/Features/Docstore/DocstoreManager.mjs'
import HistoryManager from '../../../../app/src/Features/History/HistoryManager.mjs'
import { classifySyncEntry } from './Exclusions.mjs'

// Caps on how much of a project or repo one sync may hold and copy. Fixed in
// code: exceeding either fails the sync with a 413 `project_too_large` error.
export const MAX_SYNC_ENTRIES = 5000
export const MAX_SYNC_BYTES = 500 * 1024 * 1024

function _limits() {
  return { maxEntries: MAX_SYNC_ENTRIES, maxBytes: MAX_SYNC_BYTES }
}

function _tooLarge(message) {
  const err = new Error(message)
  err.code = 'project_too_large'
  err.status = 413
  return err
}

function _checkBytes(totalBytes, maxBytes) {
  if (totalBytes > maxBytes) {
    throw _tooLarge(`project content exceeds the GitHub sync limit of ${maxBytes} bytes`)
  }
}

// Files that live in the git repo but never in Overleaf. `materializeProject`
// must leave these alone: `commitAll` runs `git add -A`, so deleting one here
// makes the next push drop it from the user's GitHub repo.
const REPO_ONLY_PATHS = new Set(['.gitignore'])

function _isRepoManaged(entry) {
  if (REPO_ONLY_PATHS.has(entry.relPath)) return true
  // Anything sync deliberately skips (.github/workflows, symlinks, oversized
  // blobs) never reaches Overleaf, so it is absent from the manifest too.
  const { verdict } = classifySyncEntry(entry.relPath, {
    sizeBytes: entry.sizeBytes,
    symlinkTarget: entry.symlinkTarget,
  })
  return verdict === 'skip'
}

function _safePath(baseDir, relPath) {
  const absPath = path.join(baseDir, relPath)
  if (!path.resolve(absPath).startsWith(path.resolve(baseDir) + path.sep)) {
    return null
  }
  return absPath
}

/**
 * Where a file from Overleaf may be written inside repoDir, or null. Every
 * existing component on the way, the file included, must be a real file or
 * directory: a symlink in the working tree can point anywhere on the server,
 * and writing through it would overwrite that target. The lexical check in
 * _safePath does not see symlinks.
 */
export async function resolveSafeWritePath(repoDir, relPath) {
  const absPath = _safePath(repoDir, relPath)
  if (!absPath) return null
  let current = repoDir
  for (const part of path.relative(repoDir, absPath).split(path.sep)) {
    current = path.join(current, part)
    const stat = await fs.lstat(current).catch(() => null)
    if (!stat) break
    if (stat.isSymbolicLink()) return null
  }
  return absPath
}

// Writes current Overleaf content into destDir (the git working tree).
// The caller must flush document-updater first
// (DocumentUpdaterHandler.promises.flushProjectToMongo).
async function materializeProject(projectId, destDir) {
  const limits = _limits()
  const entities = await ProjectEntityHandler.promises.getAllEntities(projectId)
  const entryCount = (entities.docs || []).length + (entities.files || []).length
  if (entryCount > limits.maxEntries) {
    throw _tooLarge(
      `project has ${entryCount} files, the GitHub sync limit is ${limits.maxEntries}`
    )
  }
  const manifest = []
  let totalBytes = 0

  const docs = await DocstoreManager.promises.getAllDocs(projectId)
  const docsById = new Map()
  for (const doc of Array.isArray(docs) ? docs : []) {
    if (doc && doc._id) docsById.set(String(doc._id), doc)
  }

  for (const { path: relPath, doc } of entities.docs || []) {
    const absPath = await resolveSafeWritePath(destDir, relPath)
    if (!absPath) continue
    const docData = docsById.get(String(doc._id))
    const lines = docData?.lines !== undefined ? docData.lines : []
    const text = lines.join('\n') + '\n'
    totalBytes += Buffer.byteLength(text)
    _checkBytes(totalBytes, limits.maxBytes)
    await fs.mkdir(path.dirname(absPath), { recursive: true })
    await fs.writeFile(absPath, text)
    manifest.push(relPath)
  }

  for (const { path: relPath, file } of entities.files || []) {
    const absPath = await resolveSafeWritePath(destDir, relPath)
    if (!absPath) continue
    await fs.mkdir(path.dirname(absPath), { recursive: true })
    const { stream } = await HistoryManager.promises.requestBlobWithProjectId(
      projectId,
      file.hash,
      'GET'
    )
    // Counts bytes as they stream, so an oversized blob is cut off mid-copy
    // rather than written in full.
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        totalBytes += chunk.length
        if (totalBytes > limits.maxBytes) {
          callback(
            _tooLarge(`project content exceeds the GitHub sync limit of ${limits.maxBytes} bytes`)
          )
          return
        }
        callback(null, chunk)
      },
    })
    await pipeline(stream, counter, createWriteStream(absPath))
    manifest.push(relPath)
  }

  // remove on-disk files that no longer exist in Overleaf
  const onDisk = await readProjectTree(destDir)
  const manifestSet = new Set(manifest.map(p => p.replace(/\\/g, '/')))
  for (const entry of onDisk) {
    if (manifestSet.has(entry.relPath.replace(/\\/g, '/'))) continue
    if (_isRepoManaged(entry)) continue
    const absPath = _safePath(destDir, entry.relPath)
    if (absPath) {
      await fs.rm(absPath, { force: true }).catch(() => {})
    }
  }

  return manifest
}

async function readProjectTree(repoDir) {
  const limits = _limits()
  const entries = []
  let totalBytes = 0
  async function walk(dir, prefix) {
    const dirents = await fs.readdir(dir, { withFileTypes: true })
    for (const dirent of dirents) {
      const relPath = prefix ? `${prefix}/${dirent.name}` : dirent.name
      if (relPath === '.git' || relPath.startsWith('.git/')) continue
      const absPath = path.join(dir, dirent.name)
      if (dirent.isSymbolicLink()) {
        const target = await fs.readlink(absPath)
        entries.push({ relPath, sizeBytes: 0, symlinkTarget: target })
      } else if (dirent.isDirectory()) {
        await walk(absPath, relPath)
      } else if (dirent.isFile()) {
        const stat = await fs.stat(absPath)
        entries.push({ relPath, sizeBytes: stat.size, symlinkTarget: null })
        totalBytes += stat.size
      }
      if (entries.length > limits.maxEntries) {
        throw _tooLarge(
          `repository exceeds the GitHub sync limit of ${limits.maxEntries} files`
        )
      }
      _checkBytes(totalBytes, limits.maxBytes)
    }
  }
  await walk(repoDir, '')
  return entries
}

const ProjectContentIO = {
  promises: { materializeProject, readProjectTree },
}

export default ProjectContentIO
