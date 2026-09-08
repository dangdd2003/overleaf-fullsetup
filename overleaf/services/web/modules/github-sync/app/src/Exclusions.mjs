// app/src/Exclusions.mjs
import path from 'node:path'

export const MAX_SYNC_FILE_SIZE = 50 * 1024 * 1024

const DEFAULT_TEXT_EXTENSIONS = [
  'tex', 'latex', 'sty', 'cls', 'bst', 'bib', 'bibtex', 'txt', 'tikz',
  'mtx', 'rtex', 'md', 'asy', 'dtx', 'ins', 'csv',
]
const KNOWN_TEXT_BASENAMES = [
  'makefile', 'dockerfile', 'licence', 'license', 'readme', '.gitignore',
  '.latexmkrc', 'latexmkrc',
]

export function classifyText(relPath) {
  const base = path.basename(relPath).toLowerCase()
  const ext = path.extname(relPath).slice(1).toLowerCase()
  return (
    DEFAULT_TEXT_EXTENSIONS.includes(ext) ||
    KNOWN_TEXT_BASENAMES.includes(base) ||
    (!ext && !base.includes('.'))
  )
}

export function isExcludedSyncPath(relPath) {
  const normalized = relPath.replace(/\\/g, '/')
  const segments = normalized.split('/')
  return (
    segments.includes('.git') ||
    segments.includes('.overleaf') ||
    normalized.startsWith('.github/workflows/')
  )
}

export function classifySyncEntry(relPath, { sizeBytes, symlinkTarget } = {}) {
  const normalized = relPath.replace(/\\/g, '/')
  const segments = normalized.split('/')
  if (segments.includes('.git')) {
    return { verdict: 'skip', code: 'github_git_folder_error' }
  }
  if (isExcludedSyncPath(normalized)) {
    return { verdict: 'skip', code: 'github_workflow_files_error' }
  }
  if (symlinkTarget) {
    return { verdict: 'skip', code: 'github_symlink_error' }
  }
  if (sizeBytes != null && sizeBytes > MAX_SYNC_FILE_SIZE) {
    return { verdict: 'skip', code: 'github_large_files_error' }
  }
  return { verdict: 'sync' }
}

export default {
  MAX_SYNC_FILE_SIZE,
  classifyText,
  isExcludedSyncPath,
  classifySyncEntry,
}
