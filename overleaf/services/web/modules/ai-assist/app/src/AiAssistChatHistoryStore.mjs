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
const MAX_TITLE_CHARS = 120

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

export function titleFor(transcript) {
  const firstUser = transcript.find(
    entry => entry?.role === 'user' && typeof entry.text === 'string' && entry.text.trim()
  )
  const text = firstUser ? firstUser.text.trim().replace(/\s+/g, ' ') : ''
  return text.length > MAX_TITLE_CHARS
    ? `${text.slice(0, MAX_TITLE_CHARS - 1)}…`
    : text
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
    mode: normalizeMode(chat.mode),
  }
}

async function saveChat(projectId, userId, chatId, transcript, mode = 'manual') {
  const file = fileFor(projectId, userId, chatId)
  const existing = await readChat(file).catch(() => null)
  const now = Date.now()
  const chat = {
    id: chatId,
    projectId: String(projectId),
    userId: String(userId),
    title: titleFor(transcript),
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

async function deleteChat(projectId, userId, chatId) {
  await fs.rm(fileFor(projectId, userId, chatId), { force: true })
}

export default { listChats, getChat, saveChat, deleteChat }
