import { expect } from 'chai'
import { ChatChunk, ChatRequest, ProviderSettings } from '../../../../frontend/js/features/ai-assist/providers/types'
import {
  buildResult,
  EquationFacts,
  EquationProgress,
  generateEquation,
  outcomeOf,
} from '../../../../frontend/js/features/ai-assist/equation/generate'
import { parseEquationReply } from '../../../../frontend/js/features/ai-assist/equation/parse-output'

const settings: ProviderSettings = { type: 'anthropic', baseUrl: '', apiKey: 'k', model: 'm' }

const facts: EquationFacts = {
  where: { kind: 'text', container: 'text', from: 0, to: 999 },
  before: 'The expansion is described by the Friedmann equations',
  selection: '',
  after: ' where a is the scale factor.',
  indent: '',
  labels: new Set(['eq:friedmann']),
  parenInline: false,
  loaded: new Set(['amsmath']),
  docClass: 'article',
}

const REPLY = [
  '<equation form="align" label="eq:friedmann">',
  'H^2 &= \\frac{8\\pi G}{3}\\rho \\\\',
  '\\dot{H} &= 0',
  '</equation>',
  '<passage>The expansion is described by the Friedmann equations<equation/> where $a$ is the scale factor.</passage>',
].join('\n')

function fakeClient(...replies: string[]) {
  const requests: ChatRequest[] = []
  return {
    requests,
    async *streamChat(request: ChatRequest): AsyncGenerator<ChatChunk> {
      requests.push(request)
      const text = replies[requests.length - 1] ?? ''
      for (const piece of text.match(/[\s\S]{1,20}/g) ?? []) yield { type: 'text', text: piece }
    },
  }
}

function equationOf(raw: string) {
  const parsed = parseEquationReply(raw, true)
  if (parsed.kind !== 'equation') throw new Error('expected an equation')
  return parsed
}

describe('equation: generate', function () {
  it('wraps the equation, renames a taken label and keeps the small edit', function () {
    const result = buildResult(equationOf(REPLY), REPLY, facts)
    if (result.kind !== 'equation') throw new Error('expected a result')
    expect(result.form).to.equal('align')
    expect(result.label).to.equal('eq:friedmann-2')
    expect(result.wrapped).to.equal(
      '\\begin{align}\n  H^2 &= \\frac{8\\pi G}{3}\\rho \\label{eq:friedmann-2} \\\\\n  \\dot{H} &= 0\n\\end{align}'
    )
    expect(result.withEdits).to.equal(
      `The expansion is described by the Friedmann equations\n${result.wrapped}\nwhere $a$ is the scale factor.`
    )
    expect(result.equationOnly).to.equal(
      `The expansion is described by the Friedmann equations\n${result.wrapped}\nwhere a is the scale factor.`
    )
    expect(result.editCount).to.equal(1)
    expect(result.editsSkipped).to.equal(false)
    expect(result.warnings.map(w => w.kind)).to.deep.equal(['label'])
  })

  it('renames a label the project already uses', function () {
    const result = buildResult(equationOf(REPLY), REPLY, facts)
    expect(result.kind === 'equation' && result.warnings[0].message).to.equal(
      'Label renamed to eq:friedmann-2: eq:friedmann is already used.'
    )
  })

  it('coerces display math to inline inside a caption', function () {
    const raw = '<equation form="equation" label="eq:e">E = mc^2</equation><passage>Energy<equation/> here</passage>'
    const result = buildResult(equationOf(raw), raw, {
      ...facts,
      where: { kind: 'text', container: 'caption', from: 0, to: 99 },
      before: 'Energy',
      after: ' here',
    })
    if (result.kind !== 'equation') throw new Error('expected a result')
    expect(result.form).to.equal('inline')
    expect(result.label).to.equal(null)
    expect(result.withEdits).to.equal('Energy$E = mc^2$ here')
    expect(result.warnings.map(w => w.kind)).to.deep.equal(['form'])
  })

  it('skips the edits around it when they break the passage', function () {
    const raw = '<equation form="display">x</equation><passage>Completely different text</passage>'
    const result = buildResult(equationOf(raw), raw, { ...facts, before: 'It is', after: ' here.' })
    if (result.kind !== 'equation') throw new Error('expected a result')
    expect(result.editsSkipped).to.equal(true)
    expect(result.withEdits).to.equal(result.equationOnly)
    expect(result.equationOnly).to.equal('It is\n\\[\n  x\n\\]\nhere.')
  })

  it('inserts the equation alone when the model sent no passage', function () {
    const raw = '<equation form="inline">m</equation>'
    const result = buildResult(equationOf(raw), raw, { ...facts, before: 'mass ', after: ' here' })
    expect(result).to.include({ withEdits: 'mass $m$ here', editCount: 0, editsSkipped: false })
  })

  it('reports packages the project does not load', function () {
    const raw = '<equation form="display">\\SI{3}{\\metre}</equation><packages>siunitx</packages>'
    const result = buildResult(equationOf(raw), raw, facts)
    expect(result.kind === 'equation' && result.packages).to.deep.equal(['siunitx'])
  })

  it('maps a refusal, a missing image and an empty body', function () {
    expect(outcomeOf('<cannot>Not math.</cannot>', facts)).to.deep.equal({ kind: 'cannot', reason: 'Not math.' })
    expect(outcomeOf('<cannot>no-image</cannot>', facts)).to.deep.equal({ kind: 'imageUnsupported' })
    expect(outcomeOf('<equation form="display">  </equation>', facts)).to.deep.equal({ kind: 'empty' })
  })

  it('streams progress and returns the result', async function () {
    const client = fakeClient(REPLY)
    const progress: EquationProgress[] = []
    const outcome = await generateEquation({
      messages: [{ role: 'user', content: 'go' }],
      facts,
      settings,
      onProgress: step => progress.push(step),
      client,
    })
    expect(outcome.kind).to.equal('equation')
    expect(progress.length).to.be.greaterThan(1)
    expect(client.requests[0].maxTokens).to.be.at.most(4096)
    expect(client.requests[0].system).to.include('You write the LaTeX for one piece of math')
  })

  const BAD = '<equation form="display">\\frac{a</equation><passage>The expansion is described by the Friedmann equations<equation/> where a is the scale factor.</passage>'
  const brokenFrac = async (tex: string) =>
    tex.includes('\\frac{a') && !tex.includes('}{')
      ? { errors: ['Missing close brace'], undefinedMacros: [] }
      : { errors: [], undefinedMacros: [] }

  function throwingClient(first: string) {
    const requests: ChatRequest[] = []
    return {
      requests,
      async *streamChat(request: ChatRequest): AsyncGenerator<ChatChunk> {
        requests.push(request)
        if (requests.length > 1) throw new Error('network down')
        yield { type: 'text', text: first }
      },
    }
  }

  it('repairs a body MathJax cannot read and keeps the better version', async function () {
    const client = fakeClient(BAD, REPLY)
    const progress: string[] = []
    const outcome = await generateEquation({
      messages: [{ role: 'user', content: 'go' }],
      facts,
      settings,
      onProgress: step => progress.push(step.stage),
      client,
      checkMath: brokenFrac,
    })
    expect(client.requests).to.have.length(2)
    const repair = client.requests[1].messages.at(-1)!.content
    expect(repair).to.include('<problems>\n- MathJax cannot read the body: Missing close brace')
    expect(progress).to.include('repairing')
    expect(outcome).to.include({ kind: 'equation', form: 'align', raw: REPLY })
  })

  it('keeps the first version when the repair is no better', async function () {
    const client = fakeClient(BAD, BAD.replace('display', 'equation'))
    const outcome = await generateEquation({
      messages: [{ role: 'user', content: 'go' }],
      facts,
      settings,
      onProgress: () => {},
      client,
      checkMath: brokenFrac,
    })
    expect(outcome).to.include({ raw: BAD })
  })

  it('keeps the first version when the repair fails', async function () {
    const outcome = await generateEquation({
      messages: [{ role: 'user', content: 'go' }],
      facts,
      settings,
      onProgress: () => {},
      client: throwingClient(BAD),
      checkMath: brokenFrac,
    })
    expect(outcome).to.include({ raw: BAD })
  })

  it('warns about macros the preview does not know, without repairing', async function () {
    const client = fakeClient(REPLY)
    const outcome = await generateEquation({
      messages: [{ role: 'user', content: 'go' }],
      facts,
      settings,
      onProgress: () => {},
      client,
      checkMath: async () => ({ errors: [], undefinedMacros: ['\\Hubble'] }),
    })
    expect(client.requests).to.have.length(1)
    expect(outcome.kind === 'equation' && outcome.warnings.map(w => w.message)).to.include(
      "The preview can't show \\Hubble; check that it compiles."
    )
  })

  it('asks for the format when the reply had no tags', async function () {
    const client = fakeClient('E = mc^2', REPLY)
    const outcome = await generateEquation({
      messages: [{ role: 'user', content: 'go' }],
      facts,
      settings,
      onProgress: () => {},
      client,
    })
    expect(client.requests).to.have.length(2)
    expect(outcome).to.include({ form: 'align' })
  })

  it('does not repair when MathJax is unavailable', async function () {
    const client = fakeClient(BAD)
    const outcome = await generateEquation({
      messages: [{ role: 'user', content: 'go' }],
      facts,
      settings,
      onProgress: () => {},
      client,
      checkMath: async () => null,
    })
    expect(client.requests).to.have.length(1)
    expect(outcome).to.include({ raw: BAD })
  })
})
