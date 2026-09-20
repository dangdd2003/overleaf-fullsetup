import { expect } from 'chai'
import * as z from 'zod/v4'
import { looseObject, portable } from '../../../src/schemas.js'
import { offendingKeywords } from '../../support/jsonSchemaKeywords.js'

const input = schema => portable(schema)['~standard'].jsonSchema.input({})
const output = schema => portable(schema)['~standard'].jsonSchema.output({})

describe('portable', function () {
  it('drops the dialect annotation', function () {
    expect(input(z.object({ a: z.string() }))).to.not.have.property('$schema')
  })

  it('restates an exclusive integer bound as an inclusive one', function () {
    const json = input(z.object({ n: z.number().int().positive() }))
    expect(json.properties.n).to.not.have.property('exclusiveMinimum')
    // .positive() means > 0, which for an integer is >= 1.
    expect(json.properties.n.minimum).to.equal(1)
  })

  it('drops a default that validation applies before the handler runs', function () {
    const schema = z.object({ n: z.number().default(30) })
    expect(input(schema).properties.n).to.not.have.property('default')
    expect(schema.parse({})).to.deep.equal({ n: 30 })
  })

  it('drops a format no consumer models but keeps validation', function () {
    const schema = z.object({ u: z.string().url() })
    expect(input(schema).properties.u).to.not.have.property('format')
    expect(() => schema.parse({ u: 'not a url' })).to.throw()
  })

  it('keeps a format consumers do model', function () {
    const json = input(z.object({ at: z.iso.datetime() }))
    expect(json.properties.at.format).to.equal('date-time')
  })

  it('rewrites a literal as a one-member enumeration', function () {
    const json = output(looseObject({ status: z.literal('ok') }))
    expect(json.properties.status).to.not.have.property('const')
    expect(json.properties.status.enum).to.deep.equal(['ok'])
  })

  it('drops additionalProperties, which only restates the default', function () {
    expect(output(looseObject({ a: z.string() }))).to.not.have.property(
      'additionalProperties'
    )
  })

  it('does not mistake a property named like a keyword for one', function () {
    const json = output(looseObject({ default: z.string(), const: z.number() }))
    expect(Object.keys(json.properties)).to.have.members(['default', 'const'])
  })

  it('leaves no keyword outside the portable set', function () {
    const schema = looseObject({
      status: z.literal('ok'),
      count: z.number().int().positive().optional(),
      url: z.string().url(),
      fields: z.record(z.string(), z.string()),
      nested: looseObject({ n: z.number().default(1) }),
    })
    expect(offendingKeywords(output(schema))).to.deep.equal([])
    expect(offendingKeywords(input(schema))).to.deep.equal([])
  })

  it('validates exactly as the wrapped schema does', async function () {
    const schema = z.object({ a: z.string() })
    const wrapped = portable(schema)['~standard']
    expect((await wrapped.validate({ a: 'x' })).value).to.deep.equal({ a: 'x' })
    expect((await wrapped.validate({ a: 1 })).issues).to.not.be.empty
  })
})
