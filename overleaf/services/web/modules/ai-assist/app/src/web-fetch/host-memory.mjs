const MAX_HOSTS = 1000
const SKIP_DURATION_MS = 24 * 60 * 60 * 1000 // 24 hours

const NEVER_SKIPPED = new Set([
  'wayback',
  'archive.today',
  'arxiv',
  'github',
  'texexchange',
  'ctan',
  'wikipedia',
])

// owner + host -> Map<stepName, { at: number, reason: string }>. Per owner: one
// user's blocked or bot-checked host is not skipped for another user.
const hostMemory = new Map()

function memoryKey(owner, host) {
  return `${String(owner ?? 'default')}\n${String(host || '').toLowerCase()}`
}

export function recordHostFailure(owner, host, stepName, reason) {
  if (NEVER_SKIPPED.has(stepName)) return
  const h = memoryKey(owner, host)
  if (!String(host || '')) return

  if (hostMemory.has(h)) {
    const entry = hostMemory.get(h)
    hostMemory.delete(h)
    hostMemory.set(h, entry)
    entry.set(stepName, { at: Date.now(), reason })
    return
  }

  const entry = new Map()
  entry.set(stepName, { at: Date.now(), reason })
  hostMemory.set(h, entry)

  if (hostMemory.size > MAX_HOSTS) {
    const oldestKey = hostMemory.keys().next().value
    hostMemory.delete(oldestKey)
  }
}

export function recordHostSuccess(owner, host, stepName) {
  const h = memoryKey(owner, host)
  const entry = hostMemory.get(h)
  if (!entry) return
  entry.delete(stepName)
  if (entry.size === 0) hostMemory.delete(h)
}

export function isStepSkipped(owner, host, stepName, now = Date.now()) {
  if (NEVER_SKIPPED.has(stepName)) return false
  const h = memoryKey(owner, host)
  const entry = hostMemory.get(h)
  if (!entry) return false

  const record = entry.get(stepName)
  if (!record) return false

  if (now - record.at > SKIP_DURATION_MS) {
    entry.delete(stepName)
    if (entry.size === 0) hostMemory.delete(h)
    return false
  }

  return true
}

export function clearHostMemory() {
  hostMemory.clear()
}
