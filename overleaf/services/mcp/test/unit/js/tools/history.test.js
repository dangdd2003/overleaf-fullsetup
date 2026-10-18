import { expect } from 'chai'
import sinon from 'sinon'
import { registerHistoryTools } from '../../../../src/tools/history.js'

const TOKEN = 'olp_0123456789abcdef'
const CTX = { http: { authInfo: { token: TOKEN } } }

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

  it('list_history forwards filters and suggests a diff of the latest entry', async function () {
    client.get.resolves({
      entries: [
        {
          fromVersion: 3,
          toVersion: 5,
          startedAt: '2026-01-01T00:00:00.000Z',
          endedAt: '2026-01-01T00:01:00.000Z',
          authors: ['Ada'],
          origin: null,
          labels: [],
          changes: [{ path: '/main.tex', change: 'edited' }],
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
    const value = result.structuredContent
    expect(value.ok).to.equal(true)
    expect(value.summary).to.include('version 5')
    expect(value.nextSteps[0]).to.include('fromVersion=3, toVersion=5')
    expect(value.nextSteps[1]).to.include('before=42')
    await validOutput(server, 'list_history', result)
  })

  it('get_history_diff reports counts and offers a restore', async function () {
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
    expect(result.structuredContent.summary).to.include('1 change(s)')
    expect(result.structuredContent.nextSteps[0]).to.include('version=3')
    await validOutput(server, 'get_history_diff', result)
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
    expect(result.structuredContent.summary).to.equal(
      'Restored /main.tex to its content at version 3.'
    )
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
    expect(JSON.parse(result.content[0].text).ok).to.equal(false)
  })
})
