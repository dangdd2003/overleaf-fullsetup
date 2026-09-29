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

// host -> Map<stepName, { at: number, reason: string }>
const hostMemory = new Map()

export function recordHostFailure(host, stepName, reason) {
  if (NEVER_SKIPPED.has(stepName)) return
  const h = String(host || '').toLowerCase()
  if (!h) return

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

export function recordHostSuccess(host, stepName) {
  const h = String(host || '').toLowerCase()
  const entry = hostMemory.get(h)
  if (!entry) return
  entry.delete(stepName)
  if (entry.size === 0) hostMemory.delete(h)
}

export function isStepSkipped(host, stepName, now = Date.now()) {
  if (NEVER_SKIPPED.has(stepName)) return false
  const h = String(host || '').toLowerCase()
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
