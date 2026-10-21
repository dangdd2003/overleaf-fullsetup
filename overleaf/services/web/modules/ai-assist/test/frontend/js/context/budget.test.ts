import { expect } from 'chai'
import {
  applyBudget,
  estimateTokens,
  estimateRequestTokens,
  charsPerToken,
  contextStateFor,
  contextThresholds,
  detectTextKind,
  estimateJsonTokens,
  LEGACY_CLAUDE_MODELS,
  normalizeModelId,
  usesNewClaudeTokenizer,
  KEEP_RECENT_TOOL_RESULTS,
} from '../../../../frontend/js/features/ai-assist/agent/context/budget'
import type {
  AgentMessage,
  ToolSpec,
} from '../../../../frontend/js/features/ai-assist/providers/types'

const BIG = 'x'.repeat(40000)

function conversation(toolResults: number): AgentMessage[] {
  const messages: AgentMessage[] = []
  for (let index = 0; index < toolResults; index++) {
    messages.push({ role: 'user', content: `question ${index}` })
    messages.push({
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: `call-${index}`, name: 'read_file', args: { path: 'main.tex' } },
      ],
    })
    messages.push({
      role: 'tool',
      toolCallId: `call-${index}`,
      name: 'read_file',
      content: BIG,
    })
  }
  messages.push({ role: 'user', content: 'the newest question' })
  return messages
}

describe('estimateTokens', function () {
  it('grows with length and never returns a negative', function () {
    expect(estimateTokens('')).to.equal(0)
    expect(estimateTokens('x'.repeat(370))).to.be.greaterThan(50)
    expect(estimateTokens('x'.repeat(3700))).to.be.greaterThan(
      estimateTokens('x'.repeat(370))
    )
  })
})

describe('applyBudget', function () {
  const limits = { contextWindow: 8000, maxOutputTokens: 1000 }

  it('leaves a small conversation untouched', function () {
    const messages: AgentMessage[] = [{ role: 'user', content: 'hello' }]
    const result = applyBudget({ system: 'sys', messages, limits })
    expect(result.messages).to.deep.equal(messages)
    expect(result.elided).to.equal(0)
    expect(result.exhausted).to.equal(false)
  })

  it('elides old tool results while keeping the most recent verbatim', function () {
    const result = applyBudget({
      system: 'sys',
      messages: conversation(6),
      limits,
    })

    const toolMessages = result.messages.filter(
      message => message.role === 'tool'
    )
    const intact = toolMessages.filter(message => message.content === BIG)
    expect(intact).to.have.length(KEEP_RECENT_TOOL_RESULTS)
    expect(result.elided).to.be.greaterThan(0)
  })

  it('names the tool and how to get the content back in the stub', function () {
    const result = applyBudget({
      system: 'sys',
      messages: conversation(6),
      limits,
    })
    const stub = result.messages.find(
      message => message.role === 'tool' && message.content !== BIG
    )
    const parsed = JSON.parse((stub as { content: string }).content)
    expect(parsed.elided).to.equal(true)
    expect(parsed.summary).to.include('read_file')
  })

  it('elides oldest first', function () {
    const result = applyBudget({
      system: 'sys',
      messages: conversation(6),
      limits,
    })
    const toolMessages = result.messages.filter(
      message => message.role === 'tool'
    )
    const firstIntact = toolMessages.findIndex(
      message => message.content === BIG
    )
    expect(firstIntact).to.equal(toolMessages.length - KEEP_RECENT_TOOL_RESULTS)
  })

  it('never orphans a tool call from its result', function () {
    const result = applyBudget({
      system: 'sys',
      messages: conversation(6),
      limits,
    })
    const callIds = result.messages
      .filter(message => message.role === 'assistant')
      .flatMap(
        message => (message as { toolCalls?: { id: string }[] }).toolCalls ?? []
      )
      .map(call => call.id)
    const resultIds = result.messages
      .filter(message => message.role === 'tool')
      .map(message => (message as { toolCallId: string }).toolCallId)
    expect(resultIds.sort()).to.deep.equal(callIds.sort())
  })

  it('never elides user messages', function () {
    const result = applyBudget({
      system: 'sys',
      messages: conversation(6),
      limits,
    })
    const users = result.messages.filter(message => message.role === 'user')
    expect(users).to.have.length(7)
    expect(users[users.length - 1].content).to.equal('the newest question')
  })

  it('is monotonic — eliding an already-elided array changes nothing', function () {
    const once = applyBudget({
      system: 'sys',
      messages: conversation(6),
      limits,
    })
    const twice = applyBudget({
      system: 'sys',
      messages: once.messages,
      limits,
    })
    expect(twice.messages).to.deep.equal(once.messages)
  })

  it('reports exhaustion rather than sending a request that will 400', function () {
    const tiny = { contextWindow: 200, maxOutputTokens: 100 }
    const result = applyBudget({
      system: 'sys',
      messages: conversation(6),
      limits: tiny,
    })
    expect(result.exhausted).to.equal(true)
  })
})

/** The hard budget is the block threshold, so boundary specs target it exactly. */
function budgetFor(theLimits: {
  contextWindow: number
  maxOutputTokens: number
}): number {
  return contextThresholds(theLimits).blockAt
}

describe('applyBudget boundaries', function () {
  const limits = { contextWindow: 8000, maxOutputTokens: 1000 }

  it('leaves a request exactly at the limit untouched', function () {
    const budget = budgetFor(limits)
    const target = budget - estimateTokens('sys')
    const content = 'x'.repeat(Math.floor(target * charsPerToken('prose')))
    // Guards the construction itself against float surprises before relying on it.
    expect(estimateTokens(content)).to.equal(target)

    const messages: AgentMessage[] = [{ role: 'user', content }]
    const result = applyBudget({ system: 'sys', messages, limits })
    expect(result.messages).to.deep.equal(messages)
    expect(result.elided).to.equal(0)
    expect(result.exhausted).to.equal(false)
  })

  it('reports exhaustion one token over the limit when nothing is elidable', function () {
    const budget = budgetFor(limits)
    const target = budget - estimateTokens('sys') + 1
    const content = 'x'.repeat(Math.floor(target * charsPerToken('prose')))
    expect(estimateTokens(content)).to.equal(target)

    const messages: AgentMessage[] = [{ role: 'user', content }]
    const result = applyBudget({ system: 'sys', messages, limits })
    // A lone user message can never be elided, so going one token over
    // reports exhaustion rather than silently dropping user content.
    expect(result.messages).to.deep.equal(messages)
    expect(result.exhausted).to.equal(true)
  })

  it('does not touch tool results when there are fewer than KEEP_RECENT_TOOL_RESULTS', function () {
    const result = applyBudget({
      system: 'sys',
      messages: conversation(2),
      limits,
    })
    const toolMessages = result.messages.filter(
      message => message.role === 'tool'
    )
    const intact = toolMessages.filter(message => message.content === BIG)
    expect(intact).to.have.length(2)
    expect(result.elided).to.equal(0)
    expect(result.exhausted).to.equal(true)
  })

  it('elision can succeed: a request too big to send untrimmed fits after eliding', function () {
    const roomy = { contextWindow: 50000, maxOutputTokens: 1000 }
    const result = applyBudget({
      system: 'sys',
      messages: conversation(6),
      limits: roomy,
    })
    // Two elisions would already fit the 44,000 budget; trimming continues
    // toward 70% of it (30,800) so the next steps keep the cached prefix.
    // Only three results are elidable (the newest three are kept).
    expect(result.elided).to.equal(3)
    expect(result.exhausted).to.equal(false)
  })

  it('trims no further than needed to reach the target', function () {
    const roomy = { contextWindow: 50000, maxOutputTokens: 1000 }
    const once = applyBudget({
      system: 'sys',
      messages: conversation(6),
      limits: roomy,
    })
    const next = [
      ...once.messages,
      { role: 'user', content: 'another question' } as AgentMessage,
    ]
    const twice = applyBudget({ system: 'sys', messages: next, limits: roomy })
    expect(twice.elided).to.equal(0)
    expect(twice.messages.slice(0, once.messages.length)).to.deep.equal(
      once.messages
    )
  })
})

describe('applyBudget — assistant elision never produces an invalid message', function () {
  const limits = { contextWindow: 8000, maxOutputTokens: 1000 }

  it('does not blank the only assistant turn to empty content (no tool calls)', function () {
    // Reproduces the reviewer's replication: a single, over-budget assistant
    // reply with no tool calls sits inside the keep-recent floor, so it must
    // survive intact rather than being rewritten to `content: ''`.
    const messages: AgentMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'z'.repeat(40000) },
      { role: 'user', content: 'again' },
    ]
    const result = applyBudget({ system: 'sys', messages, limits })

    for (const message of result.messages) {
      if (message.role === 'assistant') {
        const hasToolCalls = Boolean(
          (message as { toolCalls?: unknown[] }).toolCalls?.length
        )
        expect(message.content !== '' || hasToolCalls).to.equal(true)
      }
    }
    // Protected by the keep-recent floor, so this genuinely cannot be
    // trimmed further — reported honestly as exhausted, not silently
    // rewritten into a request the provider would reject.
    expect(result.exhausted).to.equal(true)
  })

  it('replaces old assistant prose with a non-empty marker and keeps tool calls attached', function () {
    const messages: AgentMessage[] = []
    for (let index = 0; index < 6; index++) {
      messages.push({ role: 'user', content: `question ${index}` })
      messages.push({
        role: 'assistant',
        content: 'y'.repeat(5000),
        toolCalls: [
          {
            id: `call-${index}`,
            name: 'read_file',
            args: { path: 'main.tex' },
          },
        ],
      })
      messages.push({
        role: 'tool',
        toolCallId: `call-${index}`,
        name: 'read_file',
        content: 'ok',
      })
    }
    messages.push({ role: 'user', content: 'the latest question' })

    const result = applyBudget({ system: 'sys', messages, limits })
    expect(result.exhausted).to.equal(false)

    const assistants = result.messages.filter(
      message => message.role === 'assistant'
    ) as Extract<AgentMessage, { role: 'assistant' }>[]
    const rewritten = assistants.filter(
      message => message.content !== 'y'.repeat(5000)
    )
    expect(rewritten.length).to.be.greaterThan(0)
    for (const message of rewritten) {
      expect(message.content).to.not.equal('')
      expect(message.toolCalls).to.have.length(1)
    }
  })
})

describe('applyBudget — eliding an assistant reply never grows the request', function () {
  it('does not rewrite a short assistant reply into a longer marker', function () {
    // Symmetric to the tool-result shrink guard: 'ok' (1 token) is shorter
    // than the marker that would replace it, so pass two must leave it alone
    // rather than trading a short reply for a longer placeholder.
    const tiny = { contextWindow: 200, maxOutputTokens: 100 }
    const messages: AgentMessage[] = []
    for (let index = 0; index < 6; index++) {
      messages.push({ role: 'user', content: `question ${index}` })
      messages.push({
        role: 'assistant',
        content: 'ok',
        toolCalls: [
          {
            id: `call-${index}`,
            name: 'read_file',
            args: { path: 'main.tex' },
          },
        ],
      })
      messages.push({
        role: 'tool',
        toolCallId: `call-${index}`,
        name: 'read_file',
        content: BIG,
      })
    }
    messages.push({ role: 'user', content: 'the newest question' })

    const before = estimateRequestTokens('sys', messages)
    const result = applyBudget({ system: 'sys', messages, limits: tiny })
    const after = estimateRequestTokens('sys', result.messages)

    const assistants = result.messages.filter(
      message => message.role === 'assistant'
    ) as Extract<AgentMessage, { role: 'assistant' }>[]
    for (const message of assistants) {
      expect(message.content).to.equal('ok')
    }
    expect(after).to.be.at.most(before)
  })
})

describe('applyBudget — the assistant keep-recent floor', function () {
  it('leaves every assistant turn intact when the conversation is at or below the floor (the floor doing its job, not elision failing)', function () {
    const limits = { contextWindow: 8000, maxOutputTokens: 1000 }
    const bigReply = 'z'.repeat(40000)
    const messages: AgentMessage[] = []
    for (let index = 0; index < KEEP_RECENT_TOOL_RESULTS; index++) {
      messages.push({ role: 'user', content: `question ${index}` })
      messages.push({ role: 'assistant', content: bigReply })
    }
    messages.push({ role: 'user', content: 'the latest question' })

    // Confirms the fixture actually needs trimming to be a meaningful test
    // of the floor rather than a small-conversation no-op.
    expect(estimateRequestTokens('sys', messages)).to.be.greaterThan(
      limits.contextWindow - limits.maxOutputTokens
    )

    const result = applyBudget({ system: 'sys', messages, limits })
    const assistants = result.messages.filter(
      message => message.role === 'assistant'
    ) as Extract<AgentMessage, { role: 'assistant' }>[]
    expect(assistants).to.have.length(KEEP_RECENT_TOOL_RESULTS)
    for (const message of assistants) {
      expect(message.content).to.equal(bigReply)
    }
    // Nothing was elidable at all (no tool results, every assistant turn
    // protected by the floor), so this is the floor costing the fit, not a
    // bug — reported honestly as exhausted rather than silently rewritten.
    expect(result.exhausted).to.equal(true)
  })
})

describe('applyBudget — eliding a tool result never grows the request', function () {
  it('skips stubbing small tool results that would only get bigger once wrapped', function () {
    const tiny = { contextWindow: 500, maxOutputTokens: 100 }
    const messages: AgentMessage[] = []
    for (let index = 0; index < 40; index++) {
      messages.push({ role: 'user', content: `q${index}` })
      messages.push({
        role: 'assistant',
        content: '',
        toolCalls: [{ id: `call-${index}`, name: 'lookup', args: {} }],
      })
      messages.push({
        role: 'tool',
        toolCallId: `call-${index}`,
        name: 'lookup',
        content: JSON.stringify({ error: 'nope' }),
      })
    }

    const before = estimateRequestTokens('sys', messages)
    const result = applyBudget({ system: 'sys', messages, limits: tiny })
    const after = estimateRequestTokens('sys', result.messages)

    expect(after).to.be.at.most(before)
  })
})

describe('estimateRequestTokens with tool specs', function () {
  it('is unaffected when tools are omitted', function () {
    const messages: AgentMessage[] = [{ role: 'user', content: 'hi' }]
    const withoutArg = estimateRequestTokens('sys', messages)
    const withEmptyArray = estimateRequestTokens('sys', messages, [])
    expect(withEmptyArray).to.equal(withoutArg)
  })

  it('counts supplied tool schemas toward the total', function () {
    const messages: AgentMessage[] = [{ role: 'user', content: 'hi' }]
    const tools: ToolSpec[] = [
      {
        name: 'read_file',
        description: 'Reads a file from the project',
        parameters: { type: 'object' },
      },
    ]
    const without = estimateRequestTokens('sys', messages)
    const withTools = estimateRequestTokens('sys', messages, tools)
    expect(withTools).to.be.greaterThan(without)
  })
})

describe('applyBudget with tool specs', function () {
  it('counts tool schema cost toward the budget when supplied', function () {
    const messages: AgentMessage[] = [{ role: 'user', content: 'hi' }]
    const tools: ToolSpec[] = [
      { name: 'x', description: 'y'.repeat(3000), parameters: {} },
    ]
    const tight = { contextWindow: 900, maxOutputTokens: 100 }

    const withoutTools = applyBudget({ system: 'sys', messages, limits: tight })
    expect(withoutTools.exhausted).to.equal(false)

    const withTools = applyBudget({
      system: 'sys',
      messages,
      limits: tight,
      tools,
    })
    expect(withTools.exhausted).to.equal(true)
  })
})

describe('applyBudget with a misconfigured budget', function () {
  it('flags a non-positive budget distinctly instead of blaming the conversation', function () {
    const messages: AgentMessage[] = [{ role: 'user', content: 'hi' }]
    // maxOutputTokens plus the margin already consume the whole window.
    const misconfigured = { contextWindow: 2048, maxOutputTokens: 2048 }
    const result = applyBudget({
      system: 'sys',
      messages,
      limits: misconfigured,
    })
    expect(result.exhausted).to.equal(true)
    expect(result.reason).to.equal('budget-non-positive')
  })

  it('does not misreport a genuinely oversized conversation as misconfigured', function () {
    const limits = { contextWindow: 200, maxOutputTokens: 100 }
    const result = applyBudget({
      system: 'sys',
      messages: conversation(6),
      limits,
    })
    expect(result.exhausted).to.equal(true)
    expect(result.reason).to.equal(undefined)
  })
})

describe('estimateTokens ratio', function () {
  it('pins the prose ratio at 4 characters per token', function () {
    expect(estimateTokens('x'.repeat(40))).to.equal(10)
    expect(charsPerToken('prose')).to.equal(4)
  })

  it('uses 3.5 for LaTeX and 3 for JSON', function () {
    expect(charsPerToken('latex')).to.equal(3.5)
    expect(charsPerToken('json')).to.equal(3)
    const latex = '\\begin{document}'
    expect(estimateTokens(latex, {}, 'latex')).to.equal(Math.ceil(latex.length / 3.5))
    const json = JSON.stringify({ a: 'bbbbbbbbb' })
    expect(estimateJsonTokens({ a: 'bbbbbbbbb' })).to.equal(Math.ceil(json.length / 3))
  })

  it('detects LaTeX or code when 2% of the first 4096 characters are markup', function () {
    expect(detectTextKind('plain words only, no markup at all')).to.equal('prose')
    expect(detectTextKind('\\frac{a}{b} $x$ & y ^ 2 % c _ d')).to.equal('latex')
    // 1 markup character in 100 is 1%: prose
    expect(detectTextKind('{' + 'a'.repeat(99))).to.equal('prose')
    expect(detectTextKind('{' + 'a'.repeat(49))).to.equal('latex')
    expect(detectTextKind('')).to.equal('prose')
  })

  it('scales the ratio by 0.75 only for Anthropic models on the newer tokenizer', function () {
    expect(charsPerToken('prose', { provider: 'anthropic', model: 'claude-opus-4-7' })).to.equal(3)
    expect(charsPerToken('latex', { provider: 'anthropic', model: 'claude-opus-4-7' })).to.equal(2.625)
    expect(charsPerToken('json', { provider: 'anthropic', model: 'claude-opus-4-7' })).to.equal(2.25)
    // Legacy list, same model under another provider, and no model: unchanged
    expect(charsPerToken('prose', { provider: 'anthropic', model: 'claude-sonnet-4-5' })).to.equal(4)
    expect(charsPerToken('prose', { provider: 'openai', model: 'claude-opus-4-7' })).to.equal(4)
    expect(charsPerToken('prose', { provider: 'anthropic' })).to.equal(4)
    expect(charsPerToken('prose', { provider: 'ollama', model: 'llama3' })).to.equal(4)
  })
})

describe('legacy Claude model list', function () {
  it('holds the same fourteen ids as Claude Code', function () {
    expect(LEGACY_CLAUDE_MODELS.size).to.equal(14)
    expect([...LEGACY_CLAUDE_MODELS]).to.include.members([
      'claude-3-opus',
      'claude-3-5-haiku',
      'claude-opus-4-5',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
    ])
  })

  it('normalises provider prefixes, date suffixes and dots before comparing', function () {
    expect(normalizeModelId('claude-sonnet-4-5-20250929')).to.equal('claude-sonnet-4-5')
    expect(normalizeModelId('anthropic/claude-sonnet-4.5')).to.equal('claude-sonnet-4-5')
    expect(normalizeModelId('us.anthropic.claude-haiku-4-5-20251001-v1:0')).to.equal('claude-haiku-4-5')
    expect(usesNewClaudeTokenizer({ provider: 'anthropic', model: 'claude-sonnet-4.5-20250929' })).to.equal(false)
    expect(usesNewClaudeTokenizer({ provider: 'anthropic', model: 'claude-sonnet-4-7' })).to.equal(true)
  })
})

describe('context thresholds', function () {
  it('computes Claude Code thresholds from the window and the output reserve', function () {
    // reserve 20000, effective 180000; buffers 13000, 20000, 3000
    expect(contextThresholds({ contextWindow: 200000, maxOutputTokens: 32000 })).to.deep.equal({
      effective: 180000,
      autoCompactAt: 167000,
      warnAt: 160000,
      blockAt: 177000,
    })
  })

  it('caps the buffers on a small window so the headroom survives', function () {
    // reserve 2000, effective 6000; auto 900, warn 1200, block 180
    expect(contextThresholds({ contextWindow: 8000, maxOutputTokens: 2000 })).to.deep.equal({
      effective: 6000,
      autoCompactAt: 5100,
      warnAt: 4800,
      blockAt: 5820,
    })
  })

  it('reads a count against the thresholds', function () {
    const thresholds = contextThresholds({ contextWindow: 200000, maxOutputTokens: 32000 })
    expect(contextStateFor(159999, thresholds)).to.equal('ok')
    expect(contextStateFor(160000, thresholds)).to.equal('warn')
    expect(contextStateFor(167000, thresholds)).to.equal('compact')
    expect(contextStateFor(177000, thresholds)).to.equal('blocked')
  })
})
