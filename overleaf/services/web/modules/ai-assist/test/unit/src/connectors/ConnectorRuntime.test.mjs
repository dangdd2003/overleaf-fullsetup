import { describe, it, afterEach, vi } from 'vitest'
import { expect } from 'chai'
import {
  ConnectorSession,
  ConnectorTimeoutError,
  CONNECTOR_SEARCH_TOOL,
  MAX_DESCRIPTION_CHARS,
  MAX_INSTRUCTIONS_CHARS,
  MAX_LOADED_DESCRIPTION_CHARS,
  MAX_RESULT_CHARS,
  MAX_STORED_RESULTS,
  TRUNCATION_MARKER,
  connectorToolSearchMode,
  contentText,
  createConnectorSession,
  deferredToolCatalog,
  isConnectorToolName,
  resultPageChars,
  toolSummary,
  uniqueName,
  READ_RESULT_TOOL,
} from '../../../../app/src/connectors/ConnectorRuntime.mjs'
import {
  McpClient,
  ConnectorAuthError,
  ConnectorRpcError,
  ConnectorScopeError,
} from '../../../../app/src/connectors/McpClient.mjs'
import McpOAuth from '../../../../app/src/connectors/McpOAuth.mjs'
import {
  ConnectorModel,
  ConnectorCredentialModel,
} from '../../../../app/src/connectors/ConnectorModel.mjs'

const CONNECTOR_ID = '507f1f77bcf86cd799439011'
const USER_ID = '607f1f77bcf86cd799439099'
const SILENT_TIMEOUT_TEXT = (name, tool, seconds) =>
  `MCP server "${name}" did not answer tool "${tool}" within ${seconds}s. The outcome is unknown — it may or may not have run on the server; verify before retrying anything that changes data.`

function connectorWith(overrides = {}) {
  return {
    _id: CONNECTOR_ID,
    name: 'docs',
    url: 'https://mcp.example.com/mcp',
    transport: 'auto',
    status: 'connected',
    tools: [],
    toolPermissions: {},
    server: { instructions: 'Use for documents.' },
    timeoutSeconds: null,
    oauth: {},
    ...overrides,
  }
}

function sessionOf(connectors, options = {}) {
  return new ConnectorSession(
    connectors.map(connector => ({
      connector,
      credentials: null,
      accessToken: null,
    })),
    options
  )
}

function query(result) {
  const q = { sort: () => q, lean: () => q, exec: async () => result }
  return q
}

const TEXT = result => ({ content: [{ type: 'text', text: result }] })

/** The JSON lines of a search result, one tool spec each. */
function loadedSpecs(result) {
  return result.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
}

describe('ConnectorRuntime', function () {
  afterEach(function () {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  function stubModelWrites() {
    return vi
      .spyOn(ConnectorModel, 'updateOne')
      .mockReturnValue({ exec: async () => undefined })
  }

  describe('tool names', function () {
    it('keeps the case of server and tool names, and allows dashes', function () {
      const session = sessionOf([
        connectorWith({
          name: 'My-Docs',
          tools: [{ name: 'Files.read-text', description: 'Read a file' }],
        }),
      ])

      const specs = session.specs()

      expect(specs[0].name).to.equal('mcp__My-Docs__Files_read-text')
      expect(session.connectors[0].prefix).to.equal('mcp__My-Docs__')
      expect(isConnectorToolName(specs[0].name)).to.be.true
    })

    it('replaces other characters with underscores and drops the underscores at the ends of a server name', function () {
      const session = sessionOf([
        connectorWith({ name: 'My Docs!', tools: [{ name: 'search' }] }),
      ])

      expect(session.specs()[0].name).to.equal('mcp__My_Docs__search')
    })

    it('keeps Search and search as two tools', function () {
      const session = sessionOf([
        connectorWith({ tools: [{ name: 'Search' }, { name: 'search' }] }),
      ])

      const names = session.specs().map(s => s.name).filter(n => n !== READ_RESULT_TOOL)

      expect(names).to.deep.equal(['mcp__docs__Search', 'mcp__docs__search'])
    })

    it('gives three tools that sanitize to one name three distinct names, none overwritten', async function () {
      const callTool = vi.spyOn(McpClient.prototype, 'callTool').mockResolvedValue(TEXT('ok'))
      stubModelWrites()
      const session = sessionOf([
        connectorWith({
          tools: [
            { name: 'a.b', description: 'dot' },
            { name: 'a_b', description: 'underscore' },
            { name: 'a b', description: 'space' },
          ],
        }),
      ])

      const names = session.specs().map(s => s.name).filter(n => n !== READ_RESULT_TOOL)

      expect(new Set(names).size).to.equal(3)
      expect(names[0]).to.equal('mcp__docs__a_b')
      for (const name of names) expect(name.length).to.be.at.most(64)
      expect(session.describe(names[1]).tool).to.equal('a_b')
      expect(session.describe(names[2]).tool).to.equal('a b')

      await session.execute(names[1], {})
      expect(callTool.mock.calls[0][0]).to.equal('a_b')
    })

    it('gives every connector with the same name its own server prefix, however many there are', function () {
      const connectors = ['Docs', 'Docs!', 'Docs?', 'Docs.', 'Docs#'].map((name, i) =>
        connectorWith({
          _id: `507f1f77bcf86cd7994390${10 + i}`,
          name,
          tools: [{ name: 'search' }],
        })
      )

      const session = sessionOf(connectors)

      const prefixes = session.connectors.map(c => c.prefix)
      expect(new Set(prefixes).size).to.equal(5)
      expect(prefixes[0]).to.equal('mcp__Docs__')
      const names = session.specs().map(s => s.name).filter(n => n !== READ_RESULT_TOOL)
      expect(new Set(names).size).to.equal(5)
      for (const name of names) expect(name.length).to.be.at.most(64)
    })

    it('keeps long names within 64 characters and distinct from one another', function () {
      const session = sessionOf([
        connectorWith({
          tools: [{ name: 'a'.repeat(90) }, { name: `${'a'.repeat(89)}b` }],
        }),
      ])

      const names = session.specs().map(s => s.name).filter(n => n !== READ_RESULT_TOOL)

      expect(names).to.have.lengthOf(2)
      for (const name of names) expect(name.length).to.be.at.most(64)
      expect(names[0]).to.not.equal(names[1])
    })

    it('makes a name unique against every taken name, whatever the number of collisions', function () {
      const taken = new Set(['a', 'a_h', 'a_2'])
      expect(uniqueName('a', taken, ['h'])).to.equal('a_3')
      expect(uniqueName('b', taken)).to.equal('b')

      const long = 'x'.repeat(80)
      const first = uniqueName(long, new Set())
      expect(first.length).to.be.at.most(64)
      expect(uniqueName(long, new Set([first]), ['h']).length).to.be.at.most(64)
    })

    it('recognises connector tool names, and the two helpers', function () {
      expect(isConnectorToolName('mcp__docs__search')).to.be.true
      expect(isConnectorToolName(READ_RESULT_TOOL)).to.be.true
      expect(isConnectorToolName(CONNECTOR_SEARCH_TOOL)).to.be.true
      expect(isConnectorToolName('edit_file')).to.be.false
      expect(isConnectorToolName(undefined)).to.be.false
    })

    it('leaves out blocked tools, and a connector-wide block with a per-tool allow keeps one', function () {
      const session = sessionOf([
        connectorWith({
          toolPermissions: { '*': 'block', search: 'allow' },
          tools: [{ name: 'search' }, { name: 'write' }],
        }),
      ])

      const names = session.specs().map(s => s.name)

      expect(names).to.deep.equal(['mcp__docs__search', READ_RESULT_TOOL])
      expect(session.has('mcp__docs__write')).to.be.false
    })

    it('offers no read-back tool when there are no tools at all', function () {
      expect(sessionOf([connectorWith()]).specs()).to.deep.equal([])
    })

    it('describes a tool with its permission and MCP hints', function () {
      const session = sessionOf([
        connectorWith({
          tools: [
            {
              name: 'search',
              title: 'Search',
              description: 'Search docs',
              annotations: { readOnlyHint: true, destructiveHint: false },
            },
          ],
        }),
      ])

      expect(session.describe('mcp__docs__search')).to.include({
        name: 'docs',
        tool: 'search',
        title: 'Search',
        permission: 'ask',
        readOnly: true,
        destructive: false,
        openWorld: false,
      })
      expect(session.describe('mcp__docs__missing')).to.be.null
    })
  })

  describe('descriptions and session metadata', function () {
    it('passes a description to the model verbatim, with no connector prefix', function () {
      const description = 'Read a file.\n\nPass the path.'
      const session = sessionOf([
        connectorWith({ tools: [{ name: 'read', description }] }),
      ])

      expect(session.specs()[0].description).to.equal(description)
    })

    it('caps a long description at 4096 characters, marker included', function () {
      const session = sessionOf([
        connectorWith({ tools: [{ name: 'read', description: 'x'.repeat(5000) }] }),
      ])

      const { description } = session.specs()[0]

      expect(description.length).to.equal(MAX_DESCRIPTION_CHARS)
      expect(description.endsWith(TRUNCATION_MARKER)).to.be.true
    })

    it('uses the title when there is no description', function () {
      const session = sessionOf([
        connectorWith({ tools: [{ name: 'read', title: 'Read a file' }] }),
      ])

      expect(session.specs()[0].description).to.equal('Read a file')
      expect(session.connectors[0].tools[0].summary).to.equal('Read a file')
    })

    it('summarises a tool by its first sentence, and caps the summary', function () {
      expect(toolSummary('Search the docs. Returns many things.')).to.equal('Search the docs.')
      expect(toolSummary('First line\nSecond line')).to.equal('First line')
      expect(toolSummary('', 'Fallback title')).to.equal('Fallback title')
      expect(toolSummary('y'.repeat(400)).length).to.be.at.most(160)
    })

    it('exposes each connector for the prompt, with instructions capped and its tools', function () {
      const session = sessionOf([
        connectorWith({
          server: {
            instructions: `  ${'i'.repeat(5000)}  `,
            title: 'Docs Server',
            version: '2.1',
          },
          tools: [
            {
              name: 'search',
              title: 'Search',
              description: 'Search the docs. Long text.',
              annotations: { readOnlyHint: true, openWorldHint: true },
            },
          ],
        }),
      ])

      const [connector] = session.connectors
      expect(connector.id).to.equal(CONNECTOR_ID)
      expect(connector.name).to.equal('docs')
      expect(connector.prefix).to.equal('mcp__docs__')
      expect(connector.instructions.length).to.equal(MAX_INSTRUCTIONS_CHARS)
      expect(connector.instructions.endsWith('… [instructions truncated]')).to.be.true
      expect(connector.serverTitle).to.equal('Docs Server')
      expect(connector.serverVersion).to.equal('2.1')
      expect(connector.tools).to.deep.equal([
        {
          name: 'mcp__docs__search',
          title: 'Search',
          summary: 'Search the docs.',
          readOnly: true,
          destructive: false,
          openWorld: true,
          permission: 'ask',
        },
      ])
    })

    it('gives an empty instruction string when the server sent none', function () {
      const session = sessionOf([connectorWith({ server: {}, tools: [{ name: 'a' }] })])

      expect(session.connectors[0].instructions).to.equal('')
      expect(session.connectors[0].serverTitle).to.be.null
    })

    it('reads each tool hint from the annotations, or from the top level of a saved tool', function () {
      const session = sessionOf([
        connectorWith({
          tools: [
            { name: 'a', annotations: { readOnly: true } },
            { name: 'b', readOnlyHint: true, destructiveHint: true },
          ],
        }),
      ])

      expect(session.describe('mcp__docs__a').readOnly).to.be.true
      expect(session.describe('mcp__docs__b')).to.include({ readOnly: true, destructive: true })
    })

    it('lists each tool by its full name and summary, grouped by connector', function () {
      const session = sessionOf(
        [
          connectorWith({
            tools: [{ name: 'search', description: 'Search the docs.' }, { name: 'write' }],
          }),
        ],
        { toolSearch: 'always' }
      )

      expect(deferredToolCatalog(session)).to.equal(
        'docs:\n- mcp__docs__search — Search the docs.\n- mcp__docs__write — write'
      )
    })
  })

  describe('deferral', function () {
    it('reads the mode from the environment value', function () {
      expect(connectorToolSearchMode(undefined)).to.deep.equal({ mode: 'auto', percent: 10 })
      expect(connectorToolSearchMode('true')).to.deep.equal({ mode: 'always', percent: 10 })
      expect(connectorToolSearchMode('always')).to.deep.equal({ mode: 'always', percent: 10 })
      expect(connectorToolSearchMode('false')).to.deep.equal({ mode: 'off', percent: 10 })
      expect(connectorToolSearchMode('OFF')).to.deep.equal({ mode: 'off', percent: 10 })
      expect(connectorToolSearchMode('auto:25')).to.deep.equal({ mode: 'auto', percent: 25 })
      expect(connectorToolSearchMode('auto:0')).to.deep.equal({ mode: 'auto', percent: 10 })
      expect(connectorToolSearchMode('auto:150')).to.deep.equal({ mode: 'auto', percent: 10 })
      expect(connectorToolSearchMode('whatever')).to.deep.equal({ mode: 'auto', percent: 10 })
    })

    it('does not defer a few small tools in auto mode', function () {
      const session = sessionOf([connectorWith({ tools: [{ name: 'search' }] })], {
        toolSearch: 'auto',
        contextWindow: 200_000,
      })

      expect(session.deferred).to.be.false
      expect(session.specs().map(s => s.name)).to.deep.equal(['mcp__docs__search', READ_RESULT_TOOL])
      expect(session.has(CONNECTOR_SEARCH_TOOL)).to.be.false
    })

    it('defers in auto mode once the tool specs reach the share of the context window', function () {
      // 30 tools of about 4,100 characters: roughly 31,000 tokens, over 10% of 200,000
      const tools = Array.from({ length: 30 }, (_, i) => ({
        name: `tool${i}`,
        description: 'd'.repeat(4000),
      }))
      const session = sessionOf([connectorWith({ tools })], {
        toolSearch: 'auto',
        contextWindow: 200_000,
      })

      expect(session.deferred).to.be.true
      expect(session.has(CONNECTOR_SEARCH_TOOL)).to.be.true
    })

    it('uses a percentage given in the mode, so a smaller share defers sooner', function () {
      // Three tools of about 4,100 characters: about 3,100 tokens, under 10% but over 1%
      const tools = Array.from({ length: 3 }, (_, i) => ({
        name: `tool${i}`,
        description: 'd'.repeat(4000),
      }))
      const tenPercent = sessionOf([connectorWith({ tools })], {
        toolSearch: 'auto',
        contextWindow: 200_000,
      })
      const onePercent = sessionOf([connectorWith({ tools })], {
        toolSearch: 'auto:1',
        contextWindow: 200_000,
      })

      expect(tenPercent.deferred).to.be.false
      expect(onePercent.deferred).to.be.true
    })

    it('defers always, and never, as the mode says', function () {
      expect(sessionOf([connectorWith({ tools: [{ name: 'a' }] })], { toolSearch: 'always' }).deferred).to.be.true
      expect(sessionOf([connectorWith({ tools: [{ name: 'a' }] })], { toolSearch: 'off' }).deferred).to.be.false
      const big = Array.from({ length: 60 }, (_, i) => ({ name: `t${i}`, description: 'd'.repeat(4000) }))
      expect(sessionOf([connectorWith({ tools: big })], { toolSearch: 'false' }).deferred).to.be.false
    })

    it('offers the search tool, the read-back tool and nothing else while deferred', function () {
      const session = sessionOf([connectorWith({ tools: [{ name: 'search' }, { name: 'write' }] })], {
        toolSearch: 'always',
      })

      expect(session.specs().map(s => s.name)).to.deep.equal([
        CONNECTOR_SEARCH_TOOL,
        READ_RESULT_TOOL,
      ])
      expect(session.has('mcp__docs__search')).to.be.true
      expect(session.has(CONNECTOR_SEARCH_TOOL)).to.be.true
    })
  })

  describe('search tool', function () {
    function deferred(tools) {
      return sessionOf([connectorWith({ tools })], { toolSearch: 'always' })
    }

    it('loads the exact tools a select query names, in the order named, and says they are callable', async function () {
      const session = deferred([{ name: 'search', description: 'Search.' }, { name: 'write', description: 'Write.' }])

      const result = await session.execute(CONNECTOR_SEARCH_TOOL, {
        query: 'select:mcp__docs__write, mcp__docs__search',
      })

      const specs = loadedSpecs(result.result)
      expect(specs.map(s => s.name)).to.deep.equal(['mcp__docs__write', 'mcp__docs__search'])
      expect(specs[0]).to.have.all.keys('name', 'description', 'parameters')
      expect(specs[0].description).to.equal('Write.')
      expect(result.result.trim().split('\n').pop()).to.equal('These tools are now callable.')
      expect([...session.loadedTools]).to.deep.equal(['mcp__docs__write', 'mcp__docs__search'])
    })

    it('adds loaded tools to the specs after the search and read-back tools, in load order', async function () {
      const session = deferred([{ name: 'search' }, { name: 'write' }, { name: 'list' }])

      await session.execute(CONNECTOR_SEARCH_TOOL, { query: 'select:mcp__docs__write' })
      const afterWrite = session.specs().map(s => s.name)
      await session.execute(CONNECTOR_SEARCH_TOOL, { query: 'select:mcp__docs__search' })
      const afterSearch = session.specs().map(s => s.name)

      expect(afterWrite).to.deep.equal([CONNECTOR_SEARCH_TOOL, READ_RESULT_TOOL, 'mcp__docs__write'])
      expect(afterSearch).to.deep.equal([
        CONNECTOR_SEARCH_TOOL,
        READ_RESULT_TOOL,
        'mcp__docs__write',
        'mcp__docs__search',
      ])
    })

    it('gives a loaded tool its description up to 16384 characters, where the listing has 4096', async function () {
      const description = 'z'.repeat(5000)
      const session = deferred([{ name: 'read', description }])

      const result = await session.execute(CONNECTOR_SEARCH_TOOL, { query: 'select:mcp__docs__read' })

      expect(loadedSpecs(result.result)[0].description).to.equal(description)
      expect(MAX_LOADED_DESCRIPTION_CHARS).to.equal(16384)
      const loaded = session.specs().find(s => s.name === 'mcp__docs__read')
      expect(loaded.description).to.equal(description)
    })

    it('matches keywords against names, titles and descriptions, and returns the best first', async function () {
      const session = deferred([
        { name: 'search_docs', title: 'Search documents', description: 'Full text search over the documents.' },
        { name: 'create_event', title: 'Create event', description: 'Create a calendar event.' },
        { name: 'delete_page', description: 'Delete a page.' },
      ])

      const byDescription = await session.execute(CONNECTOR_SEARCH_TOOL, { query: 'calendar' })
      expect(loadedSpecs(byDescription.result).map(s => s.name)).to.deep.equal(['mcp__docs__create_event'])

      const byName = await session.execute(CONNECTOR_SEARCH_TOOL, { query: 'search' })
      expect(loadedSpecs(byName.result).map(s => s.name)).to.deep.equal(['mcp__docs__search_docs'])
    })

    it('requires every +term, and keeps only the tools that have it', async function () {
      const session = deferred([
        { name: 'create_event', description: 'Create a calendar event.' },
        { name: 'delete_page', description: 'Delete a page.' },
      ])

      const result = await session.execute(CONNECTOR_SEARCH_TOOL, { query: '+event create' })

      expect(loadedSpecs(result.result).map(s => s.name)).to.deep.equal(['mcp__docs__create_event'])
      expect(session.loadedTools.has('mcp__docs__delete_page')).to.be.false
    })

    it('caps keyword matches at max_results, five by default', async function () {
      const tools = Array.from({ length: 8 }, (_, i) => ({ name: `docs_${i}` }))
      const session = deferred(tools)

      const byDefault = await session.execute(CONNECTOR_SEARCH_TOOL, { query: 'docs' })
      expect(loadedSpecs(byDefault.result)).to.have.lengthOf(5)

      const capped = await session.execute(CONNECTOR_SEARCH_TOOL, { query: 'docs', max_results: 2 })
      expect(loadedSpecs(capped.result)).to.have.lengthOf(2)
    })

    it('says so when nothing matches, and does not claim the tools are callable', async function () {
      const session = deferred([{ name: 'search' }])

      const result = await session.execute(CONNECTOR_SEARCH_TOOL, { query: 'invoice' })

      expect(result.result).to.equal('No connector tools matched "invoice".')
      expect(session.loadedTools.size).to.equal(0)
    })

    it('names a select target that does not exist', async function () {
      const session = deferred([{ name: 'search' }])

      const result = await session.execute(CONNECTOR_SEARCH_TOOL, { query: 'select:mcp__docs__nope' })

      expect(result.result).to.include('No connector tool is named "mcp__docs__nope".')
      expect(result.result).to.include('No connector tools matched')
    })

    it('asks for a query when it gets none', async function () {
      const session = deferred([{ name: 'search' }])

      expect((await session.execute(CONNECTOR_SEARCH_TOOL, {})).error).to.match(/Pass a query/)
    })
  })

  describe('calls to deferred tools', function () {
    it('refuses to run a deferred tool that is not loaded, and says how to load it', async function () {
      const callTool = vi.spyOn(McpClient.prototype, 'callTool').mockResolvedValue(TEXT('ok'))
      const session = sessionOf([connectorWith({ tools: [{ name: 'search' }] })], { toolSearch: 'always' })

      const result = await session.execute('mcp__docs__search', { query: 'x' })

      expect(result.error).to.include('not loaded yet')
      expect(result.error).to.include('select:mcp__docs__search')
      expect(callTool.mock.calls).to.have.lengthOf(0)
    })

    it('runs the tool once it is loaded', async function () {
      const callTool = vi.spyOn(McpClient.prototype, 'callTool').mockResolvedValue(TEXT('found'))
      stubModelWrites()
      const session = sessionOf([connectorWith({ tools: [{ name: 'search' }] })], { toolSearch: 'always' })
      await session.execute(CONNECTOR_SEARCH_TOOL, { query: 'select:mcp__docs__search' })

      const result = await session.execute('mcp__docs__search', { query: 'x' })

      expect(result).to.deep.equal({ result: 'found', isError: false })
      expect(callTool.mock.calls).to.have.lengthOf(1)
    })

    it('updates the listed permission when the user allows a tool always', async function () {
      vi.spyOn(McpClient.prototype, 'callTool').mockResolvedValue(TEXT('done'))
      stubModelWrites()
      const connector = connectorWith({ tools: [{ name: 'write' }] })
      const session = sessionOf([connector])

      await session.allowAlways('mcp__docs__write')

      expect(session.connectors[0].tools[0].permission).to.equal('allow')
    })
  })

  describe('deferredToolCatalog', function () {
    it('lists only the tools not yet loaded, and nothing when the tools are not deferred', async function () {
      const session = sessionOf(
        [connectorWith({ tools: [{ name: 'search', description: 'Search.' }, { name: 'write', description: 'Write.' }] })],
        { toolSearch: 'always' }
      )
      await session.execute(CONNECTOR_SEARCH_TOOL, { query: 'select:mcp__docs__write' })

      expect(deferredToolCatalog(session)).to.equal('docs:\n- mcp__docs__search — Search.')
      expect(deferredToolCatalog(sessionOf([connectorWith({ tools: [{ name: 'a' }] })], { toolSearch: 'off' }))).to.equal('')
      expect(deferredToolCatalog(null)).to.equal('')
    })
  })

  describe('argument and parameter handling', function () {
    it('renames parameters providers reject, and maps the arguments back to the server names', async function () {
      const callTool = vi.spyOn(McpClient.prototype, 'callTool').mockResolvedValue(TEXT('ok'))
      stubModelWrites()
      const session = sessionOf([
        connectorWith({
          tools: [
            {
              name: 'find',
              inputSchema: {
                type: 'object',
                properties: {
                  'user-id': { type: 'string' },
                  $filter: { type: 'string' },
                  limit: { type: 'integer' },
                },
                required: ['user-id'],
              },
            },
          ],
        }),
      ])

      const spec = session.specs()[0]
      expect(Object.keys(spec.parameters.properties)).to.have.members([
        'user_id',
        'filter',
        'limit',
      ])
      expect(spec.parameters.required).to.deep.equal(['user_id'])

      await session.execute('mcp__docs__find', {
        user_id: 'u-1',
        filter: 'name = x',
        limit: '5',
      })

      expect(callTool.mock.calls[0][1]).to.deep.equal({
        'user-id': 'u-1',
        $filter: 'name = x',
        limit: 5,
      })
    })

    it('coerces arguments back to the types the server declared, including a numeric enum', async function () {
      const callTool = vi.spyOn(McpClient.prototype, 'callTool').mockResolvedValue(TEXT('ok'))
      stubModelWrites()
      const session = sessionOf([
        connectorWith({
          tools: [
            {
              name: 'render',
              inputSchema: {
                type: 'object',
                properties: {
                  size: { type: 'integer', enum: [10, 12] },
                  dry: { type: 'boolean' },
                },
              },
            },
          ],
        }),
      ])

      expect(session.specs()[0].parameters.properties.size).to.deep.equal({
        type: 'string',
        enum: ['10', '12'],
      })

      await session.execute('mcp__docs__render', { size: '12', dry: 'True' })

      expect(callTool.mock.calls[0][1]).to.deep.equal({ size: 12, dry: true })
    })

    it('refuses a tool name the session does not know', async function () {
      const callTool = vi.spyOn(McpClient.prototype, 'callTool')
      const session = sessionOf([connectorWith({ tools: [{ name: 'search' }] })])

      const result = await session.execute('mcp__docs__nope', {})

      expect(result.error).to.equal('Unknown connector tool: mcp__docs__nope')
      expect(callTool.mock.calls).to.have.lengthOf(0)
    })
  })

  describe('results', function () {
    it('turns each kind of content into text, and structured-only results into JSON', async function () {
      const session = sessionOf([connectorWith({ tools: [{ name: 'search' }] })])
      stubModelWrites()

      const callTool = vi.spyOn(McpClient.prototype, 'callTool')
      callTool.mockResolvedValueOnce(TEXT('hello'))
      expect(await session.execute('mcp__docs__search', {})).to.deep.equal({
        result: 'hello',
        isError: false,
      })

      callTool.mockResolvedValueOnce({
        content: [{ type: 'image', mimeType: 'image/jpeg', data: 'AAAA' }],
      })
      expect((await session.execute('mcp__docs__search', {})).result).to.equal(
        '[Image: image/jpeg]'
      )

      callTool.mockResolvedValueOnce({ content: [], structuredContent: { count: 2 } })
      expect((await session.execute('mcp__docs__search', {})).result).to.equal(
        '{"count":2}'
      )
    })

    it('converts text, embedded resources, resource links and binary resources as the model reads them', function () {
      const text = contentText(
        {
          content: [
            { type: 'text', text: 'Found:' },
            { type: 'resource', resource: { uri: 'file:///notes.md', text: '# Notes' } },
            { type: 'resource_link', name: 'Agenda', uri: 'https://x.example/agenda', description: 'Meeting agenda' },
            { type: 'resource_link', name: 'Plain', uri: 'https://x.example/plain' },
            { type: 'resource', resource: { uri: 'file:///a.pdf', mimeType: 'application/pdf', blob: 'AAAA' } },
          ],
          structuredContent: { ignored: true },
        },
        'docs'
      )

      expect(text).to.equal(
        [
          'Found:',
          '[Resource from docs at file:///notes.md]\n# Notes',
          '[Resource link: Agenda] https://x.example/agenda (Meeting agenda)',
          '[Resource link: Plain] https://x.example/plain',
          '[Binary resource file:///a.pdf (application/pdf), not shown]',
        ].join('\n')
      )
    })

    it('keeps at most a bounded number of long results, each capped, with ids that never repeat', async function () {
      const session = sessionOf([connectorWith({ tools: [{ name: 'search' }] })])
      stubModelWrites()
      const callTool = vi.spyOn(McpClient.prototype, 'callTool')

      // One result larger than the cap is cut, and says so
      callTool.mockResolvedValueOnce(TEXT('x'.repeat(MAX_RESULT_CHARS + 1000)))
      await session.execute('mcp__docs__search', {})
      expect(session.results.get('r1').length).to.be.at.most(MAX_RESULT_CHARS)
      expect(session.results.get('r1')).to.include('Result truncated')

      // Then many more: the oldest go, and the ids keep counting up
      for (let i = 0; i < MAX_STORED_RESULTS + 5; i++) {
        callTool.mockResolvedValueOnce(TEXT(`${i}:` + 'y'.repeat(session.pageChars + 10)))
        await session.execute('mcp__docs__search', {})
      }
      expect(session.results.size).to.equal(MAX_STORED_RESULTS)
      expect(session.results.has('r1')).to.be.false
      expect(session.results.has(`r${MAX_STORED_RESULTS + 6}`)).to.be.true
    })

    it('passes a tool error through as an error with the server text', async function () {
      vi.spyOn(McpClient.prototype, 'callTool').mockResolvedValue({
        ...TEXT('bad input'),
        isError: true,
      })
      stubModelWrites()
      const session = sessionOf([connectorWith({ tools: [{ name: 'search' }] })])

      expect(await session.execute('mcp__docs__search', {})).to.deep.equal({
        error: 'bad input',
        mcpError: true,
      })
    })

    it('reports an error result with no text as an error with a default message', async function () {
      vi.spyOn(McpClient.prototype, 'callTool').mockResolvedValue({ content: [], isError: true })
      stubModelWrites()
      const session = sessionOf([connectorWith({ tools: [{ name: 'search' }] })])

      expect(await session.execute('mcp__docs__search', {})).to.deep.equal({
        error: 'The connector tool reported an error with no message.',
        mcpError: true,
      })
    })

    it('keeps a long result whole and pages it through read_connector_result, saying how to read on', async function () {
      const long = 'a'.repeat(8000) + 'b'.repeat(8000) + 'c'.repeat(4000)
      vi.spyOn(McpClient.prototype, 'callTool').mockResolvedValue(TEXT(long))
      stubModelWrites()
      // A small window gives the minimum page of 8,000 characters
      const session = sessionOf([connectorWith({ tools: [{ name: 'dump' }] })], {
        contextWindow: 1,
        toolSearch: 'off',
      })
      expect(resultPageChars(1)).to.equal(8000)

      const first = await session.execute('mcp__docs__dump', {})
      expect(first.isError).to.be.false
      expect(first.result).to.include('[Result r1: 20,000 characters in 3 pages. Showing page 1 of 3.')
      expect(first.result).to.include('prefer narrowing the query over reading every page')
      expect(first.result).to.include('[Page 1 of 3 of result r1. To read the next page, call read_connector_result with {"id": "r1", "page": 2}.]')

      const second = await session.execute(READ_RESULT_TOOL, { id: 'r1', page: 2 })
      expect(second.result).to.include('b'.repeat(8000))
      expect(second.result).to.include('"page": 3}')

      const last = await session.execute(READ_RESULT_TOOL, { id: 'r1', page: 3 })
      expect(last.result).to.include('c'.repeat(4000))
      expect(last.result).to.include('Page 3 of 3 of result r1: the end.')
    })

    it('clamps a page past the end to the last page, and reports an unknown result id', async function () {
      vi.spyOn(McpClient.prototype, 'callTool').mockResolvedValue(
        TEXT('x'.repeat(9000))
      )
      stubModelWrites()
      const session = sessionOf([connectorWith({ tools: [{ name: 'dump' }] })], {
        contextWindow: 1,
        toolSearch: 'off',
      })
      await session.execute('mcp__docs__dump', {})

      const clamped = await session.execute(READ_RESULT_TOOL, { id: 'r1', page: 99 })
      expect(clamped.result).to.include('Page 2 of 2 of result r1: the end.')

      expect(await session.execute(READ_RESULT_TOOL, { id: 'r9', page: 1 })).to.deep.equal({
        error: 'No connector result r9',
      })
    })
  })

  describe('failures and sign-in', function () {
    it('retries once with a refreshed token when the server says the token is not valid', async function () {
      const callTool = vi
        .spyOn(McpClient.prototype, 'callTool')
        .mockRejectedValueOnce(new ConnectorAuthError('token expired'))
        .mockResolvedValueOnce(TEXT('ok'))
      const refresh = vi
        .spyOn(McpOAuth, 'refreshTokens')
        .mockResolvedValue('fresh-token')
      stubModelWrites()
      const session = sessionOf([
        connectorWith({
          tools: [{ name: 'search' }],
          oauth: { hasRefreshToken: true },
        }),
      ])

      const result = await session.execute('mcp__docs__search', {})

      expect(result.result).to.equal('ok')
      expect(refresh.mock.calls).to.have.lengthOf(1)
      expect(callTool.mock.calls).to.have.lengthOf(2)
      expect(session.clients.get(CONNECTOR_ID).accessToken).to.equal('fresh-token')
    })

    it('asks the user to sign in again, without retrying, when there is no refresh token', async function () {
      const callTool = vi
        .spyOn(McpClient.prototype, 'callTool')
        .mockRejectedValue(new ConnectorAuthError('token expired'))
      const refresh = vi.spyOn(McpOAuth, 'refreshTokens')
      const session = sessionOf([connectorWith({ tools: [{ name: 'search' }] })])

      const result = await session.execute('mcp__docs__search', {})

      expect(result.error).to.match(/is signed out/)
      expect(callTool.mock.calls).to.have.lengthOf(1)
      expect(refresh.mock.calls).to.have.lengthOf(0)
    })

    it('names the scope a tool needs when the server asks for more permission', async function () {
      vi.spyOn(McpClient.prototype, 'callTool').mockRejectedValue(
        new ConnectorScopeError('insufficient scope', { scope: 'calendar.write' })
      )
      const session = sessionOf([connectorWith({ tools: [{ name: 'create_event' }] })])

      const result = await session.execute('mcp__docs__create_event', {})

      expect(result.error).to.match(/needs more permissions \(calendar\.write\)/)
    })

    it('reports a connector that cannot be reached, with the reason', async function () {
      vi.spyOn(McpClient.prototype, 'callTool').mockRejectedValue(new Error('fetch failed'))
      const session = sessionOf([connectorWith({ tools: [{ name: 'search' }] })])

      expect(await session.execute('mcp__docs__search', {})).to.deep.equal({
        error:
          'Could not reach the docs connector (fetch failed). Tell the user it may be down, or continue without it.',
      })
    })

    it('passes a JSON-RPC error from the server through as its own message, not as a connection failure', async function () {
      vi.spyOn(McpClient.prototype, 'callTool').mockRejectedValue(
        new ConnectorRpcError('Invalid params: limit', -32602)
      )
      const session = sessionOf([connectorWith({ tools: [{ name: 'search' }] })])

      expect(await session.execute('mcp__docs__search', {})).to.deep.equal({
        error: 'Invalid params: limit',
      })
    })

    it('refuses a tool the user blocked after the session opened, without calling the server', async function () {
      const callTool = vi.spyOn(McpClient.prototype, 'callTool')
      const connector = connectorWith({ tools: [{ name: 'search' }] })
      const session = sessionOf([connector])

      connector.toolPermissions = { search: 'block' }
      const result = await session.execute('mcp__docs__search', {})

      expect(result.error).to.match(/blocked by user permission/)
      expect(callTool.mock.calls).to.have.lengthOf(0)
    })
  })

  describe('timeouts and permissions', function () {
    it('tells the model the call timed out, and that the outcome is unknown, after the connector timeout', async function () {
      vi.useFakeTimers()
      const callTool = vi
        .spyOn(McpClient.prototype, 'callTool')
        .mockImplementation(() => new Promise(() => {}))
      stubModelWrites()
      const session = sessionOf([
        connectorWith({ tools: [{ name: 'search' }], timeoutSeconds: 30 }),
      ])

      const pending = session.execute('mcp__docs__search', {})
      await vi.advanceTimersByTimeAsync(30_000)

      expect(await pending).to.deep.equal({
        error: SILENT_TIMEOUT_TEXT('docs', 'search', 30),
      })
      expect(callTool.mock.calls[0][2].signal.aborted).to.be.true
    })

    it('waits the default 120 seconds when the connector sets no timeout', async function () {
      vi.useFakeTimers()
      vi.spyOn(McpClient.prototype, 'callTool').mockImplementation(() => new Promise(() => {}))
      const session = sessionOf([connectorWith({ tools: [{ name: 'search' }] })])

      const pending = session.execute('mcp__docs__search', {})
      await vi.advanceTimersByTimeAsync(119_000)
      let settled = false
      pending.then(() => {
        settled = true
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(settled).to.be.false

      await vi.advanceTimersByTimeAsync(1_000)
      expect(await pending).to.deep.equal({ error: SILENT_TIMEOUT_TEXT('docs', 'search', 120) })
    })

    it('does not give up at once when the connector timeout is too large for a timer', async function () {
      vi.useFakeTimers()
      vi.spyOn(McpClient.prototype, 'callTool').mockImplementation(() => new Promise(() => {}))
      const session = sessionOf([connectorWith({ tools: [{ name: 'search' }], timeoutSeconds: 1e10 })])

      const pending = session.execute('mcp__docs__search', {})
      let settled = false
      pending.then(() => {
        settled = true
      })
      await vi.advanceTimersByTimeAsync(1_000)

      expect(settled).to.be.false
    })

    it('gives the connector timeout to the timeout error type', function () {
      const err = new ConnectorTimeoutError('docs', 'search', 5)

      expect(err.message).to.equal(SILENT_TIMEOUT_TEXT('docs', 'search', 5))
      expect(err.seconds).to.equal(5)
    })

    it('records an allow-always in memory and on the saved connector, then runs the tool', async function () {
      const callTool = vi.spyOn(McpClient.prototype, 'callTool').mockResolvedValue(TEXT('done'))
      const updateOne = stubModelWrites()
      const connector = connectorWith({
        tools: [{ name: 'write' }],
        toolPermissions: { '*': 'ask' },
      })
      const session = sessionOf([connector])

      await session.allowAlways('mcp__docs__write')

      expect(connector.toolPermissions.write).to.equal('allow')
      expect(updateOne.mock.calls[0][1]).to.deep.equal({
        $set: { 'toolPermissions.write': 'allow' },
      })
      expect(session.describe('mcp__docs__write').permission).to.equal('allow')
      expect((await session.execute('mcp__docs__write', {})).result).to.equal('done')
      expect(callTool.mock.calls).to.have.lengthOf(1)
    })

    it('saves an allow-always for a name with a dot or a leading $ under an escaped key, not a path', async function () {
      vi.spyOn(McpClient.prototype, 'callTool').mockResolvedValue(TEXT('done'))
      const updateOne = stubModelWrites()
      const connector = connectorWith({
        tools: [{ name: 'files.write' }, { name: '$batch' }],
        toolPermissions: { '*': 'ask' },
      })
      const session = sessionOf([connector])

      await session.allowAlways(session.connectors[0].tools[0].name)
      await session.allowAlways(session.connectors[0].tools[1].name)

      expect(updateOne.mock.calls[0][1]).to.deep.equal({
        $set: { 'toolPermissions.files%2Ewrite': 'allow' },
      })
      expect(updateOne.mock.calls[1][1]).to.deep.equal({
        $set: { 'toolPermissions.%24batch': 'allow' },
      })
      expect(session.describe(session.connectors[0].tools[0].name).permission).to.equal('allow')
      expect(session.describe(session.connectors[0].tools[1].name).permission).to.equal('allow')
    })

    it('never reads an inherited property as a permission, so a tool named constructor still asks', function () {
      const session = sessionOf([
        connectorWith({ tools: [{ name: 'constructor' }, { name: 'toString' }] }),
      ])

      for (const name of session.connectors[0].tools) {
        expect(session.describe(name.name).permission).to.equal('ask')
      }
    })

    it('closes every connection, forgets its tools and stops deferring', async function () {
      const close = vi.spyOn(McpClient.prototype, 'close').mockResolvedValue(undefined)
      const session = sessionOf([connectorWith({ tools: [{ name: 'search' }] })], { toolSearch: 'always' })

      await session.close()

      expect(close.mock.calls).to.have.lengthOf(1)
      expect(session.specs()).to.deep.equal([])
      expect(session.deferred).to.be.false
    })
  })

  describe('createConnectorSession', function () {
    it('opens nothing without a user, and without asking the database', async function () {
      const find = vi.spyOn(ConnectorModel, 'find')

      const session = await createConnectorSession({})

      expect(session.connectors).to.deep.equal([])
      expect(find.mock.calls).to.have.lengthOf(0)
    })

    it('opens nothing when the user picked no connectors', async function () {
      const find = vi.spyOn(ConnectorModel, 'find')

      await createConnectorSession({ userId: USER_ID, connectorIds: [] })

      expect(find.mock.calls).to.have.lengthOf(0)
    })

    it('opens the enabled connectors the user picked, and their connected tools', async function () {
      const find = vi
        .spyOn(ConnectorModel, 'find')
        .mockReturnValue(query([connectorWith({ tools: [{ name: 'search' }] })]))
      vi.spyOn(ConnectorCredentialModel, 'findOne').mockReturnValue(query(null))

      const session = await createConnectorSession({
        userId: USER_ID,
        connectorIds: [CONNECTOR_ID],
        contextWindow: 200_000,
      })

      expect(find.mock.calls[0][0]).to.deep.equal({
        user_id: USER_ID,
        enabled: true,
        _id: { $in: [CONNECTOR_ID] },
      })
      expect(session.specs()[0].name).to.equal('mcp__docs__search')
      expect(session.unavailable).to.deep.equal([])
    })

    it('reports the picked connectors that cannot be used this run, and offers the rest', async function () {
      const needsAuth = connectorWith({
        _id: '507f1f77bcf86cd799439012',
        name: 'calendar',
        status: 'needs_auth',
        tools: [{ name: 'list' }],
      })
      const broken = connectorWith({
        _id: '507f1f77bcf86cd799439013',
        name: 'mail',
        status: 'error',
        lastError: { message: 'bad gateway' },
      })
      vi.spyOn(ConnectorModel, 'find').mockReturnValue(
        query([connectorWith({ tools: [{ name: 'search' }] }), needsAuth, broken])
      )
      vi.spyOn(ConnectorCredentialModel, 'findOne').mockReturnValue(query(null))

      const session = await createConnectorSession({ userId: USER_ID, connectorIds: [CONNECTOR_ID] })

      expect(session.connectors.map(c => c.name)).to.deep.equal(['docs'])
      expect(session.unavailable).to.deep.equal([
        {
          id: '507f1f77bcf86cd799439012',
          name: 'calendar',
          status: 'needs_auth',
          message:
            'calendar needs the user to sign in again in Settings → AI Features → Connectors. Its tools are not available in this chat.',
        },
        {
          id: '507f1f77bcf86cd799439013',
          name: 'mail',
          status: 'error',
          message: 'mail could not be reached (bad gateway). Its tools are not available in this chat.',
        },
      ])
    })

    it('passes the deferral mode and timeout through to the session', async function () {
      vi.spyOn(ConnectorModel, 'find').mockReturnValue(query([connectorWith({ tools: [{ name: 'search' }] })]))
      vi.spyOn(ConnectorCredentialModel, 'findOne').mockReturnValue(query(null))

      const session = await createConnectorSession({
        userId: USER_ID,
        toolSearch: 'always',
        toolTimeoutSeconds: '9',
      })

      expect(session.deferred).to.be.true
      expect(session.defaultTimeoutSeconds).to.equal(9)
    })
  })
})
