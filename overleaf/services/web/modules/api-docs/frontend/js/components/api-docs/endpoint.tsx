import { useMemo } from 'react'
import { Card } from 'react-bootstrap'
import classNames from 'classnames'
import MaterialIcon from '@/shared/components/material-icon'
import OLBadge from '@/shared/components/ol/ol-badge'
import Description from './description'
import { CodeBlock, CodeSamples } from './code-sample'
import { ParameterTable, SchemaTable } from './schema-table'
import { buildSamples } from './samples'
import type {
  Endpoint,
  MediaTypeObject,
  OpenApiSpec,
  OperationObject,
} from './types'
import {
  isBinaryMedia,
  isBinarySchema,
  isJsonMediaType,
  isPublic,
  mediaExample,
  schemeTitle,
  securitySchemeNames,
} from './spec-utils'

/** Bootstrap theme variant per HTTP method */
const METHOD_TONE: Record<string, string> = {
  get: 'info',
  post: 'success',
  put: 'warning',
  patch: 'warning',
  delete: 'danger',
}

export function MethodBadge({
  method,
  className,
}: {
  method: string
  className?: string
}) {
  return (
    <OLBadge
      bg={METHOD_TONE[method.toLowerCase()] ?? 'secondary'}
      className={classNames('api-docs-method', className)}
    >
      {method.toUpperCase()}
    </OLBadge>
  )
}

function AuthBadge({
  spec,
  operation,
}: {
  spec: OpenApiSpec
  operation: OperationObject
}) {
  if (isPublic(spec, operation)) {
    return (
      <OLBadge bg="success" prepend={<MaterialIcon type="public" />}>
        Public
      </OLBadge>
    )
  }
  const labels = [
    ...new Set(
      securitySchemeNames(spec, operation).map((name) =>
        schemeTitle(spec.components?.securitySchemes?.[name])
      )
    ),
  ]
  return (
    <OLBadge
      bg="light"
      className="badge-themed api-docs-badge-neutral"
      prepend={<MaterialIcon type="lock" />}
    >
      {labels.join(' or ')}
    </OLBadge>
  )
}

function statusTone(status: string) {
  switch (status.charAt(0)) {
    case '2':
      return 'success'
    case '3':
      return 'info'
    case '4':
      return 'warning'
    case '5':
      return 'danger'
    default:
      return 'secondary'
  }
}

function StatusBadge({ status }: { status: string }) {
  return (
    <OLBadge bg={statusTone(status)} className="api-docs-status">
      {status}
    </OLBadge>
  )
}

function jsonExample(
  spec: OpenApiSpec,
  content?: Record<string, MediaTypeObject>
) {
  for (const [mediaType, media] of Object.entries(content || {})) {
    if (isJsonMediaType(mediaType)) {
      const example = mediaExample(spec, media)
      if (example !== undefined) {
        return example
      }
    }
  }
  return undefined
}

function ResponseBlock({
  spec,
  status,
  description,
  content,
  showExample,
}: {
  spec: OpenApiSpec
  status: string
  description?: string
  content?: Record<string, MediaTypeObject>
  showExample: boolean
}) {
  const media = Object.entries(content || {})
  const example = showExample ? jsonExample(spec, content) : undefined
  const expandable = media.length > 0

  const head = (
    <>
      <StatusBadge status={status} />
      <span className="api-docs-response-description">{description}</span>
      {expandable && (
        <MaterialIcon type="expand_more" className="api-docs-response-chevron" />
      )}
    </>
  )

  if (!expandable) {
    return (
      <div className="api-docs-response">
        <div className="api-docs-response-head">{head}</div>
      </div>
    )
  }

  return (
    <details className="api-docs-response" open={status.startsWith('2')}>
      <summary className="api-docs-response-head">{head}</summary>
      <div className="api-docs-response-body">
        {media.map(([mediaType, mediaObject]) => (
          <div key={mediaType} className="api-docs-media">
            <span className="api-docs-media-type">{mediaType}</span>
            {isBinaryMedia(spec, mediaType, mediaObject) ? (
              <p className="api-docs-muted">Binary file download.</p>
            ) : (
              <SchemaTable spec={spec} schema={mediaObject.schema} />
            )}
          </div>
        ))}
        {example !== undefined && (
          <CodeBlock
            label={`Example ${status}`}
            code={JSON.stringify(example, null, 2)}
          />
        )}
      </div>
    </details>
  )
}

export default function EndpointSection({
  spec,
  endpoint,
  origin,
}: {
  spec: OpenApiSpec
  endpoint: Endpoint
  origin: string
}) {
  const { id, path, method, operation } = endpoint
  const samples = useMemo(
    () => buildSamples(spec, endpoint, origin),
    [spec, endpoint, origin]
  )
  const parameters = operation.parameters || []
  const requestBody = operation.requestBody
  const responses = Object.entries(operation.responses || {})

  // The first successful JSON example sits next to the request sample
  const featured = responses
    .filter(([status]) => status.startsWith('2'))
    .map(([status, response]) => ({
      status,
      example: jsonExample(spec, response.content),
    }))
    .find(({ example }) => example !== undefined)

  return (
    <Card
      as="article"
      id={id}
      className="api-docs-endpoint"
      aria-labelledby={`${id}-title`}
    >
      <header className="api-docs-endpoint-header">
        <h3 id={`${id}-title`} className="api-docs-endpoint-title">
          {operation.summary || `${method.toUpperCase()} ${path}`}
          {operation.deprecated && (
            <OLBadge bg="warning" className="api-docs-title-badge">
              Deprecated
            </OLBadge>
          )}
        </h3>
        <div className="api-docs-endpoint-meta">
          <div className="api-docs-route">
            <MethodBadge method={method} />
            <code className="api-docs-path">{path}</code>
          </div>
          <AuthBadge spec={spec} operation={operation} />
        </div>
      </header>

      <div className="api-docs-endpoint-grid">
        <div className="api-docs-endpoint-docs">
          <Description text={operation.description} className="api-docs-body" />

          {parameters.length > 0 && (
            <section className="api-docs-subsection">
              <h4>Parameters</h4>
              <ParameterTable spec={spec} parameters={parameters} />
            </section>
          )}

          {requestBody && (
            <section className="api-docs-subsection">
              <h4>
                Request body
                <OLBadge
                  bg={requestBody.required ? 'danger' : 'light'}
                  className={classNames('api-docs-title-badge', {
                    'badge-themed api-docs-badge-neutral':
                      !requestBody.required,
                  })}
                >
                  {requestBody.required ? 'required' : 'optional'}
                </OLBadge>
              </h4>
              <Description text={requestBody.description} />
              {Object.entries(requestBody.content ?? {}).map(([mediaType, media]) => (
                <div key={mediaType} className="api-docs-media">
                  <span className="api-docs-media-type">{mediaType}</span>
                  {isBinarySchema(spec, media.schema) ? (
                    <p className="api-docs-muted">
                      Raw body, sent as the file contents.
                    </p>
                  ) : (
                    <SchemaTable spec={spec} schema={media.schema} />
                  )}
                </div>
              ))}
            </section>
          )}

          {responses.length > 0 && (
            <section className="api-docs-subsection">
              <h4>Responses</h4>
              <div className="api-docs-responses">
                {responses.map(([status, response]) => (
                  <ResponseBlock
                    key={status}
                    spec={spec}
                    status={status}
                    description={response.description}
                    content={response.content}
                    showExample={status !== featured?.status}
                  />
                ))}
              </div>
            </section>
          )}
        </div>

        <div className="api-docs-endpoint-code">
          <div className="api-docs-code-stack">
            <CodeSamples samples={samples} title="Request" />
            {featured && (
              <CodeBlock
                label={`Response ${featured.status}`}
                code={JSON.stringify(featured.example, null, 2)}
              />
            )}
          </div>
        </div>
      </div>
    </Card>
  )
}
