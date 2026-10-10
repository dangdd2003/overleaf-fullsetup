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

const REPHRASE_LEVELS = ['low', 'medium', 'high']
const REPHRASE_STYLES = ['scientific', 'concise', 'punchy']
const REPHRASE_LENGTHS = ['shorten', 'lengthen']
const MAX_RECENT_LANGUAGES = 5
const ENGLISH_VARIANTS = ['en-US', 'en-GB']
const MODEL_SLOTS = ['main', 'fast']
const SUGGESTION_TYPES = ['all', 'grammar', 'style']
const MAX_BLOCKED = 500
const MAX_BLOCKED_TEXT = 200
const COMPLETION_MODES = ['disabled', 'manual', 'automatic']
const COMPLETION_DELAYS = [100, 200, 300, 400, 500, 600, 800, 1000]
const DEFAULT_COMPLETION_DELAY = 300

function collapseWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Language suggestions' settings and blocked list; undefined when none were
 * sent. Mirrors language-suggestions/preferences.ts in the frontend.
 */
function normalizeLanguageSuggestions(raw) {
  if (!raw || typeof raw !== 'object') return undefined
  const entries = Array.isArray(raw.blocked) ? raw.blocked : []
  const valid = []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    if (typeof entry.from !== 'string' || typeof entry.to !== 'string') continue
    const from = collapseWhitespace(entry.from)
    const to = collapseWhitespace(entry.to)
    if (!from && !to) continue
    if (from.length > MAX_BLOCKED_TEXT || to.length > MAX_BLOCKED_TEXT) continue
    const at =
      typeof entry.at === 'number' && Number.isFinite(entry.at) ? entry.at : 0
    valid.push({ from, to, at })
  }
  valid.sort((a, b) => b.at - a.at)
  const seen = new Set()
  const blocked = []
  for (const entry of valid) {
    const key = `${entry.from}\u0000${entry.to}`
    if (seen.has(key)) continue
    seen.add(key)
    blocked.push(entry)
    if (blocked.length === MAX_BLOCKED) break
  }
  return {
    enabled: raw.enabled === true,
    englishVariant: ENGLISH_VARIANTS.includes(raw.englishVariant)
      ? raw.englishVariant
      : 'en-US',
    model: MODEL_SLOTS.includes(raw.model) ? raw.model : null,
    blocked,
    types: SUGGESTION_TYPES.includes(raw.types) ? raw.types : 'all',
  }
}

/** The writing tools' remembered choices; undefined when none were sent. */
function normalizeWritingTools(raw) {
  if (!raw || typeof raw !== 'object') return undefined
  const recentLanguages = Array.isArray(raw.recentLanguages)
    ? raw.recentLanguages
        .filter(
          language =>
            typeof language === 'string' &&
            language.length > 0 &&
            language.length <= 40
        )
        .slice(0, MAX_RECENT_LANGUAGES)
    : []
  const rephrase = raw.rephrase ?? {}
  return {
    recentLanguages,
    rephrase: {
      level: REPHRASE_LEVELS.includes(rephrase.level)
        ? rephrase.level
        : 'medium',
      style: REPHRASE_STYLES.includes(rephrase.style) ? rephrase.style : null,
      length: REPHRASE_LENGTHS.includes(rephrase.length)
        ? rephrase.length
        : null,
    },
    showDiff: raw.showDiff !== false,
  }
}

/**
 * The inline AI shortcuts: the empty-line switch and the completion mode and
 * delay. A file from before the mode existed has `sentenceCompletion`, whose
 * `true` was today's Manual. Undefined when none were sent.
 */
function normalizeInlineSuggestions(raw) {
  if (!raw || typeof raw !== 'object') return undefined
  return {
    emptyLineShortcut: raw.emptyLineShortcut === true,
    completionMode: COMPLETION_MODES.includes(raw.completionMode)
      ? raw.completionMode
      : raw.sentenceCompletion === true
        ? 'manual'
        : 'disabled',
    completionDelayMs: COMPLETION_DELAYS.includes(raw.completionDelayMs)
      ? raw.completionDelayMs
      : DEFAULT_COMPLETION_DELAY,
  }
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
  const objects = {}
  for (const [name, normalize] of [
    ['writingTools', normalizeWritingTools],
    ['languageSuggestions', normalizeLanguageSuggestions],
    ['inlineSuggestions', normalizeInlineSuggestions],
  ]) {
    const value = normalize(raw?.[name])
    if (value) objects[name] = value
  }
  return { reasoningEffort, thinking, ...objects }
}

// Writes to one user's file wait their turn (within this process)
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

/** The saved preferences, or null if this user never saved any. */
async function get(userId) {
  const file = fileFor(userId)
  return withFileLock(file, async () => {
    try {
      const raw = JSON.parse(await fs.readFile(file, 'utf8'))
      return normalizePreferences(raw)
    } catch (err) {
      if (err.code === 'ENOENT') return null
      throw err
    }
  })
}

async function save(userId, preferences) {
  const file = fileFor(userId)
  const normalized = normalizePreferences(preferences)
  return withFileLock(file, async () => {
    await fs.mkdir(Path.dirname(file), { recursive: true })
    // Write-then-rename so a crash mid-write never leaves a truncated file.
    const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`
    await fs.writeFile(tmp, JSON.stringify(normalized))
    await fs.rename(tmp, file)
    return normalized
  })
}

export default { get, save }

