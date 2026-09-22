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

function baseDir() {
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
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  if (lines.length === 0) return ''
  let title = lines[0]

  // 2. Strip surrounding quotation marks, backticks, and markdown markers first
  title = title.replace(/^["'`“”‘’*#_`]+|["'`“”‘’*#_`]+$/g, '').trim()

  // 3. Strip common AI prefix labels like "Title:", "Chat title:", "Topic:", "Name:"
  title = title.replace(/^(?:chat\s+)?(?:title|topic|summary|name)\s*:\s*/i, '').trim()

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
  return str.replace(/\w\S*/g, txt => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase())
}

export function reorganizePromptToTitle(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) return 'New chat'
  const text = rawText.trim().split(/\r?\n/)[0].replace(/\s+/g, ' ').trim()

  // 1. "Edit <file> to <action>..." -> "<Action> in <file>"
  const editMatch = text.match(/^Edit\s+([^\s,]+)\s+to\s+([^,.;]+)/i)
  if (editMatch) {
    const file = editMatch[1]
    const action = editMatch[2].replace(/\b(and fix grammar|with minimal.*)\b/ig, '').trim()
    return sanitizeChatTitle(`${toTitleCase(action)} in ${file}`)
  }

  // 2. "Scan (this project|...) for <target>..." -> "Scan for <Target>"
  const scanMatch = text.match(/^Scan(?:\s+this\s+project)?\s+for\s+([^,.;]+)/i)
  if (scanMatch) {
    const target = scanMatch[1].replace(/\b(that lack.*|statements, claims, or assertions)\b/ig, 'Unsupported Statements').trim()
    return sanitizeChatTitle(`Scan for ${toTitleCase(target)}`)
  }

  // 3. "Inspect (the )?compile log and (resolve|fix) (the )?(.*)" -> "Resolve Compile Errors"
  const inspectCompileMatch = text.match(/^Inspect\s+(?:the\s+)?compile\s+log\s+and\s+(?:resolve|fix)/i)
  if (inspectCompileMatch) {
    return 'Resolve Compile Errors'
  }

  // 4. "Inspect (the )?build warnings and (resolve|fix) (.*)" -> "Resolve Build Warnings"
  const inspectWarnMatch = text.match(/^Inspect\s+(?:the\s+)?build\s+warnings/i)
  if (inspectWarnMatch) {
    return 'Resolve Build Warnings'
  }

  // 5. "Draft (and append )?(a )?(concise )?(\d+-word )?([^\s,]+)(?:.*?)of\s+([^\s,]+)" -> "Draft <Section> in <File>"
  const draftMatch = text.match(/^Draft(?:\s+and\s+append)?(?:\s+a)?(?:\s+concise)?(?:\s+\d+-word)?\s+([^\s,]+)(?:.*?)(?:in\s+the\s+[^\s,]+\s+environment\s+of|of|in|to)\s+([^\s,]+)/i)
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
    .replace(/^(?:could\s+you\s+)?(?:i\s+want\s+to\s+)?(?:i\s+need\s+to\s+)?/i, '')
    .replace(/\b(highlighting how you can help.*|with minimal.*|preserving all.*)\b/ig, '')
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
  const chats = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    let chat
    try {
      chat = await readChat(Path.join(dir, name))
    } catch {
      continue // a corrupt file must not hide the rest of the history
    }
    if (!chat) continue
    chats.push({
      id: chat.id,
      title: chat.title,
      titleGenerated: Boolean(chat.titleGenerated),
      mode: normalizeMode(chat.mode),
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
      messageCount: Array.isArray(chat.transcript) ? chat.transcript.length : 0,
    })
  }
  return chats.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
}

async function getChat(projectId, userId, chatId) {
  const chat = await readChat(fileFor(projectId, userId, chatId))
  if (!chat) return null
  return {
    ...chat,
    titleGenerated: Boolean(chat.titleGenerated),
    mode: normalizeMode(chat.mode),
  }
}

async function saveChat(
  projectId,
  userId,
  chatId,
  transcript,
  mode = 'manual',
  title = null,
  titleGenerated = undefined
) {
  const file = fileFor(projectId, userId, chatId)
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

  const chat = {
    id: chatId,
    projectId: String(projectId),
    userId: String(userId),
    title: finalTitle,
    titleGenerated: isGenerated,
    mode: normalizeMode(mode || existing?.mode),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    transcript,
  }
  await fs.mkdir(Path.dirname(file), { recursive: true })
  // Write-then-rename so a crash mid-write never leaves a truncated file.
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`
  await fs.writeFile(tmp, JSON.stringify(chat))
  await fs.rename(tmp, file)
  const { transcript: _omit, ...summary } = chat
  return { ...summary, messageCount: transcript.length }
}

async function saveChatTitle(projectId, userId, chatId, title, isGenerated = true) {
  const cleanTitle = sanitizeChatTitle(title) || 'New chat'
  const file = fileFor(projectId, userId, chatId)
  const existing = await readChat(file).catch(() => null)
  const now = Date.now()
  if (!existing) {
    const chat = {
      id: chatId,
      projectId: String(projectId),
      userId: String(userId),
      title: cleanTitle,
      titleGenerated: Boolean(isGenerated),
      mode: 'manual',
      createdAt: now,
      updatedAt: now,
      transcript: [],
    }
    await fs.mkdir(Path.dirname(file), { recursive: true })
    const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`
    await fs.writeFile(tmp, JSON.stringify(chat))
    await fs.rename(tmp, file)
    const { transcript: _omit, ...summary } = chat
    return { ...summary, messageCount: 0 }
  }
  existing.title = cleanTitle
  existing.titleGenerated = true
  existing.updatedAt = now
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`
  await fs.writeFile(tmp, JSON.stringify(existing))
  await fs.rename(tmp, file)
  const { transcript: _omit, ...summary } = existing
  return {
    ...summary,
    messageCount: Array.isArray(existing.transcript) ? existing.transcript.length : 0,
  }
}

async function deleteChat(projectId, userId, chatId) {
  await fs.rm(fileFor(projectId, userId, chatId), { force: true })
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
}
