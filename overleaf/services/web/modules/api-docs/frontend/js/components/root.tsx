import { useEffect, useState } from 'react'
import { getJSON } from '@/infrastructure/fetch-json'
import OLPageContentCard from '@/shared/components/ol/ol-page-content-card'
import OLRow from '@/shared/components/ol/ol-row'
import OLCol from '@/shared/components/ol/ol-col'
import OLBadge from '@/shared/components/ol/ol-badge'
import OLCard from '@/shared/components/ol/ol-card'
import OLTable from '@/shared/components/ol/ol-table'

type Schema = {
  $ref?: string
  type?: string
  format?: string
  description?: string
  enum?: string[]
  properties?: Record<string, Schema>
  required?: string[]
  items?: Schema
  allOf?: Schema[]
}

type Parameter = {
  name: string
  in: string
  required?: boolean
  description?: string
  schema?: Schema
  example?: string
}

type MediaTypes = Record<string, { schema?: Schema }>

type OpenApiOperation = {
  summary?: string
  description?: string
  tags?: string[]
  security?: Record<string, string[]>[]
  parameters?: Parameter[]
  requestBody?: { required?: boolean; content: MediaTypes }
  responses?: Record<string, { description?: string; content?: MediaTypes }>
}

type SecurityScheme = { description?: string; name?: string }

type OpenApiSpec = {
  info: { title: string; version: string; description?: string }
  tags?: { name: string; description?: string }[]
  security?: Record<string, string[]>[]
  paths: Record<string, Record<string, OpenApiOperation>>
  components?: {
    schemas?: Record<string, Schema>
    securitySchemes?: Record<string, SecurityScheme>
  }
}

type Endpoint = { path: string; method: string; operation: OpenApiOperation }

const METHOD_BADGE_BG: Record<string, string> = {
  get: 'info',
  post: 'success',
  put: 'warning',
  patch: 'warning',
  delete: 'danger',
}

function refName(schema?: Schema) {
  return schema?.$ref?.split('/').pop()
}

function resolveSchema(spec: OpenApiSpec, schema?: Schema): Schema {
  if (!schema) {
    return {}
  }
  const name = refName(schema)
  if (name) {
    return resolveSchema(spec, spec.components?.schemas?.[name])
  }
  if (schema.allOf) {
    return schema.allOf
      .map(part => resolveSchema(spec, part))
      .reduce<Schema>(
        (merged, part) => ({
          ...merged,
          ...part,
          properties: { ...merged.properties, ...part.properties },
          required: [...(merged.required || []), ...(part.required || [])],
        }),
        {}
      )
  }
  return schema
}

function typeLabel(spec: OpenApiSpec, schema?: Schema): string {
  const name = refName(schema)
  if (name) {
    return name
  }
  const resolved = resolveSchema(spec, schema)
  if (resolved.enum) {
    return resolved.enum.map(value => `"${value}"`).join(' | ')
  }
  if (resolved.type === 'array') {
    return `${typeLabel(spec, resolved.items)}[]`
  }
  if (resolved.type === 'string' && resolved.format) {
    return `string (${resolved.format})`
  }
  return resolved.type || 'object'
}

function exampleValue(
  spec: OpenApiSpec,
  schema: Schema | undefined,
  name: string
): unknown {
  const resolved = resolveSchema(spec, schema)
  if (resolved.enum) {
    return resolved.enum[0]
  }
  switch (resolved.type) {
    case 'array':
      return [exampleValue(spec, resolved.items, name)]
    case 'boolean':
      return false
    case 'integer':
    case 'number':
      return 0
    case 'object':
      return {}
    default:
      return `<${name}>`
  }
}

function operationSecurity(spec: OpenApiSpec, operation: OpenApiOperation) {
  return operation.security ?? spec.security ?? []
}

function buildCurl(spec: OpenApiSpec, endpoint: Endpoint) {
  const { path, method, operation } = endpoint
  const args = ['curl']
  if (method !== 'get') {
    args.push(`-X ${method.toUpperCase()}`)
  }

  const query = (operation.parameters || [])
    .filter(param => param.in === 'query' && param.required)
    .map(param => `${param.name}=${param.example ?? `{${param.name}}`}`)
  const url = `$OVERLEAF_URL${path}${query.length ? `?${query.join('&')}` : ''}`
  args.push(`"${url}"`)

  const [scheme] = Object.keys(operationSecurity(spec, operation)[0] || {})
  if (scheme === 'sessionAuth') {
    const cookie = spec.components?.securitySchemes?.sessionAuth?.name
    args.push(`-H "Cookie: ${cookie}=$OVERLEAF_SESSION"`)
    if (method !== 'get') {
      args.push('-H "X-CSRF-Token: $OVERLEAF_CSRF_TOKEN"')
    }
  } else if (scheme) {
    args.push('-H "Authorization: Bearer $OVERLEAF_TOKEN"')
  }

  const json = operation.requestBody?.content['application/json']?.schema
  if (operation.requestBody?.required && json) {
    const resolved = resolveSchema(spec, json)
    const properties = resolved.properties || {}
    const names = resolved.required?.length
      ? resolved.required
      : Object.keys(properties)
    const body = Object.fromEntries(
      names.map(name => [name, exampleValue(spec, properties[name], name)])
    )
    args.push('-H "Content-Type: application/json"')
    args.push(`-d '${JSON.stringify(body)}'`)
  }
  return args.join(' \\\n  ')
}

function groupEndpoints(spec: OpenApiSpec) {
  const groups = new Map<string, Endpoint[]>()
  for (const [path, operations] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      const tag = operation.tags?.[0] || 'Other'
      groups.set(tag, [...(groups.get(tag) || []), { path, method, operation }])
    }
  }
  const order = (spec.tags || []).map(tag => tag.name)
  const position = (tag: string) => {
    const index = order.indexOf(tag)
    return index === -1 ? order.length : index
  }
  return [...groups.entries()].sort(([a], [b]) => position(a) - position(b))
}

function PropertyTable({
  spec,
  schema,
}: {
  spec: OpenApiSpec
  schema?: Schema
}) {
  const resolved = resolveSchema(spec, schema)
  const properties = Object.entries(resolved.properties || {})
  if (!properties.length) {
    return <code>{typeLabel(spec, schema)}</code>
  }
  return (
    <OLTable size="sm" responsive>
      <thead>
        <tr>
          <th>Field</th>
          <th>Type</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        {properties.map(([name, property]) => (
          <tr key={name}>
            <td>
              <code>{name}</code>
              {resolved.required?.includes(name) && (
                <span className="text-danger"> *</span>
              )}
            </td>
            <td>
              <code>{typeLabel(spec, property)}</code>
            </td>
            <td>
              {resolveSchema(spec, property).description ||
                property.description}
            </td>
          </tr>
        ))}
      </tbody>
    </OLTable>
  )
}

function ParameterTable({
  spec,
  parameters,
}: {
  spec: OpenApiSpec
  parameters: Parameter[]
}) {
  return (
    <OLTable size="sm" responsive>
      <thead>
        <tr>
          <th>Name</th>
          <th>In</th>
          <th>Type</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        {parameters.map(param => (
          <tr key={`${param.in} ${param.name}`}>
            <td>
              <code>{param.name}</code>
              {param.required && <span className="text-danger"> *</span>}
            </td>
            <td>{param.in}</td>
            <td>
              <code>{typeLabel(spec, param.schema)}</code>
            </td>
            <td>{param.description}</td>
          </tr>
        ))}
      </tbody>
    </OLTable>
  )
}

function authenticationText(spec: OpenApiSpec, operation: OpenApiOperation) {
  const [scheme] = Object.keys(operationSecurity(spec, operation)[0] || {})
  if (!scheme) {
    return 'None. This endpoint is public.'
  }
  return spec.components?.securitySchemes?.[scheme]?.description || scheme
}

function EndpointCard({
  spec,
  endpoint,
}: {
  spec: OpenApiSpec
  endpoint: Endpoint
}) {
  const { path, method, operation } = endpoint
  const requestSchema = Object.values(operation.requestBody?.content || {})[0]
    ?.schema
  const responses = Object.entries(operation.responses || {})

  return (
    <OLCard className="mb-3">
      {Body => (
        <Body>
          <details>
            <summary>
              <span className="d-inline-flex align-items-center gap-2">
                <OLBadge bg={METHOD_BADGE_BG[method] || 'secondary'}>
                  {method.toUpperCase()}
                </OLBadge>
                <code>{path}</code>
                {operation.summary && <span>{operation.summary}</span>}
              </span>
            </summary>
            <div className="mt-3">
              {operation.description && <p>{operation.description}</p>}
              <h4 className="h6">Authentication</h4>
              <p>{authenticationText(spec, operation)}</p>
              {!!operation.parameters?.length && (
                <>
                  <h4 className="h6">Parameters</h4>
                  <ParameterTable
                    spec={spec}
                    parameters={operation.parameters}
                  />
                </>
              )}
              {requestSchema && (
                <>
                  <h4 className="h6">
                    Request body
                    {operation.requestBody?.required ? '' : ' (optional)'}
                  </h4>
                  <PropertyTable spec={spec} schema={requestSchema} />
                </>
              )}
              {!!responses.length && (
                <>
                  <h4 className="h6">Responses</h4>
                  {responses.map(([status, response]) => {
                    const schema = Object.values(response.content || {})[0]
                      ?.schema
                    return (
                      <div key={status} className="mb-2">
                        <OLBadge
                          bg={status.startsWith('2') ? 'success' : 'secondary'}
                        >
                          {status}
                        </OLBadge>{' '}
                        {response.description}
                        {schema && (
                          <PropertyTable spec={spec} schema={schema} />
                        )}
                      </div>
                    )
                  })}
                </>
              )}
              <h4 className="h6">Example</h4>
              <pre className="mb-0">
                <code>{buildCurl(spec, endpoint)}</code>
              </pre>
            </div>
          </details>
        </Body>
      )}
    </OLCard>
  )
}

function ApiDocsPageRoot() {
  const [spec, setSpec] = useState<OpenApiSpec | null>(null)

  useEffect(() => {
    getJSON<OpenApiSpec>('/api/v0/openapi.json').then(setSpec)
  }, [])

  if (!spec) {
    return null
  }

  const descriptions = new Map(
    (spec.tags || []).map(tag => [tag.name, tag.description])
  )

  return (
    <div className="container">
      <OLRow>
        <OLCol xl={{ span: 10, offset: 1 }}>
          <OLPageContentCard>
            <div className="page-header">
              <h1>{spec.info.title}</h1>
              {spec.info.description && <p>{spec.info.description}</p>}
            </div>
            {groupEndpoints(spec).map(([tag, endpoints]) => (
              <section key={tag} className="mb-4">
                <h2 className="h4">{tag}</h2>
                {descriptions.get(tag) && <p>{descriptions.get(tag)}</p>}
                {endpoints.map(endpoint => (
                  <EndpointCard
                    key={`${endpoint.method} ${endpoint.path}`}
                    spec={spec}
                    endpoint={endpoint}
                  />
                ))}
              </section>
            ))}
          </OLPageContentCard>
        </OLCol>
      </OLRow>
    </div>
  )
}

export default ApiDocsPageRoot
