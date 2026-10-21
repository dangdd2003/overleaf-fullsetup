// Subset of the OpenAPI 3.0 document that the API reference renders.

export type SchemaObject = {
  $ref?: string
  type?: string
  format?: string
  description?: string
  example?: unknown
  default?: unknown
  enum?: unknown[]
  nullable?: boolean
  deprecated?: boolean
  properties?: Record<string, SchemaObject>
  required?: string[]
  items?: SchemaObject
  allOf?: SchemaObject[]
  oneOf?: SchemaObject[]
  anyOf?: SchemaObject[]
  additionalProperties?: SchemaObject | boolean
}

export type MediaTypeObject = {
  schema?: SchemaObject
  example?: unknown
  examples?: Record<string, { summary?: string; value?: unknown }>
}

export type ParameterObject = {
  name: string
  in: 'query' | 'path' | 'header' | 'cookie' | string
  required?: boolean
  deprecated?: boolean
  description?: string
  schema?: SchemaObject
  example?: unknown
}

export type RequestBodyObject = {
  description?: string
  required?: boolean
  content: Record<string, MediaTypeObject>
}

type ResponseObject = {
  description?: string
  content?: Record<string, MediaTypeObject>
}

export type SecurityRequirement = Record<string, string[]>

export type OperationObject = {
  operationId?: string
  summary?: string
  description?: string
  tags?: string[]
  deprecated?: boolean
  security?: SecurityRequirement[]
  'x-feature'?: string | string[]
  parameters?: ParameterObject[]
  requestBody?: RequestBodyObject
  responses?: Record<string, ResponseObject>
}

export type SecuritySchemeObject = {
  type?: string
  scheme?: string
  in?: string
  name?: string
  description?: string
  flows?: Record<
    string,
    {
      authorizationUrl?: string
      tokenUrl?: string
      scopes?: Record<string, string>
    }
  >
}

type TagObject = { name: string; description?: string }

type TagGroup = { name: string; tags: string[] }

export type OpenApiSpec = {
  openapi?: string
  info: { title: string; version: string; description?: string }
  tags?: TagObject[]
  'x-tagGroups'?: TagGroup[]
  security?: SecurityRequirement[]
  paths: Record<string, Record<string, OperationObject | unknown>>
  components?: {
    schemas?: Record<string, SchemaObject>
    securitySchemes?: Record<string, SecuritySchemeObject>
  }
}

export type Endpoint = {
  id: string
  path: string
  method: string
  operation: OperationObject
}

export type TagSection = {
  /** Name of the x-tagGroups section, or null when the spec has no groups */
  groupName: string | null
  tags: {
    name: string
    anchor: string
    description?: string
    endpoints: Endpoint[]
  }[]
}
