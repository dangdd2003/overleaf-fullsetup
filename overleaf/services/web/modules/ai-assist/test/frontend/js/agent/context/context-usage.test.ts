import { expect } from 'chai'
import {
  CONTEXT_CATEGORY_ORDER,
  computeContextUsage,
  formatPercent,
  formatTokens,
} from '../../../../../frontend/js/features/ai-assist/agent/context/context-usage'
import { estimateTokens } from '../../../../../frontend/js/features/ai-assist/agent/context/budget'
import { TranscriptEntry } from '../../../../../frontend/js/features/ai-assist/agent/agent-messages'
import { ContextBreakdown, ProviderUsage } from '../../../../../frontend/js/features/ai-assist/agent/context/context-usage-types'

const LIMITS = { contextWindow: 200000, maxOutputTokens: 32000 }
// The block threshold: 200000 - min(32000, 20000) - min(3000, 3% of 180000)
const FALLBACK_BUDGET = 177000

const user = (id: string, text: string, extra: Partial<TranscriptEntry> = {}) =>
  ({ id, role: 'user', text, ...extra }) as TranscriptEntry

const assistant = (
  id: string,
  extra: Partial<Extract<TranscriptEntry, { role: 'assistant' }>> = {}
) =>
  ({
    id,
    role: 'assistant',
    text: '',
    toolCalls: [],
    ...extra,
  }) as TranscriptEntry

function usage(overrides: Partial<ProviderUsage> = {}): ProviderUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    ...overrides,
  }
}

function breakdown(overrides: Partial<ContextBreakdown> = {}): ContextBreakdown {
  return {
    systemPrompt: 0,
    projectInstructions: 0,
    connectorInstructions: 0,
    builtinTools: 0,
    webTools: 0,
    connectorTools: 0,
    userMessages: 0,
    projectContext: 0,
    assistantMessages: 0,
    toolResults: 0,
    images: 0,
    elidedMessages: 0,
    droppedMessages: 0,
    contextWindow: 200000,
    maxOutputTokens: 32000,
    budget: FALLBACK_BUDGET,
    ...overrides,
  }
}

type Snapshot = ReturnType<typeof computeContextUsage>

function tokensOf(snapshot: Snapshot, id: string): number {
  return snapshot.categories.find(category => category.id === id)!.tokens
}

function sumCategories(snapshot: Snapshot) {
  return snapshot.categories.reduce((total, category) => total + category.tokens, 0)
}

describe('formatTokens', function () {
  it('formats counts the way Claude Code does, without a stray .0', function () {
    const table: [number, string][] = [
      [0, '0'],
      [999, '999'],
      [1000, '1k'],
      [1049, '1k'],
      [12345, '12.3k'],
      [200000, '200k'],
      [1000000, '1M'],
      [1500000, '1.5M'],
    ]
    for (const [n, expected] of table) {
      expect(formatTokens(n), String(n)).to.equal(expected)
    }
  })
})

describe('formatPercent', function () {
  it('keeps one decimal and the percent sign', function () {
    expect(formatPercent(23.4567)).to.equal('23.5%')
    expect(formatPercent(0)).to.equal('0.0%')
    expect(formatPercent(100)).to.equal('100.0%')
  })
})

describe('computeContextUsage', function () {
  it('lists the rows in Claude Code order, ending with the buffer and free space', function () {
    expect(CONTEXT_CATEGORY_ORDER).to.deep.equal([
      'messages',
      'systemTools',
      'mcpTools',
      'skills',
      'systemPrompt',
      'memoryFiles',
      'mcpInstructions',
      'sinceLastUpdate',
      'reserved',
      'free',
    ])
  })

  it('takes the meter total from exact usage and marks it exact', function () {
    const transcript = [
      user('u1', 'hello'),
      assistant('a1', {
        text: 'hi there',
        usage: usage({
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: 2000,
          cacheCreationTokens: 100,
        }),
      }),
    ]
    const snapshot = computeContextUsage({ transcript, limits: LIMITS })

    expect(snapshot.exact).to.equal(true)
    expect(snapshot.usedTokens).to.equal(3600)
    expect(snapshot.usage?.outputTokens).to.equal(500)
    expect(snapshot.budget).to.equal(FALLBACK_BUDGET)
    expect(snapshot.contextWindow).to.equal(200000)
    // No fixed rows known: input + output all falls to messages
    expect(tokensOf(snapshot, 'messages')).to.equal(3600)
    expect(sumCategories(snapshot)).to.equal(200000)
  })

  it('takes the fixed rows from the paired breakdown and the rest to messages', function () {
    // Fixed F = systemPrompt 1000 + systemTools 500 (builtin) = 1500
    // messages = I - F + O = 4000 - 1500 + 50 = 2550
    const snapshot = computeContextUsage({
      transcript: [
        user('u1', 'hi'),
        assistant('a1', {
          text: 'reply',
          usage: usage({ inputTokens: 4000, outputTokens: 50, step: 1 }),
          usageBreakdown: breakdown({
            systemPrompt: 1000,
            builtinTools: 500,
            userMessages: 1000,
            toolResults: 1000,
            step: 1,
          }),
        }),
      ],
      limits: LIMITS,
    })

    expect(snapshot.exact).to.equal(true)
    expect(tokensOf(snapshot, 'systemPrompt')).to.equal(1000)
    expect(tokensOf(snapshot, 'systemTools')).to.equal(500)
    expect(tokensOf(snapshot, 'messages')).to.equal(2550)
    expect(snapshot.usedTokens).to.equal(4050)
    expect(sumCategories(snapshot)).to.equal(200000)
  })

  it('maps memory files, MCP instructions, MCP tools and skills to their own rows', function () {
    const snapshot = computeContextUsage({
      transcript: [
        user('u1', 'hi'),
        assistant('a1', {
          usage: usage({ inputTokens: 5000, step: 1 }),
          usageBreakdown: breakdown({
            projectInstructions: 100,
            connectorInstructions: 200,
            connectorTools: 300,
            skills: 400,
            step: 1,
          }),
        }),
      ],
      limits: LIMITS,
    })

    expect(tokensOf(snapshot, 'memoryFiles')).to.equal(100)
    expect(tokensOf(snapshot, 'mcpInstructions')).to.equal(200)
    expect(tokensOf(snapshot, 'mcpTools')).to.equal(300)
    expect(tokensOf(snapshot, 'skills')).to.equal(400)
    expect(tokensOf(snapshot, 'messages')).to.equal(5000 - 1000)
    expect(sumCategories(snapshot)).to.equal(200000)
  })

  it('scales the fixed rows down to the input when they overshoot it', function () {
    // F = 800 + 600 + 200 = 1600 > I = 1000: fixed rows scale to 1000
    const snapshot = computeContextUsage({
      transcript: [
        user('u1', 'hi'),
        assistant('a1', {
          usage: usage({ inputTokens: 1000, outputTokens: 50, step: 1 }),
          usageBreakdown: breakdown({
            systemPrompt: 800,
            connectorTools: 600,
            skills: 200,
            step: 1,
          }),
        }),
      ],
      limits: LIMITS,
    })

    expect(tokensOf(snapshot, 'systemPrompt')).to.equal(500)
    expect(tokensOf(snapshot, 'mcpTools')).to.equal(375)
    expect(tokensOf(snapshot, 'skills')).to.equal(125)
    expect(tokensOf(snapshot, 'messages')).to.equal(50)
    expect(snapshot.usedTokens).to.equal(1050)
    expect(sumCategories(snapshot)).to.equal(200000)
  })

  it('adds the estimate of turns after the usage to since last update', function () {
    // 400 chars is 100 tokens
    const snapshot = computeContextUsage({
      transcript: [
        user('u1', 'hi'),
        assistant('a1', {
          usage: usage({ inputTokens: 4000, outputTokens: 50, step: 1 }),
          usageBreakdown: breakdown({ systemPrompt: 1000, step: 1 }),
        }),
        user('u2', 'x'.repeat(400)),
      ],
      limits: LIMITS,
    })

    expect(tokensOf(snapshot, 'sinceLastUpdate')).to.equal(100)
    expect(snapshot.usedTokens).to.equal(4050 + 100)
    expect(sumCategories(snapshot)).to.equal(200000)
  })

  it('keeps the trailing estimate out of messages when the usage is exact', function () {
    const snapshot = computeContextUsage({
      transcript: [
        user('u1', 'first'),
        assistant('a1', {
          text: 'reply',
          usage: usage({ inputTokens: 1000, outputTokens: 100 }),
          contextBreakdown: breakdown({ systemPrompt: 600, userMessages: 400 }),
        }),
        // u2 is 10 tokens, a2 is 30: all of it after the usage report
        user('u2', 'x'.repeat(40)),
        assistant('a2', { text: 'y'.repeat(120) }),
      ],
      limits: LIMITS,
    })

    expect(snapshot.usedTokens).to.equal(1000 + 100 + 40)
    expect(tokensOf(snapshot, 'sinceLastUpdate')).to.equal(40)
    expect(tokensOf(snapshot, 'systemPrompt')).to.equal(600)
    // I - F + O = 1000 - 600 + 100
    expect(tokensOf(snapshot, 'messages')).to.equal(500)
    expect(sumCategories(snapshot)).to.equal(200000)
  })

  it('uses the newest breakdown for the fixed rows when the usage has no paired one', function () {
    const snapshot = computeContextUsage({
      transcript: [
        user('u1', 'hi'),
        assistant('a1', {
          usage: usage({ inputTokens: 4000, outputTokens: 50, step: 1 }),
          contextBreakdown: breakdown({ systemPrompt: 1000, projectInstructions: 200, step: 2 }),
        }),
      ],
      limits: LIMITS,
    })

    expect(snapshot.exact).to.equal(true)
    expect(tokensOf(snapshot, 'systemPrompt')).to.equal(1000)
    expect(tokensOf(snapshot, 'memoryFiles')).to.equal(200)
    expect(tokensOf(snapshot, 'messages')).to.equal(4000 - 1200 + 50)
    expect(snapshot.usedTokens).to.equal(4050)
  })

  it('estimates from the breakdown and its overhead for a partial input count', function () {
    const snapshot = computeContextUsage({
      transcript: [
        user('u1', 'hi'),
        assistant('a1', {
          text: '',
          usage: usage({ inputTokens: 10, outputTokens: 5, partialInput: true, step: 1 }),
          contextBreakdown: breakdown({
            systemPrompt: 1000,
            userMessages: 500,
            overhead: 300,
            step: 1,
          }),
        }),
      ],
      limits: LIMITS,
    })

    expect(snapshot.exact).to.equal(false)
    expect(snapshot.usage?.partialInput).to.equal(true)
    expect(tokensOf(snapshot, 'systemPrompt')).to.equal(1000)
    expect(tokensOf(snapshot, 'messages')).to.equal(800)
    expect(snapshot.usedTokens).to.equal(1800)
    expect(sumCategories(snapshot)).to.equal(200000)
  })

  it('uses the breakdown and the trailing estimate when there is no usage', function () {
    const transcript = [
      user('u1', 'hi'),
      assistant('a1', {
        text: 'working',
        contextBreakdown: breakdown({
          systemPrompt: 1000,
          builtinTools: 500,
          userMessages: 20,
        }),
      }),
      // The turn the run is writing now: 80 chars of reply is 20 tokens
      assistant('a2', { text: 'y'.repeat(80) }),
    ]
    const snapshot = computeContextUsage({
      transcript,
      limits: LIMITS,
      model: 'fallback-model',
    })

    expect(snapshot.exact).to.equal(false)
    expect(snapshot.breakdown).to.exist
    expect(tokensOf(snapshot, 'systemPrompt')).to.equal(1000)
    expect(tokensOf(snapshot, 'systemTools')).to.equal(500)
    expect(tokensOf(snapshot, 'messages')).to.equal(20)
    expect(tokensOf(snapshot, 'sinceLastUpdate')).to.equal(20)
    expect(snapshot.usedTokens).to.equal(1540)
    expect(sumCategories(snapshot)).to.equal(200000)
  })

  it('estimates the transcript alone for a chat with no server data', function () {
    const toolResult = { ok: 'c'.repeat(100) }
    const transcript = [
      user('u1', 'a'.repeat(400)),
      assistant('a1', {
        text: 'b'.repeat(200),
        toolCalls: [{ id: 't1', name: 'read_file', args: {}, result: toolResult }],
      }),
    ]
    const snapshot = computeContextUsage({ transcript, limits: LIMITS })

    expect(snapshot.exact).to.equal(false)
    expect(snapshot.breakdown).to.be.undefined
    expect(snapshot.usage).to.be.undefined
    expect(tokensOf(snapshot, 'messages')).to.equal(
      estimateTokens('a'.repeat(400)) +
        estimateTokens('b'.repeat(200)) +
        estimateTokens('{}', {}, 'json') +
        estimateTokens(JSON.stringify(toolResult), {}, 'json')
    )
    expect(tokensOf(snapshot, 'systemPrompt')).to.equal(0)
    expect(tokensOf(snapshot, 'sinceLastUpdate')).to.equal(0)
    expect(snapshot.empty).to.equal(false)
    expect(sumCategories(snapshot)).to.equal(200000)
  })

  it('reports the deferred connector tools of the newest breakdown beside the categories', function () {
    const transcript = [
      user('u1', 'hi'),
      assistant('a1', {
        usage: usage({ inputTokens: 1000 }),
        contextBreakdown: breakdown({
          userMessages: 10,
          deferredConnectorTools: 750,
          deferredConnectorToolCount: 12,
        }),
      }),
    ]
    const snapshot = computeContextUsage({ transcript, limits: LIMITS })

    expect(snapshot.deferred).to.deep.equal([
      { id: 'deferredConnectorTools', tokens: 750, count: 12 },
    ])
    expect(snapshot.usedTokens).to.equal(1000)
    expect(sumCategories(snapshot)).to.equal(200000)
  })

  it('reports no deferred tools when the newest breakdown has none', function () {
    const transcript = [
      user('u1', 'hi'),
      assistant('a1', {
        contextBreakdown: breakdown({ deferredConnectorTools: 0, deferredConnectorToolCount: 0 }),
      }),
      assistant('a2', {
        contextBreakdown: breakdown({ deferredConnectorTools: 300, deferredConnectorToolCount: 2 }),
      }),
      assistant('a3', {
        contextBreakdown: breakdown({ deferredConnectorTools: 0, deferredConnectorToolCount: 0 }),
      }),
    ]
    expect(computeContextUsage({ transcript, limits: LIMITS }).deferred).to.deep.equal([])
    expect(computeContextUsage({ transcript: [user('u1', 'hi')], limits: LIMITS }).deferred).to.deep.equal([])
  })

  it('reports an empty chat with nothing used and the reserve kept back', function () {
    const snapshot = computeContextUsage({ transcript: [], limits: LIMITS })

    expect(snapshot.empty).to.equal(true)
    expect(snapshot.usedTokens).to.equal(0)
    expect(snapshot.state).to.equal('ok')
    // The buffer is the window above the auto-compact threshold (200000 - 167000)
    expect(tokensOf(snapshot, 'reserved')).to.equal(33000)
    expect(tokensOf(snapshot, 'free')).to.equal(200000 - 33000)
    expect(sumCategories(snapshot)).to.equal(200000)
  })

  it('follows the saved limits over an older breakdown, so a model switch shows at once', function () {
    const transcript = [
      user('u1', 'hi'),
      assistant('a1', {
        contextBreakdown: breakdown({
          contextWindow: 100000,
          maxOutputTokens: 10000,
          budget: 80000,
          model: 'server-model',
          userMessages: 10,
        }),
      }),
    ]
    const snapshot = computeContextUsage({
      transcript,
      limits: LIMITS,
      model: 'client-model',
    })

    expect(snapshot.contextWindow).to.equal(200000)
    expect(snapshot.maxOutputTokens).to.equal(32000)
    expect(snapshot.budget).to.equal(FALLBACK_BUDGET)
    expect(snapshot.model).to.equal('client-model')
    expect(sumCategories(snapshot)).to.equal(200000)
  })

  it('takes the window from the breakdown when the saved limits have none', function () {
    const transcript = [
      user('u1', 'hi'),
      assistant('a1', {
        contextBreakdown: breakdown({
          contextWindow: 100000,
          maxOutputTokens: 10000,
          userMessages: 10,
        }),
      }),
    ]
    const snapshot = computeContextUsage({
      transcript,
      limits: { contextWindow: 0, maxOutputTokens: 0 },
    })

    expect(snapshot.contextWindow).to.equal(100000)
    // Block at 100000 - 10000 - min(3000, 2700) = 87300
    expect(snapshot.budget).to.equal(87300)
    expect(snapshot.thresholds.autoCompactAt).to.equal(77000)
    expect(tokensOf(snapshot, 'reserved')).to.equal(23000)
    expect(sumCategories(snapshot)).to.equal(100000)
  })

  it('falls back to the client model when the breakdown names none', function () {
    const snapshot = computeContextUsage({
      transcript: [user('u1', 'hi')],
      limits: LIMITS,
      model: 'client-model',
    })
    expect(snapshot.model).to.equal('client-model')
  })

  it('draws the state from the thresholds the count crosses', function () {
    const stateAt = (input: number) =>
      computeContextUsage({
        transcript: [
          user('u1', 'hi'),
          assistant('a1', { usage: usage({ inputTokens: input }) }),
        ],
        limits: LIMITS,
      }).state

    // warn 160000, auto-compact 167000, block 177000
    expect(stateAt(150000)).to.equal('ok')
    expect(stateAt(160000)).to.equal('warn')
    expect(stateAt(167000)).to.equal('compact')
    expect(stateAt(176999)).to.equal('compact')
    expect(stateAt(177000)).to.equal('blocked')
  })

  it('exposes the window thresholds the state is read against', function () {
    const snapshot = computeContextUsage({ transcript: [], limits: LIMITS })
    expect(snapshot.thresholds).to.deep.equal({
      effective: 180000,
      autoCompactAt: 167000,
      warnAt: 160000,
      blockAt: 177000,
    })
  })

  it('takes the meter total from the newest contextUsage record, plus the estimate after its entry', function () {
    const transcript = [
      user('u1', 'hi'),
      assistant('a1', {
        usage: usage({ inputTokens: 1000, outputTokens: 100 }),
      }),
      user('u2', 'more'),
      assistant('a2', {
        contextUsage: {
          step: 2,
          tokens: 5000,
          anchoredTokens: 1100,
          estimatedTokens: 3900,
          exact: true,
          contextWindow: 200000,
          thresholds: {
            effective: 180000,
            autoCompactAt: 167000,
            warnAt: 160000,
            blockAt: 177000,
          },
          state: 'ok',
        },
      }),
      user('u3', 'x'.repeat(400)),
    ]
    const snapshot = computeContextUsage({ transcript, limits: LIMITS })

    // 5000 from the record, and u3's 400 characters at 4 per token
    expect(snapshot.usedTokens).to.equal(5100)
    expect(snapshot.exact).to.equal(true)
    expect(tokensOf(snapshot, 'sinceLastUpdate')).to.equal(100)
    expect(sumCategories(snapshot)).to.equal(200000)
  })

  it('lets a usage newer than the record win over it', function () {
    const transcript = [
      user('u1', 'hi'),
      assistant('a1', {
        usage: usage({ inputTokens: 1000, outputTokens: 100 }),
        contextUsage: {
          step: 1,
          tokens: 9000,
          anchoredTokens: 0,
          estimatedTokens: 9000,
          exact: false,
          contextWindow: 200000,
          thresholds: {
            effective: 180000,
            autoCompactAt: 167000,
            warnAt: 160000,
            blockAt: 177000,
          },
          state: 'ok',
        },
      }),
    ]
    const snapshot = computeContextUsage({ transcript, limits: LIMITS })
    expect(snapshot.usedTokens).to.equal(1100)
    expect(snapshot.exact).to.equal(true)
  })

  it('scales the rows to the window and stops the ring at 100 when over it', function () {
    const snapshot = computeContextUsage({
      transcript: [
        user('u1', 'hi'),
        assistant('a1', {
          usage: usage({ inputTokens: 250000, outputTokens: 1000 }),
          contextBreakdown: breakdown({ systemPrompt: 100, userMessages: 300 }),
        }),
      ],
      limits: LIMITS,
    })

    expect(snapshot.usedTokens).to.equal(251000)
    expect(snapshot.percentUsed).to.equal(100)
    expect(snapshot.state).to.equal('blocked')
    expect(tokensOf(snapshot, 'reserved')).to.equal(0)
    expect(tokensOf(snapshot, 'free')).to.equal(0)
    expect(sumCategories(snapshot)).to.equal(200000)
  })

  it('computes the percentages from the window and the budget', function () {
    const snapshot = computeContextUsage({
      transcript: [
        user('u1', 'hi'),
        assistant('a1', { usage: usage({ inputTokens: 50000 }) }),
      ],
      limits: LIMITS,
    })

    expect(snapshot.percentUsed).to.be.closeTo(25, 1e-9)
    expect(snapshot.percentOfBudget).to.be.closeTo((50000 / 177000) * 100, 1e-9)
    const free = snapshot.categories.find(category => category.id === 'free')!
    expect(free.percent).to.be.closeTo(((200000 - 50000 - 33000) / 200000) * 100, 1e-9)
  })

  it('does not pair a breakdown of another step with the usage', function () {
    const snapshot = computeContextUsage({
      transcript: [
        user('u1', 'hi'),
        assistant('a1', {
          text: 'reply',
          usage: usage({ inputTokens: 4000, step: 1 }),
          usageBreakdown: breakdown({ systemPrompt: 1000, step: 7 }),
        }),
      ],
      limits: LIMITS,
    })

    expect(snapshot.exact).to.equal(true)
    expect(tokensOf(snapshot, 'systemPrompt')).to.equal(0)
    expect(tokensOf(snapshot, 'messages')).to.equal(4000)
    expect(sumCategories(snapshot)).to.equal(200000)
  })

  it('keeps the rows integers and adds up to the window', function () {
    const snapshot = computeContextUsage({
      transcript: [
        user('u1', 'hi'),
        assistant('a1', {
          usage: usage({ inputTokens: 4001, step: 1 }),
          usageBreakdown: breakdown({ systemPrompt: 1000, skills: 1000, step: 1 }),
        }),
      ],
      limits: LIMITS,
    })

    for (const category of snapshot.categories) {
      expect(Number.isInteger(category.tokens), category.id).to.equal(true)
    }
    expect(sumCategories(snapshot)).to.equal(200000)
    expect(snapshot.usedTokens).to.equal(4001)
  })
})
