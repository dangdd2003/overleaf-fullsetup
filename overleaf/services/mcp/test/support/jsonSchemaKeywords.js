/**
 * Keywords a consumer of `tools/list` can be expected to model.
 *
 * Gemini's FunctionDeclaration is the strictest of the clients we target: its
 * Schema message rejects a payload carrying any field it does not declare, so
 * an exotic keyword breaks the whole connector rather than degrading one
 * field. Anything zod emits outside this set is stripped by `portable()`.
 */
const PORTABLE_KEYWORDS = new Set([
  'type',
  'format',
  'description',
  'nullable',
  'enum',
  'items',
  'properties',
  'required',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'pattern',
  'anyOf',
  'propertyOrdering',
  'title',
])

/** Keys whose values are maps of names to schemas, not nested keywords. */
const SCHEMA_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions'])

/**
 * Collect the paths of every keyword outside the portable set.
 *
 * @param {unknown} node a JSON Schema
 * @param {string} [path] prefix for reported paths
 * @returns {string[]} empty when the schema is portable
 */
export function offendingKeywords(node, path = '$', inMap = false, hits = []) {
  if (!node || typeof node !== 'object') return hits
  if (Array.isArray(node)) {
    node.forEach((item, i) => offendingKeywords(item, `${path}[${i}]`, false, hits))
    return hits
  }
  for (const [key, value] of Object.entries(node)) {
    if (inMap) {
      offendingKeywords(value, `${path}.${key}`, false, hits)
      continue
    }
    if (!PORTABLE_KEYWORDS.has(key)) hits.push(`${path}.${key}`)
    offendingKeywords(value, `${path}.${key}`, SCHEMA_MAPS.has(key), hits)
  }
  return hits
}
