import type {
  Endpoint,
  MediaTypeObject,
  OpenApiSpec,
  OperationObject,
  ParameterObject,
  RequestBodyObject,
} from './types'
import {
  exampleFor,
  isBinaryMedia,
  isBinarySchema,
  isJsonMediaType,
  isPublic,
  mediaExample,
  operationSecurity,
  resolveSchema,
  schemeKind,
} from './spec-utils'

export type SampleLanguage = 'curl' | 'javascript' | 'python'

export const SAMPLE_LANGUAGES: { id: SampleLanguage; label: string }[] = [
  { id: 'curl', label: 'cURL' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'python', label: 'Python' },
]

export type Samples = Record<SampleLanguage, string>

type Field = { name: string; value: string; file: boolean }

type BodySample =
  | { kind: 'json'; value: unknown }
  | { kind: 'multipart' | 'urlencoded'; fields: Field[] }
  | { kind: 'raw'; contentType: string }

type ResponseSample =
  | { kind: 'json' }
  | { kind: 'text' }
  | { kind: 'binary'; extension: string }

/** Language-neutral description of one request, rendered into each sample */
type RequestModel = {
  method: string
  path: string
  query: [string, string][]
  headers: [string, string][]
  /** Cookie auth: JavaScript relies on credentials: 'include' instead */
  cookieAuth: boolean
  body: BodySample | null
  response: ResponseSample | null
}

// The curl sample is meant to be pasted into a shell with these set
const CURL_BASE_URL = '$OVERLEAF_URL'

const EXTENSIONS: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/gzip': 'gz',
  'application/x-tar': 'tar',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
}

function extensionFor(mediaType: string) {
  return EXTENSIONS[mediaType.toLowerCase()] || 'bin'
}

function isPlaceholder(value: string) {
  return /^<.*>$/.test(value)
}

function encodeQueryValue(value: string) {
  return isPlaceholder(value) ? value : encodeURIComponent(value)
}

function stringify(value: unknown) {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function parameterValue(spec: OpenApiSpec, param: ParameterObject) {
  const value =
    param.example !== undefined
      ? param.example
      : exampleFor(spec, param.schema, param.name)
  return stringify(value)
}

function credentialParts(
  spec: OpenApiSpec,
  operation: OperationObject,
  method: string,
  lang: SampleLanguage
): Pick<RequestModel, 'headers' | 'query' | 'cookieAuth'> {
  const parts: Pick<RequestModel, 'headers' | 'query' | 'cookieAuth'> = {
    headers: [],
    query: [],
    cookieAuth: false,
  }
  if (isPublic(spec, operation)) {
    return parts
  }

  // Requirements are alternatives; the sample uses the first one that names a scheme
  const requirement = operationSecurity(spec, operation).find(
    (entry) => Object.keys(entry).length > 0
  )
  const [name] = Object.keys(requirement || {})
  if (!name) {
    return parts
  }
  const scheme = spec.components?.securitySchemes?.[name]
  const kind = schemeKind(scheme)

  if (kind === 'cookie') {
    const cookieName = scheme?.name || name
    parts.cookieAuth = true
    if (lang !== 'javascript') {
      const value = lang === 'curl' ? '$OVERLEAF_SESSION' : '<session-cookie>'
      parts.headers.push(['Cookie', `${cookieName}=${value}`])
    }
    if (method !== 'GET') {
      const csrf = lang === 'curl' ? '$OVERLEAF_CSRF_TOKEN' : '<csrf-token>'
      parts.headers.push(['X-CSRF-Token', csrf])
    }
  } else if (kind === 'header') {
    const value = lang === 'curl' ? '$OVERLEAF_API_KEY' : '<api-key>'
    parts.headers.push([scheme?.name || name, value])
  } else if (kind === 'query') {
    parts.query.push([scheme?.name || name, '<api-key>'])
  } else {
    const token = lang === 'curl' ? 'Bearer $OVERLEAF_TOKEN' : 'Bearer <token>'
    parts.headers.push(['Authorization', token])
  }
  return parts
}

function bodySample(
  spec: OpenApiSpec,
  body: RequestBodyObject
): { mediaType: string; sample: BodySample } | null {
  const mediaTypes = Object.keys(body.content || {})
  const mediaType =
    mediaTypes.find((type) => isJsonMediaType(type)) ||
    mediaTypes.find((type) => type === 'multipart/form-data') ||
    mediaTypes.find((type) => type === 'application/x-www-form-urlencoded') ||
    mediaTypes[0]
  if (!mediaType) {
    return null
  }
  const media: MediaTypeObject = body.content[mediaType]

  if (isJsonMediaType(mediaType)) {
    return {
      mediaType,
      sample: { kind: 'json', value: mediaExample(spec, media) },
    }
  }

  if (
    mediaType === 'multipart/form-data' ||
    mediaType === 'application/x-www-form-urlencoded'
  ) {
    const schema = resolveSchema(spec, media.schema)
    const example = mediaExample(spec, media)
    const values =
      example && typeof example === 'object'
        ? (example as Record<string, unknown>)
        : {}
    const fields: Field[] = Object.entries(schema.properties || {}).map(
      ([name, property]) => {
        const file =
          mediaType === 'multipart/form-data' && isBinarySchema(spec, property)
        const value = file
          ? `path/to/${name}`
          : stringify(values[name] ?? exampleFor(spec, property, name))
        return { name, value, file }
      }
    )
    return {
      mediaType,
      sample: {
        kind: mediaType === 'multipart/form-data' ? 'multipart' : 'urlencoded',
        fields,
      },
    }
  }

  return { mediaType, sample: { kind: 'raw', contentType: mediaType } }
}

function responseSample(
  spec: OpenApiSpec,
  operation: OperationObject
): ResponseSample | null {
  const code = Object.keys(operation.responses || {})
    .filter((status) => /^2\d\d$/.test(status))
    .sort()[0]
  const content = code ? operation.responses?.[code]?.content : undefined
  if (!content) {
    return null
  }
  const mediaType =
    Object.keys(content).find((type) => isJsonMediaType(type)) ||
    Object.keys(content)[0]
  const media = content[mediaType]
  if (isBinaryMedia(spec, mediaType, media)) {
    return { kind: 'binary', extension: extensionFor(mediaType) }
  }
  return isJsonMediaType(mediaType) ? { kind: 'json' } : { kind: 'text' }
}

function buildRequest(
  spec: OpenApiSpec,
  endpoint: Endpoint,
  lang: SampleLanguage
): RequestModel {
  const { method, path, operation } = endpoint
  const params = operation.parameters || []
  const httpMethod = method.toUpperCase()

  const resolvedPath = path.replace(/\{([^}]+)\}/g, (match, name: string) => {
    const param = params.find((p) => p.in === 'path' && p.name === name)
    return param ? parameterValue(spec, param) : match
  })

  const query: [string, string][] = params
    .filter((p) => p.in === 'query' && p.required)
    .map((p) => [p.name, encodeQueryValue(parameterValue(spec, p))])

  const headers: [string, string][] = params
    .filter((p) => p.in === 'header' && p.required)
    .map((p) => [p.name, parameterValue(spec, p)])

  const credentials = credentialParts(spec, operation, httpMethod, lang)
  headers.push(...credentials.headers)
  query.push(...credentials.query)

  let body: BodySample | null = null
  if (operation.requestBody) {
    const parsed = bodySample(spec, operation.requestBody)
    if (parsed) {
      body = parsed.sample
      if (body.kind === 'json') {
        headers.push(['Content-Type', 'application/json'])
      } else if (body.kind === 'raw') {
        headers.push(['Content-Type', body.contentType])
      }
    }
  }

  return {
    method: httpMethod,
    path: resolvedPath,
    query,
    headers,
    cookieAuth: credentials.cookieAuth,
    body,
    response: responseSample(spec, operation),
  }
}

/** Escape for a double-quoted shell string; $VARIABLE expansion is kept on purpose */
function dq(value: string) {
  return value.replace(/["\\]/g, '\\$&')
}

/** Escape for a single-quoted shell string */
function sq(value: string) {
  return value.replace(/'/g, `'\\''`)
}

function queryString(query: [string, string][]) {
  return query.length
    ? `?${query.map(([name, value]) => `${name}=${value}`).join('&')}`
    : ''
}

function curlSample(request: RequestModel): string {
  const url = `${CURL_BASE_URL}${request.path}${queryString(request.query)}`
  const args = ['curl']
  if (request.method !== 'GET') {
    args.push(`-X ${request.method}`)
  }
  args.push(`"${dq(url)}"`)
  for (const [name, value] of request.headers) {
    args.push(`-H "${dq(name)}: ${dq(value)}"`)
  }

  const body = request.body
  if (body?.kind === 'json') {
    const jsonText = JSON.stringify(body.value ?? {}, null, 2)
    args.push(`-d '${sq(jsonText)}'`)
  } else if (body?.kind === 'multipart') {
    for (const field of body.fields) {
      const value = field.file ? `@${field.value}` : dq(field.value)
      args.push(`-F "${dq(field.name)}=${value}"`)
    }
  } else if (body?.kind === 'urlencoded') {
    for (const field of body.fields) {
      args.push(`--data-urlencode "${dq(field.name)}=${dq(field.value)}"`)
    }
  } else if (body?.kind === 'raw') {
    args.push('--data-binary @path/to/file')
  }

  if (request.response?.kind === 'binary') {
    args.push(`-o download.${request.response.extension}`)
  }
  return args.join(' \\\n  ')
}

/** Single-quoted JS string literal */
function jsString(value: string) {
  return `'${value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')}'`
}

function javascriptSample(request: RequestModel, origin: string): string {
  const lines: string[] = [`const baseUrl = ${jsString(origin)}`, '']
  const body = request.body
  // Expression passed to fetch as the body, if the request has one
  let bodyExpression: string | null = null

  if (body?.kind === 'json') {
    lines.push(`const body = ${JSON.stringify(body.value, null, 2)}`, '')
    bodyExpression = 'JSON.stringify(body)'
  } else if (body?.kind === 'multipart') {
    if (body.fields.some((field) => field.file)) {
      lines.push('const file = /* File or Blob */ null')
    }
    lines.push('const form = new FormData()')
    for (const field of body.fields) {
      lines.push(
        field.file
          ? `form.append(${jsString(field.name)}, file) // File or Blob`
          : `form.append(${jsString(field.name)}, ${jsString(field.value)})`
      )
    }
    lines.push('')
    bodyExpression = 'form'
  } else if (body?.kind === 'urlencoded') {
    lines.push(
      'const body = new URLSearchParams({',
      ...body.fields.map(
        (field) => `  ${jsString(field.name)}: ${jsString(field.value)},`
      ),
      '})',
      ''
    )
    bodyExpression = 'body'
  } else if (body?.kind === 'raw') {
    lines.push('const file = /* File, Blob or ArrayBuffer */ null', '')
    bodyExpression = 'file'
  }

  lines.push(
    `const url = baseUrl + ${jsString(request.path + queryString(request.query))}`
  )

  const options: string[] = [`  method: ${jsString(request.method)},`]
  if (request.headers.length) {
    options.push('  headers: {')
    for (const [name, value] of request.headers) {
      options.push(`    ${jsString(name)}: ${jsString(value)},`)
    }
    options.push('  },')
  }
  if (bodyExpression) {
    options.push(`  body: ${bodyExpression},`)
  }
  if (request.cookieAuth) {
    options.push("  credentials: 'include', // sends the session cookie")
  }

  lines.push('const response = await fetch(url, {', ...options, '})')
  lines.push(
    'if (!response.ok) {',
    "  throw new Error('Request failed: ' + response.status)",
    '}'
  )

  const response = request.response
  if (response?.kind === 'json') {
    lines.push('const data = await response.json()')
  } else if (response?.kind === 'binary') {
    lines.push('const blob = await response.blob()')
  } else if (response?.kind === 'text') {
    lines.push('const text = await response.text()')
  }
  return lines.join('\n')
}

/** Python literal, nested values indented relative to `indent` */
function pyLiteral(value: unknown, indent = ''): string {
  if (value === null || value === undefined) {
    return 'None'
  }
  if (value === true) {
    return 'True'
  }
  if (value === false) {
    return 'False'
  }
  const inner = `${indent}    `
  if (Array.isArray(value)) {
    if (!value.length) {
      return '[]'
    }
    const items = value.map((item) => `${inner}${pyLiteral(item, inner)},`)
    return `[\n${items.join('\n')}\n${indent}]`
  }
  if (typeof value === 'object') {
    return pyDictRaw(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        JSON.stringify(key),
        pyLiteral(item, inner),
      ]),
      indent
    )
  }
  return JSON.stringify(value)
}

/** Python dict whose values are already-rendered Python expressions */
function pyDictRaw(entries: [string, string][], indent: string) {
  if (!entries.length) {
    return '{}'
  }
  const inner = `${indent}    `
  const items = entries.map(
    ([key, expression]) => `${inner}${key}: ${expression},`
  )
  return `{\n${items.join('\n')}\n${indent}}`
}

function pythonSample(request: RequestModel, origin: string): string {
  const method = request.method.toLowerCase()
  const urlArg = `base_url + ${JSON.stringify(request.path)}`
  const body = request.body
  // requests sets Content-Type itself for json=, files= and data=
  const headers = request.headers.filter(
    ([name]) =>
      !(
        name === 'Content-Type' &&
        (body?.kind === 'json' ||
          body?.kind === 'multipart' ||
          body?.kind === 'urlencoded')
      )
  )
  const kwargs: string[] = []

  if (headers.length) {
    kwargs.push(
      `headers=${pyDictRaw(
        headers.map(([name, value]) => [
          JSON.stringify(name),
          JSON.stringify(value),
        ]),
        '    '
      )}`
    )
  }
  if (request.query.length) {
    kwargs.push(
      `params=${pyDictRaw(
        request.query.map(([name, value]) => [
          JSON.stringify(name),
          JSON.stringify(value),
        ]),
        '    '
      )}`
    )
  }
  if (body?.kind === 'json') {
    kwargs.push(`json=${pyLiteral(body.value, '    ')}`)
  } else if (body?.kind === 'multipart') {
    // (None, value) makes requests send a plain text part in multipart
    kwargs.push(
      `files=${pyDictRaw(
        body.fields.map((field) => [
          JSON.stringify(field.name),
          field.file
            ? `open(${JSON.stringify(field.value)}, 'rb')`
            : `(None, ${JSON.stringify(field.value)})`,
        ]),
        '    '
      )}`
    )
  } else if (body?.kind === 'urlencoded') {
    kwargs.push(
      `data=${pyDictRaw(
        body.fields.map((field) => [
          JSON.stringify(field.name),
          JSON.stringify(field.value),
        ]),
        '    '
      )}`
    )
  } else if (body?.kind === 'raw') {
    kwargs.push(`data=open('path/to/file', 'rb')`)
  }

  const lines = [
    'import requests',
    '',
    `base_url = ${JSON.stringify(origin)}`,
    '',
    `response = requests.${method}(`,
    ...[urlArg, ...kwargs].map((arg) => `    ${arg},`),
    ')',
    'response.raise_for_status()',
  ]

  const response = request.response
  if (response?.kind === 'json') {
    lines.push('data = response.json()')
  } else if (response?.kind === 'binary') {
    lines.push(
      `with open('download.${response.extension}', 'wb') as file:`,
      '    file.write(response.content)'
    )
  } else if (response?.kind === 'text') {
    lines.push('text = response.text')
  }
  return lines.join('\n')
}

/** cURL, JavaScript (fetch) and Python (requests) samples for one endpoint */
export function buildSamples(
  spec: OpenApiSpec,
  endpoint: Endpoint,
  origin: string
): Samples {
  return {
    curl: curlSample(buildRequest(spec, endpoint, 'curl')),
    javascript: javascriptSample(
      buildRequest(spec, endpoint, 'javascript'),
      origin
    ),
    python: pythonSample(buildRequest(spec, endpoint, 'python'), origin),
  }
}
