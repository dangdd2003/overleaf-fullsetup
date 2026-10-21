import { expect } from 'chai'
import sinon from 'sinon'
import { registerHistoryTools } from '../../../../src/tools/history.js'

const TOKEN = 'olp_0123456789abcdef'
const CTX = { http: { authInfo: { token: TOKEN } } }

function body(result) {
  return result.content[0].text.slice(result.structuredContent.summary.length + 1)
}

function fakeServer() {
  const tools = new Map()
  return {
    tools,
    registerTool(name, config, handler) {
      tools.set(name, { config, handler })
    },
    call(name, args, ctx = CTX) {
      return tools.get(name).handler(args, ctx)
    },
  }
}

async function validOutput(server, name, result) {
  const { config } = server.tools.get(name)
  const validated = await config.outputSchema['~standard'].validate(
    result.structuredContent
  )
  expect(validated.issues, JSON.stringify(validated.issues)).to.be.undefined
}

const ENTRY = {
  fromVersion: 3,
  toVersion: 5,
  startedAt: '2026-01-01T00:00:00.000Z',
  endedAt: '2026-01-01T00:01:00.000Z',
  authors: ['Ada'],
  origin: null,
  labels: [],
  changes: [{ path: '/main.tex', change: 'edited' }],
}

describe('history tools', function () {
  let client, server

  beforeEach(function () {
    client = { get: sinon.stub(), post: sinon.stub() }
    server = fakeServer()
    registerHistoryTools(server, { client, staticToken: '' })
  })

  it('registers list_history, get_history_diff and restore_file', function () {
    expect([...server.tools.keys()]).to.deep.equal([
      'list_history',
      'get_history_diff',
      'restore_file',
    ])
  })

  it('list_history forwards filters and renders one line per entry', async function () {
    client.get.resolves({
      entries: [
        ENTRY,
        {
          ...ENTRY,
          fromVersion: 1,
          toVersion: 2,
          authors: ['Ada', 'Bo'],
          origin: 'file-restore',
          labels: ['draft'],
          changes: [
            { path: '/a.tex', change: 'added' },
            { path: '/b.tex', change: 'renamed to /c.tex' },
          ],
        },
      ],
      nextBefore: 42,
      path: '/main.tex',
    })
    const result = await server.call('list_history', {
      projectId: 'p1',
      path: '/main.tex',
      limit: 5,
    })
    expect(client.get.firstCall.args[1]).to.equal('/projects/p1/history')
    expect(client.get.firstCall.args[2]).to.deep.equal({
      path: '/main.tex',
      limit: 5,
      before: undefined,
    })
    expect(body(result)).to.equal(
      [
        'v3→v5  2026-01-01 00:01  Ada  /main.tex',
        'v1→v2  2026-01-01 00:01  Ada, Bo  [file-restore]  [labels: draft]  /a.tex added; /b.tex renamed to /c.tex',
      ].concat(['→ list_history before=42']).join('\n')
    )
    const value = result.structuredContent
    expect(value.ok).to.equal(true)
    expect(value.summary).to.equal('2 entries, older: before=42')
    expect(value.nextSteps).to.deep.equal(['list_history before=42'])
    await validOutput(server, 'list_history', result)
  })

  it('list_history omits the next step on the last page', async function () {
    client.get.resolves({ entries: [ENTRY], nextBefore: null, path: null })
    const result = await server.call('list_history', { projectId: 'p1' })
    expect(result.structuredContent.nextSteps).to.be.undefined
    expect(result.content[0].text).to.not.include('null')
    expect(result.content[0].text).to.not.include('{')
  })

  it('get_history_diff reports counts and renders the diff', async function () {
    client.get.resolves({
      path: '/main.tex',
      fromVersion: 3,
      toVersion: 5,
      binary: false,
      changes: [{ type: 'insert', line: 4, text: 'x', author: null }],
      truncated: false,
      insertedChars: 1,
      deletedChars: 0,
    })
    const result = await server.call('get_history_diff', {
      projectId: 'p1',
      path: '/main.tex',
      fromVersion: 3,
      toVersion: 5,
    })
    expect(client.get.firstCall.args[1]).to.equal('/projects/p1/history/diff')
    expect(result.structuredContent.summary).to.equal(
      '/main.tex v3→v5: 1 changes +1/-0 chars'
    )
    expect(body(result)).to.equal('+4 x')
    expect(result.structuredContent.nextSteps).to.be.undefined
    await validOutput(server, 'get_history_diff', result)
  })

  it('get_history_diff prefixes each line, numbers inserts upward and marks author changes', async function () {
    client.get.resolves({
      path: '/main.tex',
      fromVersion: 3,
      toVersion: 5,
      binary: false,
      changes: [
        { type: 'insert', line: 4, text: 'a\nb', author: 'Ada' },
        { type: 'delete', line: 9, text: 'c', author: 'Ada' },
        { type: 'insert', line: 9, text: 'd', author: 'Bo' },
      ],
      truncated: false,
      insertedChars: 3,
      deletedChars: 1,
    })
    const result = await server.call('get_history_diff', {
      projectId: 'p1',
      path: '/main.tex',
      fromVersion: 3,
      toVersion: 5,
    })
    expect(body(result)).to.equal('(Ada)\n+4 a\n+5 b\n-9 c\n(Bo)\n+9 d')
  })

  it('get_history_diff keeps trailing spaces in changed text', async function () {
    client.get.resolves({
      path: '/main.tex',
      fromVersion: 1,
      toVersion: 2,
      binary: false,
      changes: [{ type: 'insert', line: 2, text: 'x  ', author: null }],
      truncated: false,
      insertedChars: 3,
      deletedChars: 0,
    })
    const result = await server.call('get_history_diff', {
      projectId: 'p1',
      path: '/main.tex',
      fromVersion: 1,
      toVersion: 2,
    })
    expect(body(result)).to.equal('+2 x  ')
  })

  it('get_history_diff says so for a binary file', async function () {
    client.get.resolves({
      path: '/logo.png',
      fromVersion: 3,
      toVersion: 5,
      binary: true,
      changes: [],
      truncated: false,
      insertedChars: 0,
      deletedChars: 0,
    })
    const result = await server.call('get_history_diff', {
      projectId: 'p1',
      path: '/logo.png',
      fromVersion: 3,
      toVersion: 5,
    })
    expect(result.structuredContent.summary).to.equal(
      '/logo.png v3→v5: binary file, no text diff'
    )
    expect(body(result)).to.equal('')
  })

  it('restore_file posts the path and version', async function () {
    client.post.resolves({ path: '/main.tex', version: 3, type: 'doc', id: 'd1' })
    const result = await server.call('restore_file', {
      projectId: 'p1',
      path: '/main.tex',
      version: 3,
    })
    expect(client.post.firstCall.args[1]).to.equal('/projects/p1/history/restore')
    expect(client.post.firstCall.args[2]).to.deep.equal({ path: '/main.tex', version: 3 })
    expect(result.structuredContent.summary).to.equal('Restored /main.tex to v3')
    expect(result.structuredContent.nextSteps).to.be.undefined
    expect(result.content[0].text).to.equal('Restored /main.tex to v3')
    await validOutput(server, 'restore_file', result)
  })

  it('surfaces an upstream failure as an error envelope', async function () {
    client.post.rejects(new Error('boom'))
    const result = await server.call('restore_file', {
      projectId: 'p1',
      path: '/main.tex',
      version: 3,
    })
    expect(result.isError).to.be.true
    expect(result.structuredContent.ok).to.equal(false)
  })
})
