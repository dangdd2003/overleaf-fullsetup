import { describe, it, beforeEach } from 'vitest'
import { expect } from 'chai'
import sinon from 'sinon'
import {
  allocateByShare,
  clearExactCountCache,
  contextBreakdownFor,
  charsPerToken,
  contextBudget,
  contextState,
  contextThresholds,
  createExactCounter,
  isCountUnsupported,
  usesNewerTokenizer,
  exactCountKey,
  estimateJsonTokens,
  estimateMessageTokens,
  estimateRequestTokens,
  estimateTokens,
  estimateToolTokens,
  fixedOverheadTokens,
  messageFramingTokens,
  withExactFixed,
  ANTHROPIC_TOOL_PREAMBLE_TOKENS,
  JSON_CHARS_PER_TOKEN,
  LATEX_CHARS_PER_TOKEN,
  PROSE_CHARS_PER_TOKEN,
} from '../../../app/src/AiAssistContextUsage.mjs'
import { IMAGE_TOKEN_ESTIMATE } from '../../../app/src/AiAssistImages.mjs'
import { toolWireSpec } from '../../../app/src/AiAssistProviders.mjs'
import {
  SLASH_COMMANDS_PROMPT,
  systemBlocksFor,
} from '../../../app/src/AiAssistSystemPrompt.mjs'

const LIMITS = { contextWindow: 1000, maxOutputTokens: 100 }

function breakdownOf(overrides = {}) {
  return contextBreakdownFor({
    system: { shared: '', instructions: '', connectors: '' },
    messages: [],
    tools: [],
    limits: LIMITS,
    provider: 'openai',
    ...overrides,
  })
}

// A PNG header carrying the given size: the signature and the IHDR size
function pngBase64(width, height) {
  const bytes = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0)
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes.toString('base64')
}

const spec = (name, description = 'Does a thing.') => ({
  name,
  description,
  parameters: { type: 'object', properties: { path: { type: 'string' } } },
})

describe('AiAssistContextUsage', function () {
  describe('estimateTokens', function () {
    it('counts four prose characters to a token, rounding up', function () {
      expect(estimateTokens('abcd')).to.equal(1)
      expect(estimateTokens('abcde')).to.equal(2)
      expect(estimateTokens('')).to.equal(0)
      expect(estimateTokens(undefined)).to.equal(0)
      expect(PROSE_CHARS_PER_TOKEN).to.equal(4)
    })

    it('counts LaTeX-dense text at 3.5 characters a token', function () {
      const latex = '\\frac{a}{b} + \\sum_{i=1}^{n} x_i \\\\ $y$ '.repeat(10)

      expect(estimateTokens(latex)).to.equal(
        Math.ceil(latex.length / LATEX_CHARS_PER_TOKEN)
      )
    })

    it('reads only the head of a long text for its density', function () {
      const prose = 'word '.repeat(2000)
      const text = prose + '\\{}$'.repeat(5000)

      expect(estimateTokens(text)).to.equal(
        Math.ceil(text.length / PROSE_CHARS_PER_TOKEN)
      )
    })
  })

  describe('estimateJsonTokens', function () {
    it('counts JSON at three characters a token', function () {
      const value = { name: 'read_file', description: 'Reads a file.' }
      const text = JSON.stringify(value)

      expect(JSON_CHARS_PER_TOKEN).to.equal(3)
      expect(estimateJsonTokens(value)).to.equal(Math.ceil(text.length / 3))
      expect(estimateJsonTokens(text)).to.equal(Math.ceil(text.length / 3))
    })
  })

  describe('estimateToolTokens', function () {
    it('prices a tool in the wire shape of its provider', function () {
      const tool = spec('read_file')

      expect(estimateToolTokens(tool, 'anthropic')).to.equal(
        estimateJsonTokens(toolWireSpec('anthropic', tool))
      )
      expect(estimateToolTokens(tool, 'openai')).to.equal(
        estimateJsonTokens(toolWireSpec('openai', tool))
      )
      // The Anthropic shape names the schema input_schema, so it is not the
      // same text as the OpenAI shape
      expect(estimateToolTokens(tool, 'anthropic')).to.not.equal(
        estimateToolTokens(tool, 'openai')
      )
    })
  })

  describe('overhead', function () {
    it('takes the Anthropic tool preamble when tools are offered, and per-message framing', function () {
      expect(ANTHROPIC_TOOL_PREAMBLE_TOKENS).to.equal(346)
      expect(fixedOverheadTokens('anthropic', { hasTools: true })).to.equal(346)
      expect(fixedOverheadTokens('anthropic', { hasTools: false })).to.equal(0)
      expect(messageFramingTokens('anthropic')).to.equal(4)
    })

    it('takes the OpenAI reply priming and framing, and none for Ollama', function () {
      expect(fixedOverheadTokens('openai', { hasTools: false })).to.equal(3)
      expect(messageFramingTokens('openai')).to.equal(3)
      expect(fixedOverheadTokens('ollama', { hasTools: true })).to.equal(0)
      expect(messageFramingTokens('ollama')).to.equal(0)
    })

    it('adds the overhead of the messages to the breakdown', function () {
      const breakdown = breakdownOf({
        provider: 'anthropic',
        messages: [
          { role: 'user', content: 'a' },
          { role: 'assistant', content: 'b' },
        ],
        tools: [spec('read_file')],
      })

      expect(breakdown.overhead).to.equal(346 + 2 * 4)
    })
  })

  describe('estimateRequestTokens', function () {
    it('is the sum of the breakdown categories and overhead, so trimming and the meter agree', function () {
      const system = { shared: 'System prompt. '.repeat(20), instructions: '', connectors: '' }
      const messages = [
        { role: 'user', content: 'Look at this', images: [{ data: pngBase64(640, 480), mediaType: 'image/png' }] },
        { role: 'assistant', content: 'ok', toolCalls: [{ id: '1', name: 'read_file', args: { path: 'a' } }] },
        { role: 'tool', name: 'read_file', content: '{"ok":true,"text":"hello"}' },
      ]
      const tools = [spec('read_file'), spec('web_search')]
      const pricing = { provider: 'anthropic', model: 'claude-sonnet-4-6' }

      const breakdown = contextBreakdownFor({
        system,
        messages,
        tools,
        webToolNames: ['web_search'],
        limits: LIMITS,
        ...pricing,
      })
      const categories = [
        'systemPrompt',
        'projectInstructions',
        'connectorInstructions',
        'builtinTools',
        'webTools',
        'connectorHelperTools',
        'connectorTools',
        'userMessages',
        'projectContext',
        'assistantMessages',
        'toolResults',
        'images',
        'overhead',
      ].reduce((sum, key) => sum + (breakdown[key] ?? 0), 0)

      expect(categories).to.equal(
        estimateRequestTokens({
          system: system.shared,
          messages,
          tools,
          ...pricing,
        })
      )
    })
  })

  describe('estimateMessageTokens', function () {
    it('prices a user image from its size for the provider', function () {
      const image = { mediaType: 'image/png', data: pngBase64(1000, 500) }

      // Anthropic: 28 px patches, 36 x 18 of them
      expect(
        estimateMessageTokens(
          { role: 'user', content: '', images: [image] },
          { provider: 'anthropic', model: 'claude-3-5-sonnet' }
        )
      ).to.equal(36 * 18)
      // OpenAI gpt-4o, high detail: 85 + 170 per 512 px tile, 2 tiles here
      expect(
        estimateMessageTokens(
          { role: 'user', content: '', images: [image] },
          { provider: 'openai', model: 'gpt-4o' }
        )
      ).to.equal(85 + 170 * 2)
    })

    it('takes the flat estimate for an image whose size is unknown', function () {
      expect(
        estimateMessageTokens(
          { role: 'user', content: '', images: [{ data: 'bm9wZQ==' }] },
          { provider: 'anthropic', model: 'claude-3-5-sonnet' }
        )
      ).to.equal(IMAGE_TOKEN_ESTIMATE)
    })

    it('keeps the cost a tool image was given', function () {
      expect(
        estimateMessageTokens({
          role: 'tool',
          content: '',
          images: [{ tokens: 300, data: pngBase64(10, 10) }],
        })
      ).to.equal(300)
    })
  })

  describe('contextBudget', function () {
    it('is the blockAt threshold: the window less the reserve and the block buffer', function () {
      expect(contextBudget(LIMITS)).to.equal(contextThresholds(LIMITS).blockAt)
      expect(contextBudget(LIMITS)).to.equal(873)
    })
  })

  describe('contextThresholds', function () {
    it('sets the buffers as shares of the effective window, capped for large windows', function () {
      expect(
        contextThresholds({ contextWindow: 200000, maxOutputTokens: 32000 })
      ).to.deep.equal({
        effective: 180000,
        autoCompactAt: 167000,
        warnAt: 160000,
        blockAt: 177000,
      })
    })

    it('keeps the buffers usable on a small local window', function () {
      expect(
        contextThresholds({ contextWindow: 8192, maxOutputTokens: 2048 })
      ).to.deep.equal({
        effective: 6144,
        autoCompactAt: 5223,
        warnAt: 4916,
        blockAt: 5960,
      })
    })

    it('reserves at most 20000 tokens for the reply', function () {
      expect(
        contextThresholds({ contextWindow: 200000, maxOutputTokens: 64000 })
          .effective
      ).to.equal(180000)
    })

    it('names the state a count is in, from the highest threshold it reaches', function () {
      const t = contextThresholds({ contextWindow: 200000, maxOutputTokens: 32000 })
      expect(contextState(t.warnAt - 1, t)).to.equal('ok')
      expect(contextState(t.warnAt, t)).to.equal('warn')
      expect(contextState(t.autoCompactAt, t)).to.equal('compact')
      expect(contextState(t.blockAt, t)).to.equal('blocked')
    })
  })

  describe('charsPerToken', function () {
    const newer = { provider: 'anthropic', model: 'claude-opus-4-7' }

    it('keeps the base ratios for other providers, legacy Claude models and no model', function () {
      expect(charsPerToken('prose')).to.equal(4)
      expect(charsPerToken('latex')).to.equal(3.5)
      expect(charsPerToken('json')).to.equal(3)
      expect(charsPerToken('prose', { provider: 'openai', model: 'gpt-5' })).to.equal(4)
      expect(
        charsPerToken('prose', { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' })
      ).to.equal(4)
      expect(charsPerToken('prose', { provider: 'anthropic', model: '' })).to.equal(4)
    })

    it('scales the ratios by 0.75 for a Claude model on the newer tokenizer', function () {
      expect(usesNewerTokenizer(newer)).to.equal(true)
      expect(charsPerToken('prose', newer)).to.equal(3)
      expect(charsPerToken('latex', newer)).to.equal(2.625)
      expect(charsPerToken('json', newer)).to.equal(2.25)
    })

    it('counts more tokens for the same text on the newer tokenizer', function () {
      const text = 'a'.repeat(300)
      expect(estimateTokens(text)).to.equal(75)
      expect(estimateTokens(text, newer)).to.equal(100)
      expect(estimateJsonTokens({ a: 'b' }, newer)).to.equal(
        Math.ceil(JSON.stringify({ a: 'b' }).length / 2.25)
      )
    })
  })

  describe('allocateByShare', function () {
    it('splits a total in proportion, in whole parts that sum to it', function () {
      expect(allocateByShare(10, [1, 1, 1])).to.deep.equal([4, 3, 3])
      expect(allocateByShare(100, [1, 3])).to.deep.equal([25, 75])
      expect(allocateByShare(7, [0, 0])).to.deep.equal([7, 0])
      expect(allocateByShare(5, [])).to.deep.equal([])
      const parts = allocateByShare(1234, [3, 7, 11, 13])
      expect(parts.reduce((a, b) => a + b, 0)).to.equal(1234)
    })
  })

  describe('contextBreakdownFor', function () {
    it('takes the connectors block out of the shared block, which contains it', function () {
      const breakdown = breakdownOf({
        system: {
          shared: 'a'.repeat(400) + 'c'.repeat(40),
          instructions: 'i'.repeat(80),
          connectors: 'c'.repeat(40),
        },
      })

      expect(breakdown.systemPrompt).to.equal(100)
      expect(breakdown.connectorInstructions).to.equal(10)
      expect(breakdown.projectInstructions).to.equal(20)
    })

    it('counts the slash commands section as skills and takes it out of the system prompt', function () {
      const shared = 'a'.repeat(400) + '\n\n' + SLASH_COMMANDS_PROMPT + '\n\n' + 'c'.repeat(40)
      const breakdown = breakdownOf({
        system: { shared, instructions: '', connectors: 'c'.repeat(40) },
      })

      expect(breakdown.skills).to.equal(estimateTokens(SLASH_COMMANDS_PROMPT))
      expect(breakdown.systemPrompt).to.equal(
        estimateTokens(shared) - 10 - estimateTokens(SLASH_COMMANDS_PROMPT)
      )
    })

    it('counts no skills when the shared block does not include the section', function () {
      const breakdown = breakdownOf({
        system: { shared: 'a'.repeat(400), instructions: '', connectors: '' },
      })

      expect(breakdown.skills).to.equal(0)
      expect(breakdown.systemPrompt).to.equal(100)
    })

    it('counts the real system blocks: skills and system prompt add up to the shared block', function () {
      const system = systemBlocksFor('agent', { pdfTools: true })
      const breakdown = breakdownOf({ system })

      expect(breakdown.skills).to.equal(estimateTokens(SLASH_COMMANDS_PROMPT))
      expect(breakdown.systemPrompt + breakdown.skills).to.equal(
        estimateTokens(system.shared)
      )
    })

    it('never takes the system prompt below zero', function () {
      const breakdown = breakdownOf({
        system: { shared: SLASH_COMMANDS_PROMPT, instructions: '', connectors: 'c'.repeat(400) },
      })

      expect(breakdown.systemPrompt).to.equal(0)
      expect(breakdown.skills).to.equal(estimateTokens(SLASH_COMMANDS_PROMPT))
    })

    it('splits a user turn into its project-context envelope and its own words', function () {
      const envelope = '<project-context turn="1">' + 'p'.repeat(40) + '</project-context>'
      const breakdown = breakdownOf({
        messages: [{ role: 'user', content: `${envelope}\n\nhello` }],
      })

      expect(breakdown.projectContext).to.equal(estimateTokens(envelope))
      expect(breakdown.userMessages).to.equal(
        estimateTokens(`${envelope}\n\nhello`) - estimateTokens(envelope)
      )
    })

    it('counts a user turn without an envelope as its own words only', function () {
      const breakdown = breakdownOf({
        messages: [{ role: 'user', content: 'a'.repeat(40) }],
      })

      expect(breakdown.projectContext).to.equal(0)
      expect(breakdown.userMessages).to.equal(10)
    })

    it('counts assistant prose with its tool-call arguments, the arguments as JSON', function () {
      const toolCalls = [{ id: '1', name: 'read_file', args: { path: 'a' } }]
      const breakdown = breakdownOf({
        messages: [{ role: 'assistant', content: 'ok', toolCalls }],
      })

      expect(breakdown.assistantMessages).to.equal(
        estimateTokens('ok') + estimateJsonTokens(toolCalls)
      )
    })

    it('prices a JSON tool result as JSON and other results as prose', function () {
      const json = JSON.stringify({ ok: true, text: 'x'.repeat(90) })
      const breakdown = breakdownOf({
        messages: [
          { role: 'tool', name: 'read_file', content: json },
          { role: 'tool', name: 'read_file', content: 'x'.repeat(40) },
        ],
      })

      expect(breakdown.toolResults).to.equal(
        estimateJsonTokens(json) + estimateTokens('x'.repeat(40))
      )
    })

    it('sorts tool results by name, largest first, with their counts', function () {
      const breakdown = breakdownOf({
        messages: [
          { role: 'tool', name: 'read_file', content: 'x'.repeat(40) },
          { role: 'tool', name: 'search_text', content: 'x'.repeat(200) },
          { role: 'tool', name: 'read_file', content: 'x'.repeat(40) },
        ],
      })

      expect(breakdown.toolResults).to.equal(10 + 50 + 10)
      expect(breakdown.toolResultDetails).to.deep.equal([
        { name: 'search_text', tokens: 50, count: 1 },
        { name: 'read_file', tokens: 20, count: 2 },
      ])
    })

    it('counts images on user and tool messages apart from their text', function () {
      const breakdown = breakdownOf({
        messages: [
          {
            role: 'user',
            content: 'look',
            images: [{ tokens: 300 }, { data: 'no size' }],
          },
          {
            role: 'tool',
            name: 'view_compiled_pdf_page',
            content: 'x'.repeat(40),
            images: [{ tokens: 50 }],
          },
        ],
      })

      expect(breakdown.images).to.equal(300 + IMAGE_TOKEN_ESTIMATE + 50)
      expect(breakdown.userMessages).to.equal(estimateTokens('look'))
      expect(breakdown.toolResults).to.equal(10)
      expect(breakdown.toolResultDetails).to.deep.equal([
        { name: 'view_compiled_pdf_page', tokens: 10, count: 1 },
      ])
    })

    it('classifies the offered tools as built-in, web, connector or connector helper', function () {
      const create = {
        name: 'mcp__calendar__create_event',
        description: 'c'.repeat(200),
        parameters: {},
      }
      const send = { name: 'mcp__mail__send', description: 's', parameters: {} }
      const read = { name: 'read_file', description: 'r', parameters: {} }
      const web = { name: 'web_search', description: 'w', parameters: {} }
      const helper = {
        name: 'search_connector_tools',
        description: 'h',
        parameters: {},
      }
      const breakdown = breakdownOf({
        tools: [read, web, create, send, helper],
        webToolNames: ['web_search'],
        connectorToolNames: ['mcp__calendar__create_event', 'mcp__mail__send'],
        helperToolNames: ['search_connector_tools'],
        connectorCatalog: [
          { name: 'mcp__calendar__create_event', originalName: 'create_event', server: 'Calendar', spec: create, deferred: false },
          { name: 'mcp__mail__send', originalName: 'send', server: 'Mail', spec: send, deferred: false },
        ],
      })
      const tokens = tool => estimateToolTokens(tool, 'openai')

      expect(breakdown.builtinTools).to.equal(tokens(read))
      expect(breakdown.webTools).to.equal(tokens(web))
      expect(breakdown.connectorHelperTools).to.equal(tokens(helper))
      expect(breakdown.connectorTools).to.equal(tokens(create) + tokens(send))
      expect(breakdown.connectorToolDetails).to.deep.equal([
        {
          name: 'create_event',
          server: 'Calendar',
          tokens: tokens(create),
          deferred: false,
        },
        { name: 'send', server: 'Mail', tokens: tokens(send), deferred: false },
      ])
    })

    it('lists every connector tool of the session: sent first, deferred last, each largest first', function () {
      const loaded = spec('mcp__docs__get', 'g'.repeat(100))
      const pendingBig = spec('mcp__docs__write', 'w'.repeat(300))
      const pendingSmall = spec('mcp__mail__send', 's')
      const breakdown = breakdownOf({
        tools: [loaded],
        connectorToolNames: ['mcp__docs__get'],
        connectorCatalog: [
          { name: 'mcp__mail__send', originalName: 'send', server: 'Mail', spec: pendingSmall, deferred: true },
          { name: 'mcp__docs__write', originalName: 'write', server: 'Docs', spec: pendingBig, deferred: true },
          { name: 'mcp__docs__get', originalName: 'get', server: 'Docs', spec: loaded, deferred: false },
        ],
      })

      expect(breakdown.connectorToolDetails.map(row => [row.name, row.deferred])).to.deep.equal([
        ['get', false],
        ['write', true],
        ['send', true],
      ])
      expect(breakdown.deferredConnectorToolCount).to.equal(2)
      expect(breakdown.deferredConnectorTools).to.equal(
        estimateToolTokens(pendingBig, 'openai') + estimateToolTokens(pendingSmall, 'openai')
      )
      expect(breakdown.connectorTools).to.equal(estimateToolTokens(loaded, 'openai'))
    })

    it('counts the deferred connector tools apart from the offered ones', function () {
      const deferred = [spec('mcp__calendar__create', 'c'.repeat(200)), spec('mcp__mail__send')]
      const breakdown = breakdownOf({
        tools: [spec('read_file')],
        connectorCatalog: deferred.map((tool, i) => ({
          name: tool.name,
          originalName: tool.name.split('__')[2],
          server: ['Calendar', 'Mail'][i],
          spec: tool,
          deferred: true,
        })),
      })

      expect(breakdown.deferredConnectorTools).to.equal(
        estimateToolTokens(deferred[0], 'openai') + estimateToolTokens(deferred[1], 'openai')
      )
      expect(breakdown.deferredConnectorToolCount).to.equal(2)
      expect(breakdown.connectorTools).to.equal(0)
      expect(breakdown.builtinTools).to.equal(estimateToolTokens(spec('read_file'), 'openai'))
    })

    it('reports no deferred tools when none can be loaded', function () {
      const breakdown = breakdownOf()

      expect(breakdown.deferredConnectorTools).to.equal(0)
      expect(breakdown.deferredConnectorToolCount).to.equal(0)
      expect(breakdown.connectorToolDetails).to.deep.equal([])
    })

    it('reports trimmed and dropped counts, the limits, the budget, the model and the step', function () {
      const breakdown = breakdownOf({
        trim: { total: 9, anchor: 'x', dropped: 2, elided: [3, 4, 6] },
        model: '  gpt-5  ',
        step: 4,
      })

      expect(breakdown.elidedMessages).to.equal(3)
      expect(breakdown.droppedMessages).to.equal(2)
      expect(breakdown.contextWindow).to.equal(1000)
      expect(breakdown.maxOutputTokens).to.equal(100)
      expect(breakdown.budget).to.equal(873)
      expect(breakdown.model).to.equal('gpt-5')
      expect(breakdown.step).to.equal(4)
      expect(breakdown.exactFixed).to.equal(false)
    })

    it('leaves the model out when none is known', function () {
      const breakdown = breakdownOf({ model: '  ' })

      expect(breakdown).to.not.have.property('model')
      expect(breakdown.elidedMessages).to.equal(0)
      expect(breakdown.droppedMessages).to.equal(0)
    })

    it('caps the connector list at 1000 and the tool-result list at 20', function () {
      const catalog = Array.from({ length: 1100 }, (_, i) => ({
        name: `mcp__srv__tool_${i}`,
        originalName: `tool_${i}`,
        server: 'srv',
        spec: spec(`mcp__srv__tool_${i}`, 'd'.repeat(i + 1)),
        deferred: i % 2 === 0,
      }))
      const messages = Array.from({ length: 25 }, (_, i) => ({
        role: 'tool',
        name: `tool_${i}`,
        content: 'x'.repeat(i + 1),
      }))
      const breakdown = breakdownOf({ connectorCatalog: catalog, messages })

      expect(breakdown.connectorToolDetails).to.have.lengthOf(1000)
      expect(breakdown.toolResultDetails).to.have.lengthOf(20)
      expect(breakdown.deferredConnectorToolCount).to.equal(550)
    })
  })

  describe('withExactFixed', function () {
    it('replaces the fixed parts with the counts, split by estimate share, and keeps the rows exact', function () {
      const loaded = spec('mcp__docs__get', 'g'.repeat(100))
      const pending = spec('mcp__docs__write', 'w'.repeat(300))
      const estimated = contextBreakdownFor({
        system: { shared: 'x'.repeat(400), instructions: 'y'.repeat(80), connectors: 'c'.repeat(40) },
        tools: [spec('read_file'), loaded],
        connectorToolNames: ['mcp__docs__get'],
        connectorCatalog: [
          { name: 'mcp__docs__get', originalName: 'get', server: 'Docs', spec: loaded, deferred: false },
          { name: 'mcp__docs__write', originalName: 'write', server: 'Docs', spec: pending, deferred: true },
        ],
        limits: LIMITS,
        provider: 'anthropic',
        messages: [{ role: 'user', content: 'hi' }],
      })

      const exact = withExactFixed(estimated, {
        system: 500,
        tools: 901,
        overheadInTools: ANTHROPIC_TOOL_PREAMBLE_TOKENS,
      })

      expect(exact.exactFixed).to.equal(true)
      expect(
        exact.systemPrompt + exact.projectInstructions + exact.connectorInstructions
      ).to.equal(500)
      expect(
        exact.builtinTools + exact.webTools + exact.connectorHelperTools + exact.connectorTools
      ).to.equal(901)
      const sent = exact.connectorToolDetails.filter(row => !row.deferred)
      expect(sent.reduce((sum, row) => sum + row.tokens, 0)).to.equal(exact.connectorTools)
      const deferred = exact.connectorToolDetails.find(row => row.deferred)
      expect(deferred.tokens).to.equal(estimated.connectorToolDetails.find(row => row.deferred).tokens)
      // The preamble is inside the tools count, so the overhead does not hold it too
      expect(exact.overhead).to.equal(estimated.overhead - ANTHROPIC_TOOL_PREAMBLE_TOKENS)
    })

    it('splits the exact system total between the system prompt and skills by estimate share', function () {
      const estimated = breakdownOf({
        system: {
          shared: 'x'.repeat(400) + SLASH_COMMANDS_PROMPT,
          instructions: 'y'.repeat(80),
          connectors: 'c'.repeat(40),
        },
      })

      const exact = withExactFixed(estimated, { system: 501, tools: 0 })

      expect(exact.systemPrompt + exact.skills + exact.projectInstructions + exact.connectorInstructions).to.equal(501)
      expect(exact.connectorInstructions).to.equal(
        allocateByShare(501, [
          estimated.systemPrompt + estimated.skills,
          estimated.projectInstructions,
          estimated.connectorInstructions,
        ])[2]
      )
      expect(exact.skills).to.equal(
        allocateByShare(
          allocateByShare(501, [
            estimated.systemPrompt + estimated.skills,
            estimated.projectInstructions,
            estimated.connectorInstructions,
          ])[0],
          [estimated.systemPrompt, estimated.skills]
        )[1]
      )
    })
  })

  describe('exact counts', function () {
    beforeEach(function () {
      clearExactCountCache()
    })

    // Counts the system prompt as its length and each tool as 50, on a base of 10
    function countingClient(overrides = {}) {
      return {
        model: 'claude-sonnet-4-6',
        baseURL: 'https://api.anthropic.com',
        exactCountsSupported: true,
        countTokens: sinon.spy(async ({ system = '', tools = [] }) => {
          return 10 + system.length + tools.length * 50
        }),
        ...overrides,
      }
    }
    const settle = () => new Promise(resolve => setTimeout(resolve, 0))

    it('measures the system prompt and the tools net of the base count, in the background', async function () {
      const client = countingClient()
      const ready = sinon.spy()
      const counter = createExactCounter({ client, type: 'anthropic', onReady: ready })

      const first = counter.lookup({ system: 'SYSTEM', tools: [spec('read_file')] })
      expect(first.counts).to.equal(null)
      await settle()

      expect(ready.calledOnce).to.equal(true)
      const [counts, key] = ready.firstCall.args
      expect(key).to.equal(first.key)
      expect(counts).to.deep.equal({
        system: 6,
        tools: 50,
        overheadInTools: ANTHROPIC_TOOL_PREAMBLE_TOKENS,
      })
      expect(client.countTokens.callCount).to.equal(3)
    })

    it('answers from the cache for the same parts, without counting again', async function () {
      const client = countingClient()
      const counter = createExactCounter({ client, type: 'anthropic', onReady: () => {} })
      counter.lookup({ system: 'SYSTEM', tools: [spec('read_file')] })
      await settle()

      const again = counter.lookup({ system: 'SYSTEM', tools: [spec('read_file')] })

      expect(again.counts).to.deep.equal({
        system: 6,
        tools: 50,
        overheadInTools: ANTHROPIC_TOOL_PREAMBLE_TOKENS,
      })
      expect(client.countTokens.callCount).to.equal(3)
    })

    it('measures again when the tool list changes', async function () {
      const client = countingClient()
      const counter = createExactCounter({ client, type: 'anthropic', onReady: () => {} })
      counter.lookup({ system: 'SYSTEM', tools: [spec('read_file')] })
      await settle()

      const changed = counter.lookup({
        system: 'SYSTEM',
        tools: [spec('read_file'), spec('mcp__docs__get')],
      })

      expect(changed.counts).to.equal(null)
    })

    it('never asks providers without a count API, or off their official endpoint', function () {
      const client = countingClient({ exactCountsSupported: false })
      const counter = createExactCounter({ client, type: 'anthropic' })

      expect(counter.supported).to.equal(false)
      expect(counter.lookup({ system: 'S', tools: [] })).to.equal(null)
      expect(client.countTokens.called).to.equal(false)
      expect(createExactCounter({ client: { baseURL: 'x' }, type: 'openai' }).lookup({ system: 'S', tools: [] })).to.equal(null)
    })

    it('reports a failed measure to onError and holds that count back for ten minutes', async function () {
      const clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['Date'] })
      try {
        const client = countingClient({
          countTokens: sinon.stub().rejects(new Error('timeout')),
        })
        const onError = sinon.spy()
        const counter = createExactCounter({ client, type: 'anthropic', onError })

        counter.lookup({ system: 'S', tools: [] })
        await settle()
        expect(onError.calledOnce).to.equal(true)
        const failedCalls = client.countTokens.callCount

        counter.lookup({ system: 'S', tools: [] })
        expect(client.countTokens.callCount).to.equal(failedCalls)

        clock.tick(10 * 60 * 1000 + 1)
        counter.lookup({ system: 'S', tools: [] })
        expect(client.countTokens.callCount).to.be.above(failedCalls)
      } finally {
        clock.restore()
      }
    })

    it('marks an endpoint without a count API unsupported for a day, on any key', async function () {
      const clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['Date'] })
      try {
        const notFound = Object.assign(new Error('HTTP 404'), { status: 404 })
        const client = countingClient({
          countTokens: sinon.stub().rejects(notFound),
        })
        const counter = createExactCounter({ client, type: 'anthropic', onError: () => {} })
        counter.lookup({ system: 'S', tools: [] })
        await settle()
        const probes = client.countTokens.callCount

        const other = counter.lookup({ system: 'OTHER', tools: [spec('read_file')] })
        expect(other).to.equal(null)
        expect(client.countTokens.callCount).to.equal(probes)

        clock.tick(24 * 60 * 60 * 1000 - 1000)
        expect(counter.lookup({ system: 'OTHER', tools: [] })).to.equal(null)
        expect(client.countTokens.callCount).to.equal(probes)

        clock.tick(2000)
        counter.lookup({ system: 'OTHER', tools: [] })
        expect(client.countTokens.callCount).to.be.above(probes)
      } finally {
        clock.restore()
      }
    })

    it('treats a 400 that says the route or model is not found as unsupported', function () {
      expect(isCountUnsupported({ status: 400, message: 'Count API error (400): model not found' })).to.equal(true)
      expect(isCountUnsupported({ status: 400, message: 'Count API error (400): unsupported route' })).to.equal(true)
      expect(isCountUnsupported({ status: 400, message: 'Count API error (400): invalid tool schema' })).to.equal(false)
      expect(isCountUnsupported({ status: 405 })).to.equal(true)
      expect(isCountUnsupported({ status: 501 })).to.equal(true)
      expect(isCountUnsupported({ status: 429 })).to.equal(false)
    })

    it('counts the base once per model, so a new tool set costs two calls', async function () {
      const client = countingClient()
      const counter = createExactCounter({ client, type: 'anthropic', onReady: () => {} })
      counter.lookup({ system: 'SYSTEM', tools: [spec('read_file')] })
      await settle()
      expect(client.countTokens.callCount).to.equal(3)

      counter.lookup({ system: 'SYSTEM', tools: [spec('read_file'), spec('mcp__docs__get')] })
      await settle()

      expect(client.countTokens.callCount).to.equal(5)
    })
  })

  describe('exact count cache', function () {
    it('keeps at most sixteen measures, evicting the least recently used', async function () {
      clearExactCountCache()
      const client = {
        model: 'claude-sonnet-4-6',
        baseURL: 'https://api.anthropic.com',
        exactCountsSupported: true,
        countTokens: async () => 10,
      }
      const settle = () => new Promise(resolve => setTimeout(resolve, 0))
      const counter = createExactCounter({ client, type: 'anthropic', onReady: () => {} })
      const first = counter.lookup({ system: 'S0', tools: [] })
      await settle()
      for (let i = 1; i <= 16; i++) {
        counter.lookup({ system: `S${i}`, tools: [] })
        await settle()
      }

      expect(counter.lookup({ system: 'S0', tools: [] }).counts).to.equal(null)
      expect(first.key).to.be.a('string')
    })
  })

  describe('exact count keys', function () {
    it('is the same for the same parts and differs when the model or endpoint changes', function () {
      const base = { type: 'anthropic', model: 'm', baseUrl: 'u', system: 's', tools: [spec('a')] }

      expect(exactCountKey(base)).to.equal(exactCountKey({ ...base }))
      expect(exactCountKey(base)).to.not.equal(exactCountKey({ ...base, model: 'n' }))
      expect(exactCountKey(base)).to.not.equal(exactCountKey({ ...base, baseUrl: 'v' }))
    })
  })
})
