import { expect } from 'chai'
import fetchMock from 'fetch-mock'
import { AnthropicClient } from '../../../../frontend/js/features/ai-assist/providers/anthropic'
import { OpenAiClient } from '../../../../frontend/js/features/ai-assist/providers/openai'

const ANTHROPIC = {
  type: 'anthropic' as const,
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'sk-ant-test',
  model: 'claude-opus-5',
}

const OPENAI = {
  type: 'openai' as const,
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-4o',
}

const READ_FILE = {
  name: 'read_file',
  description: 'Read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } } },
}

const LIST_FILES = {
  name: 'list_files',
  description: 'List files',
  parameters: { type: 'object', properties: {} },
}

const MESSAGES = [
  { role: 'user' as const, content: 'first question' },
  { role: 'assistant' as const, content: 'first answer' },
  { role: 'user' as const, content: 'second question' },
]

function sse(body: string) {
  return { body, headers: { 'Content-Type': 'text/event-stream' } }
}

async function collect(generator: AsyncGenerator<any>) {
  const chunks = []
  for await (const chunk of generator) chunks.push(chunk)
  return chunks
}

function lastBody() {
  return JSON.parse(fetchMock.callHistory.lastCall()!.options!.body as string)
}

describe('prompt caching', function () {
  afterEach(function () {
    fetchMock.removeRoutes().clearHistory()
  })

  describe('AnthropicClient', function () {
    beforeEach(function () {
      fetchMock.post(
        'https://api.anthropic.com/v1/messages',
        sse('data: {"type":"message_stop"}\n\n')
      )
    })

    it('sends a plain system string when no hints are given', async function () {
      await collect(
        new AnthropicClient(ANTHROPIC).streamChat({
          system: 'be helpful',
          messages: MESSAGES,
          maxTokens: 100,
        })
      )
      expect(lastBody().system).to.equal('be helpful')
    })

    it('marks the system prompt as an ephemeral cache breakpoint', async function () {
      await collect(
        new AnthropicClient(ANTHROPIC).streamChat({
          system: 'be helpful',
          messages: MESSAGES,
          maxTokens: 100,
          cacheHints: {
            cacheSystem: true,
            cacheTools: false,
            lastStableMessage: null,
          },
        })
      )
      expect(lastBody().system).to.deep.equal([
        {
          type: 'text',
          text: 'be helpful',
          cache_control: { type: 'ephemeral' },
        },
      ])
    })

    it('marks only the last tool spec, because breakpoints are scarce', async function () {
      await collect(
        new AnthropicClient(ANTHROPIC).streamChat({
          system: 'be helpful',
          messages: MESSAGES,
          maxTokens: 100,
          tools: [LIST_FILES, READ_FILE],
          cacheHints: {
            cacheSystem: false,
            cacheTools: true,
            lastStableMessage: null,
          },
        })
      )
      const { tools } = lastBody()
      expect(tools[0].cache_control).to.equal(undefined)
      expect(tools[1].cache_control).to.deep.equal({ type: 'ephemeral' })
    })

    it('marks the last stable message', async function () {
      await collect(
        new AnthropicClient(ANTHROPIC).streamChat({
          system: 'be helpful',
          messages: MESSAGES,
          maxTokens: 100,
          cacheHints: {
            cacheSystem: true,
            cacheTools: false,
            lastStableMessage: 1,
          },
        })
      )
      const { messages } = lastBody()
      const blocks = messages[1].content
      expect(blocks[blocks.length - 1].cache_control).to.deep.equal({
        type: 'ephemeral',
      })
      expect(messages[2].content[0].cache_control).to.equal(undefined)
    })

    it('never sends more than four breakpoints', async function () {
      await collect(
        new AnthropicClient(ANTHROPIC).streamChat({
          system: 'be helpful',
          messages: MESSAGES,
          maxTokens: 100,
          tools: [LIST_FILES, READ_FILE],
          cacheHints: {
            cacheSystem: true,
            cacheTools: true,
            lastStableMessage: 1,
          },
        })
      )
      const count = JSON.stringify(lastBody()).split('"cache_control"').length - 1
      expect(count).to.be.at.most(4)
    })

    it('ignores an out-of-range stable index instead of throwing', async function () {
      await collect(
        new AnthropicClient(ANTHROPIC).streamChat({
          system: 'be helpful',
          messages: MESSAGES,
          maxTokens: 100,
          cacheHints: {
            cacheSystem: false,
            cacheTools: false,
            lastStableMessage: 99,
          },
        })
      )
      expect(JSON.stringify(lastBody())).to.not.include('cache_control')
    })
  })

  describe('OpenAiClient', function () {
    beforeEach(function () {
      fetchMock.post(
        'https://api.openai.com/v1/chat/completions',
        sse('data: [DONE]\n\n')
      )
    })

    it('sends a prompt_cache_key when one is supplied', async function () {
      await collect(
        new OpenAiClient(OPENAI).streamChat({
          system: 'be helpful',
          messages: MESSAGES,
          maxTokens: 100,
          cacheHints: {
            cacheSystem: true,
            cacheTools: true,
            lastStableMessage: 1,
            cacheKey: 'project-abc',
          },
        })
      )
      expect(lastBody().prompt_cache_key).to.equal('project-abc')
    })

    // OpenAI caches prefixes automatically. Sending Anthropic's directives
    // would be rejected as an unknown field.
    it('never sends cache_control', async function () {
      await collect(
        new OpenAiClient(OPENAI).streamChat({
          system: 'be helpful',
          messages: MESSAGES,
          maxTokens: 100,
          cacheHints: {
            cacheSystem: true,
            cacheTools: true,
            lastStableMessage: 1,
          },
        })
      )
      const body = JSON.stringify(lastBody())
      expect(body).to.not.include('cache_control')
      expect(body).to.not.include('prompt_cache_key')
    })
  })
})
