import fs from 'node:fs/promises'
import Path from 'node:path'
import crypto from 'node:crypto'
import Settings from '@overleaf/settings'
import './ModuleSettings.mjs'
import { normalizeMode } from './AiAssistModePolicy.mjs'

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
// would let the later rename drop what the earlier one wrote, so writes to
// one file wait their turn (within this process). Different chats still write in parallel.
const fileLocks = new Map()

function withFileLock(file, task) {
  const previous = fileLocks.get(file) || Promise.resolve()
  const next = previous.catch(() => {}).then(task)
  const tail = next.catch(() => {})
  fileLocks.set(file, tail)
  tail.then(() => {
    if (fileLocks.get(file) === tail) fileLocks.delete(file)
  })
  return next
}

async function writeChat(file, chat) {
  await fs.mkdir(Path.dirname(file), { recursive: true })
  // Write-then-rename so a crash mid-write never leaves a truncated file.
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`
  await fs.writeFile(tmp, JSON.stringify(chat, null, 2))
  await fs.rename(tmp, file)
}

async function readChat(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

async function listChats(projectId, userId) {
  const dir = dirFor(projectId, userId)
  let names
  try {
    names = await fs.readdir(dir)
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
  // Read in parallel: a project with many chats opens its history in the
  // time of the slowest file, not the sum of them all
  const loaded = await Promise.all(
    names
      .filter(name => name.endsWith('.json'))
      // a corrupt file must not hide the rest of the history
      .map(name => readChat(Path.join(dir, name)).catch(() => null))
  )
  const chats = []
  for (const chat of loaded) {
    if (!chat?.id) continue
    const transcript = Array.isArray(chat.transcript) ? chat.transcript : []
    chats.push({
      id: chat.id,
      title: chat.title,
      titleGenerated: Boolean(chat.titleGenerated),
      mode: normalizeMode(chat.mode),
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
      messageCount: transcript.length,
      totalSteps: chat.stats?.totalSteps ?? countSteps(transcript),
      durationMs: chat.stats?.durationMs ?? totalDuration(transcript),
    })
  }
  return chats.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
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
  return withFileLock(file, async () => {
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

    // Counted from the transcript being written: the stored counts are of
    // an older copy of it and would never move on
    const finalStats = {
      ...(existing?.stats || {}),
      totalSteps: countSteps(transcript),
      durationMs: totalDuration(transcript),
      ...(stats || {}),
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
    const { transcript: _omit, ...summary } = chat
    return {
      ...summary,
      messageCount: transcript.length,
      totalSteps: finalStats.totalSteps,
      durationMs: finalStats.durationMs,
    }
  })
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
  return withFileLock(file, async () => {
    const existing = await readChat(file).catch(() => null)
    if (!existing) return null
    existing.title = cleanTitle
    existing.titleGenerated =
      Boolean(isGenerated) || Boolean(existing.titleGenerated)
    existing.updatedAt = Date.now()
    await writeChat(file, existing)
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

async function deleteChat(projectId, userId, chatId) {
  const file = fileFor(projectId, userId, chatId)
  await withFileLock(file, () => fs.rm(file, { force: true }))
}

export default {
  listChats,
  getChat,
  saveChat,
  saveChatTitle,
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
