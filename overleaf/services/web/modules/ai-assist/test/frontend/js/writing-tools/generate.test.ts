import { expect } from 'chai'
import {
  contextEchoes,
  generate,
  WritingProgress,
} from '../../../../frontend/js/features/ai-assist/writing-tools/generate'
import { WritingRequest } from '../../../../frontend/js/features/ai-assist/writing-tools/prompt'
import { StreamingClient } from '../../../../frontend/js/features/ai-assist/writing-tools/run-writing-tool'
import {
  ChatRequest,
  ProviderSettings,
} from '../../../../frontend/js/features/ai-assist/providers/types'

const SETTINGS: ProviderSettings = {
  type: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'k',
  model: 'claude',
}

const REQUEST: WritingRequest = {
  action: 'rephrase',
  selection: 'As shown in \\cite{a,b}, the method is fast.',
  before: 'We evaluate three baselines on the benchmark suite.\n',
  after: '\nThe ablation study in Section 4 confirms this result.',
  macros: [],
}

/** Answers each call with the next reply, recording every request. */
function scripted(...replies: string[]) {
  const requests: ChatRequest[] = []
  const client: StreamingClient = {
    async *streamChat(request) {
      requests.push(request)
      const reply = replies[requests.length - 1]
      if (reply === undefined) throw new Error('unexpected call')
      yield { type: 'text', text: reply }
      yield { type: 'done' }
    },
  }
  return { client, requests }
}

function run(
  client: StreamingClient,
  request: Partial<WritingRequest> = {},
  original = ` ${REQUEST.selection}\n`
) {
  const progress: WritingProgress[] = []
  return generate({
    request: { ...REQUEST, ...request },
    original,
    settings: SETTINGS,
    client,
    onProgress: p => progress.push(p),
  }).then(outcome => ({ outcome, progress }))
}

describe('writing tools: generate', function () {
  it('returns a clean rewrite with the selection whitespace put back', async function () {
    const { client, requests } = scripted(
      '<rewrite>The method is fast, as \\cite{a,b} show.</rewrite>'
    )
    const { outcome, progress } = await run(client)
    expect(outcome).to.deep.equal({
      kind: 'rewrite',
      text: ' The method is fast, as \\cite{a,b} show.\n',
      warnings: [],
    })
    expect(requests).to.have.length(1)
    expect(progress.at(-1)).to.deep.equal({
      stage: 'writing',
      text: 'The method is fast, as \\cite{a,b} show.',
      options: [],
    })
  })

  it('reports an unchanged result instead of an empty diff', async function () {
    const { client } = scripted(`<rewrite>\n${REQUEST.selection}\n</rewrite>`)
    expect((await run(client)).outcome).to.deep.equal({ kind: 'unchanged' })
  })

  it('repairs a dropped citation in a second turn', async function () {
    const first = '<rewrite>The method is fast \\cite{a}.</rewrite>'
    const { client, requests } = scripted(
      first,
      '<rewrite>The method is fast \\cite{a,b}.</rewrite>'
    )
    const { outcome, progress } = await run(client)
    expect(outcome).to.deep.equal({
      kind: 'rewrite',
      text: ' The method is fast \\cite{a,b}.\n',
      warnings: [],
    })
    expect(requests).to.have.length(2)
    const messages = requests[1].messages
    expect(messages[1]).to.deep.equal({ role: 'assistant', content: first })
    expect(messages[2].content).to.include('\\cite{b} was dropped')
    expect(progress.some(p => p.stage === 'repairing')).to.equal(true)
  })

  it('keeps the first version when the repair is no better', async function () {
    const { client } = scripted(
      '<rewrite>The method is fast \\cite{a}.</rewrite>',
      '<rewrite>The method is fast.</rewrite>'
    )
    const { outcome } = await run(client)
    expect(outcome).to.deep.equal({
      kind: 'rewrite',
      text: ' The method is fast \\cite{a}.\n',
      warnings: [{ kind: 'droppedKey', message: '\\cite{b} was dropped' }],
    })
  })

  it('does not repair an added key, which may be intended', async function () {
    const { client, requests } = scripted(
      '<rewrite>As shown in \\cite{a,b,c}, the method is fast.</rewrite>'
    )
    const { outcome } = await run(client)
    expect(requests).to.have.length(1)
    expect(outcome.kind === 'rewrite' && outcome.warnings).to.deep.equal([
      { kind: 'addedKey', message: '\\cite{c} was added' },
    ])
  })

  it('never repairs against the author’s own instruction', async function () {
    const { client, requests } = scripted(
      '<rewrite>The method is fast \\cite{a}.</rewrite>'
    )
    await run(client, {
      rephrase: {
        level: 'medium',
        style: null,
        length: null,
        prompt: 'drop the second citation',
      },
    })
    expect(requests).to.have.length(1)
  })

  it('repairs a result that copied the following text', async function () {
    const { client, requests } = scripted(
      '<rewrite>The method is fast \\cite{a,b}.\nThe ablation study in Section 4 confirms this result.</rewrite>',
      '<rewrite>The method is fast \\cite{a,b}.</rewrite>'
    )
    const { outcome } = await run(client)
    expect(requests).to.have.length(2)
    expect(requests[1].messages[2].content).to.include('repeats text')
    expect(outcome.kind === 'rewrite' && outcome.text).to.equal(
      ' The method is fast \\cite{a,b}.\n'
    )
  })

  it('keeps the first version when the repair call fails', async function () {
    const { client } = scripted('<rewrite>The method is fast \\cite{a}.</rewrite>')
    const { outcome } = await run(client)
    expect(outcome.kind).to.equal('rewrite')
  })

  it('passes cannot through', async function () {
    const { client } = scripted('<cannot>The selection holds only math.</cannot>')
    expect((await run(client)).outcome).to.deep.equal({
      kind: 'cannot',
      reason: 'The selection holds only math.',
    })
  })

  it('filters synonyms already shown or equal to the selection', async function () {
    const { client } = scripted(
      '<synonyms><s>Fast</s><s>rapid</s><s>swift</s></synonyms>'
    )
    const { outcome } = await run(
      client,
      { action: 'synonyms', selection: 'fast', previous: ['rapid'] },
      'fast'
    )
    expect(outcome).to.deep.equal({ kind: 'synonyms', options: ['swift'] })
  })

  it('warns when a translation needs a script the document cannot typeset', async function () {
    const { client } = scripted('<rewrite>如 \\cite{a,b} 所示，该方法很快。</rewrite>')
    const outcome = await generate({
      request: { ...REQUEST, action: 'translate', targetLanguage: 'Chinese (Simplified)' },
      original: REQUEST.selection,
      doc: '\\documentclass{article}\n\\begin{document}\nx\n\\end{document}',
      settings: SETTINGS,
      client,
      onProgress: () => {},
    })
    expect(outcome.kind === 'rewrite' && outcome.warnings.map(w => w.kind)).to.deep.equal([
      'script',
    ])
  })
})

describe('writing tools: context echo', function () {
  it('finds context copied into the result, not context the selection has', function () {
    const after = 'The ablation study in Section 4 confirms this result.'
    expect(contextEchoes('A.', `B. ${after}`, '', after)).to.have.length(1)
    expect(contextEchoes(`A. ${after}`, `B. ${after}`, '', after)).to.deep.equal([])
    expect(contextEchoes('A.', 'B.', '', 'short')).to.deep.equal([])
  })
})
