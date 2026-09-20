import { describe, it, expect } from 'vitest'
import {
  sanitizeToolSchema,
  coerceToolArgs,
} from '../../../app/src/AiAssistToolSchema.mjs'

describe('AiAssistToolSchema', () => {
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

    it('strips keywords outside the OpenAPI subset', () => {
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
      expect(item.properties.oldText).to.deep.equal({ type: 'string' })
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
  })
})
