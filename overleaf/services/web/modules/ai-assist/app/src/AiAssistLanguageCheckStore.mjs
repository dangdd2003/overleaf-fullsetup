import fs from 'node:fs/promises'
import Path from 'node:path'
import crypto from 'node:crypto'
import logger from '@overleaf/logger'
import { baseDir } from './AiAssistChatHistoryStore.mjs'
import { createLocalLock } from './AiAssistFileLock.mjs'

// Language-check results shared by everyone working on a project, so a
// sentence one collaborator's model checked is not sent again for another
// using the same model. One JSON file per project, next to the chat history:
//   <chatHistoryDir>/language-checks/<projectId>.json
// Keys name the model, the English variant, the prompt version and a hash of
// the sentence (language-suggestions/cache.ts); values are its edits, the text
// they were made for and the contexts it was checked in. Dismissals are each
// author's own and are not stored here.

const OBJECT_ID = /^[0-9a-f]{24}$/i
/** The entries a project keeps, most recently stored first kept. */
export const MAX_ENTRIES = 10000
/** Serialized size a project keeps: the oldest results go past it, bounding file, memory and lookup size. */
export const MAX_PROJECT_CHARS = 8 * 1024 * 1024
export const MAX_LOOKUP_KEYS = 500
/**
 * Serialized size a lookup answers with. Results past it are left out: the
 * client treats a missing key as unchecked and has the model check it.
 */
export const MAX_LOOKUP_CHARS = 1024 * 1024
export const MAX_STORE_ENTRIES = 100
const MAX_KEY = 400
const MAX_EDITS = 40
const MAX_EDIT_TEXT = 2000
const MAX_TEXT = 10000
const MAX_CONTEXTS = 4
const MAX_CONTEXT = 2000

function fileFor(projectId) {
  if (!OBJECT_ID.test(String(projectId))) throw new Error('invalid project id')
  return Path.join(baseDir(), 'language-checks', `${projectId}.json`)
}

export function isValidKey(key) {
  return typeof key === 'string' && key.length > 0 && key.length <= MAX_KEY
}

function validEdit(edit) {
  return (
    edit &&
    typeof edit === 'object' &&
    Number.isInteger(edit.from) &&
    Number.isInteger(edit.to) &&
    edit.from >= 0 &&
    edit.to >= edit.from &&
    typeof edit.insert === 'string' &&
    typeof edit.original === 'string' &&
    edit.insert.length <= MAX_EDIT_TEXT &&
    edit.original.length <= MAX_EDIT_TEXT
  )
}

/** A stored result, or null when it is malformed or too big. */
export function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null
  const { edits, text, contexts } = raw
  if (!Array.isArray(edits) || edits.length > MAX_EDITS || !edits.every(validEdit)) {
    return null
  }
  if (text !== undefined && (typeof text !== 'string' || text.length > MAX_TEXT)) {
    return null
  }
  if (
    contexts !== undefined &&
    (!Array.isArray(contexts) ||
      contexts.length > MAX_CONTEXTS ||
      !contexts.every(c => typeof c === 'string' && c.length <= MAX_CONTEXT))
  ) {
    return null
  }
  // Each edit replaces a part of the checked text, so it must occur in it.
  // (A result without its text cannot be checked and is kept as sent.)
  if (
    text !== undefined &&
    !edits.every(edit => edit.original === '' || text.includes(edit.original))
  ) {
    return null
  }
  return {
    edits: edits.map(({ from, to, insert, original, kind }) => ({
      from,
      to,
      insert,
      original,
      // grammar or style; older results have none and are corrections
      ...(kind === 'style' || kind === 'grammar' ? { kind } : {}),
    })),
    ...(text !== undefined ? { text } : {}),
    ...(contexts !== undefined ? { contexts } : {}),
  }
}

// Writes to one project's file wait their turn. The lock is in-process only:
// every web process keeps its own open projects in memory, so this store
// assumes one web process writes a project's file at a time (as the
// deployment runs). Cross-process locking would not make the in-memory
// copies agree, so it is not added here.
const withFileLock = createLocalLock()

/** Keys are stored as own properties only: a key such as `__proto__` must not reach a prototype. */
function ownMap(source) {
  const map = Object.create(null)
  if (source && typeof source === 'object') Object.assign(map, source)
  return map
}

/**
 * Moves a file that does not parse aside (<name>.corrupt-<ts>), so it is kept
 * for inspection and the next write starts clean. Under the file's lock, and
 * only if it is still unreadable: a write that landed meanwhile is left alone.
 */
async function quarantine(file) {
  return withFileLock(file, async () => {
    let text
    try {
      text = await fs.readFile(file, 'utf8')
    } catch (err) {
      if (err.code === 'ENOENT') return
      throw err
    }
    try {
      JSON.parse(text)
      return
    } catch {}
    const aside = `${file}.corrupt-${Date.now()}`
    try {
      await fs.rename(file, aside)
      logger.warn({ file, aside }, '[AiAssist] language check file was corrupt; moved aside')
    } catch (err) {
      // Not movable: the next write replaces it all the same
      logger.warn({ err, file }, '[AiAssist] corrupt language check file not moved')
    }
  })
}

async function readFile(file) {
  let text
  let stat
  try {
    ;[text, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)])
  } catch (err) {
    if (err.code === 'ENOENT') return { entries: ownMap(null), mtimeMs: 0 }
    throw err
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    await quarantine(file)
    return { entries: ownMap(null), mtimeMs: 0 }
  }
  return { entries: ownMap(parsed?.entries), mtimeMs: stat.mtimeMs }
}

async function mtimeOf(file) {
  try {
    return (await fs.stat(file)).mtimeMs
  } catch (err) {
    if (err.code === 'ENOENT') return 0
    throw err
  }
}

/** Saves arriving together (one check's batches) are written once. */
export const FLUSH_DELAY_MS = 2000
/** Projects whose results stay parsed in memory: a count, and the text they hold once parsed. */
const MAX_OPEN_PROJECTS = 20
const MAX_OPEN_CHARS = 64 * 1024 * 1024

/**
 * Each entry's serialized size and their total, kept with the project so a
 * store does not serialize the whole project again.
 */
function measure(entries) {
  const sizes = new Map()
  let chars = 0
  for (const key of Object.keys(entries)) {
    const size = JSON.stringify(entries[key]).length
    sizes.set(key, size)
    chars += size
  }
  return { sizes, chars }
}

export class AiAssistLanguageCheckStore {
  constructor() {
    /** projectId → { entries, sizes, chars, mtimeMs, dirty, timer } */
    this.open = new Map()
  }

  /** A project's results, parsed once and read again only when the file changed. */
  async load(projectId) {
    const id = String(projectId)
    const file = fileFor(id)
    const cached = this.open.get(id)
    if (cached && (cached.dirty || (await mtimeOf(file)) === cached.mtimeMs)) {
      this.open.delete(id)
      this.open.set(id, cached)
      return cached
    }
    const { entries, mtimeMs } = await readFile(file)
    // Another call may have loaded, or stored into, this project while the
    // file was read. Its object is the one the timer flushes, so a store made
    // into a replaced object would never be written.
    const existing = this.open.get(id)
    if (existing) {
      if (!existing.dirty) {
        existing.entries = entries
        existing.mtimeMs = mtimeMs
        Object.assign(existing, measure(entries))
      }
      this.open.delete(id)
      this.open.set(id, existing)
      return existing
    }
    const loaded = {
      entries,
      mtimeMs,
      dirty: false,
      timer: null,
      ...measure(entries),
    }
    this.open.set(id, loaded)
    await this.evict(id)
    return loaded
  }

  /** Characters the open projects hold in all, as parsed. */
  openChars() {
    let chars = 0
    for (const project of this.open.values()) chars += project.chars
    return chars
  }

  async evict(skipId = null) {
    for (const key of [...this.open.keys()]) {
      if (
        this.open.size <= MAX_OPEN_PROJECTS &&
        this.openChars() <= MAX_OPEN_CHARS
      ) {
        break
      }
      if (key === skipId && this.open.size > 1) continue
      try {
        await this.flush(key)
      } catch {
        continue
      }
      const current = this.open.get(key)
      if (current && !current.dirty) {
        this.open.delete(key)
      }
    }
  }

  /** The stored results among `keys`. */
  async lookup(projectId, keys) {
    const id = String(projectId)
    const { entries } = await this.load(id)
    const found = Object.create(null)
    let chars = 0
    for (const key of keys) {
      if (!isValidKey(key) || !Object.hasOwn(entries, key)) continue
      const entry = normalizeEntry(entries[key])
      if (!entry) continue
      chars += key.length + JSON.stringify(entry).length
      if (chars > MAX_LOOKUP_CHARS) break
      found[key] = entry
    }
    return found
  }

  /** Forgets a project's results, in memory and on disk. Safe to repeat. */
  async remove(projectId) {
    const id = String(projectId)
    const file = fileFor(id)
    const project = this.open.get(id)
    if (project) {
      if (project.timer) clearTimeout(project.timer)
      project.timer = null
      project.dirty = false
      this.open.delete(id)
    }
    await withFileLock(file, () => fs.rm(file, { force: true }))
  }

  /** Adds results, written shortly after; the oldest are dropped past `MAX_ENTRIES`. */
  async store(projectId, items) {
    if (items.length === 0) return
    const id = String(projectId)
    const project = await this.load(id)
    for (const { key, entry } of items) {
      // Re-inserted last: insertion order is the age order
      delete project.entries[key]
      project.entries[key] = entry
      const size = JSON.stringify(entry).length
      project.chars += size - (project.sizes.get(key) ?? 0)
      project.sizes.set(key, size)
    }
    // Oldest first out, until the project is within its count and size budget
    if (
      project.sizes.size > MAX_ENTRIES ||
      project.chars > MAX_PROJECT_CHARS
    ) {
      const keys = Object.keys(project.entries)
      for (let drop = 0; drop < keys.length - 1; drop++) {
        if (
          keys.length - drop <= MAX_ENTRIES &&
          project.chars <= MAX_PROJECT_CHARS
        ) {
          break
        }
        project.chars -= project.sizes.get(keys[drop])
        project.sizes.delete(keys[drop])
        delete project.entries[keys[drop]]
      }
    }
    project.dirty = true
    if (!project.timer) {
      project.timer = setTimeout(() => {
        this.flush(id).catch(() => {})
      }, FLUSH_DELAY_MS)
      project.timer.unref?.()
    }
    if (this.openChars() > MAX_OPEN_CHARS) {
      await this.evict(id)
    }
  }

  /** Writes a project's unsaved results now. */
  async flush(projectId) {
    const id = String(projectId)
    const project = this.open.get(id)
    if (!project) return
    if (project.timer) clearTimeout(project.timer)
    project.timer = null
    if (!project.dirty) return
    const file = fileFor(id)
    await withFileLock(file, async () => {
      // Removed while waiting for the lock: its results must not come back
      if (this.open.get(id) !== project) return
      await fs.mkdir(Path.dirname(file), { recursive: true })
      // Snapshot and clear `dirty` in the same tick: a store landing during
      // the write sets it again, so the next flush saves it.
      const snapshot = JSON.stringify({ entries: project.entries })
      project.dirty = false
      // Write-then-rename so a crash mid-write never leaves a truncated file.
      const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`
      try {
        await fs.writeFile(tmp, snapshot)
        await fs.rename(tmp, file)
      } catch (err) {
        project.dirty = true
        await fs.rm(tmp, { force: true }).catch(() => {})
        throw err
      }
      project.mtimeMs = await mtimeOf(file)
    })
  }
}

const store = new AiAssistLanguageCheckStore()
export default store
