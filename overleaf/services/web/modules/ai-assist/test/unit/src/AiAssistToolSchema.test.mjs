import { describe, it, expect } from 'vitest'
import {
  flattenJsonSchema,
  sanitizeToolSchema,
  coerceToolArgs,
} from '../../../app/src/AiAssistToolSchema.mjs'

describe('AiAssistToolSchema', () => {
  describe('flattenJsonSchema', () => {
    it('inlines a $ref into $defs and drops the $defs block', () => {
      const result = flattenJsonSchema({
        type: 'object',
        properties: { edit: { $ref: '#/$defs/Edit' } },
        $defs: {
          Edit: {
            type: 'object',
            properties: { oldText: { type: 'string' } },
          },
        },
      })

      expect(result).to.not.have.property('$defs')
      expect(result.properties.edit).to.deep.equal({
        type: 'object',
        properties: { oldText: { type: 'string' } },
      })
    })

    it('resolves draft-07 definitions references too', () => {
      const result = flattenJsonSchema({
        type: 'object',
        properties: { color: { $ref: '#/definitions/Color' } },
        definitions: { Color: { type: 'string', enum: ['red', 'blue'] } },
      })

      expect(result.properties.color).to.deep.equal({
        type: 'string',
        enum: ['red', 'blue'],
      })
    })

    it('stops expanding a self-referencing schema, so a recursive tool does not loop', () => {
      const result = flattenJsonSchema({
        type: 'object',
        properties: { node: { $ref: '#/$defs/Node' } },
        $defs: {
          Node: {
            type: 'object',
            properties: { child: { $ref: '#/$defs/Node' } },
          },
        },
      })

      let node = result.properties.node
      let depth = 0
      while (node.properties) {
        node = node.properties.child
        depth++
      }
      expect(depth).to.be.greaterThan(1)
      expect(node).to.deep.equal({ type: 'object' })
    })

    it('gives a missing reference a plain object type, keeping its description', () => {
      const result = flattenJsonSchema({
        type: 'object',
        properties: {
          gone: { $ref: '#/$defs/Missing', description: 'Removed upstream' },
        },
      })

      expect(result.properties.gone).to.deep.equal({
        type: 'object',
        description: 'Removed upstream',
      })
    })

    it('collapses an optional value (anyOf with null) into a nullable concrete type', () => {
      const result = flattenJsonSchema({
        type: 'object',
        properties: {
          imageName: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        },
      })

      expect(result.properties.imageName).to.deep.equal({
        type: 'string',
        nullable: true,
      })
    })

    it('merges same-typed string enum variants from oneOf into one enum', () => {
      const result = flattenJsonSchema({
        type: 'object',
        properties: {
          mode: {
            oneOf: [
              { type: 'string', const: 'fast' },
              { type: 'string', const: 'thorough' },
            ],
          },
        },
      })

      expect(result.properties.mode).to.deep.equal({
        type: 'string',
        enum: ['fast', 'thorough'],
      })
    })

    it('merges allOf parts into one object with their properties and required names', () => {
      const result = flattenJsonSchema({
        allOf: [
          {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
          {
            properties: { line: { type: 'integer' } },
            required: ['line'],
          },
        ],
      })

      expect(result.type).to.equal('object')
      expect(result.properties).to.deep.equal({
        path: { type: 'string' },
        line: { type: 'integer' },
      })
      expect(result.required).to.deep.equal(['path', 'line'])
    })

    it('turns const into a one-value enum of the same type', () => {
      const result = flattenJsonSchema({
        type: 'object',
        properties: { path: { const: 'main.tex' } },
      })

      expect(result.properties.path).to.deep.equal({
        type: 'string',
        enum: ['main.tex'],
      })
    })

    it('returns an empty object for a missing schema, and leaves a plain one unchanged', () => {
      expect(flattenJsonSchema(undefined)).to.deep.equal({})

      const plain = {
        type: 'object',
        properties: { limit: { type: 'number', minimum: 0 } },
        required: ['limit'],
      }
      expect(flattenJsonSchema(plain)).to.deep.equal(plain)
    })
  })

  describe('sanitizeToolSchema with references and unions', () => {
    it('inlines references before narrowing them to the provider subset', () => {
      const result = sanitizeToolSchema({
        type: 'object',
        properties: { page: { $ref: '#/$defs/Page' } },
        $defs: { Page: { type: 'integer', minimum: 1, examples: [1] } },
      })

      expect(result.properties.page).to.deep.equal({ type: 'integer', minimum: 1 })
    })

    it('forces a string type onto an enum declared with a non-string type', () => {
      const result = sanitizeToolSchema({
        type: 'object',
        properties: { mode: { type: 'integer', enum: [1, 2] } },
      })

      expect(result.properties.mode).to.deep.equal({
        type: 'string',
        enum: ['1', '2'],
      })
    })
  })

  describe('sanitizeToolSchema', () => {
    it('drops an empty required array', () => {
      const result = sanitizeToolSchema({
        type: 'object',
        properties: { glob: { type: 'string' } },
        required: [],
      })

      expect(result).to.not.have.property('required')
    })

    it('keeps a non-empty required array', () => {
      const result = sanitizeToolSchema({
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      })

      expect(result.required).to.deep.equal(['path'])
    })

    it('keeps an empty object schema by default', () => {
      const result = sanitizeToolSchema({
        type: 'object',
        properties: {},
        required: [],
      })

      expect(result).to.deep.equal({ type: 'object', properties: {} })
    })

    it('omits an empty object schema when asked', () => {
      const result = sanitizeToolSchema(
        { type: 'object', properties: {}, required: [] },
        { emptyObject: 'omit' }
      )

      expect(result).to.equal(undefined)
    })

    it('omits a missing schema when asked', () => {
      expect(sanitizeToolSchema(undefined, { emptyObject: 'omit' })).to.equal(
        undefined
      )
    })

    it('strips keywords outside the OpenAPI subset, and turns const into a one-value enum', () => {
      const result = sanitizeToolSchema({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        additionalProperties: false,
        properties: {
          path: {
            type: 'string',
            description: 'Path to read',
            const: 'main.tex',
            examples: ['main.tex'],
          },
        },
      })

      expect(result).to.not.have.property('$schema')
      expect(result).to.not.have.property('additionalProperties')
      expect(result.properties.path).to.deep.equal({
        type: 'string',
        description: 'Path to read',
        enum: ['main.tex'],
      })
    })

    it('preserves the keywords a tool actually relies on', () => {
      const result = sanitizeToolSchema({
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['errors', 'warnings', 'all'] },
          limit: { type: 'number', description: 'Cap per severity' },
          includeRaw: { type: 'boolean', default: true },
          paths: { type: 'array', items: { type: 'string' } },
        },
        required: ['severity'],
      })

      expect(result.properties.severity.enum).to.deep.equal([
        'errors',
        'warnings',
        'all',
      ])
      expect(result.properties.limit.description).to.equal('Cap per severity')
      expect(result.properties.includeRaw.default).to.equal(true)
      expect(result.properties.paths.items).to.deep.equal({ type: 'string' })
      expect(result.required).to.deep.equal(['severity'])
    })

    it('rewrites a union type as a nullable concrete type', () => {
      const result = sanitizeToolSchema({
        type: 'object',
        properties: { imageName: { type: ['string', 'null'] } },
      })

      expect(result.properties.imageName).to.deep.equal({
        type: 'string',
        nullable: true,
      })
    })

    it('recurses into nested objects and array items', () => {
      const result = sanitizeToolSchema({
        type: 'object',
        properties: {
          edits: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { oldText: { type: 'string', const: 'x' } },
              required: [],
            },
          },
        },
      })

      const item = result.properties.edits.items
      expect(item).to.not.have.property('additionalProperties')
      expect(item).to.not.have.property('required')
      expect(item.properties.oldText).to.deep.equal({
        type: 'string',
        enum: ['x'],
      })
    })

    it('stringifies enum members so the values stay comparable', () => {
      const result = sanitizeToolSchema({
        type: 'object',
        properties: { size: { type: 'string', enum: [10, 12] } },
      })

      expect(result.properties.size.enum).to.deep.equal(['10', '12'])
    })
  })

  describe('coerceToolArgs', () => {
    const compileResultSchema = {
      type: 'object',
      properties: {
        severity: { type: 'string', enum: ['errors', 'warnings', 'all'] },
        limit: { type: 'number' },
        includeRaw: { type: 'boolean' },
      },
    }

    it('coerces the Python-style "True" that gateways reject', () => {
      const result = coerceToolArgs(
        { includeRaw: 'True' },
        compileResultSchema
      )

      expect(result.includeRaw).to.equal(true)
    })

    it('coerces the other spellings of a stringified boolean', () => {
      for (const [input, expected] of [
        ['true', true],
        ['TRUE', true],
        ['yes', true],
        ['1', true],
        ['False', false],
        ['false', false],
        ['no', false],
        ['0', false],
      ]) {
        expect(coerceToolArgs({ includeRaw: input }, compileResultSchema))
          .to.have.property('includeRaw')
          .that.equals(expected)
      }
    })

    it('leaves a real boolean alone', () => {
      expect(
        coerceToolArgs({ includeRaw: false }, compileResultSchema).includeRaw
      ).to.equal(false)
    })

    it('leaves an unrecognised string alone rather than guessing', () => {
      expect(
        coerceToolArgs({ includeRaw: 'maybe' }, compileResultSchema).includeRaw
      ).to.equal('maybe')
    })

    it('coerces a stringified number', () => {
      expect(coerceToolArgs({ limit: '20' }, compileResultSchema).limit).to.equal(
        20
      )
    })

    it('truncates towards an integer when the schema says integer', () => {
      const schema = { type: 'object', properties: { from: { type: 'integer' } } }

      expect(coerceToolArgs({ from: '12.7' }, schema).from).to.equal(12)
    })

    it('leaves a non-numeric string alone', () => {
      expect(
        coerceToolArgs({ limit: 'twenty' }, compileResultSchema).limit
      ).to.equal('twenty')
    })

    it('stringifies a scalar where the schema wants a string', () => {
      const schema = { type: 'object', properties: { path: { type: 'string' } } }

      expect(coerceToolArgs({ path: 12 }, schema).path).to.equal('12')
    })

    it('never stringifies an object into a string parameter', () => {
      const schema = { type: 'object', properties: { path: { type: 'string' } } }
      const value = { name: 'main.tex' }

      expect(coerceToolArgs({ path: value }, schema).path).to.deep.equal(value)
    })

    it('wraps a lone value where the schema wants an array', () => {
      const schema = {
        type: 'object',
        properties: { paths: { type: 'array', items: { type: 'string' } } },
      }

      expect(coerceToolArgs({ paths: 'main.tex' }, schema).paths).to.deep.equal([
        'main.tex',
      ])
    })

    it('coerces inside array items', () => {
      const schema = {
        type: 'object',
        properties: { flags: { type: 'array', items: { type: 'boolean' } } },
      }

      expect(
        coerceToolArgs({ flags: ['True', 'false'] }, schema).flags
      ).to.deep.equal([true, false])
    })

    it('parses a JSON string into a nested object parameter', () => {
      const schema = {
        type: 'object',
        properties: {
          settings: {
            type: 'object',
            properties: { draft: { type: 'boolean' } },
          },
        },
      }

      expect(
        coerceToolArgs({ settings: '{"draft":"True"}' }, schema).settings
      ).to.deep.equal({ draft: true })
    })

    it('passes through arguments the schema does not name', () => {
      const result = coerceToolArgs(
        { includeRaw: 'True', unknown: 'True' },
        compileResultSchema
      )

      expect(result.unknown).to.equal('True')
    })

    it('does not add properties the call omitted', () => {
      const result = coerceToolArgs({ limit: '5' }, compileResultSchema)

      expect(result).to.not.have.property('includeRaw')
      expect(result).to.not.have.property('severity')
    })

    it('returns the arguments unchanged when there is no schema', () => {
      const args = { includeRaw: 'True' }

      expect(coerceToolArgs(args, undefined)).to.deep.equal(args)
    })

    it('does not mutate the arguments it was given', () => {
      const args = { includeRaw: 'True' }
      coerceToolArgs(args, compileResultSchema)

      expect(args.includeRaw).to.equal('True')
    })

    it('parses a JSON-encoded array into a list parameter', () => {
      const schema = {
        type: 'object',
        properties: { paths: { type: 'array', items: { type: 'string' } } },
      }

      expect(coerceToolArgs({ paths: '["a.tex","b.tex"]' }, schema).paths).to.deep.equal([
        'a.tex',
        'b.tex',
      ])
    })
  })

  describe('sanitizeToolSchema untyped enum', () => {
    it('gives an untyped enum the string type it needs', () => {
      const result = sanitizeToolSchema({
        type: 'object',
        properties: { mode: { enum: [1, 2] } },
      })

      expect(result.properties.mode).to.deep.equal({
        type: 'string',
        enum: ['1', '2'],
      })
    })
  })
})
