import { expect } from 'chai'
import {
  checkBatch,
  CheckResult,
  CheckTarget,
} from '../../../../frontend/js/features/ai-assist/language-suggestions/check-batch'
import {
  LANGUAGE_SUGGESTIONS_SYSTEM,
  PromptRequest,
} from '../../../../frontend/js/features/ai-assist/language-suggestions/prompt'
import { buildUnits } from '../../../../frontend/js/features/ai-assist/language-suggestions/units'
import { StreamingClient } from '../../../../frontend/js/features/ai-assist/writing-tools/run-writing-tool'
import {
  ChatChunk,
  ChatRequest,
  ProviderError,
  ProviderSettings,
} from '../../../../frontend/js/features/ai-assist/providers/types'

const SETTINGS: ProviderSettings = {
  type: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'k',
  model: 'gpt-mini',
}

function batchFor(doc: string): { request: PromptRequest; targets: CheckTarget[] } {
  const units = buildUnits(doc)
  const targets = units.map((unit, i) => ({ id: `s${i + 1}`, masked: unit.masked }))
  return {
    targets,
    request: {
      variant: 'en-US',
      paragraphs: [
        {
          container: 'text',
          sentences: targets.map(t => ({ id: t.id, text: t.masked.text, context: false })),
        },
      ],
    },
  }
}

/** Streams the given chunks, recording each request and when each chunk went out. */
function streaming(chunks: ChatChunk[], events: string[] = []) {
  const requests: ChatRequest[] = []
  const client: StreamingClient = {
    async *streamChat(request) {
      requests.push(request)
      for (let i = 0; i < chunks.length; i++) {
        events.push(`chunk ${i + 1}`)
        yield chunks[i]
      }
      if (chunks.at(-1)?.type !== 'stop') yield { type: 'done' }
    },
  }
  return { client, requests }
}

const text = (value: string): ChatChunk => ({ type: 'text', text: value })

const DOC = 'The results shows a gain. The method is fast.'

function edits(result: CheckResult) {
  return [result.id, result.edits.map(e => [e.original, e.insert])]
}

describe('language suggestions: check batch', function () {
  it('reports each sentence as soon as it is complete', async function () {
    const events: string[] = []
    const { client } = streaming(
      [
        text('<s id="s1">The results show a gain.</s>'),
        text('\n<s id="s2">The method is quick.</s>'),
      ],
      events
    )
    const results: CheckResult[] = []
    const outcome = await checkBatch({
      ...batchFor(DOC),
      settings: SETTINGS,
      client,
      onResult: result => {
        events.push(`result ${result.id}`)
        results.push(result)
      },
    })
    expect(outcome).to.deep.equal({ malformed: false })
    expect(events).to.deep.equal(['chunk 1', 'result s1', 'chunk 2', 'result s2'])
    expect(results.map(edits)).to.deep.equal([
      ['s1', [['shows', 'show']]],
      ['s2', [['fast', 'quick']]],
    ])
  })

  it('reports the sentences the model left out as clean', async function () {
    const { client } = streaming([text('<s id="s1">The results show a gain.</s>')])
    const results: CheckResult[] = []
    await checkBatch({ ...batchFor(DOC), settings: SETTINGS, client, onResult: r => results.push(r) })
    expect(results.map(edits)).to.deep.equal([
      ['s1', [['shows', 'show']]],
      ['s2', []],
    ])
  })

  it('reports everything clean on <none/>', async function () {
    const { client } = streaming([text('<none/>')])
    const results: CheckResult[] = []
    await checkBatch({ ...batchFor(DOC), settings: SETTINGS, client, onResult: r => results.push(r) })
    expect(results.map(edits)).to.deep.equal([
      ['s1', []],
      ['s2', []],
    ])
  })

  it('reports nothing for a reply off the contract', async function () {
    const { client } = streaming([text('Sure! The text looks good to me.')])
    const results: CheckResult[] = []
    const outcome = await checkBatch({ ...batchFor(DOC), settings: SETTINGS, client, onResult: r => results.push(r) })
    expect(outcome).to.deep.equal({ malformed: true })
    expect(results).to.deep.equal([])
  })

  it('reports a sentence whose placeholders the model broke as clean', async function () {
    const { client } = streaming([text('<s id="s1">The value is better here.</s>')])
    const results: CheckResult[] = []
    await checkBatch({
      ...batchFor('The value $x$ shows a gain here.'),
      settings: SETTINGS,
      client,
      onResult: r => results.push(r),
    })
    expect(results.map(edits)).to.deep.equal([['s1', []]])
  })

  it('sends the constant system prompt, cached, with a small output budget', async function () {
    const { client, requests } = streaming([text('<none/>')])
    await checkBatch({ ...batchFor(DOC), settings: SETTINGS, client, onResult: () => {} })
    expect(requests[0].system).to.equal(LANGUAGE_SUGGESTIONS_SYSTEM)
    expect(requests[0].messages[0].content).to.contain('<s id="s1">The results shows a gain.</s>')
    expect(requests[0].maxTokens).to.equal(1024)
    expect(requests[0].cacheHints?.cacheSystem).to.equal(true)
  })

  it('keeps what arrived before a cut-off reply, then reports the cut-off', async function () {
    const { client } = streaming([
      text('<s id="s1">The results show a gain.</s><s id="s2">The meth'),
      { type: 'stop', reason: 'max_tokens' },
    ])
    const results: CheckResult[] = []
    let error: unknown
    try {
      await checkBatch({ ...batchFor(DOC), settings: SETTINGS, client, onResult: r => results.push(r) })
    } catch (e) {
      error = e
    }
    expect((error as ProviderError).code).to.equal('outputTruncated')
    expect(results.map(r => r.id)).to.deep.equal(['s1'])
  })
  it('with style, waits for the rewording of a sentence before reporting it', async function () {
    const events: string[] = []
    const { client } = streaming(
      [
        text('<s id="s1" kind="grammar">The results show a gain.</s>'),
        text('<s id="s1" kind="style">The results show a clear gain.</s>'),
        text('<s id="s2" kind="style">The method is quick.</s>'),
      ],
      events
    )
    const batch = batchFor(DOC)
    const results: CheckResult[] = []
    await checkBatch({
      ...batch,
      request: { ...batch.request, style: true },
      settings: SETTINGS,
      client,
      onResult: result => {
        events.push(`result ${result.id}`)
        results.push(result)
      },
    })
    expect(events).to.deep.equal(['chunk 1', 'chunk 2', 'result s1', 'chunk 3', 'result s2'])
    expect(results.map(r => [r.id, r.edits.map(e => [e.kind, e.original, e.insert])])).to.deep.equal([
      ['s1', [['grammar', 'shows', 'show'], ['style', '', 'clear ']]],
      ['s2', [['style', 'fast', 'quick']]],
    ])
  })

  it('without style, ignores a rewording the model sent anyway', async function () {
    const { client } = streaming([
      text('<s id="s1" kind="grammar">The results show a gain.</s><s id="s1" kind="style">The results show a clear gain.</s>'),
    ])
    const results: CheckResult[] = []
    await checkBatch({ ...batchFor(DOC), settings: SETTINGS, client, onResult: r => results.push(r) })
    expect(results[0].edits.map(e => [e.kind, e.original, e.insert])).to.deep.equal([['grammar', 'shows', 'show']])
  })
})
