import { expect } from 'chai'
import sinon from 'sinon'
import { registerTagTools } from '../../../../src/tools/tags.js'

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

async function inputIssues(server, name, args) {
  const { config } = server.tools.get(name)
  const checked = await config.inputSchema['~standard'].validate(args)
  return checked.issues
}

const tag = { id: 't1', name: 'thesis', color: '#3366CC', projectCount: 2 }

describe('tag tools', function () {
  let client, server

  beforeEach(function () {
    client = {
      get: sinon.stub(),
      post: sinon.stub(),
      patch: sinon.stub(),
      request: sinon.stub(),
    }
    server = fakeServer()
    registerTagTools(server, { client, staticToken: '' })
  })

  it('registers the six tag tools', function () {
    expect([...server.tools.keys()]).to.deep.equal([
      'list_tags',
      'create_tag',
      'update_tag',
      'delete_tag',
      'add_projects_to_tag',
      'remove_projects_from_tag',
    ])
  })

  it('every tool states all four annotation hints', function () {
    for (const [name, { config }] of server.tools) {
      for (const hint of [
        'readOnlyHint',
        'destructiveHint',
        'idempotentHint',
        'openWorldHint',
      ]) {
        expect(config.annotations[hint], `${name} ${hint}`).to.be.a('boolean')
      }
    }
  })

  it('list_tags forwards includeProjects and suggests tagging', async function () {
    client.get.resolves({ tags: [tag], total: 1 })
    const result = await server.call('list_tags', { includeProjects: true })
    expect(client.get.firstCall.args[1]).to.equal('/tags')
    expect(client.get.firstCall.args[2]).to.deep.equal({
      includeProjects: true,
    })
    expect(result.structuredContent.summary).to.equal('1 tag(s).')
    expect(result.structuredContent.nextSteps).to.be.undefined
    expect(result.content[0].text).to.equal(
      '1 tag(s).\nt1  thesis  #3366CC  2 projects'
    )
    await validOutput(server, 'list_tags', result)
  })

  it('list_tags adds the projectIds of each tag only when includeProjects is set', async function () {
    const withIds = { ...tag, projectIds: ['p1', 'p2'] }
    client.get.resolves({ tags: [withIds, { ...tag, id: 't2', name: 'empty', color: null, projectCount: 0 }], total: 2 })
    const result = await server.call('list_tags', { includeProjects: true })
    expect(result.content[0].text).to.equal(
      [
        '2 tag(s).',
        't1  thesis  #3366CC  2 projects: p1, p2',
        't2  empty  0 projects',
      ].join('\n')
    )
    expect(result.content[0].text).to.not.include('null')
    expect(result.content[0].text).to.not.include('{')

    client.get.resolves({ tags: [withIds], total: 1 })
    const plain = await server.call('list_tags', {})
    expect(plain.content[0].text).to.equal('1 tag(s).\nt1  thesis  #3366CC  2 projects')
    expect(plain.content[0].text).to.not.include('p1')
  })

  it('list_tags reports an empty tag list in one line', async function () {
    client.get.resolves({ tags: [], total: 0 })
    const result = await server.call('list_tags', {})
    expect(result.structuredContent.summary).to.equal('No tags.')
    expect(result.structuredContent.nextSteps).to.be.undefined
    expect(result.content[0].text).to.equal('No tags.')
    await validOutput(server, 'list_tags', result)
  })

  it('create_tag posts name and colour and reports creation', async function () {
    client.post.resolves({ tag, created: true })
    const result = await server.call('create_tag', {
      name: 'thesis',
      color: '#3366CC',
    })
    expect(client.post.firstCall.args[1]).to.equal('/tags')
    expect(client.post.firstCall.args[2]).to.deep.equal({
      name: 'thesis',
      color: '#3366CC',
    })
    expect(result.structuredContent.summary).to.equal(
      'Created tag "thesis" (id t1).'
    )
    expect(result.content[0].text).to.equal('Created tag "thesis" (id t1).')
    expect(result.structuredContent.nextSteps).to.be.undefined
    await validOutput(server, 'create_tag', result)
  })

  it('create_tag on an existing name says nothing changed and flags a colour mismatch', async function () {
    client.post.resolves({ tag, created: false })
    const result = await server.call('create_tag', {
      name: 'thesis',
      color: '#000000',
    })
    expect(result.structuredContent.summary).to.include('already exists')
    expect(result.structuredContent.warnings[0]).to.include('#3366CC')
    await validOutput(server, 'create_tag', result)
  })

  it('update_tag patches only the supplied fields and summarises the change', async function () {
    client.patch.resolves({
      tag: { ...tag, name: 'diss' },
      before: { name: 'thesis', color: '#3366CC' },
    })
    const result = await server.call('update_tag', {
      tagId: 't1',
      name: 'diss',
    })
    expect(client.patch.firstCall.args[1]).to.equal('/tags/t1')
    expect(client.patch.firstCall.args[2]).to.deep.equal({ name: 'diss' })
    expect(result.structuredContent.summary).to.include(
      'renamed "thesis" to "diss"'
    )
    await validOutput(server, 'update_tag', result)
  })

  it('update_tag rejects a call with nothing to change or a bad colour', async function () {
    expect(await inputIssues(server, 'update_tag', { tagId: 't1' })).to.be.an(
      'array'
    ).that.is.not.empty
    expect(
      await inputIssues(server, 'update_tag', { tagId: 't1', color: 'blue' })
    ).to.be.an('array').that.is.not.empty
  })

  it('delete_tag issues a DELETE and states projects are untouched', async function () {
    client.request.resolves({
      tagId: 't1',
      name: 'thesis',
      deleted: true,
      projectsUntagged: 2,
    })
    const result = await server.call('delete_tag', { tagId: 't1' })
    expect(client.request.firstCall.args.slice(1)).to.deep.equal([
      'DELETE',
      '/tags/t1',
    ])
    expect(result.structuredContent.summary).to.include(
      'no project was changed'
    )
    await validOutput(server, 'delete_tag', result)
  })

  it('add_projects_to_tag posts the ids and reports already-tagged ones', async function () {
    client.post.resolves({ tag, added: ['p1'], alreadyTagged: ['p2'] })
    const result = await server.call('add_projects_to_tag', {
      tagId: 't1',
      projectIds: ['p1', 'p2'],
    })
    expect(client.post.firstCall.args[1]).to.equal('/tags/t1/projects')
    expect(client.post.firstCall.args[2]).to.deep.equal({
      projectIds: ['p1', 'p2'],
    })
    expect(result.structuredContent.summary).to.include('1 already had it')
    await validOutput(server, 'add_projects_to_tag', result)
  })

  it('remove_projects_from_tag posts to the remove route', async function () {
    client.post.resolves({ tag, removed: ['p1'], notTagged: [] })
    const result = await server.call('remove_projects_from_tag', {
      tagId: 't1',
      projectIds: ['p1'],
    })
    expect(client.post.firstCall.args[1]).to.equal('/tags/t1/projects/remove')
    expect(result.structuredContent.summary).to.include(
      'Removed "thesis" from 1 project(s)'
    )
    await validOutput(server, 'remove_projects_from_tag', result)
  })

  it('accepts more than 200 projectIds in one call', async function () {
    const ids = Array.from({ length: 201 }, (_, i) => `p${i}`)
    expect(
      await inputIssues(server, 'add_projects_to_tag', {
        tagId: 't1',
        projectIds: ids,
      })
    ).to.be.undefined
  })

  it('surfaces an upstream failure as an error envelope', async function () {
    client.post.rejects(new Error('boom'))
    const result = await server.call('create_tag', { name: 'x' })
    expect(result.isError).to.be.true
    expect(result.structuredContent.ok).to.equal(false)
  })
})
