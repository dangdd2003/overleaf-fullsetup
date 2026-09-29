/**
 * Tool schema and argument normalisation shared by every provider.
 *
 * Two separate jobs, both of which exist because the JSON Schema a tool
 * declares and the schema dialect a provider accepts are not the same thing:
 *
 * - `sanitizeToolSchema` narrows a tool's `parameters` to the OpenAPI 3.0
 *   subset that Gemini (and the gateways that front it) will accept. Sending
 *   raw JSON Schema is what makes a gateway reject a call outright with
 *   "Could not execute tool(s)".
 * - `coerceToolArgs` repairs the arguments a model emits so a stringified
 *   boolean or number does not fail a call that was otherwise correct.
 */

/**
 * Keywords Gemini's OpenAPI 3.0 subset understands. Anything else —
 * `additionalProperties`, `$schema`, `const`, `examples`, `exclusiveMinimum`,
 * `oneOf`/`allOf`, `patternProperties` — is either rejected outright or
 * silently degrades the schema so the model emits loosely typed arguments.
 */
const ALLOWED_KEYWORDS = new Set([
  'type',
  'format',
  'title',
  'description',
  'nullable',
  'enum',
  'properties',
  'required',
  'items',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'default',
])

/** JSON Schema types that survive the conversion unchanged. */
const KNOWN_TYPES = new Set([
  'string',
  'number',
  'integer',
  'boolean',
  'object',
  'array',
  'null',
])

function sanitizeNode(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return {}

  const result = {}

  for (const [key, value] of Object.entries(node)) {
    if (!ALLOWED_KEYWORDS.has(key)) continue

    if (key === 'properties') {
      if (!value || typeof value !== 'object') continue
      const properties = {}
      for (const [name, child] of Object.entries(value)) {
        properties[name] = sanitizeNode(child)
      }
      result.properties = properties
      continue
    }

    if (key === 'items') {
      result.items = sanitizeNode(value)
      continue
    }

    if (key === 'required') {
      // An empty `required` is not just useless, it is invalid in the OpenAPI
      // subset: some gateways reject the whole declaration over it.
      if (Array.isArray(value) && value.length > 0) {
        result.required = value.filter(name => typeof name === 'string')
        if (result.required.length === 0) delete result.required
      }
      continue
    }

    if (key === 'type') {
      // A union type (`['string', 'null']`) has no OpenAPI equivalent; keep the
      // first concrete member and mark the field nullable instead.
      if (Array.isArray(value)) {
        const concrete = value.filter(t => t !== 'null' && KNOWN_TYPES.has(t))
        if (concrete.length > 0) result.type = concrete[0]
        if (value.includes('null')) result.nullable = true
        continue
      }
      if (typeof value === 'string' && KNOWN_TYPES.has(value)) result.type = value
      continue
    }

    if (key === 'enum') {
      // Gemini only accepts string enums, and only alongside `type: 'string'`.
      if (Array.isArray(value) && value.length > 0) {
        result.enum = value.map(entry => String(entry))
      }
      continue
    }

    result[key] = value
  }

  return result
}

/**
 * Narrows a tool's declared parameters to what every provider accepts.
 *
 * `emptyObject` decides what a no-argument tool becomes. Gemini rejects an
 * object schema whose `properties` is empty, so its declaration must omit
 * `parameters` altogether; OpenAI, Anthropic and Ollama all want the empty
 * object and treat a missing schema as "unknown arguments".
 *
 * @param {object|undefined} parameters
 * @param {{ emptyObject?: 'keep' | 'omit' }} [options]
 * @returns {object|undefined}
 */
export function sanitizeToolSchema(parameters, { emptyObject = 'keep' } = {}) {
  const sanitized = sanitizeNode(parameters)

  if (!sanitized.type) sanitized.type = 'object'

  const hasProperties =
    sanitized.properties && Object.keys(sanitized.properties).length > 0

  if (sanitized.type === 'object' && !hasProperties) {
    if (emptyObject === 'omit') return undefined
    return { type: 'object', properties: {} }
  }

  return sanitized
}

/** Strings a model uses for `true`, in the casings they actually arrive in. */
const TRUTHY = new Set(['true', 'yes', 'y', '1', 'on'])
/** Strings a model uses for `false`. */
const FALSY = new Set(['false', 'no', 'n', '0', 'off', 'none', 'null'])

function coerceScalar(value, schema) {
  const type = schema?.type

  if (type === 'boolean') {
    if (typeof value === 'boolean') return value
    if (typeof value === 'number') return value !== 0
    if (typeof value === 'string') {
      // "True" and "False" are what a model trained on Python emits, and they
      // are the single most common reason a gateway refuses a tool call.
      const normalized = value.trim().toLowerCase()
      if (TRUTHY.has(normalized)) return true
      if (FALSY.has(normalized)) return false
    }
    return value
  }

  if (type === 'number' || type === 'integer') {
    if (typeof value === 'number') return value
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) {
        return type === 'integer' ? Math.trunc(parsed) : parsed
      }
    }
    return value
  }

  if (type === 'string') {
    // Never stringify an object: that turns a malformed call into a plausible
    // one and the tool acts on "[object Object]".
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value)
    }
    return value
  }

  return value
}

function coerceValue(value, schema) {
  if (!schema || typeof schema !== 'object') return value
  if (value === null || value === undefined) return value

  const type = schema.type

  if (type === 'array') {
    if (Array.isArray(value)) {
      return value.map(entry => coerceValue(entry, schema.items))
    }
    // A model asked for one item where the schema wanted a list. Wrapping it
    // is unambiguous; failing the call over it is not useful to anyone.
    return [coerceValue(value, schema.items)]
  }

  if (type === 'object') {
    let object = value
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          object = parsed
        }
      } catch {
        return value
      }
    }
    if (!object || typeof object !== 'object' || Array.isArray(object)) {
      return value
    }
    return coerceToolArgs(object, schema)
  }

  return coerceScalar(value, schema)
}

/**
 * Repairs tool-call arguments against the tool's declared schema.
 *
 * Only properties the schema names are touched, and only towards the type it
 * declares, so an argument the schema says nothing about is passed through
 * untouched rather than guessed at.
 *
 * @param {object} args
 * @param {object|undefined} parameters
 * @returns {object}
 */
export function coerceToolArgs(args, parameters) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args
  const properties = parameters?.properties
  if (!properties || typeof properties !== 'object') return args

  const result = { ...args }
  for (const [name, schema] of Object.entries(properties)) {
    if (!(name in result)) continue
    result[name] = coerceValue(result[name], schema)
  }
  return result
}
