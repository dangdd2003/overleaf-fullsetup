import type {
  Endpoint,
  MediaTypeObject,
  OpenApiSpec,
  OperationObject,
  SchemaObject,
  SecurityRequirement,
  SecuritySchemeObject,
  TagSection,
} from './types'

const HTTP_METHODS = [
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'options',
  'trace',
] as const

// Guards recursive $ref chains and recursive example synthesis
const MAX_DEPTH = 4

export function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function refName(ref?: string) {
  return ref?.split('/').pop()
}

export function listEndpoints(spec: OpenApiSpec): Endpoint[] {
  const endpoints: Endpoint[] = []
  const seen = new Set<string>()
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = (item as Record<string, unknown>)[method] as
        | OperationObject
        | undefined
      if (!operation) {
        continue
      }
      let id = operation.operationId || `${method}-${slugify(path)}`
      if (seen.has(id)) {
        id = `${method}-${slugify(path)}`
      }
      seen.add(id)
      endpoints.push({ id, path, method, operation })
    }
  }
  return endpoints
}

export function matchesQuery(endpoint: Endpoint, query: string) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) {
    return true
  }
  const haystack = [
    endpoint.method,
    endpoint.path,
    endpoint.operation.summary,
    endpoint.operation.operationId,
    ...(endpoint.operation.tags || []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return terms.every((term) => haystack.includes(term))
}

/**
 * Groups endpoints by their first tag, following x-tagGroups when present.
 * Tags missing from every group end up in an "Other" group, and the spec's
 * own tag order is kept otherwise.
 */
export function buildSections(
  spec: OpenApiSpec,
  endpoints: Endpoint[]
): TagSection[] {
  const specTags = spec.tags || []
  const tagDescriptions = new Map(
    specTags.map((tag) => [tag.name, tag.description])
  )

  const byTag = new Map<string, Endpoint[]>()
  for (const endpoint of endpoints) {
    const tag = endpoint.operation.tags?.[0] || 'Other'
    byTag.set(tag, [...(byTag.get(tag) || []), endpoint])
  }

  const orderedTags = [
    ...specTags.map((tag) => tag.name),
    ...[...byTag.keys()].filter((tag) => !tagDescriptions.has(tag)),
  ].filter((tag, index, all) => byTag.has(tag) && all.indexOf(tag) === index)

  const tagEntry = (name: string) => ({
    name,
    anchor: `tag-${slugify(name)}`,
    description: tagDescriptions.get(name),
    endpoints: byTag.get(name) || [],
  })

  const groups = spec['x-tagGroups'] || []
  if (!groups.length) {
    return orderedTags.length
      ? [{ groupName: null, tags: orderedTags.map(tagEntry) }]
      : []
  }

  const placed = new Set<string>()
  const sections: TagSection[] = []
  for (const group of groups) {
    const tags = group.tags.filter((tag) => byTag.has(tag))
    tags.forEach((tag) => placed.add(tag))
    if (tags.length) {
      sections.push({ groupName: group.name, tags: tags.map(tagEntry) })
    }
  }
  const rest = orderedTags.filter((tag) => !placed.has(tag))
  if (rest.length) {
    sections.push({ groupName: 'Other', tags: rest.map(tagEntry) })
  }
  return sections
}

export function resolveSchema(
  spec: OpenApiSpec,
  schema?: SchemaObject,
  depth = 0
): SchemaObject {
  if (!schema || depth > MAX_DEPTH) {
    return {}
  }
  const name = refName(schema.$ref)
  if (name) {
    return resolveSchema(spec, spec.components?.schemas?.[name], depth + 1)
  }
  if (schema.allOf?.length) {
    const mergedAllOf = schema.allOf
      .map((part) => resolveSchema(spec, part, depth + 1))
      .reduce<SchemaObject>(
        (merged, part) => ({
          ...merged,
          ...part,
          properties: { ...merged.properties, ...part.properties },
          required: [...(merged.required || []), ...(part.required || [])],
        }),
        {}
      )
    return {
      ...mergedAllOf,
      ...schema,
      properties: { ...mergedAllOf.properties, ...schema.properties },
      required: [...(mergedAllOf.required || []), ...(schema.required || [])],
      description: schema.description || mergedAllOf.description,
    }
  }
  return schema
}

/** Name of the component a schema refers to, or undefined for inline schemas */
function componentName(schema?: SchemaObject) {
  return refName(schema?.$ref)
}

/** Human-readable type, e.g. `string (date-time)`, `Project[]`, `"a" | "b" | null` */
export function schemaLabel(
  spec: OpenApiSpec,
  schema?: SchemaObject,
  depth = 0
): string {
  if (!schema) {
    return 'any'
  }
  if (depth > MAX_DEPTH) {
    return 'object'
  }
  const name = componentName(schema)
  const resolved = resolveSchema(spec, schema)
  let label: string
  const variants = resolved.oneOf || resolved.anyOf
  if (name) {
    label = name
  } else if (variants?.length) {
    label = variants.map((v) => schemaLabel(spec, v, depth + 1)).join(' | ')
  } else if (resolved.enum?.length) {
    const values = resolved.enum.slice(0, 10).map((v) => JSON.stringify(v))
    if (resolved.enum.length > 10) {
      values.push('...')
    }
    label = values.join(' | ')
  } else if (resolved.type === 'array') {
    label = `${schemaLabel(spec, resolved.items, depth + 1)}[]`
  } else if (resolved.type === 'string' && resolved.format === 'binary') {
    label = 'binary file'
  } else if (resolved.format) {
    label = `${resolved.type || 'string'} (${resolved.format})`
  } else if (resolved.type) {
    label = resolved.type
  } else if (resolved.properties) {
    label = 'object'
  } else {
    label = 'any'
  }
  return resolved.nullable ? `${label} | null` : label
}

export function isBinarySchema(spec: OpenApiSpec, schema?: SchemaObject) {
  const resolved = resolveSchema(spec, schema)
  return resolved.type === 'string' && resolved.format === 'binary'
}

export function isJsonMediaType(mediaType: string) {
  return /json/i.test(mediaType)
}

/** Binary responses are files (PDF, zip, images, ...) rather than text or JSON */
export function isBinaryMedia(
  spec: OpenApiSpec,
  mediaType: string,
  media?: MediaTypeObject
) {
  if (isBinarySchema(spec, media?.schema)) {
    return true
  }
  return !/^(text\/|application\/(json|xml|x-www-form-urlencoded)|.*\+json$)/i.test(
    mediaType
  )
}

function formatExample(format: string | undefined, name: string) {
  switch (format) {
    case 'date-time':
      return '2026-01-01T00:00:00Z'
    case 'date':
      return '2026-01-01'
    case 'uuid':
      return '00000000-0000-4000-8000-000000000000'
    case 'email':
      return 'user@example.com'
    case 'uri':
    case 'url':
      return 'https://example.com'
    default:
      return `<${name}>`
  }
}

/**
 * Example value for a schema: the spec's own `example` when present, otherwise
 * one synthesised from enums, property examples and types.
 */
export function exampleFor(
  spec: OpenApiSpec,
  schema?: SchemaObject,
  name = 'value',
  depth = 0
): unknown {
  if (!schema) {
    return `<${name}>`
  }
  if (schema.example !== undefined) {
    return schema.example
  }
  const resolved = resolveSchema(spec, schema, depth)
  if (resolved.example !== undefined) {
    return resolved.example
  }
  if (resolved.enum?.length) {
    return resolved.enum[0]
  }
  if (resolved.default !== undefined) {
    return resolved.default
  }
  const variants = resolved.oneOf || resolved.anyOf
  if (variants?.length) {
    return exampleFor(spec, variants[0], name, depth + 1)
  }
  if (resolved.type === 'array' || resolved.items) {
    return depth > MAX_DEPTH
      ? []
      : [exampleFor(spec, resolved.items, name, depth + 1)]
  }
  if (resolved.type === 'object' || resolved.properties) {
    if (depth > MAX_DEPTH) {
      return {}
    }
    return Object.fromEntries(
      Object.entries(resolved.properties || {}).map(([key, property]) => [
        key,
        exampleFor(spec, property, key, depth + 1),
      ])
    )
  }
  switch (resolved.type) {
    case 'boolean':
      return false
    case 'integer':
    case 'number':
      return 0
    case 'string':
      return formatExample(resolved.format, name)
    default:
      return `<${name}>`
  }
}

/** The media type's example, its first named example, or one synthesised from the schema */
export function mediaExample(spec: OpenApiSpec, media?: MediaTypeObject) {
  if (!media) {
    return undefined
  }
  if (media.example !== undefined) {
    return media.example
  }
  const [firstNamed] = Object.values(media.examples || {})
  if (firstNamed?.value !== undefined) {
    return firstNamed.value
  }
  return media.schema ? exampleFor(spec, media.schema) : undefined
}

export function operationSecurity(
  spec: OpenApiSpec,
  operation: OperationObject
): SecurityRequirement[] {
  return operation.security ?? spec.security ?? []
}

export function isPublic(spec: OpenApiSpec, operation: OperationObject) {
  const requirements = operationSecurity(spec, operation)
  return (
    requirements.length === 0 ||
    requirements.some((requirement) => Object.keys(requirement).length === 0)
  )
}

export function securitySchemeNames(
  spec: OpenApiSpec,
  operation: OperationObject
) {
  return [
    ...new Set(
      operationSecurity(spec, operation).flatMap((requirement) =>
        Object.keys(requirement)
      )
    ),
  ]
}

export type SchemeKind = 'bearer' | 'cookie' | 'header' | 'query'

export function schemeKind(scheme?: SecuritySchemeObject): SchemeKind {
  if (scheme?.type === 'apiKey') {
    if (scheme.in === 'cookie') {
      return 'cookie'
    }
    return scheme.in === 'query' ? 'query' : 'header'
  }
  return 'bearer'
}

export function schemeTitle(scheme?: SecuritySchemeObject) {
  if (scheme?.type === 'apiKey') {
    switch (scheme.in) {
      case 'cookie':
        return 'Session cookie'
      case 'query':
        return 'API key (query)'
      default:
        return 'API key'
    }
  }
  if (scheme?.type === 'oauth2') {
    return 'OAuth 2.0'
  }
  if (scheme?.type === 'openIdConnect') {
    return 'OpenID Connect'
  }
  if (scheme?.type === 'http' && scheme.scheme === 'basic') {
    return 'Basic auth'
  }
  return 'Bearer token'
}

/** Header/parameter lines that show how a client sends credentials for a scheme */
export function authHeaderLines(
  name: string,
  scheme?: SecuritySchemeObject
): string[] {
  switch (schemeKind(scheme)) {
    case 'cookie': {
      const cookieName = scheme?.name || name
      return [
        `Cookie: ${cookieName}=<session-cookie>`,
        'X-CSRF-Token: <csrf-token>',
      ]
    }
    case 'header':
      return [`${scheme?.name || name}: <api-key>`]
    case 'query':
      return [`?${scheme?.name || name}=<api-key>`]
    default:
      return ['Authorization: Bearer <token>']
  }
}
