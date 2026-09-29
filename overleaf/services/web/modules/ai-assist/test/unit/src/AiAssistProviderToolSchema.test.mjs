import { describe, it, expect, vi } from 'vitest'

// The real settings module pulls in overleaf-editor-core, which does not
// resolve under the unit runner. Nothing here depends on its values.
vi.mock('@overleaf/settings', () => ({ default: { aiAssist: {} } }))

const {
  OpenAiServerClient,
  GoogleServerClient,
  OllamaServerClient,
  createProviderClient,
} = await import('../../../app/src/AiAssistProviders.mjs')

/**
 * The tool schemas that actually tripped a gateway: `get_packages` declares no
 * arguments at all, and `get_compile_result` declares the boolean a model kept
 * sending as the string "True".
 */
const TOOLS = [
  {
    name: 'get_packages',
    description: 'Every \\usepackage in the project.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_compile_result',
    description: 'Errors and warnings of the last compile.',
    parameters: {
      type: 'object',
      properties: {
        severity: { type: 'string', enum: ['errors', 'warnings', 'all'] },
        includeRaw: { type: 'boolean', description: 'Include TeX log lines.' },
      },
      required: [],
    },
  },
]

/**
 * Captures the request body of the first call, then ends the stream so the
 * generator finishes without a network round trip.
 */
function capturingFetch(capture) {
  return async (url, options) => {
    capture.url = url
    capture.body = JSON.parse(options.body)
    return {
      ok: true,
      status: 200,
      body: (async function* () {
        yield new TextEncoder().encode('data: [DONE]\n\n')
      })(),
    }
  }
}

async function drain(client) {
  const chunks = []
  for await (const chunk of client.streamChat({
    system: 'system',
    messages: [{ role: 'user', content: 'hello' }],
    tools: TOOLS,
  })) {
    chunks.push(chunk)
  }
  return chunks
}

describe('provider tool schemas on the wire', function () {
  describe('OpenAI-compatible', function () {
    it('drops the empty required array every tool declares', async function () {
      const capture = {}
      const client = new OpenAiServerClient({
        apiKey: 'k',
        model: 'gpt-4o',
        baseURL: 'https://api.openai.com',
        fetchFn: capturingFetch(capture),
      })

      await drain(client)

      for (const tool of capture.body.tools) {
        expect(tool.function.parameters).to.not.have.property('required')
      }
    })

    it('keeps an empty object schema, which the API expects', async function () {
      const capture = {}
      const client = new OpenAiServerClient({
        apiKey: 'k',
        model: 'gpt-4o',
        baseURL: 'https://api.openai.com',
        fetchFn: capturingFetch(capture),
      })

      await drain(client)

      const packages = capture.body.tools.find(
        t => t.function.name === 'get_packages'
      )
      expect(packages.function.parameters).to.deep.equal({
        type: 'object',
        properties: {},
      })
    })

    it('preserves the typed properties the model needs', async function () {
      const capture = {}
      const client = new OpenAiServerClient({
        apiKey: 'k',
        model: 'gpt-4o',
        baseURL: 'https://api.openai.com',
        fetchFn: capturingFetch(capture),
      })

      await drain(client)

      const compile = capture.body.tools.find(
        t => t.function.name === 'get_compile_result'
      )
      expect(compile.function.parameters.properties.includeRaw.type).to.equal(
        'boolean'
      )
      expect(compile.function.parameters.properties.severity.enum).to.deep.equal(
        ['errors', 'warnings', 'all']
      )
    })
  })

  describe('Google Gemini', function () {
    it('omits parameters entirely for a tool that takes none', async function () {
      const capture = {}
      const client = new GoogleServerClient({
        apiKey: 'k',
        model: 'gemini-2.0-flash',
        fetchFn: capturingFetch(capture),
      })

      await drain(client)

      const declarations = capture.body.tools[0].functionDeclarations
      const packages = declarations.find(d => d.name === 'get_packages')
      expect(packages).to.not.have.property('parameters')
    })

    it('drops the empty required array Gemini rejects', async function () {
      const capture = {}
      const client = new GoogleServerClient({
        apiKey: 'k',
        model: 'gemini-2.0-flash',
        fetchFn: capturingFetch(capture),
      })

      await drain(client)

      const declarations = capture.body.tools[0].functionDeclarations
      const compile = declarations.find(d => d.name === 'get_compile_result')
      expect(compile.parameters).to.not.have.property('required')
      expect(compile.parameters.properties.includeRaw.type).to.equal('boolean')
    })
  })

  describe('Anthropic', function () {
    it('drops the empty required array from input_schema', async function () {
      const capture = {}
      const client = createProviderClient({
        type: 'anthropic',
        apiKey: 'k',
        model: 'claude-sonnet-5',
        fetchFn: capturingFetch(capture),
      })

      await drain(client)

      for (const tool of capture.body.tools) {
        expect(tool.input_schema).to.not.have.property('required')
      }
    })

    it('keeps an empty object schema, which the API expects', async function () {
      const capture = {}
      const client = createProviderClient({
        type: 'anthropic',
        apiKey: 'k',
        model: 'claude-sonnet-5',
        fetchFn: capturingFetch(capture),
      })

      await drain(client)

      const packages = capture.body.tools.find(t => t.name === 'get_packages')
      expect(packages.input_schema).to.deep.equal({
        type: 'object',
        properties: {},
      })
    })
  })

  describe('Ollama', function () {
    it('drops the empty required array', async function () {
      const capture = {}
      const client = new OllamaServerClient({
        model: 'llama3',
        baseURL: 'http://localhost:11434',
        fetchFn: capturingFetch(capture),
      })

      await drain(client)

      for (const tool of capture.body.tools) {
        expect(tool.function.parameters).to.not.have.property('required')
      }
    })
  })
})
