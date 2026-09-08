// app/src/SyncFileOps.mjs
import fs from 'node:fs/promises'
import path from 'node:path'
import EditorController from '../../../../app/src/Features/Editor/EditorController.mjs'
import SyncEngine from './SyncEngine.mjs'
import ProjectContentIO from './ProjectContentIO.mjs'
import { classifyText, classifySyncEntry } from './Exclusions.mjs'

export const SYNC_SOURCE = 'github'

function _deepestFirst(paths) {
  return [...paths].sort(
    (a, b) =>
      b.split('/').length - a.split('/').length || b.length - a.length
  )
}

async function _upsertFromRepo(projectId, userId, repoDir, relPath, warnings) {
  const absPath = path.join(repoDir, relPath)
  if (!path.resolve(absPath).startsWith(path.resolve(repoDir) + path.sep)) {
    warnings.push({ path: relPath, code: 'invalid_path' })
    return
  }
  let fsPath = absPath
  let tmpDir = null
  const stat = await fs.lstat(absPath).catch(() => null)
  if (!stat) {
    // not present in the working tree — stage a copy from git
    const staged = await SyncEngine.promises.writeFileFromRepo(repoDir, relPath)
    fsPath = staged.tmpPath
    tmpDir = staged.tmpDir
  }
  try {
    const effectiveStat =
      stat || (await fs.lstat(fsPath).catch(() => null))
    const symlinkTarget = effectiveStat?.isSymbolicLink()
      ? await fs.readlink(fsPath)
      : null
    const verdict = classifySyncEntry(relPath, {
      sizeBytes: effectiveStat?.size,
      symlinkTarget,
    })
    if (verdict.verdict === 'skip') {
      warnings.push({ path: relPath, code: verdict.code })
      return
    }
    if (classifyText(relPath)) {
      const content = await fs.readFile(fsPath, 'utf8')
      const lines = content.split(/\r\n|\n|\r/)
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
      await EditorController.promises.upsertDocWithPath(
        projectId,
        relPath,
        lines,
        SYNC_SOURCE,
        userId
      )
    } else {
      await EditorController.promises.upsertFileWithPath(
        projectId,
        relPath,
        fsPath,
        null,
        SYNC_SOURCE,
        userId
      )
    }
  } finally {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

async function applyChangeSet(projectId, userId, repoDir, changes) {
  const warnings = []

  const deletions = changes.filter(c => c.type === 'D').map(c => c.path)
  const renameSources = changes.filter(c => c.type === 'R').map(c => c.oldPath)
  for (const delPath of _deepestFirst([...deletions, ...renameSources])) {
    await EditorController.promises.deleteEntityWithPath(
      projectId,
      delPath,
      SYNC_SOURCE,
      userId
    )
  }

  const upserts = changes.filter(c => ['A', 'M', 'R'].includes(c.type))
  for (const change of upserts) {
    await _upsertFromRepo(projectId, userId, repoDir, change.path, warnings)
  }

  return warnings
}

async function applyImportTree(projectId, userId, repoDir) {
  const warnings = []
  const tree = await ProjectContentIO.promises.readProjectTree(repoDir)
  for (const entry of tree) {
    const verdict = classifySyncEntry(entry.relPath, {
      sizeBytes: entry.sizeBytes,
      symlinkTarget: entry.symlinkTarget,
    })
    if (verdict.verdict === 'skip') {
      warnings.push({ path: entry.relPath, code: verdict.code })
      continue
    }
    await _upsertFromRepo(projectId, userId, repoDir, entry.relPath, warnings)
  }
  return warnings
}

const SyncFileOps = {
  SYNC_SOURCE,
  promises: { applyChangeSet, applyImportTree },
}

export default SyncFileOps
