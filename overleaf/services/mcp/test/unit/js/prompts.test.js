import { expect } from 'chai'
import { McpServer } from '@modelcontextprotocol/server'
import { registerAllPrompts } from '../../../src/prompts.js'
import { OVERLEAF_INSTRUCTIONS, createMcpServerFactory } from '../../../src/server.js'

describe('prompts', function () {
  let server

  beforeEach(function () {
    server = new McpServer({ name: 'test', version: '1.0.0' })
    registerAllPrompts(server)
  })

  it('registers the three standard prompts', function () {
    expect([...Object.keys(server._registeredPrompts)]).to.have.members([
      'review_project',
      'fix_compile_errors',
      'edit_section',
    ])
  })

  it('review_project generates structured review instructions', async function () {
    const handler = server.server._requestHandlers.get('prompts/get')
    const ctx = { mcpReq: { requestState: () => undefined } }
    const result = await handler(
      {
        method: 'prompts/get',
        params: { name: 'review_project', arguments: { projectId: 'proj-123' } },
      },
      ctx
    )
    const text = result.messages[0].content.text
    expect(text).to.include('proj-123')
    expect(text).to.include('get_doc_outline')
    expect(text).to.include('scan_latex')
    expect(text).to.include('get_word_count')
    expect(text).to.include('compile_project')
  })

  it('fix_compile_errors generates targeted diagnostic steps', async function () {
    const handler = server.server._requestHandlers.get('prompts/get')
    const ctx = { mcpReq: { requestState: () => undefined } }
    const result = await handler(
      {
        method: 'prompts/get',
        params: {
          name: 'fix_compile_errors',
          arguments: { projectId: 'proj-456', buildId: 'b-999' },
        },
      },
      ctx
    )
    const text = result.messages[0].content.text
    expect(text).to.include('proj-456')
    expect(text).to.include('b-999')
    expect(text).to.include('get_compile_log')
    expect(text).to.include('edit_file')
    expect(text).to.include('clearCache: true')
  })

  it('edit_section guides section location via outline and line ranges', async function () {
    const handler = server.server._requestHandlers.get('prompts/get')
    const ctx = { mcpReq: { requestState: () => undefined } }
    const result = await handler(
      {
        method: 'prompts/get',
        params: {
          name: 'edit_section',
          arguments: {
            projectId: 'proj-789',
            path: '/chapters/intro.tex',
            title: 'Introduction',
          },
        },
      },
      ctx
    )
    const text = result.messages[0].content.text
    expect(text).to.include('Introduction')
    expect(text).to.include('/chapters/intro.tex')
    expect(text).to.include('startLine and endLine')
  })
})

describe('server instructions', function () {
  it('exposes OVERLEAF_INSTRUCTIONS string', function () {
    expect(OVERLEAF_INSTRUCTIONS).to.be.a('string')
    expect(OVERLEAF_INSTRUCTIONS).to.include('get_doc_outline')
    expect(OVERLEAF_INSTRUCTIONS).to.include('startLine and endLine')
    expect(OVERLEAF_INSTRUCTIONS).to.include('edit_file')
    expect(OVERLEAF_INSTRUCTIONS).to.include('clearCache: true')
  })

  it('server factory sets instructions on McpServer instance', function () {
    const factory = createMcpServerFactory({ client: {} })
    const server = factory()
    expect(server.server._instructions).to.equal(OVERLEAF_INSTRUCTIONS)
    expect([...Object.keys(server._registeredPrompts)]).to.have.members([
      'review_project',
      'fix_compile_errors',
      'edit_section',
    ])
  })
})
