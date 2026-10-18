import fs from 'node:fs/promises'
import Path from 'node:path'
import crypto from 'node:crypto'
import Settings from '@overleaf/settings'
import './ModuleSettings.mjs'
import { withAiAssistFileLock } from './AiAssistFileLock.mjs'

export function computeLineDiff(original, current) {
  if (original === current) return { insertions: 0, deletions: 0 }
  const linesA = original === '' ? [] : original.split('\n')
  const linesB = current === '' ? [] : current.split('\n')
  const m = linesA.length
  const n = linesB.length
  if (m === 0) return { insertions: n, deletions: 0 }
  if (n === 0) return { insertions: 0, deletions: m }

  // Fast path for simple append/prepend
  if (n > m && current.startsWith(original)) {
    return { insertions: n - m, deletions: 0 }
  }

  // Bounded LCS table to prevent large memory spikes
  if (m * n > 4_000_000) {
    // For very large files, compute line difference based on frequency/counts
    const setA = new Set(linesA)
    const setB = new Set(linesB)
    let ins = 0
    let del = 0
    for (const line of linesB) {
      if (!setA.has(line)) ins++
    }
    for (const line of linesA) {
      if (!setB.has(line)) del++
    }
    return { insertions: ins, deletions: del }
  }

  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1))
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      if (linesA[i] === linesB[j]) {
        dp[i + 1][j + 1] = dp[i][j] + 1
      } else {
        dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1])
      }
    }
  }
  const lcs = dp[m][n]
  return {
    insertions: n - lcs,
    deletions: m - lcs,
  }
}

const OBJECT_ID = /^[0-9a-f]{24}$/i
const CHAT_ID = /^[A-Za-z0-9_-]{1,64}$/

export function isValidChatId(chatId) {
  return typeof chatId === 'string' && CHAT_ID.test(chatId)
}

export function isValidUserMessageId(id) {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= 128 &&
    /^[A-Za-z0-9_.-]+$/.test(id) &&
    !id.includes('..')
  )
}

export function baseDir() {
  return (
    Settings.aiAssist?.checkpointsDir ||
    (Settings.aiAssist?.chatHistoryDir
      ? Path.join(Settings.aiAssist.chatHistoryDir, 'checkpoints')
      : '/var/lib/overleaf/data/ai-assist/checkpoints')
  )
}

function dirFor(projectId, userId, chatId) {
  if (!OBJECT_ID.test(String(projectId)) || !OBJECT_ID.test(String(userId))) {
    throw new Error('invalid project or user id')
  }
  if (!isValidChatId(chatId)) throw new Error('invalid chat id')
  return Path.join(baseDir(), `${projectId}-${userId}`, chatId)
}

function fileFor(projectId, userId, chatId, userMessageId) {
  if (!isValidUserMessageId(userMessageId)) {
    throw new Error('invalid user message id')
  }
  return Path.join(dirFor(projectId, userId, chatId), `${userMessageId}.json`)
}

async function writeCheckpoint(file, checkpoint) {
  await fs.mkdir(Path.dirname(file), { recursive: true })
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`
  await fs.writeFile(tmp, JSON.stringify(checkpoint, null, 2))
  await fs.rename(tmp, file)
}

async function readCheckpoint(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

export async function saveCheckpoint(
  projectId,
  userId,
  chatId,
  userMessageId,
  data = {}
) {
  const file = fileFor(projectId, userId, chatId, userMessageId)
  return withAiAssistFileLock(file, async () => {
    const existing = await readCheckpoint(file).catch(() => null)
    const now = Date.now()
    const existingFiles = existing?.files || {}
    const incomingFiles = data?.files ? data.files : data
    const mergedFiles = { ...existingFiles }

    if (incomingFiles && typeof incomingFiles === 'object') {
      for (const [filePath, fileInfo] of Object.entries(incomingFiles)) {
        if (!mergedFiles[filePath]) {
          mergedFiles[filePath] = {
            originalContent: fileInfo?.originalContent ?? '',
            docId: fileInfo?.docId ? String(fileInfo.docId) : null,
            isNew: Boolean(fileInfo?.isNew),
          }
        }
      }
    }

    const checkpoint = {
      version: 1,
      projectId: String(projectId),
      userId: String(userId),
      chatId,
      userMessageId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      files: mergedFiles,
    }

    await writeCheckpoint(file, checkpoint)
    return checkpoint
  })
}

export async function getCheckpoint(projectId, userId, chatId, userMessageId) {
  try {
    const file = fileFor(projectId, userId, chatId, userMessageId)
    return await readCheckpoint(file)
  } catch (err) {
    if (err.code === 'ENOENT') return null
    if (err.message?.includes('invalid')) return null
    throw err
  }
}

/** Most checkpoint files read at once when a chat's index is loaded. */
const INDEX_READ_CONCURRENCY = 8

/** Runs `fn` over `items` with at most `limit` in flight; results keep their order. */
export async function mapWithLimit(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index], index)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  )
  return results
}

async function loadCheckpointIndex(projectId, userId, chatId) {
  let dir
  try {
    dir = dirFor(projectId, userId, chatId)
  } catch {
    return []
  }

  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }

  const jsonFiles = entries
    .filter(e => e.isFile() && e.name.endsWith('.json'))
    .map(e => e.name)

  // A bounded number at a time: a chat with many checkpoints must not open
  // every file at once
  const loaded = await mapWithLimit(jsonFiles, INDEX_READ_CONCURRENCY, async name => {
    const userMessageId = name.slice(0, -5)
    try {
      const data = await readCheckpoint(Path.join(dir, name))
      return {
        userMessageId,
        createdAt: data?.createdAt ?? 0,
      }
    } catch {
      return { userMessageId, createdAt: 0 }
    }
  })

  loaded.sort((a, b) => a.createdAt - b.createdAt)
  return loaded
}

export async function listCheckpoints(projectId, userId, chatId) {
  const index = await loadCheckpointIndex(projectId, userId, chatId)
  return index.map(item => item.userMessageId)
}

const REWIND_MAX_MESSAGES = 500

function normalizeFilePath(filePath) {
  return String(filePath).replace(/^\//, '')
}

// Ordered user message ids from M onward. An explicit transcript order from
// the client wins; otherwise use checkpoint creation times.
async function rewindMessageIds(projectId, userId, chatId, userMessageId, ids) {
  if (Array.isArray(ids) && ids.length > 0) {
    const valid = ids.filter(isValidUserMessageId)
    const ordered = valid[0] === userMessageId ? valid : [userMessageId, ...valid]
    return [...new Set(ordered)].slice(0, REWIND_MAX_MESSAGES)
  }

  const index = await loadCheckpointIndex(projectId, userId, chatId)
  const own = index.find(item => item.userMessageId === userMessageId)
  if (!own) return [userMessageId]
  return index
    .filter(
      item =>
        item.userMessageId === userMessageId || item.createdAt >= own.createdAt
    )
    .map(item => item.userMessageId)
    .slice(0, REWIND_MAX_MESSAGES)
}

// Project state right before M's turn: merges the checkpoints of M and every
// later user message. First-seen wins per file, since a file's originalContent
// in a later checkpoint is its state after M only if M did not touch it.
export async function getRewindCheckpoint(
  projectId,
  userId,
  chatId,
  userMessageId,
  { userMessageIds } = {}
) {
  if (!isValidUserMessageId(userMessageId)) return null

  const ids = await rewindMessageIds(
    projectId,
    userId,
    chatId,
    userMessageId,
    userMessageIds
  )

  const files = {}
  const seen = new Set()
  for (const id of ids) {
    const checkpoint = await getCheckpoint(projectId, userId, chatId, id)
    for (const [filePath, fileInfo] of Object.entries(checkpoint?.files || {})) {
      const key = normalizeFilePath(filePath)
      if (seen.has(key)) continue
      seen.add(key)
      files[filePath] = fileInfo
    }
  }

  if (Object.keys(files).length === 0) return null
  return { userMessageId, files }
}

function extractFileContent(val) {
  if (val === null || val === undefined) return null
  if (typeof val === 'string') return val
  if (Array.isArray(val?.lines)) return val.lines.join('\n')
  if (typeof val?.content === 'string') return val.content
  return String(val)
}

function getFileContent(currentFiles, targetPath) {
  if (!currentFiles || typeof currentFiles !== 'object') return null
  const norm = targetPath.replace(/^\//, '')
  if (currentFiles[norm] !== undefined) return extractFileContent(currentFiles[norm])
  if (currentFiles['/' + norm] !== undefined) return extractFileContent(currentFiles['/' + norm])
  if (currentFiles[targetPath] !== undefined) return extractFileContent(currentFiles[targetPath])
  return null
}

export async function checkRewind(
  projectId,
  userId,
  chatId,
  userMessageId,
  currentFiles = {},
  { userMessageIds } = {}
) {
  const checkpoint = await getRewindCheckpoint(
    projectId,
    userId,
    chatId,
    userMessageId,
    { userMessageIds }
  )
  if (!checkpoint) {
    return {
      canRewind: false,
      filesChanged: [],
      insertions: 0,
      deletions: 0,
    }
  }

  const filesChanged = []
  let insertions = 0
  let deletions = 0

  for (const [filePath, fileInfo] of Object.entries(checkpoint.files)) {
    const originalContent = fileInfo?.originalContent ?? ''
    const isNew = Boolean(fileInfo?.isNew)
    const currentContent = getFileContent(currentFiles, filePath)

    if (isNew) {
      if (currentContent !== null) {
        filesChanged.push(filePath)
        const lines = currentContent === '' ? 0 : currentContent.split('\n').length
        insertions += lines
      }
    } else {
      if (currentContent !== null) {
        if (originalContent !== currentContent) {
          filesChanged.push(filePath)
          const diff = computeLineDiff(originalContent, currentContent)
          insertions += diff.insertions
          deletions += diff.deletions
        }
      } else {
        filesChanged.push(filePath)
        const lines = originalContent === '' ? 0 : originalContent.split('\n').length
        deletions += lines
      }
    }
  }

  return {
    canRewind: filesChanged.length > 0,
    filesChanged,
    insertions,
    deletions,
  }
}

export async function deleteChatCheckpoints(projectId, userId, chatId) {
  try {
    const dir = dirFor(projectId, userId, chatId)
    await fs.rm(dir, { recursive: true, force: true })
  } catch (err) {
    if (err.code === 'ENOENT') return
    if (err.message?.includes('invalid')) return
    throw err
  }
}

// Copies checkpoints of a forked chat so its code can still be rewound.
export async function copyCheckpoints(
  projectId,
  userId,
  fromChatId,
  toChatId,
  userMessageIds
) {
  if (fromChatId === toChatId) return []
  if (!isValidChatId(fromChatId) || !isValidChatId(toChatId)) return []
  if (!Array.isArray(userMessageIds)) return []

  const copied = []
  const ids = [...new Set(userMessageIds.filter(isValidUserMessageId))]
  for (const id of ids.slice(0, REWIND_MAX_MESSAGES)) {
    const checkpoint = await getCheckpoint(projectId, userId, fromChatId, id)
    if (!checkpoint) continue
    const file = fileFor(projectId, userId, toChatId, id)
    await withAiAssistFileLock(file, () =>
      writeCheckpoint(file, { ...checkpoint, chatId: toChatId })
    )
    copied.push(id)
  }
  return copied
}

export default {
  baseDir,
  saveCheckpoint,
  getCheckpoint,
  listCheckpoints,
  getRewindCheckpoint,
  checkRewind,
  deleteChatCheckpoints,
  copyCheckpoints,
  isValidChatId,
  isValidUserMessageId,
}
