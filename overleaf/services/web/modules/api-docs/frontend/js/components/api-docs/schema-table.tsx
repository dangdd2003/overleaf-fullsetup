import classNames from 'classnames'
import OLBadge from '@/shared/components/ol/ol-badge'
import OLTable from '@/shared/components/ol/ol-table'
import Description from './description'
import type { OpenApiSpec, ParameterObject, SchemaObject } from './types'
import { resolveSchema, schemaLabel } from './spec-utils'

type FieldRow = {
  name: string
  /** Unique within the table: parent field name joined with this one */
  key: string
  schema: SchemaObject
  required: boolean
  nested: boolean
}

function exampleText(value: unknown) {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/** Fields of an object schema; object fields get one level of nested rows */
function fieldRows(
  spec: OpenApiSpec,
  schema?: SchemaObject,
  parent?: string
): FieldRow[] {
  const nested = parent !== undefined
  let resolved = resolveSchema(spec, schema)
  if (!nested && resolved.type === 'array' && resolved.items) {
    resolved = resolveSchema(spec, resolved.items)
  }
  const required = new Set(resolved.required || [])
  return Object.entries(resolved.properties || {}).flatMap(
    ([name, property]) => {
      const row: FieldRow = {
        name,
        key: nested ? `${parent}.${name}` : name,
        schema: property,
        required: required.has(name),
        nested,
      }
      if (nested) {
        return [row]
      }
      let target = resolveSchema(spec, property)
      if (target.type === 'array') {
        target = resolveSchema(spec, target.items)
      }
      const children = target.properties ? fieldRows(spec, target, name) : []
      return [row, ...children]
    }
  )
}

function Field({
  name,
  type,
  location,
  required,
  deprecated,
  description,
  example,
  nested = false,
}: {
  name: string
  type: string
  location?: string
  required?: boolean
  deprecated?: boolean
  description?: string
  example?: unknown
  nested?: boolean
}) {
  return (
    <tr className={classNames('api-docs-field', { 'is-nested': nested })}>
      <td className="api-docs-field-name-cell">
        <code className="api-docs-field-name">{name}</code>
        <div className="api-docs-field-meta">
          <span className="api-docs-field-type">{type}</span>
          {location && (
            <OLBadge
              bg="light"
              className="badge-themed api-docs-badge-neutral api-docs-field-badge"
            >
              in {location}
            </OLBadge>
          )}
          {required && (
            <OLBadge bg="danger" className="api-docs-field-badge">
              required
            </OLBadge>
          )}
          {deprecated && (
            <OLBadge bg="warning" className="api-docs-field-badge">
              deprecated
            </OLBadge>
          )}
        </div>
      </td>
      <td className="api-docs-field-body">
        <Description text={description} />
        {example !== undefined && (
          <div className="api-docs-example">
            Example: <code>{exampleText(example)}</code>
          </div>
        )}
      </td>
    </tr>
  )
}

function FieldTable({
  spec,
  rows,
  label,
}: {
  spec: OpenApiSpec
  rows: FieldRow[]
  label: string
}) {
  return (
    <OLTable responsive borderless size="sm" className="api-docs-fields">
      <caption className="visually-hidden">{label}</caption>
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Description</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const resolved = resolveSchema(spec, row.schema)
          return (
            <Field
              key={row.key}
              name={row.name}
              type={schemaLabel(spec, row.schema)}
              required={row.required}
              deprecated={resolved.deprecated}
              description={row.schema.description || resolved.description}
              example={row.schema.example ?? resolved.example}
              nested={row.nested}
            />
          )
        })}
      </tbody>
    </OLTable>
  )
}

/**
 * Describes a request or response schema: its type, then a table of fields
 * for objects, or of the element fields for arrays. oneOf/anyOf render one
 * block per variant.
 */
export function SchemaTable({
  spec,
  schema,
}: {
  spec: OpenApiSpec
  schema?: SchemaObject
}) {
  const resolved = resolveSchema(spec, schema)
  const variants = resolved.oneOf || resolved.anyOf
  if (variants?.length) {
    return (
      <div className="api-docs-variants">
        <p className="api-docs-muted">One of:</p>
        {variants.map((variant, index) => {
          const rows = fieldRows(spec, variant)
          return (
            <div key={index} className="mb-3">
              <p>
                <code>{schemaLabel(spec, variant)}</code>
              </p>
              {rows.length > 0 && (
                <FieldTable
                  spec={spec}
                  rows={rows}
                  label={schemaLabel(spec, variant)}
                />
              )}
            </div>
          )
        })}
      </div>
    )
  }

  const rows = fieldRows(spec, schema)
  return (
    <div>
      {rows.length > 0 ? (
        <FieldTable
          spec={spec}
          rows={rows}
          label={schemaLabel(spec, schema)}
        />
      ) : (
        <p className="api-docs-type">
          Type: <code>{schemaLabel(spec, schema)}</code>
        </p>
      )}
    </div>
  )
}

export function ParameterTable({
  spec,
  parameters,
}: {
  spec: OpenApiSpec
  parameters: ParameterObject[]
}) {
  return (
    <OLTable responsive borderless size="sm" className="api-docs-fields">
      <caption className="visually-hidden">Parameters</caption>
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Description</th>
        </tr>
      </thead>
      <tbody>
        {parameters.map((param) => (
          <Field
            key={`${param.in} ${param.name}`}
            name={param.name}
            type={schemaLabel(spec, param.schema)}
            location={param.in}
            required={param.required}
            deprecated={param.deprecated}
            description={param.description}
            example={param.example ?? param.schema?.example}
          />
        ))}
      </tbody>
    </OLTable>
  )
}
