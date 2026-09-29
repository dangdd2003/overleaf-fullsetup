import * as z from 'zod/v4'

/**
 * Build an object schema that tolerates unknown keys.
 *
 * Advertising an `outputSchema` makes the MCP SDK validate every successful
 * result against it, so a field web adds to a response later would start
 * failing tool calls if the schema were strict. Output objects are loose for
 * that reason; the declared fields still tell the model what to expect.
 *
 * @param {Record<string, z.ZodType>} shape
 */
export function looseObject(shape) {
  return z.object(shape).loose()
}

/** The JSON Schema dialect the MCP SDK converts to. */
const JSON_SCHEMA_TARGET = 'draft-2020-12'

/**
 * Keys whose meaning is carried elsewhere, so dropping them loses nothing.
 *
 * `$schema` is a dialect annotation; `additionalProperties: {}` restates the
 * JSON Schema default of permitting unknown keys; `default` is applied by
 * validation before the handler runs, so a client never has to act on it; and
 * the `propertyNames` a string-keyed record emits restates that JSON object
 * keys are strings.
 */
const DROPPED_KEYS = new Set([
  '$schema',
  'additionalProperties',
  'default',
  'propertyNames',
])

/** `format` values a consumer can be expected to model. */
const PORTABLE_FORMATS = new Set([
  'enum',
  'date-time',
  'int32',
  'int64',
  'float',
  'double',
])

/** Keys whose values are maps of names to schemas, not nested keywords. */
const SCHEMA_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions'])

function portableNode(node) {
  if (Array.isArray(node)) return node.map(portableNode)
  if (!node || typeof node !== 'object') return node

  const out = {}
  for (const [key, value] of Object.entries(node)) {
    if (DROPPED_KEYS.has(key)) continue
    if (key === 'exclusiveMinimum' || key === 'exclusiveMaximum') continue
    if (key === 'format' && !PORTABLE_FORMATS.has(value)) continue
    // A single permitted value is a one-member enumeration.
    if (key === 'const') {
      out.enum = [value]
      continue
    }
    if (SCHEMA_MAPS.has(key) && value && typeof value === 'object') {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, sub]) => [name, portableNode(sub)])
      )
      continue
    }
    out[key] = portableNode(value)
  }

  // Restate an exclusive bound as an inclusive one. Integers shift by one and
  // stay exact; anything else keeps the endpoint, which only widens the
  // advertised range — validation still rejects it.
  if (node.exclusiveMinimum !== undefined) {
    const bound =
      node.type === 'integer' ? node.exclusiveMinimum + 1 : node.exclusiveMinimum
    out.minimum = Math.max(bound, node.minimum ?? -Infinity)
  }
  if (node.exclusiveMaximum !== undefined) {
    const bound =
      node.type === 'integer' ? node.exclusiveMaximum - 1 : node.exclusiveMaximum
    out.maximum = Math.min(bound, node.maximum ?? Infinity)
  }
  return out
}

/**
 * Advertise a schema as conservative JSON Schema without changing validation.
 *
 * Zod emits keywords that some tool-calling APIs do not model — Gemini's
 * `FunctionDeclaration.parameters`, for one, rejects payloads carrying unknown
 * fields such as `$schema`. Those keywords are annotations or restatements of
 * a default, so stripping them from what `tools/list` advertises costs no
 * meaning, while the wrapped zod schema still validates every call exactly as
 * strictly as before.
 *
 * The MCP SDK prefers `~standard.jsonSchema` over converting the schema
 * itself, which is the seam this hooks into.
 *
 * @param {z.ZodType} schema
 */
export function portable(schema) {
  const converted = {}
  const jsonSchema = io =>
    (converted[io] ??= portableNode(
      z.toJSONSchema(schema, { target: JSON_SCHEMA_TARGET, io })
    ))

  return {
    '~standard': {
      version: 1,
      vendor: 'overleaf-mcp',
      validate: value => schema['~standard'].validate(value),
      jsonSchema: { input: () => jsonSchema('input'), output: () => jsonSchema('output') },
    },
  }
}

/** The project every tool operates on. */
export const projectId = z.string().min(1).describe('The Overleaf project id')

/** The `{ status: 'ok' }` acknowledgement web returns from a mutation. */
export const okStatus = z
  .literal('ok')
  .describe('"ok" when the change was applied')

/**
 * Fields describing a binary `resource` content block.
 *
 * A tool returning a blob also returns these so a client that cannot render
 * the resource still learns what it received and how large it is.
 */
export const binaryFields = {
  uri: z.string().describe('overleaf:// uri identifying the returned resource'),
  mimeType: z.string().describe('Media type of the returned resource'),
  sizeBytes: z.number().int().describe('Decoded size of the resource in bytes'),
}

/**
 * Annotations for a tool that only reads Overleaf data.
 *
 * All four hints are stated even where the value looks obvious: an omitted
 * hint falls back to the protocol's pessimistic default — destructiveHint to
 * true, idempotentHint to false — and a client that decides confirmation from
 * the hints then treats a plain read as a possible mutation. Gemini and Gemini
 * Enterprise confirm every action by default and skip the prompt only for
 * readOnlyHint, so an under-specified read tool costs the user a click on
 * every call.
 */
export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}

/**
 * Annotations for a tool that writes, but only ever to the caller's own
 * Overleaf projects — never to an open world of external services.
 *
 * The destructive and idempotent hints carry the pessimistic value here so a
 * tool that forgets to narrow them is over-confirmed rather than waved
 * through; every call site states its own pair.
 */
export const WRITES = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
}
