/**
 * Reads the clean flag out of whatever the model actually sent.
 *
 * Providers vary in how faithfully they honour a boolean schema, and local
 * models routinely send `"true"` for `true`. Coercing here is what keeps a clean
 * rebuild working without a paragraph of prompt coaching telling the model how
 * to spell its own arguments.
 *
 * Kept in its own module, with no imports, because the status line and the tool
 * call card both need it to describe an in-flight call. Hanging it off the tool
 * would pull the whole registry into those components, and registry.ts already
 * imports the tool — a cycle waiting for the next edit.
 */
export function wantsCleanCompile(args: unknown): boolean {
  if (!args || typeof args !== 'object') return false
  const source = args as Record<string, unknown>
  // `clean` is the documented name. The others are the ways models phrase the
  // same idea when they have not read the schema closely.
  const raw =
    source.clean ??
    source.clearCache ??
    source.clear_cache ??
    source.fromScratch ??
    source.from_scratch ??
    source.rebuild
  if (typeof raw === 'boolean') return raw
  if (typeof raw === 'number') return raw !== 0
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase()
    return ['true', '1', 'yes', 'y', 'on'].includes(normalized)
  }
  return false
}
