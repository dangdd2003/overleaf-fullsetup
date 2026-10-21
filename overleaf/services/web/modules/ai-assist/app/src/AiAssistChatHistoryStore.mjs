import fs from 'node:fs/promises'
import Path from 'node:path'
import crypto from 'node:crypto'
import Settings from '@overleaf/settings'
import './ModuleSettings.mjs'
import { normalizeMode } from './AiAssistModePolicy.mjs'
import { deleteChatCheckpoints } from './AiAssistCheckpointStore.mjs'
import { withAiAssistFileLock } from './AiAssistFileLock.mjs'
import logger from '@overleaf/logger'

// One JSON file per conversation, grouped like clsi's compiles/output dirs:
//   <chatHistoryDir>/<projectId>-<userId>/<chatId>.json
// The default dir lives under /var/lib/overleaf/data so a backup of the
// data volume carries the chat history with it.

const OBJECT_ID = /^[0-9a-f]{24}$/i
const CHAT_ID = /^[A-Za-z0-9_-]{1,64}$/

export function isValidChatId(chatId) {
  return typeof chatId === 'string' && CHAT_ID.test(chatId)
}

export function baseDir() {
  return Settings.aiAssist?.chatHistoryDir || '/var/lib/overleaf/data/ai-assist'
}

function dirFor(projectId, userId) {
  if (!OBJECT_ID.test(String(projectId)) || !OBJECT_ID.test(String(userId))) {
    throw new Error('invalid project or user id')
  }
  return Path.join(baseDir(), `${projectId}-${userId}`)
}

function fileFor(projectId, userId, chatId) {
  if (!isValidChatId(chatId)) throw new Error('invalid chat id')
  return Path.join(dirFor(projectId, userId), `${chatId}.json`)
}

export function sanitizeChatTitle(raw) {
  if (typeof raw !== 'string') return ''
  // 1. Take first non-empty line
  const lines = raw
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
  if (lines.length === 0) return ''
  let title = lines[0]

  // 2. Strip surrounding quotation marks, backticks, and markdown markers first
  title = title.replace(/^["'`“”‘’*#_`]+|["'`“”‘’*#_`]+$/g, '').trim()

  // 3. Strip common AI prefix labels like "Title:", "Chat title:", "Topic:", "Name:"
  title = title
    .replace(/^(?:chat\s+)?(?:title|topic|summary|name)\s*:\s*/i, '')
    .trim()

  // 4. Strip surrounding quotes or markdown again if they were inside the label
  title = title.replace(/^["'`“”‘’*#_`]+|["'`“”‘’*#_`]+$/g, '').trim()

  // 5. Strip trailing punctuation
  title = title.replace(/[.,:;!?]+$/, '').trim()

  // 6. Replace multiple whitespace with a single space
  title = title.replace(/\s+/g, ' ')

  // 7. Max length clamp (60 chars)
  if (title.length > 60) {
    const trimmed = title.slice(0, 60).trim()
    const lastSpace = trimmed.lastIndexOf(' ')
    title = lastSpace > 20 ? trimmed.slice(0, lastSpace) : trimmed
  }

  return title
}

function toTitleCase(str) {
  return str.replace(
    /\w\S*/g,
    txt => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase()
  )
}

export function reorganizePromptToTitle(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) return 'New chat'
  const text = rawText.trim().split(/\r?\n/)[0].replace(/\s+/g, ' ').trim()

  // 1. "Edit <file> to <action>..." -> "<Action> in <file>"
  const editMatch = text.match(/^Edit\s+([^\s,]+)\s+to\s+([^,.;]+)/i)
  if (editMatch) {
    const file = editMatch[1]
    const action = editMatch[2]
      .replace(/\b(and fix grammar|with minimal.*)\b/gi, '')
      .trim()
    return sanitizeChatTitle(`${toTitleCase(action)} in ${file}`)
  }

  // 2. "Scan (this project|...) for <target>..." -> "Scan for <Target>"
  const scanMatch = text.match(/^Scan(?:\s+this\s+project)?\s+for\s+([^,.;]+)/i)
  if (scanMatch) {
    const target = scanMatch[1]
      .replace(
        /\b(that lack.*|statements, claims, or assertions)\b/gi,
        'Unsupported Statements'
      )
      .trim()
    return sanitizeChatTitle(`Scan for ${toTitleCase(target)}`)
  }

  // 3. "Inspect (the )?compile log and (resolve|fix) (the )?(.*)" -> "Resolve Compile Errors"
  const inspectCompileMatch = text.match(
    /^Inspect\s+(?:the\s+)?compile\s+log\s+and\s+(?:resolve|fix)/i
  )
  if (inspectCompileMatch) {
    return 'Resolve Compile Errors'
  }

  // 4. "Inspect (the )?build warnings and (resolve|fix) (.*)" -> "Resolve Build Warnings"
  const inspectWarnMatch = text.match(/^Inspect\s+(?:the\s+)?build\s+warnings/i)
  if (inspectWarnMatch) {
    return 'Resolve Build Warnings'
  }

  // 5. "Draft (and append )?(a )?(concise )?(\d+-word )?([^\s,]+)(?:.*?)of\s+([^\s,]+)" -> "Draft <Section> in <File>"
  const draftMatch = text.match(
    /^Draft(?:\s+and\s+append)?(?:\s+a)?(?:\s+concise)?(?:\s+\d+-word)?\s+([^\s,]+)(?:.*?)(?:in\s+the\s+[^\s,]+\s+environment\s+of|of|in|to)\s+([^\s,]+)/i
  )
  if (draftMatch) {
    const section = draftMatch[1]
    const file = draftMatch[2]
    return sanitizeChatTitle(`Draft ${toTitleCase(section)} in ${file}`)
  }

  // 6. "Read <file> and draw (.*) as a TikZ figure..." -> "Draw TikZ Figure for <file>"
  const tikzMatch = text.match(/^Read\s+([^\s,]+)\s+and\s+draw/i)
  if (tikzMatch) {
    return sanitizeChatTitle(`Draw TikZ Figure for ${tikzMatch[1]}`)
  }

  // 7. General prompt: strip filler words, drop mid-phrase punctuation so a
  // 5-word slice never ends on a dangling comma, then take a clean title.
  const cleaned = text
    .replace(/^(?:please\s+)?(?:can\s+you\s+)?(?:help\s+me\s+)?(?:to\s+)?/i, '')
    .replace(
      /^(?:could\s+you\s+)?(?:i\s+want\s+to\s+)?(?:i\s+need\s+to\s+)?/i,
      ''
    )
    .replace(
      /\b(highlighting how you can help.*|with minimal.*|preserving all.*)\b/gi,
      ''
    )
    .replace(/[,:;]/g, '')
    .trim()

  const words = cleaned.split(' ').slice(0, 5).join(' ')
  return sanitizeChatTitle(toTitleCase(words))
}

export function fallbackTitleFor(transcript) {
  const firstUser = Array.isArray(transcript)
    ? transcript.find(
        entry =>
          entry?.role === 'user' &&
          typeof entry?.text === 'string' &&
          entry.text.trim()
      )
    : null
  if (!firstUser) return 'New chat'
  return reorganizePromptToTitle(firstUser.text)
}

export function titleFor(transcript, existingTitle = null) {
  if (typeof existingTitle === 'string' && existingTitle.trim()) {
    return sanitizeChatTitle(existingTitle)
  }
  return fallbackTitleFor(transcript)
}

/** A tool result the panel cut down to keep its local copy small. */
function isShrunkResult(result) {
  return Boolean(result && typeof result === 'object' && result._shrunk)
}

// Bounds on a stored compact entry (see AiAssistCompaction.mjs): the summary
// and the ledger as JSON. An entry past them is refused, never cut.
const COMPACT_SUMMARY_MAX_CHARS = 60_000
const COMPACT_LEDGER_MAX_CHARS = 200_000
export const COMPACT_INSTRUCTIONS_MAX_CHARS = 2000
// The edited-region excerpts the engine budgets by window (<=6% of it)
const COMPACT_EXCERPTS_MAX_CHARS = 250_000

/**
 * The reason a compact entry cannot be stored, or null when it can. Only the
 * fields the rebuilt conversation reads are checked; the rest is kept as sent.
 */
export function compactEntryProblem(entry) {
  if (typeof entry?.id !== 'string' || !entry.id) {
    return 'A compacted conversation needs an id.'
  }
  if (entry.trigger !== 'manual' && entry.trigger !== 'auto') {
    return 'A compacted conversation has an unknown trigger.'
  }
  if (typeof entry.summary !== 'string') {
    return 'A compacted conversation needs a summary.'
  }
  if (entry.summary.length > COMPACT_SUMMARY_MAX_CHARS) {
    return 'The compacted summary is too long.'
  }
  if (
    !entry.ledger ||
    typeof entry.ledger !== 'object' ||
    Array.isArray(entry.ledger)
  ) {
    return 'A compacted conversation needs a ledger.'
  }
  if (JSON.stringify(entry.ledger).length > COMPACT_LEDGER_MAX_CHARS) {
    return 'The compacted ledger is too long.'
  }
  if (
    entry.excerpts !== undefined &&
    (typeof entry.excerpts !== 'string' ||
      entry.excerpts.length > COMPACT_EXCERPTS_MAX_CHARS)
  ) {
    return 'The compacted excerpts are too long.'
  }
  if (entry.tailFromId !== undefined && typeof entry.tailFromId !== 'string') {
    return 'The kept tail of a compacted conversation is not an entry id.'
  }
  if (
    entry.instructions !== undefined &&
    (typeof entry.instructions !== 'string' ||
      entry.instructions.length > COMPACT_INSTRUCTIONS_MAX_CHARS)
  ) {
    return 'The compact instructions are too long.'
  }
  return null
}

/** The first problem with the compact entries of a transcript, or null. */
export function compactEntriesProblem(transcript) {
  if (!Array.isArray(transcript)) return null
  for (const entry of transcript) {
    if (entry?.role !== 'compact') continue
    const problem = compactEntryProblem(entry)
    if (problem) return problem
  }
  return null
}

export function countSteps(transcript) {
  if (!Array.isArray(transcript)) return 0
  let steps = 0
  for (const entry of transcript) {
    if (!entry) continue
    if (entry.role === 'user') {
      steps++
    } else if (entry.role === 'assistant') {
      const calls = Array.isArray(entry.toolCalls) ? entry.toolCalls.length : 0
      steps += Math.max(1, calls)
    }
  }
  return steps
}

export function totalDuration(transcript) {
  if (!Array.isArray(transcript)) return 0
  let total = 0
  for (const entry of transcript) {
    if (entry?.role === 'assistant' && typeof entry.durationMs === 'number') {
      total += entry.durationMs
    }
  }
  return total
}

function entriesMatch(a, b) {
  if (!a || !b) return false
  if (a.id && b.id && a.id === b.id) return true
  if (a.role !== b.role) return false
  if (a.role === 'compact') {
    // A compacted span is one unit: the same summary and time, or not the same
    return a.summary === b.summary && a.createdAt === b.createdAt
  }
  if (a.role === 'user') {
    return a.text === b.text
  }
  if (a.role === 'assistant') {
    if (
      Array.isArray(a.toolCalls) &&
      Array.isArray(b.toolCalls) &&
      a.toolCalls.length > 0 &&
      b.toolCalls.length > 0
    ) {
      if (a.toolCalls[0]?.id && b.toolCalls[0]?.id) {
        return a.toolCalls[0].id === b.toolCalls[0].id
      }
    }
    return Boolean(a.text && b.text && a.text === b.text)
  }
  return false
}

/**
 * Fills in what the panel's copy of a chat has lost from the chat's history
 * on disk, which keeps it whole, as Claude Code's session log does.
 *
 * Ensures:
 * 1. Shrunk tool call results are restored to full results by call ID.
 * 2. Dropped turns from the top of the transcript are restored and prepended.
 * 3. Never truncates or loses existing turns.
 */
export function hydrateTranscript(transcript, stored) {
  if (!Array.isArray(transcript) || transcript.length === 0) {
    return Array.isArray(stored) ? stored : []
  }
  if (!Array.isArray(stored) || stored.length === 0) {
    return transcript
  }

  // 1. Collect all whole tool call results from stored transcript
  const whole = new Map()
  for (const entry of stored) {
    if (entry?.role !== 'assistant') continue
    if (Array.isArray(entry.toolCalls)) {
      for (const call of entry.toolCalls) {
        if (call?.id && 'result' in call && !isShrunkResult(call.result)) {
          whole.set(call.id, call)
        }
      }
    }
    if (Array.isArray(entry.blocks)) {
      for (const block of entry.blocks) {
        if (
          block?.type === 'tool_call' &&
          block.call?.id &&
          'result' in block.call &&
          !isShrunkResult(block.call.result)
        ) {
          whole.set(block.call.id, block.call)
        }
      }
    }
  }

  const restore = call => {
    if (!call || !isShrunkResult(call.result) || !whole.has(call.id)) {
      return call
    }
    const { result, isError } = whole.get(call.id)
    return { ...call, result, isError, _shrunk: undefined }
  }

  let hydrated = transcript.map(entry => {
    if (entry?.role !== 'assistant') return entry
    return {
      ...entry,
      ...(Array.isArray(entry.toolCalls)
        ? { toolCalls: entry.toolCalls.map(restore) }
        : {}),
      ...(Array.isArray(entry.blocks)
        ? {
            blocks: entry.blocks.map(block =>
              block?.type === 'tool_call' && block.call
                ? { ...block, call: restore(block.call) }
                : block
            ),
          }
        : {}),
    }
  })

  // 2. Detect missing prefix from stored history
  const linesUpAt = at => {
    const overlap = Math.min(stored.length - at, hydrated.length)
    if (overlap <= 0) return false
    for (let i = 0; i < overlap; i++) {
      if (!entriesMatch(hydrated[i], stored[at + i])) {
        return false
      }
    }
    return true
  }

  // Check if hydrated starts at an offset within stored
  let matchedAt = -1
  for (let at = 1; at < stored.length; at++) {
    if (linesUpAt(at)) {
      matchedAt = at
      break
    }
  }

  if (matchedAt > 0) {
    hydrated = [...stored.slice(0, matchedAt), ...hydrated]
  } else if (stored.length > hydrated.length) {
    // Check if hydrated is a strict tail suffix of stored
    const tailOffset = stored.length - hydrated.length
    if (linesUpAt(tailOffset)) {
      hydrated = [...stored.slice(0, tailOffset), ...hydrated]
    }
  }

  return hydrated
}

/**
 * The transcript without an entry repeated right after itself: the same id,
 * role and text. A chat reopened while its run was going could store its
 * question twice, and every later run would send it twice.
 */
export function dropRepeatedEntries(transcript) {
  if (!Array.isArray(transcript)) return []
  return transcript.filter((entry, index) => {
    const previous = transcript[index - 1]
    return !(
      previous &&
      entry?.id &&
      entry.id === previous.id &&
      entry.role === previous.role &&
      entry.text === previous.text
    )
  })
}

// Every write to a chat's file reads it, merges and renames over it. Two of
// them interleaving (the panel's save, the run's own save, a generated title)
// Mutations of a project's chats (and its index file) queue per directory, here
// and across web processes, so the index never misses an update.
function withDirLock(dir, task) {
  return withAiAssistFileLock(dir, task)
}

const INDEX_FILE = '_index.json'

/**
 * The most chats a user keeps across all their projects. Past it, the least
 * recently updated are removed when a new chat is saved.
 */
export const MAX_CHATS_PER_USER = 200

/** The lightweight entry a chat keeps in its project's index, and listChats returns. */
function summaryOf(chat) {
  const transcript = Array.isArray(chat.transcript) ? chat.transcript : []
  return {
    id: chat.id,
    title: chat.title,
    titleGenerated: Boolean(chat.titleGenerated),
    mode: normalizeMode(chat.mode),
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    messageCount: transcript.length,
    totalSteps: chat.stats?.totalSteps ?? countSteps(transcript),
    durationMs: chat.stats?.durationMs ?? totalDuration(transcript),
  }
}

async function writeJsonAtomic(file, data) {
  await fs.mkdir(Path.dirname(file), { recursive: true })
  // Write-then-rename so a crash mid-write never leaves a truncated file.
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2))
  await fs.rename(tmp, file)
}

async function writeChat(file, chat) {
  await writeJsonAtomic(file, chat)
}

async function readChat(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

/** The chat files of a directory (not its index), by name. */
async function chatFileNames(dir) {
  try {
    const names = await fs.readdir(dir)
    return names.filter(name => name.endsWith('.json') && name !== INDEX_FILE)
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
}

/** The index as stored, or null when it is missing or unreadable. */
async function readIndexFile(dir) {
  try {
    const index = JSON.parse(
      await fs.readFile(Path.join(dir, INDEX_FILE), 'utf8')
    )
    return index && typeof index.chats === 'object' && index.chats ? index : null
  } catch {
    return null
  }
}

/** Builds the index from the chat files: the only time a transcript is read. */
async function rebuildIndex(dir) {
  // Read a few at a time: a project with many chats must not open them all at once
  const names = await chatFileNames(dir)
  const chats = {}
  for (let i = 0; i < names.length; i += INDEX_READ_CONCURRENCY) {
    const batch = await Promise.all(
      names
        .slice(i, i + INDEX_READ_CONCURRENCY)
        .map(name => readChat(Path.join(dir, name)).catch(() => null))
    )
    for (const chat of batch) {
      if (chat?.id) chats[chat.id] = summaryOf(chat)
    }
  }
  return { version: 1, chats }
}

const INDEX_READ_CONCURRENCY = 8

/**
 * The index of a project directory. Read without a lock when it exists; when
 * it is missing it is rebuilt under the directory's lock and kept.
 */
async function indexFor(dir) {
  const existing = await readIndexFile(dir)
  if (existing) return existing
  return withDirLock(dir, async () => {
    const again = await readIndexFile(dir)
    if (again) return again
    const rebuilt = await rebuildIndex(dir)
    if (Object.keys(rebuilt.chats).length > 0) {
      await writeJsonAtomic(Path.join(dir, INDEX_FILE), rebuilt)
    }
    return rebuilt
  })
}

/** Sets (or, with a null summary, removes) one chat's entry. Call under the directory's lock. */
async function setIndexEntry(dir, id, summary) {
  const index = (await readIndexFile(dir)) ?? (await rebuildIndex(dir))
  if (summary) index.chats[id] = summary
  else delete index.chats[id]
  await writeJsonAtomic(Path.join(dir, INDEX_FILE), index)
}

function newestFirst(a, b) {
  const byTime = (b.updatedAt || 0) - (a.updatedAt || 0)
  if (byTime !== 0) return byTime
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}

/** A page cursor names the last chat returned: `updatedAt|id`. */
const CURSOR = /^(\d{1,16})\|([A-Za-z0-9_-]{1,64})$/

export function isValidChatCursor(cursor) {
  return typeof cursor === 'string' && CURSOR.test(cursor)
}

/**
 * One page of a project's chats, newest first, from the index: no transcript
 * is read. `nextCursor` is null when this page is the last.
 */
async function listChatPage(
  projectId,
  userId,
  { cursor = null, limit = MAX_CHATS_PER_USER } = {}
) {
  const dir = dirFor(projectId, userId)
  const index = await indexFor(dir)
  const sorted = Object.values(index.chats).sort(newestFirst)
  let start = 0
  const match = cursor ? CURSOR.exec(cursor) : null
  if (match) {
    const after = { updatedAt: Number(match[1]), id: match[2] }
    // Everything sorting after the cursor's chat
    start = sorted.findIndex(
      chat =>
        (chat.updatedAt || 0) < after.updatedAt ||
        ((chat.updatedAt || 0) === after.updatedAt && chat.id < after.id)
    )
    if (start === -1) start = sorted.length
  }
  const size = Math.max(1, Math.min(Number(limit) || MAX_CHATS_PER_USER, MAX_CHATS_PER_USER))
  const chats = sorted.slice(start, start + size)
  const more = start + size < sorted.length
  const last = chats[chats.length - 1]
  return {
    chats,
    nextCursor:
      more && last ? `${last.updatedAt || 0}|${last.id}` : null,
  }
}

/** Every chat of the user, not only the one project's: for the per-user cap. */
async function userChatDirs(userId) {
  let names
  try {
    names = await fs.readdir(baseDir())
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
  const ownDir = new RegExp(`^([0-9a-f]{24})-${userId}$`, 'i')
  return names
    .map(name => ({ name, match: ownDir.exec(name) }))
    .filter(({ match }) => match)
    .map(({ name, match }) => ({
      dir: Path.join(baseDir(), name),
      projectId: match[1],
    }))
}

/**
 * Keeps the user to MAX_CHATS_PER_USER chats: the least recently updated are
 * removed (with their checkpoints). Runs after the save that made the excess,
 * outside its lock, since it touches other projects' directories too.
 */
async function enforceChatCap(userId, keep) {
  const entries = []
  for (const { dir, projectId } of await userChatDirs(userId)) {
    const index = await indexFor(dir)
    for (const chat of Object.values(index.chats)) {
      entries.push({ projectId, chatId: chat.id, updatedAt: chat.updatedAt || 0 })
    }
  }
  const excess = entries.length - MAX_CHATS_PER_USER
  if (excess <= 0) return
  const victims = entries
    .filter(
      entry =>
        !(entry.projectId === keep.projectId && entry.chatId === keep.chatId)
    )
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .slice(0, excess)
  for (const victim of victims) {
    await deleteChat(victim.projectId, userId, victim.chatId).catch(err =>
      logger.warn({ err }, '[AiAssist] could not evict an old chat')
    )
  }
}

async function getChat(projectId, userId, chatId) {
  const chat = await readChat(fileFor(projectId, userId, chatId))
  if (!chat) return null
  const transcript = dropRepeatedEntries(chat.transcript)
  return {
    version: chat.version || 2,
    ...chat,
    titleGenerated: Boolean(chat.titleGenerated),
    mode: normalizeMode(chat.mode),
    stats: chat.stats || {
      totalSteps: countSteps(transcript),
      durationMs: totalDuration(transcript),
    },
    transcript,
  }
}

async function saveChat(
  projectId,
  userId,
  chatId,
  transcript,
  mode = 'manual',
  title = null,
  titleGenerated = undefined,
  stats = null
) {
  const file = fileFor(projectId, userId, chatId)
  const dir = dirFor(projectId, userId)
  const { output, created } = await withDirLock(dir, async () => {
    const existing = await readChat(file).catch(() => null)
    const now = Date.now()

    let finalTitle
    let isGenerated = Boolean(existing?.titleGenerated)
    if (typeof titleGenerated === 'boolean') {
      isGenerated = titleGenerated
    }

    if (typeof title === 'string' && title.trim()) {
      finalTitle = sanitizeChatTitle(title)
    } else if (
      existing?.title &&
      existing.title !== 'New chat' &&
      existing.title !== 'Untitled chat'
    ) {
      finalTitle = existing.title
    } else {
      finalTitle = fallbackTitleFor(transcript)
    }

    transcript = dropRepeatedEntries(
      hydrateTranscript(transcript, dropRepeatedEntries(existing?.transcript))
    )

    // The counts come from the transcript being written, last, so the
    // client's stats cannot override them
    const finalStats = {
      ...(existing?.stats || {}),
      ...(stats || {}),
      totalSteps: countSteps(transcript),
      durationMs: totalDuration(transcript),
    }

    const chat = {
      version: 2,
      id: chatId,
      projectId: String(projectId),
      userId: String(userId),
      title: finalTitle,
      titleGenerated: isGenerated,
      mode: normalizeMode(mode || existing?.mode),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      stats: finalStats,
      transcript,
    }
    await writeChat(file, chat)
    const summary = summaryOf(chat)
    await setIndexEntry(dir, chatId, summary)
    const { transcript: _omit, ...rest } = chat
    return {
      output: {
        ...rest,
        messageCount: transcript.length,
        totalSteps: finalStats.totalSteps,
        durationMs: finalStats.durationMs,
      },
      created: !existing,
    }
  })
  if (created) {
    await enforceChatCap(userId, { projectId: String(projectId), chatId }).catch(
      err => logger.warn({ err }, '[AiAssist] chat cap not enforced')
    )
  }
  return output
}

/**
 * Sets the title of a chat that exists. Resolves null for one that does not:
 * a title arriving for a chat never saved, or deleted meanwhile, must not
 * leave an empty chat behind in the history.
 */
async function saveChatTitle(
  projectId,
  userId,
  chatId,
  title,
  isGenerated = true
) {
  const cleanTitle = sanitizeChatTitle(title) || 'New chat'
  const file = fileFor(projectId, userId, chatId)
  const dir = dirFor(projectId, userId)
  return withDirLock(dir, async () => {
    const existing = await readChat(file).catch(() => null)
    if (!existing) return null
    existing.title = cleanTitle
    existing.titleGenerated =
      Boolean(isGenerated) || Boolean(existing.titleGenerated)
    existing.updatedAt = Date.now()
    await writeChat(file, existing)
    await setIndexEntry(dir, chatId, summaryOf(existing))
    const { transcript: _omit, ...summary } = existing
    const transcript = Array.isArray(existing.transcript)
      ? existing.transcript
      : []
    return {
      ...summary,
      messageCount: transcript.length,
      totalSteps: existing.stats?.totalSteps ?? countSteps(transcript),
      durationMs: existing.stats?.durationMs ?? totalDuration(transcript),
    }
  })
}

export async function truncateChat(
  projectId,
  userId,
  chatId,
  userMessageId,
  { inclusive = true } = {}
) {
  const file = fileFor(projectId, userId, chatId)
  const dir = dirFor(projectId, userId)
  return withDirLock(dir, async () => {
    const chat = await readChat(file)
    if (!chat || !Array.isArray(chat.transcript)) return null

    const index = chat.transcript.findIndex(entry => entry?.id === userMessageId)
    if (index === -1) {
      return null
    }

    const endIndex = inclusive ? index + 1 : index
    chat.transcript = chat.transcript.slice(0, endIndex)
    const now = Date.now()
    chat.updatedAt = now
    chat.stats = {
      ...(chat.stats || {}),
      totalSteps: countSteps(chat.transcript),
      durationMs: totalDuration(chat.transcript),
    }

    await writeChat(file, chat)
    await setIndexEntry(dir, chatId, summaryOf(chat))
    return {
      version: chat.version || 2,
      ...chat,
      titleGenerated: Boolean(chat.titleGenerated),
      mode: normalizeMode(chat.mode),
    }
  })
}

async function deleteChat(projectId, userId, chatId) {
  const file = fileFor(projectId, userId, chatId)
  const dir = dirFor(projectId, userId)
  await withDirLock(dir, async () => {
    await fs.rm(file, { force: true })
    await setIndexEntry(dir, chatId, null)
  })
  try {
    await deleteChatCheckpoints(projectId, userId, chatId)
  } catch {
    // cleanup shouldn't fail chat deletion
  }
}

async function listChats(projectId, userId) {
  return (await listChatPage(projectId, userId)).chats
}

export default {
  listChats,
  listChatPage,
  getChat,
  saveChat,
  saveChatTitle,
  truncateChat,
  deleteChat,
  sanitizeChatTitle,
  reorganizePromptToTitle,
  fallbackTitleFor,
  titleFor,
  hydrateTranscript,
  dropRepeatedEntries,
  countSteps,
  totalDuration,
}
