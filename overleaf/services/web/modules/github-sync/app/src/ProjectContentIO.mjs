import fs from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import ProjectEntityHandler from '../../../../app/src/Features/Project/ProjectEntityHandler.mjs'
import DocstoreManager from '../../../../app/src/Features/Docstore/DocstoreManager.mjs'
import HistoryManager from '../../../../app/src/Features/History/HistoryManager.mjs'
import { classifySyncEntry } from './Exclusions.mjs'

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

// Writes current Overleaf content into destDir (the git working tree).
// The caller must flush document-updater first
// (DocumentUpdaterHandler.promises.flushProjectToMongo).
async function materializeProject(projectId, destDir) {
  const entities = await ProjectEntityHandler.promises.getAllEntities(projectId)
  const manifest = []

  const docs = await DocstoreManager.promises.getAllDocs(projectId)
  const docsById = new Map()
  for (const doc of Array.isArray(docs) ? docs : []) {
    if (doc && doc._id) docsById.set(String(doc._id), doc)
  }

  for (const { path: relPath, doc } of entities.docs || []) {
    const absPath = _safePath(destDir, relPath)
    if (!absPath) continue
    const docData = docsById.get(String(doc._id))
    const lines = docData?.lines !== undefined ? docData.lines : []
    await fs.mkdir(path.dirname(absPath), { recursive: true })
    await fs.writeFile(absPath, lines.join('\n') + '\n')
    manifest.push(relPath)
  }

  for (const { path: relPath, file } of entities.files || []) {
    const absPath = _safePath(destDir, relPath)
    if (!absPath) continue
    await fs.mkdir(path.dirname(absPath), { recursive: true })
    const { stream } = await HistoryManager.promises.requestBlobWithProjectId(
      projectId,
      file.hash,
      'GET'
    )
    await pipeline(stream, createWriteStream(absPath))
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
  const entries = []
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
      }
    }
  }
  await walk(repoDir, '')
  return entries
}

const ProjectContentIO = {
  promises: { materializeProject, readProjectTree },
}

export default ProjectContentIO
