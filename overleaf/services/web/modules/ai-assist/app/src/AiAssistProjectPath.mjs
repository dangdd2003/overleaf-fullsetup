// Keep project paths identical for file tools and checkpoint storage/restoration.
export function normalizeProjectPath(filePath) {
  if (typeof filePath !== 'string') return ''
  const cleaned = filePath.trim().replace(/\\/g, '/').replace(/^\/+/, '')
  if (!cleaned) return ''
  const resolved = []
  for (const segment of cleaned.split('/').filter(Boolean)) {
    if (segment === '.') continue
    if (segment === '..') return null
    resolved.push(segment)
  }
  return resolved.join('/')
}
