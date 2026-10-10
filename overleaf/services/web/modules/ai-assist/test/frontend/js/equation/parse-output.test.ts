import { expect } from 'chai'
import {
  hasEquationBlock,
  parseEquationReply,
} from '../../../../frontend/js/features/ai-assist/equation/parse-output'

const FULL = [
  '<equation form="align" label="eq:friedmann">',
  'H^2 = \\frac{8\\pi G}{3}\\rho \\\\',
  '\\dot H = 0',
  '</equation>',
  '<passage>is governed by<equation/> where $a$ is the scale factor.</passage>',
  '<packages>mathtools</packages>',
  '<notes>Read the symbol as rho</notes>',
].join('\n')

describe('equation: parse-output', function () {
  it('reads a complete reply', function () {
    expect(parseEquationReply(FULL, true)).to.deep.equal({
      kind: 'equation',
      form: 'align',
      label: 'eq:friedmann',
      body: 'H^2 = \\frac{8\\pi G}{3}\\rho \\\\\n\\dot H = 0',
      bodyComplete: true,
      passage: 'is governed by<equation/> where $a$ is the scale factor.',
      packages: ['mathtools'],
      notes: 'Read the symbol as rho',
      complete: true,
    })
  })

  it('shows the body while it streams, without a half-written closing tag', function () {
    const partial = parseEquationReply('<equation form="display">E = mc^2</equ', false)
    expect(partial).to.include({ kind: 'equation', body: 'E = mc^2', bodyComplete: false })
    expect(partial).to.include({ passage: null })
  })

  it('has no passage until it closes, unless the reply ended', function () {
    const reply = '<equation form="inline">x</equation><passage>abc'
    expect(parseEquationReply(reply, false)).to.include({ passage: null, bodyComplete: true })
    expect(parseEquationReply(reply, true)).to.include({ passage: 'abc' })
  })

  it('keeps the passage exactly, whitespace included', function () {
    const reply = '<equation form="display">x</equation>\n<passage>\nby<equation/>\n</passage>'
    expect(parseEquationReply(reply, true)).to.include({ passage: '\nby<equation/>\n' })
  })

  it('reads a refusal', function () {
    expect(parseEquationReply('<cannot>no-image</cannot>', true)).to.deep.equal({
      kind: 'cannot',
      reason: 'no-image',
      complete: true,
    })
  })

  it('cleans the label and ignores an unknown form', function () {
    const parsed = parseEquationReply('<equation form="weird" label="eq: Friedmann!">x</equation>', true)
    expect(parsed).to.include({ form: null, label: 'eq:Friedmann' })
    const noLabel = parseEquationReply('<equation form="equation*" label="">x</equation>', true)
    expect(noLabel).to.include({ form: 'equation*', label: null })
  })

  it('drops reasoning and code fences', function () {
    const parsed = parseEquationReply(
      '<think>hmm</think><equation form="inline">```latex\nx^2\n```</equation>',
      true
    )
    expect(parsed).to.include({ body: 'x^2' })
  })

  it('takes the math from a reply without tags', function () {
    expect(parseEquationReply('E = mc^2', true)).to.include({
      kind: 'equation',
      body: 'E = mc^2',
      form: null,
      bodyComplete: true,
      passage: null,
    })
    expect(
      parseEquationReply('Here is the equation:\n```latex\n\\begin{align}a &= b\\end{align}\n```', true)
    ).to.include({ body: '\\begin{align}a &= b\\end{align}', form: 'align' })
    expect(parseEquationReply('Here you go:\n$$E = mc^2$$', true)).to.include({ body: '$$E = mc^2$$' })
    expect(parseEquationReply('E = mc^2', false)).to.include({ body: '', bodyComplete: false })
  })

  it('tells a reply with an equation block from one without', function () {
    expect(hasEquationBlock('<equation form="display">x</equation>')).to.equal(true)
    expect(hasEquationBlock('<passage>a<equation/>b</passage>')).to.equal(false)
    expect(hasEquationBlock('x')).to.equal(false)
  })
})
