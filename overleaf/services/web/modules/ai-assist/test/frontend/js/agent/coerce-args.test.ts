import { expect } from 'chai'
import { coerceToolArgs } from '../../../../frontend/js/features/ai-assist/agent/tools/coerce-args'
import { TOOLS } from '../../../../frontend/js/features/ai-assist/agent/tools/registry'

describe('coerceToolArgs', function () {
  const compileResultSchema = {
    type: 'object',
    properties: {
      severity: { type: 'string', enum: ['errors', 'warnings', 'all'] },
      limit: { type: 'number' },
      includeRaw: { type: 'boolean' },
    },
  }

  it('coerces the Python-style "True" that gateways reject', function () {
    expect(
      coerceToolArgs({ includeRaw: 'True' }, compileResultSchema).includeRaw
    ).to.equal(true)
  })

  it('coerces the other spellings of a stringified boolean', function () {
    const cases: Array<[string, boolean]> = [
      ['true', true],
      ['TRUE', true],
      ['yes', true],
      ['1', true],
      ['False', false],
      ['false', false],
      ['no', false],
      ['0', false],
    ]
    for (const [input, expected] of cases) {
      expect(
        coerceToolArgs({ includeRaw: input }, compileResultSchema).includeRaw
      ).to.equal(expected)
    }
  })

  it('leaves a real boolean alone', function () {
    expect(
      coerceToolArgs({ includeRaw: false }, compileResultSchema).includeRaw
    ).to.equal(false)
  })

  it('leaves an unrecognised string alone rather than guessing', function () {
    expect(
      coerceToolArgs({ includeRaw: 'maybe' }, compileResultSchema).includeRaw
    ).to.equal('maybe')
  })

  it('coerces a stringified number', function () {
    expect(coerceToolArgs({ limit: '20' }, compileResultSchema).limit).to.equal(
      20
    )
  })

  it('truncates towards an integer when the schema says integer', function () {
    const schema = { type: 'object', properties: { from: { type: 'integer' } } }

    expect(coerceToolArgs({ from: '12.7' }, schema).from).to.equal(12)
  })

  it('leaves a non-numeric string alone', function () {
    expect(
      coerceToolArgs({ limit: 'twenty' }, compileResultSchema).limit
    ).to.equal('twenty')
  })

  it('never stringifies an object into a string parameter', function () {
    const schema = { type: 'object', properties: { path: { type: 'string' } } }
    const value = { name: 'main.tex' }

    expect(coerceToolArgs({ path: value }, schema).path).to.deep.equal(value)
  })

  it('wraps a lone value where the schema wants an array', function () {
    const schema = {
      type: 'object',
      properties: { paths: { type: 'array', items: { type: 'string' } } },
    }

    expect(coerceToolArgs({ paths: 'main.tex' }, schema).paths).to.deep.equal([
      'main.tex',
    ])
  })

  it('passes through arguments the schema does not name', function () {
    expect(
      coerceToolArgs({ unknown: 'True' }, compileResultSchema).unknown
    ).to.equal('True')
  })

  it('does not add properties the call omitted', function () {
    const result = coerceToolArgs({ limit: '5' }, compileResultSchema)

    expect(result).to.not.have.property('includeRaw')
  })

  it('returns the arguments unchanged when there is no schema', function () {
    expect(coerceToolArgs({ includeRaw: 'True' }, undefined)).to.deep.equal({
      includeRaw: 'True',
    })
  })

  it('does not mutate the arguments it was given', function () {
    const args = { includeRaw: 'True' }
    coerceToolArgs(args, compileResultSchema)

    expect(args.includeRaw).to.equal('True')
  })

  describe('against the real tool registry', function () {
    it("repairs get_compile_result's includeRaw, the call the gateway rejected", function () {
      const spec = TOOLS.get_compile_result.spec

      const result = coerceToolArgs(
        { includeRaw: 'True', limit: '5' },
        spec.parameters as any
      )

      expect(result.includeRaw).to.equal(true)
      expect(result.limit).to.equal(5)
    })

    it("repairs compile_project's clean flag", function () {
      const spec = TOOLS.compile_project.spec

      expect(
        coerceToolArgs({ clean: 'True' }, spec.parameters as any).clean
      ).to.equal(true)
    })

    it('leaves edit_file text content untouched', function () {
      const spec = TOOLS.edit_file.spec
      const args = {
        path: 'main.tex',
        oldText: 'true',
        newText: '0',
      }

      expect(coerceToolArgs(args, spec.parameters as any)).to.deep.equal(args)
    })
  })
})
