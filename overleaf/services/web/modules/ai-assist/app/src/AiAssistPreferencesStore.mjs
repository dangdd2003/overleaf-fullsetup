import fs from 'node:fs/promises'
import Path from 'node:path'
import crypto from 'node:crypto'
import { baseDir } from './AiAssistChatHistoryStore.mjs'
import { REASONING_EFFORTS } from './AiAssistProviders.mjs'

// One JSON file per user, next to the chat history:
//   <chatHistoryDir>/preferences/<userId>.json
// It holds the composer's effort level and thinking switch per provider type,
// so they follow the user to any browser.

const OBJECT_ID = /^[0-9a-f]{24}$/i

function fileFor(userId) {
  if (!OBJECT_ID.test(String(userId))) throw new Error('invalid user id')
  return Path.join(baseDir(), 'preferences', `${userId}.json`)
}

/** Keeps known provider types only, each with a level that provider takes. */
export function normalizePreferences(raw) {
  const reasoningEffort = {}
  const thinking = {}
  for (const [type, levels] of Object.entries(REASONING_EFFORTS)) {
    const effort = raw?.reasoningEffort?.[type]
    if (levels.includes(effort)) reasoningEffort[type] = effort
    if (typeof raw?.thinking?.[type] === 'boolean') {
      thinking[type] = raw.thinking[type]
    }
  }
  return { reasoningEffort, thinking }
}

/** The saved preferences, or null if this user never saved any. */
async function get(userId) {
  try {
    const raw = JSON.parse(await fs.readFile(fileFor(userId), 'utf8'))
    return normalizePreferences(raw)
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

async function save(userId, preferences) {
  const file = fileFor(userId)
  const normalized = normalizePreferences(preferences)
  await fs.mkdir(Path.dirname(file), { recursive: true })
  // Write-then-rename so a crash mid-write never leaves a truncated file.
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`
  await fs.writeFile(tmp, JSON.stringify(normalized))
  await fs.rename(tmp, file)
  return normalized
}

export default { get, save }
