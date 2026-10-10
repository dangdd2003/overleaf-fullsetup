import { expect } from 'chai'
import {
  generateTexGpt,
  TexGptProgress,
} from '../../../../frontend/js/features/ai-assist/texgpt/generate'
import { StreamingClient } from '../../../../frontend/js/features/ai-assist/writing-tools/run-writing-tool'
import {
  AgentMessage,
  ChatRequest,
  ProviderSettings,
} from '../../../../frontend/js/features/ai-assist/providers/types'

const SETTINGS: ProviderSettings = {
  type: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'k',
  model: 'claude',
}

const MESSAGES: AgentMessage[] = [
  { role: 'user', content: '<request>\nx\n</request>' },
]

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
  options: Partial<Parameters<typeof generateTexGpt>[0]> = {}
) {
  const progress: TexGptProgress[] = []
  return generateTexGpt({
    messages: MESSAGES,
    loaded: new Set(),
    docClass: 'article',
    settings: SETTINGS,
    client,
    onProgress: p => progress.push(p),
    ...options,
  }).then(outcome => ({ outcome, progress }))
}

describe('texgpt: generate', function () {
  it('returns code with the packages the project lacks', async function () {
    const { client, requests } = scripted(
      '<latex>\\begin{tabular}{l}\\toprule a\\end{tabular}</latex>'
    )
    const { outcome } = await run(client)
    expect(outcome).to.deep.include({
      kind: 'latex',
      text: '\\begin{tabular}{l}\\toprule a\\end{tabular}',
      packages: ['booktabs'],
    })
    expect((outcome as any).warnings.map((w: any) => w.kind)).to.deep.equal([
      'package',
    ])
    expect(requests[0].system).to.include('TeXGPT')
    expect(requests[0].maxTokens).to.be.at.most(8192)
  })

  it('keeps the selection whitespace and reports unchanged text', async function () {
    const { client } = scripted('<latex>the result</latex>')
    const { outcome } = await run(client, { original: ' teh result\n' })
    expect(outcome).to.deep.include({ kind: 'latex', text: ' the result\n' })
    const same = scripted('<latex>teh result</latex>')
    expect(
      (await run(same.client, { original: ' teh result\n' })).outcome
    ).to.deep.equal({ kind: 'unchanged' })
  })

  it('passes answers, refusals and options through', async function () {
    expect(
      (await run(scripted('<answer>Use X.</answer>').client)).outcome
    ).to.deep.include({ kind: 'answer', text: 'Use X.' })
    expect(
      (await run(scripted('<cannot>No.</cannot>').client)).outcome
    ).to.deep.equal({ kind: 'cannot', reason: 'No.' })
    expect(
      (
        await run(scripted('<titles><t>A</t></titles>').client, {
          expect: 'titles',
        })
      ).outcome
    ).to.deep.include({ kind: 'options', options: ['A'] })
    expect(
      (await run(scripted('<latex></latex>').client)).outcome
    ).to.deep.equal({ kind: 'empty' })
  })

  it('repairs broken structure once and keeps the better version', async function () {
    const { client, requests } = scripted(
      '<latex>\\begin{table}x</latex>',
      '<latex>\\begin{table}x\\end{table}</latex>'
    )
    const { outcome, progress } = await run(client)
    expect(outcome).to.deep.include({
      kind: 'latex',
      text: '\\begin{table}x\\end{table}',
      warnings: [],
    })
    expect(requests).to.have.length(2)
    expect(requests[1].messages[1]).to.deep.equal({
      role: 'assistant',
      content: '<latex>\\begin{table}x</latex>',
    })
    expect(requests[1].messages[2].content).to.include(
      '\\begin{table} has no matching \\end{table}'
    )
    expect(progress.some(p => p.stage === 'repairing')).to.equal(true)
  })

  it('keeps the first version when the repair is no better or fails', async function () {
    const worse = scripted(
      '<latex>\\begin{table}x</latex>',
      '<latex>\\begin{table}\\begin{figure}</latex>'
    )
    expect((await run(worse.client)).outcome).to.deep.include({
      text: '\\begin{table}x',
    })
    const failing = scripted('<latex>\\begin{table}x</latex>')
    const { outcome } = await run(failing.client)
    expect(outcome).to.deep.include({ text: '\\begin{table}x' })
    expect((outcome as any).warnings[0]).to.deep.equal({
      kind: 'structure',
      message: '\\begin{table} has no matching \\end{table}',
    })
  })
})
