// Test-only deep merge for plain objects (arrays and scalars are replaced).
// The production defaults module no longer exports a merge helper.
const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v)

export function mergePlain(base, override) {
  const out = { ...base }
  for (const [k, v] of Object.entries(override || {})) {
    out[k] = isPlain(v) && isPlain(base?.[k]) ? mergePlain(base[k], v) : v
  }
  return out
}
