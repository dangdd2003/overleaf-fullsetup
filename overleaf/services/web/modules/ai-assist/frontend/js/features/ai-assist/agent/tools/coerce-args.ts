/**
 * Repairs tool-call arguments against the schema the tool declares.
 *
 * Port of coerceToolArgs in app/src/AiAssistToolSchema.mjs — the in-page loop
 * (the compile-log fix) executes tools itself, so it needs the same repair the
 * server loop applies to the main chat.
 *
 * Models routinely emit a stringified scalar where the schema asked for a
 * typed one: `"True"` for a boolean is the most common, and it is enough to
 * make an OpenAI-compatible gateway refuse the call outright.
 */

export type JsonSchema = {
  type?: string | string[]
  properties?: Record<string, JsonSchema>
  items?: JsonSchema
  [key: string]: unknown
}

/** Strings a model uses for `true`, in the casings they actually arrive in. */
const TRUTHY = new Set(['true', 'yes', 'y', '1', 'on'])
/** Strings a model uses for `false`. */
const FALSY = new Set(['false', 'no', 'n', '0', 'off', 'none', 'null'])

function schemaType(schema: JsonSchema | undefined): string | undefined {
  const type = schema?.type
  if (Array.isArray(type)) return type.find(entry => entry !== 'null')
  return type
}

function coerceScalar(value: unknown, schema: JsonSchema | undefined): unknown {
  const type = schemaType(schema)

  if (type === 'boolean') {
    if (typeof value === 'boolean') return value
    if (typeof value === 'number') return value !== 0
    if (typeof value === 'string') {
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

function coerceValue(value: unknown, schema: JsonSchema | undefined): unknown {
  if (!schema || typeof schema !== 'object') return value
  if (value === null || value === undefined) return value

  const type = schemaType(schema)

  if (type === 'array') {
    if (Array.isArray(value)) {
      return value.map(entry => coerceValue(entry, schema.items))
    }
    // A model sent one item where the schema wanted a list. Wrapping it is
    // unambiguous; failing the call over it helps nobody.
    return [coerceValue(value, schema.items)]
  }

  if (type === 'object') {
    let object: unknown = value
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
    return coerceToolArgs(object as Record<string, unknown>, schema)
  }

  return coerceScalar(value, schema)
}

/**
 * Only properties the schema names are touched, and only towards the type it
 * declares, so an argument the schema says nothing about passes through
 * untouched rather than being guessed at.
 */
export function coerceToolArgs(
  args: Record<string, unknown>,
  parameters: JsonSchema | undefined
): Record<string, unknown> {
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
